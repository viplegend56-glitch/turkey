// Admin panel (panel/server.mjs): sign-in, limits, and the rules a publish must pass.
// GitHub is replaced by an in-memory stand-in; nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp, readSettings } from '../panel/server.mjs';
import { FakeGitHub } from './helpers/fake-github.mjs';

const PASSWORD = 'correct horse battery 42';
const TOKEN = 'test-token';
const baseConfig = () => JSON.parse(readFileSync(new URL('../hope.config.json', import.meta.url), 'utf8'));
const text = cfg => JSON.stringify(cfg, null, 2) + '\n';
const clone = o => JSON.parse(JSON.stringify(o));

async function start({ env = {}, files, clock } = {}) {
  const cfg = baseConfig();
  const gh = new FakeGitHub({ files: files || { 'docs/hope.config.json': text(cfg), 'hope.config.json': text(cfg), 'docs/index.html': '<html></html>', 'docs/impact.json': '{"status":"off","reason":"not yet"}' } });
  const logs = [];
  const app = createApp({
    env: Object.assign({ ADMIN_PASSWORD: PASSWORD, GITHUB_TOKEN: TOKEN, GITHUB_REPO: 'owner/hope' }, env),
    fetchImpl: gh.fetch, adminHtml: '<!DOCTYPE html><title>editor</title><script>window.x=1</script>', delayMs: 0,
    now: clock ? () => clock.t : undefined, log: m => logs.push(m)
  });
  const server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const req = (path, { method = 'GET', cookie, body, headers = {}, form } = {}) => fetch(origin + path, {
    method, redirect: 'manual',
    headers: Object.assign({}, cookie ? { cookie } : {}, form ? { 'content-type': 'application/x-www-form-urlencoded' } : body ? { 'content-type': 'application/json' } : {}, headers),
    body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined
  });
  const signIn = async (password = PASSWORD) => {
    const r = await req('/login', { method: 'POST', form: { password }, headers: { origin } });
    const set = r.headers.get('set-cookie');
    return { r, cookie: set ? set.split(';')[0] : null, set };
  };
  const api = (path, cookie, opts = {}) => req(path, Object.assign({ cookie }, opts, { headers: Object.assign({ 'x-requested-with': 'hope-admin', origin }, opts.headers || {}) }));
  return { gh, app, server, origin, req, signIn, api, logs, cfg, close: () => new Promise(r => server.close(r)) };
}
const entry = (o = {}) => Object.assign({ at: new Date().toISOString(), actor: 'Tester', action: 'links.updated', routing: false, details: 'A change', reason: '' }, o);
function withEntry(cfg, e, change) { const next = clone(cfg); change(next); next.auditLog.push(entry(e)); return next; }

test('setup: says what is missing without showing values, and refuses sign-in', async () => {
  const s = readSettings({ ADMIN_PASSWORD: 'short', GITHUB_TOKEN: '' });
  assert.deepEqual(s.missing.map(m => m[0]), ['ADMIN_PASSWORD', 'GITHUB_TOKEN', 'GITHUB_REPO']);
  const t = await start({ env: { ADMIN_PASSWORD: 'short' } });
  const page = await t.req('/');
  assert.equal(page.status, 503);
  const html = await page.text();
  assert.match(html, /ADMIN_PASSWORD/);
  assert.ok(!html.includes('short') || /Too short/.test(html));
  assert.equal((await t.signIn('short')).r.status, 503);
  assert.equal((await t.api('/api/config', 'hope_admin=x')).status, 503);
  await t.close();
});

test('Railway fills in the repo and branch', () => {
  const s = readSettings({ ADMIN_PASSWORD: PASSWORD, GITHUB_TOKEN: TOKEN, RAILWAY_GIT_REPO_OWNER: 'viplegend56-glitch', RAILWAY_GIT_REPO_NAME: 'hope', RAILWAY_GIT_BRANCH: 'main', RAILWAY_ENVIRONMENT: 'production' });
  assert.equal(s.repo, 'viplegend56-glitch/hope');
  assert.equal(s.branch, 'main');
  assert.equal(s.hosted, true);
  assert.deepEqual(s.missing, []);
});

test('sign-in: wrong password is refused, right one sets a locked-down cookie', async () => {
  const t = await start();
  const anon = await t.req('/');
  assert.equal(anon.status, 200);
  assert.match(await anon.text(), /Sign in/);
  assert.equal((await t.req('/api/config', { headers: { 'x-requested-with': 'hope-admin' } })).status, 401);

  const bad = await t.signIn('not the password');
  assert.equal(bad.r.status, 401);
  assert.equal(bad.cookie, null);
  assert.match(await bad.r.text(), /not right/);

  const ok = await t.signIn();
  assert.equal(ok.r.status, 303);
  assert.match(ok.set, /HttpOnly/);
  assert.match(ok.set, /SameSite=Strict/);
  assert.match(ok.set, /Path=\//);
  const page = await t.req('/', { cookie: ok.cookie });
  assert.match(await page.text(), /editor/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'sha256-/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');

  const forged = ok.cookie.slice(0, -3) + 'abc';
  assert.equal((await t.api('/api/panel', forged)).status, 401);
  // No secret ever appears in a response or a log line.
  const info = await (await t.api('/api/panel', ok.cookie)).json();
  assert.equal(info.repo, 'owner/hope');
  assert.ok(!JSON.stringify(info).includes(TOKEN) && !JSON.stringify(info).includes(PASSWORD));
  assert.ok(!t.logs.join('\n').includes(TOKEN) && !t.logs.join('\n').includes(PASSWORD));
  await t.close();
});

test('on Railway the cookie is Secure with the __Host- prefix, and http is sent to https', async () => {
  const t = await start({ env: { RAILWAY_ENVIRONMENT: 'production' } });
  const ok = await t.signIn();
  assert.match(ok.set, /^__Host-hope_admin=/);
  assert.match(ok.set, /; Secure/);
  // fetch() can't set Host, so ask with a plain request, the way Railway's proxy does.
  const r = await new Promise((resolve, reject) => {
    http.get(t.origin + '/', { headers: { 'x-forwarded-proto': 'http', host: 'panel.up.railway.app' } }, res => { res.resume(); resolve(res); }).on('error', reject);
  });
  await t.close();
  assert.equal(r.statusCode, 308);
  assert.equal(r.headers.location, 'https://panel.up.railway.app/');
});

test('sign-in: five wrong passwords lock that address for 15 minutes', async () => {
  const clock = { t: Date.parse('2026-11-24T12:00:00Z') };
  const t = await start({ clock });
  for (let i = 0; i < 5; i++) assert.equal((await t.signIn('wrong ' + i)).r.status, 401);
  const locked = await t.signIn();
  assert.equal(locked.r.status, 429, 'even the right password waits');
  assert.match(await locked.r.text(), /Wait 15 minutes/);
  clock.t += 16 * 60 * 1000;
  assert.equal((await t.signIn()).r.status, 303);
  await t.close();
});

test('sign-in: many wrong passwords from different addresses lock everyone', async () => {
  const clock = { t: Date.parse('2026-11-24T12:00:00Z') };
  const t = await start({ clock });
  for (let i = 0; i < 40; i++) {
    const r = await t.req('/login', { method: 'POST', form: { password: 'guess' + i }, headers: { origin: t.origin, 'x-real-ip': '10.0.' + (i % 250) + '.' + i } });
    assert.equal(r.status, 401);
  }
  const r = await t.req('/login', { method: 'POST', form: { password: PASSWORD }, headers: { origin: t.origin, 'x-real-ip': '10.9.9.9' } });
  assert.equal(r.status, 429);
  await t.close();
});

test('sessions end after 12 hours and on sign-out', async () => {
  const clock = { t: Date.parse('2026-11-24T12:00:00Z') };
  const t = await start({ clock });
  const a = await t.signIn();
  assert.equal((await t.api('/api/panel', a.cookie)).status, 200);
  clock.t += 12 * 60 * 60 * 1000 + 1000;
  assert.equal((await t.api('/api/panel', a.cookie)).status, 401);
  const b = await t.signIn();
  clock.t += 1000;
  const out = await t.api('/logout', b.cookie, { method: 'POST' });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await t.api('/api/panel', b.cookie)).status, 401, 'the old cookie no longer works');
  await t.close();
});

test('requests must come from the editor itself', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  const next = withEntry(t.cfg, {}, c => { c.project.links.x = 'https://x.com/hope'; });
  const sha = (await (await t.api('/api/config', cookie)).json()).sha;
  const body = { config: next, baseSha: sha };
  // no custom header
  assert.equal((await t.req('/api/publish', { method: 'POST', cookie, body })).status, 403);
  // another site's page
  assert.equal((await t.api('/api/publish', cookie, { method: 'POST', body, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await t.api('/api/publish', cookie, { method: 'POST', body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  // a form post from another site cannot sign in either
  assert.equal((await t.req('/login', { method: 'POST', form: { password: PASSWORD }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal(t.gh.log().length, 1, 'nothing was committed');
  await t.close();
});

test('publish: a receipt goes live with its audit entry', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  const live = await (await t.api('/api/config', cookie)).json();
  const ch = live.config.charities[0];
  const rc = { id: 'r-1', charityId: ch.id, date: '2026-11-24', amount: 0.5, unit: 'SOL', url: 'https://solscan.io/tx/5abc', note: null };
  const next = withEntry(live.config, { action: 'receipt.added', details: 'Receipt: ' + ch.name }, c => { c.receipts = [rc]; });
  const r = await t.api('/api/publish', cookie, { method: 'POST', body: { config: next, baseSha: live.sha } });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.deepEqual(JSON.parse(t.gh.file('docs/hope.config.json')).receipts, [rc]);
  assert.equal((await r.json()).routingChanged, false);
  await t.close();
});

test('publish: one commit updates every copy of the config and keeps other files', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  const live = await (await t.api('/api/config', cookie)).json();
  assert.equal(live.path, 'docs/hope.config.json');
  const next = withEntry(live.config, { actor: 'Sam', details: 'x link: none → https://x.com/hope' }, c => { c.project.links.x = 'https://x.com/hope'; });
  const r = await t.api('/api/publish', cookie, { method: 'POST', body: { config: next, baseSha: live.sha } });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.changes, 1);
  assert.equal(j.routingChanged, false);
  assert.deepEqual(j.paths, ['docs/hope.config.json', 'hope.config.json']);
  assert.equal(t.gh.file('docs/hope.config.json'), text(next));
  assert.equal(t.gh.file('hope.config.json'), text(next));
  assert.equal(t.gh.file('docs/index.html'), '<html></html>');
  assert.equal(t.gh.log().length, 2);
  assert.match(t.gh.log()[0], /^Admin panel: links\.updated\n\n- links\.updated by Sam: x link/);
  // the new version is what the next visit loads
  const again = await (await t.api('/api/config', cookie)).json();
  assert.equal(again.sha, j.sha);
  assert.equal(again.config.project.links.x, 'https://x.com/hope');
  await t.close();
});

test('publish: only writes the copies that exist in the repo', async () => {
  const cfg = baseConfig();
  const t = await start({ files: { 'hope.config.json': text(cfg), 'index.html': 'x' } });
  const { cookie } = await t.signIn();
  const live = await (await t.api('/api/config', cookie)).json();
  assert.equal(live.path, 'hope.config.json');
  const next = withEntry(live.config, {}, c => { c.project.links.x = 'https://x.com/hope'; });
  const j = await (await t.api('/api/publish', cookie, { method: 'POST', body: { config: next, baseSha: live.sha } })).json();
  assert.deepEqual(j.paths, ['hope.config.json']);
  assert.equal(t.gh.file('docs/hope.config.json'), null);
  await t.close();
});

test('publish: routing changes need a routing entry in the audit log, nothing more', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  const live = await (await t.api('/api/config', cookie)).json();
  const send = body => t.api('/api/publish', cookie, { method: 'POST', body: Object.assign({ baseSha: live.sha }, body) });
  const flip = c => { c.rotation.mode = 'signed-up-only'; };

  // logged as an ordinary change: refused
  let r = await send({ config: withEntry(live.config, { routing: false }, flip) });
  assert.equal(r.status, 422); assert.equal((await r.json()).code, 'routing-unlogged');
  assert.equal(t.gh.log().length, 1, 'nothing was committed so far');
  // logged as a routing change, no reason and no extra tick: published
  r = await send({ config: withEntry(live.config, { action: 'rotation.mode', routing: true, reason: '' }, flip) });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.routingChanged, true);
  assert.match(t.gh.log()[0], /\(routing\)/);
  assert.equal(JSON.parse(t.gh.file('docs/hope.config.json')).rotation.mode, 'signed-up-only');
  await t.close();
});

test('publish: each kind of routing change is caught', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  const live = await (await t.api('/api/config', cookie)).json();
  const approved = live.config.queues.thanksgiving[0];
  const changes = {
    wallet: c => { c.project.donationWallet = 'So11111111111111111111111111111111111111112'; },
    pause: c => { c.rotation.paused = true; },
    interval: c => { c.rotation.intervalSeconds = 600; },
    dates: c => { c.schedule.campaigns[0].end = '2026-11-27T02:00'; },
    lineOrder: c => { c.queues.thanksgiving.reverse(); },
    unapprove: c => { c.charities.find(x => x.id === approved).status = 'inactive'; },
    signedUp: c => { const ch = c.charities.find(x => x.id === approved); ch.donate.signedUp = !ch.donate.signedUp; },
    donationId: c => { c.charities.find(x => x.id === approved).donate.configId = '0x' + 'ab'.repeat(32); }
  };
  for (const [name, change] of Object.entries(changes)) {
    const r = await t.api('/api/publish', cookie, { method: 'POST', body: { config: withEntry(live.config, { routing: false }, change), baseSha: live.sha, confirmRouting: true } });
    assert.equal((await r.json()).code, 'routing-unlogged', name);
  }
  // text-only edits are not routing
  const r = await t.api('/api/publish', cookie, { method: 'POST', body: { config: withEntry(live.config, {}, c => { c.schedule.campaigns[0].intro = 'New words'; c.charities[0].name += ' (renamed)'; }), baseSha: live.sha } });
  assert.equal(r.status, 200);
  await t.close();
});

test('publish: the audit log only grows, and every change needs an entry', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  const live = await (await t.api('/api/config', cookie)).json();
  const send = config => t.api('/api/publish', cookie, { method: 'POST', body: { config, baseSha: live.sha, confirmRouting: true } });
  const code = async r => (await r.json()).code;

  assert.equal(await code(await send(live.config)), 'nothing');
  const silent = clone(live.config); silent.project.links.x = 'https://x.com/hope';
  assert.equal(await code(await send(silent)), 'audit', 'a change with no audit entry');
  const rewritten = withEntry(live.config, {}, c => { c.auditLog[0].details = 'Edited history'; });
  assert.equal(await code(await send(rewritten)), 'audit');
  const dropped = withEntry(live.config, {}, c => { c.auditLog.shift(); c.auditLog.shift(); });
  assert.equal(await code(await send(dropped)), 'audit');
  const nameless = withEntry(live.config, { actor: '  ' }, c => { c.project.links.x = 'https://x.com/hope'; });
  assert.equal(await code(await send(nameless)), 'audit');
  const badReceipt = withEntry(live.config, { action: 'receipt.added' }, c => { c.receipts = [{ id: 'r1', charityId: c.charities[0].id, date: '2026-11-24', amount: 1, unit: 'SOL', url: 'http://not-https.example' }]; });
  assert.equal(await code(await send(badReceipt)), 'invalid');
  const strayReceipt = withEntry(live.config, { action: 'receipt.added' }, c => { c.receipts = [{ id: 'r1', charityId: 'nobody', date: '2026-11-24', amount: 1, unit: 'SOL', url: 'https://solscan.io/tx/abc' }]; });
  assert.equal(await code(await send(strayReceipt)), 'invalid');
  const broken = withEntry(live.config, {}, c => { c.project.links.x = 'http://not-https.example'; });
  const r = await send(broken);
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.equal(j.code, 'invalid');
  assert.match(j.error, /must start with https/);
  assert.equal(await code(await send({ nope: true })), 'shape');
  assert.equal(t.gh.log().length, 1, 'nothing was committed');
  await t.close();
});

test('publish: refuses to overwrite settings that changed elsewhere', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  const live = await (await t.api('/api/config', cookie)).json();
  const outside = withEntry(live.config, { actor: 'refresh script' }, c => { c.project.links.telegram = 'https://t.me/hope'; });
  t.gh.push({ 'docs/hope.config.json': text(outside), 'hope.config.json': text(outside) }, 'Uploaded by hand');
  const mine = withEntry(live.config, {}, c => { c.project.links.x = 'https://x.com/hope'; });
  const r = await t.api('/api/publish', cookie, { method: 'POST', body: { config: mine, baseSha: live.sha } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'conflict');
  assert.equal(t.gh.file('docs/hope.config.json'), text(outside));
  await t.close();
});

test('publish: retries when the counter job pushes at the same moment', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  const live = await (await t.api('/api/config', cookie)).json();
  t.gh.raceOnce = () => t.gh.push({ 'docs/impact.json': '{"status":"live","n":2}' }, 'Update donation counter');
  const next = withEntry(live.config, {}, c => { c.project.links.x = 'https://x.com/hope'; });
  const r = await t.api('/api/publish', cookie, { method: 'POST', body: { config: next, baseSha: live.sha } });
  assert.equal(r.status, 200);
  assert.equal(t.gh.file('docs/hope.config.json'), text(next));
  assert.equal(t.gh.file('docs/impact.json'), '{"status":"live","n":2}', 'the counter update was kept');
  assert.deepEqual(t.gh.log().slice(0, 2).map(m => m.split('\n')[0]), ['Admin panel: links.updated', 'Update donation counter']);
  await t.close();
});

test('GitHub problems come back as plain instructions, never as the token', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  const live = await (await t.api('/api/config', cookie)).json();
  t.gh.readOnly = true;
  const next = withEntry(live.config, {}, c => { c.project.links.x = 'https://x.com/hope'; });
  let r = await t.api('/api/publish', cookie, { method: 'POST', body: { config: next, baseSha: live.sha } });
  let j = await r.json();
  assert.equal(r.status, 502);
  assert.match(j.error, /Contents: Read and write/);
  t.gh.token = 'rotated';
  r = await t.api('/api/config', cookie);
  j = await r.json();
  assert.equal(r.status, 502);
  assert.match(j.error, /did not accept the token/);
  assert.ok(!JSON.stringify(j).includes(TOKEN));
  await t.close();
});

test('the counter file and donate.gg checks go through the panel', async () => {
  const t = await start();
  const { cookie } = await t.signIn();
  assert.deepEqual(await (await t.api('/api/impact', cookie)).json(), { status: 'off', reason: 'not yet' });
  const bad = await t.api('/api/route-check?configId=nope', cookie);
  assert.equal(bad.status, 400);
  assert.equal((await t.req('/api/impact')).status, 401);
  assert.equal((await t.req('/hope.config.json')).status, 404);
  assert.equal((await t.req('/server.mjs')).status, 404);
  await t.close();
});

test('Vercel fills in the repo and branch, and the entry point serves the panel', async () => {
  const s = readSettings({ ADMIN_PASSWORD: PASSWORD, GITHUB_TOKEN: TOKEN, VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'viplegend56-glitch', VERCEL_GIT_REPO_SLUG: 'hope', VERCEL_GIT_COMMIT_REF: 'main' });
  assert.equal(s.repo, 'viplegend56-glitch/hope');
  assert.equal(s.branch, 'main');
  assert.equal(s.hosted, true);
  assert.equal(readSettings({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'some-branch' }).branch, 'main', 'previews never publish to another branch');

  const saved = { ...process.env };
  Object.assign(process.env, { ADMIN_PASSWORD: PASSWORD, GITHUB_TOKEN: TOKEN, GITHUB_REPO: 'owner/hope', VERCEL: '1' });
  try {
    const { default: handler } = await import('../panel/api/index.js?' + Date.now());
    const server = http.createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const page = await fetch(origin + '/');
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Sign in/);
    const signIn = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(PASSWORD) });
    const cookie = signIn.headers.get('set-cookie');
    assert.match(cookie, /^__Host-hope_admin=.*; Secure/);
    await new Promise(r => server.close(r));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('the built editor page is bundled as a module', async () => {
  const { default: page } = await import('../panel/admin-page.mjs');
  assert.match(page, /^<!DOCTYPE html>/i);
  assert.match(page, /HopeValidate/);
  assert.match(page, /id="saveState"/);
});

test('server.mjs itself default-exports a request handler (Vercel loads it directly)', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ADMIN_PASSWORD: PASSWORD, GITHUB_TOKEN: TOKEN, GITHUB_REPO: 'owner/hope', VERCEL: '1' });
  try {
    const mod = await import('../panel/server.mjs?direct=' + Date.now());
    assert.equal(typeof mod.default, 'function');
    const server = http.createServer(mod.default);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/healthz');
    assert.equal(await r.text(), 'ok');
    await new Promise(r => server.close(r));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('Vercel rewrites: the real address is restored', async () => {
  const { originalUrl } = await import('../panel/server.mjs');
  assert.equal(originalUrl('/api/index?__path=/'), '/');
  assert.equal(originalUrl('/api/index?__path=/api/config'), '/api/config');
  assert.equal(originalUrl('/api/index?__path=/api/route-check&configId=abc'), '/api/route-check?configId=abc');
  assert.equal(originalUrl('/api/index?in=1&__path=/'), '/?in=1');
  assert.equal(originalUrl('/api/index?__path=login'), '/login');
  assert.equal(originalUrl('/api/index'), '/');
  assert.equal(originalUrl('/login'), '/login');
  assert.equal(originalUrl('/api/config'), '/api/config');

  const t = await start();
  const page = await t.req('/api/index?__path=/');
  assert.match(await page.text(), /Sign in/);
  const r = await t.req('/api/index?__path=/login', { method: 'POST', form: { password: PASSWORD }, headers: { origin: t.origin } });
  assert.equal(r.status, 303);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await t.api('/api/index?__path=/api/panel', cookie)).status, 200);
  await t.close();
});
