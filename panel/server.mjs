// Turkeycoin admin panel: a small password-protected server. Runs on Vercel (api/index.js) or as a
// plain Node server anywhere (npm start).
// It serves the settings editor and saves what you publish straight to the GitHub repo that
// hosts the site, so there is no config file to download or upload.
//
// Set these in the host's environment variables (Vercel: Settings, Environment Variables).
// Never put them in a file in the repo.
//   ADMIN_PASSWORD   the password for this panel, 12 characters or more
//   GITHUB_TOKEN     a fine-grained GitHub token with "Contents: Read and write" on the site repo only
// Optional:
//   GITHUB_REPO      owner/name. Filled in from Vercel's or Railway's Git info when deployed from the repo.
//   GITHUB_BRANCH    the branch the site is published from. Default: main.
//   SESSION_SECRET   signs the sign-in cookie. By default it is derived from the two secrets above.
//   DONATE_API_KEY   only used to read donate.gg's stats when checking a donation ID
//
// No dependencies. Node 18 or newer. Start with: npm start
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getRoute, isConfigId } from './_lib.js';
import C from './hope-core.cjs';
import V from './hope-validate.cjs';
import ADMIN_PAGE from './admin-page.mjs';


const SESSION_MS = 12 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_ADDRESS = 5;
const MAX_FAILS_TOTAL = 40;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const HEADER = 'hope-admin';

/* ------------------------------------------------------------------ settings */
export function readSettings(env) {
  const password = String(env.ADMIN_PASSWORD || '').trim();
  const token = String(env.GITHUB_TOKEN || '').trim();
  const fromHost = env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG && (!env.VERCEL_GIT_PROVIDER || env.VERCEL_GIT_PROVIDER === 'github') ? env.VERCEL_GIT_REPO_OWNER + '/' + env.VERCEL_GIT_REPO_SLUG
    : env.RAILWAY_GIT_REPO_OWNER && env.RAILWAY_GIT_REPO_NAME ? env.RAILWAY_GIT_REPO_OWNER + '/' + env.RAILWAY_GIT_REPO_NAME : '';
  const repo = String(env.GITHUB_REPO || fromHost).trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
  const branch = String(env.GITHUB_BRANCH || (env.VERCEL_ENV === 'production' && env.VERCEL_GIT_COMMIT_REF) || env.RAILWAY_GIT_BRANCH || 'main').trim();
  const paths = String(env.CONFIG_PATHS || 'docs/hope.config.json,hope.config.json').split(',').map(s => s.trim().replace(/^\/+/, '')).filter(Boolean);
  const missing = [];
  if (!password) missing.push(['ADMIN_PASSWORD', 'Not set. Choose a password of 12 characters or more.']);
  else if (password.length < 12) missing.push(['ADMIN_PASSWORD', 'Too short. Use 12 characters or more.']);
  else if (new Set(password).size < 5) missing.push(['ADMIN_PASSWORD', 'Too easy to guess. Mix more different characters.']);
  if (!token) missing.push(['GITHUB_TOKEN', 'Not set. Create a fine-grained token with Contents: Read and write on the site repo.']);
  if (!repo) missing.push(['GITHUB_REPO', 'Not set. Use the form owner/name, for example your-name/turkeycoin.']);
  else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) missing.push(['GITHUB_REPO', 'Use the form owner/name, for example your-name/turkeycoin.']);
  if (!/^[A-Za-z0-9_.\/-]+$/.test(branch)) missing.push(['GITHUB_BRANCH', 'That is not a valid branch name.']);
  const secret = String(env.SESSION_SECRET || '').trim() ||
    crypto.createHmac('sha256', password || 'unset').update('hope-admin-session-v1\n' + token).digest('hex');
  return {
    password, token, repo, branch, paths, missing, secret,
    api: String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    donateKey: env.DONATE_API_KEY || undefined,
    hosted: !!(env.VERCEL || env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID)
  };
}

/* ------------------------------------------------------------------ GitHub */
class PanelError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || null; }
}
function gitBlobSha(buf) { return crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex'); }

function github(S, fetchImpl) {
  const repoPath = '/repos/' + S.repo.split('/').map(encodeURIComponent).join('/');
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');
  async function call(method, p, body) {
    let res;
    try {
      res = await fetchImpl(S.api + repoPath + p, {
        method,
        headers: Object.assign({ authorization: 'Bearer ' + S.token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'hope-admin-panel' }, body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(25_000) : undefined
      });
    } catch (e) {
      throw new PanelError(502, 'github-unreachable', 'Could not reach GitHub. Try again in a minute.');
    }
    return res;
  }
  /** Turns a failed GitHub answer into a message the owner can act on. Never includes the token. */
  function fail(res, what) {
    const left = res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining');
    if (res.status === 401) return new PanelError(502, 'github-token', 'GitHub did not accept the token. Create a new one and update GITHUB_TOKEN in your host\'s settings, then redeploy.');
    if ((res.status === 403 || res.status === 429) && left === '0') return new PanelError(502, 'github-limit', 'GitHub\'s hourly request limit was reached. Try again in a few minutes.');
    if (res.status === 403 || res.status === 404) return new PanelError(502, 'github-access', 'GitHub would not let the token ' + what + ' in ' + S.repo + '. Check that GITHUB_TOKEN has "Contents: Read and write" on that repo, and that GITHUB_REPO and GITHUB_BRANCH (' + S.branch + ') are right.');
    return new PanelError(502, 'github-error', 'GitHub answered with an error (HTTP ' + res.status + ') while trying to ' + what + '. Try again in a minute.');
  }
  async function readFile(p, ref) {
    const res = await call('GET', '/contents/' + encPath(p) + '?ref=' + encodeURIComponent(ref));
    if (res.status === 404) return null;
    if (!res.ok) throw fail(res, 'read ' + p);
    const j = await res.json();
    if (!j || Array.isArray(j) || j.type !== 'file') return null;
    let b64 = j.encoding === 'base64' ? j.content : '';
    if (!b64) {
      const b = await call('GET', '/git/blobs/' + j.sha);
      if (!b.ok) throw fail(b, 'read ' + p);
      b64 = (await b.json()).content || '';
    }
    return { sha: j.sha, text: Buffer.from(b64, 'base64').toString('utf8') };
  }
  async function head() {
    const res = await call('GET', '/git/ref/heads/' + encPath(S.branch));
    if (!res.ok) throw fail(res, 'read the ' + S.branch + ' branch');
    const j = await res.json();
    const c = await call('GET', '/git/commits/' + j.object.sha);
    if (!c.ok) throw fail(c, 'read the latest commit');
    return { commit: j.object.sha, tree: (await c.json()).tree.sha };
  }
  /** The blob SHA of a file inside a tree, without downloading the file. null when it is not there. */
  async function blobShaAt(treeSha, p) {
    const parts = p.split('/');
    let sha = treeSha;
    for (let i = 0; i < parts.length; i++) {
      const res = await call('GET', '/git/trees/' + sha);
      if (!res.ok) throw fail(res, 'read the repo');
      const entry = ((await res.json()).tree || []).find(e => e.path === parts[i]);
      if (!entry) return null;
      const last = i === parts.length - 1;
      if (last) return entry.type === 'blob' ? entry.sha : null;
      if (entry.type !== 'tree') return null;
      sha = entry.sha;
    }
    return null;
  }
  async function post(p, body, what) {
    const res = await call('POST', p, body);
    if (!res.ok) throw fail(res, what);
    return res.json();
  }

  /** The published config: the first of the config paths that exists on the branch. */
  async function loadLive() {
    for (const p of S.paths) {
      const f = await readFile(p, S.branch);
      if (!f) continue;
      let config = null;
      try { config = JSON.parse(f.text); } catch { config = null; }
      if (!V.shapeOk(config)) throw new PanelError(502, 'config-broken', p + ' in ' + S.repo + ' is not a valid Turkeycoin config. Upload a good copy to GitHub first.');
      return { config, sha: f.sha, path: p };
    }
    await head(); // tells a missing file apart from a token that cannot see the repo
    throw new PanelError(502, 'config-missing', 'hope.config.json is not in ' + S.repo + ' yet. Upload the site files to GitHub first.');
  }

  /** One commit that writes the same config to every config path already in the repo. */
  async function commitConfig({ text, baseSha, basePath, message }) {
    let blob = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const h = await head();
      const current = await blobShaAt(h.tree, basePath);
      if (current !== baseSha) throw new PanelError(409, 'conflict', 'The live settings changed after you opened this page. Reload to get the latest, then make your changes again.');
      const targets = [];
      for (const p of S.paths) if (p === basePath || await blobShaAt(h.tree, p)) targets.push(p);
      if (!blob) blob = await post('/git/blobs', { content: text, encoding: 'utf-8' }, 'save the settings');
      const tree = await post('/git/trees', { base_tree: h.tree, tree: targets.map(p => ({ path: p, mode: '100644', type: 'blob', sha: blob.sha })) }, 'save the settings');
      const commit = await post('/git/commits', { message, tree: tree.sha, parents: [h.commit] }, 'save the settings');
      const res = await call('PATCH', '/git/refs/heads/' + encPath(S.branch), { sha: commit.sha, force: false });
      if (res.ok) return { sha: blob.sha, commit: commit.sha, url: commit.html_url || null, paths: targets };
      if (res.status !== 422 && res.status !== 409) throw fail(res, 'save the settings');
      // Something else was pushed in the meantime (the donation counter job, usually). Start again from the new tip.
    }
    throw new PanelError(503, 'github-busy', 'GitHub was busy with other changes to the repo. Nothing was published. Try again.');
  }

  async function readJson(paths) {
    for (const p of paths) {
      const f = await readFile(p, S.branch);
      if (!f) continue;
      try { return { path: p, json: JSON.parse(f.text) }; } catch { return null; }
    }
    return null;
  }
  return { loadLive, commitConfig, readJson };
}

/* ------------------------------------------------------------------ pages */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #15100c; color: #f3e9d2; }
body { min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px; font: 400 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { width: min(460px, 100%); border: 1px solid rgba(243, 233, 210, .26); border-radius: 3px; background: #1d1611; padding: 30px 28px 28px; }
h1 { margin: 0 0 6px; font: 400 30px/1.15 "Libre Caslon Text", Georgia, "Times New Roman", serif; }
p { margin: 0 0 18px; color: #cbbda2; }
label { display: block; font-size: 14px; color: #cbbda2; margin-bottom: 6px; }
input { width: 100%; background: #15100c; color: #f3e9d2; border: 1px solid rgba(243, 233, 210, .26); border-radius: 2px; padding: 12px; font: inherit; }
input:focus-visible, button:focus-visible { outline: 2px solid #c9a55c; outline-offset: 2px; }
button { margin-top: 16px; width: 100%; padding: 12px 14px; border: 1px solid #f3e9d2; border-radius: 2px; background: #f3e9d2; color: #15100c; font: 600 15px/1.2 inherit; cursor: pointer; }
button:hover { background: #e2c88e; border-color: #e2c88e; }
.err { color: #f09a85; margin: 0 0 16px; }
dl { margin: 0 0 18px; }
dt { font: 500 14px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #e2c88e; margin-top: 12px; }
dd { margin: 2px 0 0; color: #cbbda2; font-size: 15px; }
small { color: #9d907a; font-size: 13.5px; }
`;
function shell(title, body) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>' + esc(title) + '</title><style>' + PAGE_CSS + '</style></head><body><main>' + body + '</main></body></html>';
}
function loginPage(error) {
  return shell('Turkeycoin admin: sign in',
    '<h1>Turkeycoin admin</h1><p>Sign in to change the live site\'s settings.</p>' +
    (error ? '<p class="err" role="alert">' + esc(error) + '</p>' : '') +
    '<form method="post" action="/login"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>' +
    '<button type="submit">Sign in</button></form>');
}
function setupPage(S) {
  return shell('Turkeycoin admin: finish setup',
    '<h1>Finish setup</h1><p>This panel is running, but it needs these before anyone can sign in. Add them in your host\'s environment variables (on Vercel: Settings, Environment Variables), then redeploy.</p><dl>' +
    S.missing.map(([k, t]) => '<dt>' + esc(k) + '</dt><dd>' + esc(t) + '</dd>').join('') +
    '</dl><small>Values are never shown here. Type them straight into your host\'s settings, not into a chat or a file in the repo.</small>');
}
const bouncePage = shell('Turkeycoin admin', '<meta http-equiv="refresh" content="0;url=/?in=1"><h1>Turkeycoin admin</h1><p><a href="/?in=1" style="color:#f3e9d2">Continue</a></p>');

/* ------------------------------------------------------------------ app */
/** On Vercel every path is rewritten to /api/index (see vercel.json), which passes the address
    the browser asked for as ?__path=. Put it back so routing sees the real one. */
export function originalUrl(raw) {
  const u = new URL(raw || '/', 'http://panel.local');
  if (!u.searchParams.has('__path') && u.pathname !== '/api/index') return raw || '/';
  let p = u.searchParams.get('__path') || '/';
  u.searchParams.delete('__path');
  if (!p.startsWith('/')) p = '/' + p;
  if (u.pathname === '/api/index' && !p) p = '/';
  const q = u.searchParams.toString();
  return p + (q ? '?' + q : '');
}

export function createApp({ env = process.env, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), adminHtml, log = () => {}, delayMs = 350 } = {}) {
  const S = readSettings(env);
  const ready = S.missing.length === 0;
  const gh = ready ? github(S, fetchImpl) : null;
  const html = adminHtml != null ? adminHtml : ADMIN_PAGE;
  // Only the page's own inline scripts may run.
  const scriptHashes = Array.from(html.matchAll(/<script(?![^>]*\btype="application\/json")[^>]*>([\s\S]*?)<\/script>/g))
    .map(m => "'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
  const ADMIN_CSP = "default-src 'none'; script-src " + (scriptHashes.join(' ') || "'none'") + "; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

  /* ---- sessions: a signed, expiring cookie. Signing out ends every session issued before it. ---- */
  let sessionsValidFrom = 0;
  const mac = data => crypto.createHmac('sha256', S.secret).update(data).digest('base64url');
  const eqKey = crypto.randomBytes(32);
  const digest = v => crypto.createHmac('sha256', eqKey).update(String(v)).digest();
  const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
  const isLocal = req => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
  const secure = req => S.hosted || !isLocal(req) || req.headers['x-forwarded-proto'] === 'https';
  const cookieName = req => (secure(req) ? '__Host-hope_admin' : 'hope_admin');
  function newSession() {
    const body = Buffer.from(JSON.stringify({ iat: now(), exp: now() + SESSION_MS, n: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
    return body + '.' + mac(body);
  }
  function session(req) {
    const name = cookieName(req);
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i < 0 || part.slice(0, i).trim() !== name) continue;
      const [body, sig] = part.slice(i + 1).trim().split('.');
      if (!body || !sig || !safeEqual(sig, mac(body))) return null;
      try {
        const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (typeof s.exp === 'number' && typeof s.iat === 'number' && s.exp > now() && s.iat >= sessionsValidFrom) return s;
      } catch { /* not ours */ }
      return null;
    }
    return null;
  }
  const cookie = (req, value, maxAge) => cookieName(req) + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure(req) ? '; Secure' : '');

  /* ---- wrong-password limits: per address, and in total as the backstop ---- */
  const fails = new Map();
  let allFails = [];
  function clientAddress(req) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    return fwd.length ? fwd[fwd.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
  }
  function recent(list) { const t = now() - WINDOW_MS; return list.filter(x => x > t); }
  function locked(addr) {
    allFails = recent(allFails);
    const mine = recent(fails.get(addr) || []);
    if (mine.length) fails.set(addr, mine); else fails.delete(addr);
    return mine.length >= MAX_FAILS_PER_ADDRESS || allFails.length >= MAX_FAILS_TOTAL;
  }
  function recordFail(addr) {
    allFails.push(now());
    fails.set(addr, recent(fails.get(addr) || []).concat(now()));
    if (fails.size > 5000) fails.delete(fails.keys().next().value);
  }

  /* ---- responses ---- */
  function baseHeaders(req, res, csp) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'same-origin'); // with no-referrer, browsers send Origin: null on the sign-in form
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('content-security-policy', csp || PAGE_CSP);
    if (secure(req)) res.setHeader('strict-transport-security', 'max-age=31536000');
  }
  function sendHtml(req, res, status, body, csp) {
    baseHeaders(req, res, csp);
    res.statusCode = status;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  }
  function sendJson(req, res, status, body) {
    baseHeaders(req, res, "default-src 'none'; frame-ancestors 'none'");
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
  function sendText(req, res, status, body) {
    baseHeaders(req, res);
    res.statusCode = status;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(body);
  }
  function redirect(req, res, to, extra) {
    baseHeaders(req, res);
    res.statusCode = 303;
    res.setHeader('location', to);
    if (extra) res.setHeader('set-cookie', extra);
    res.end();
  }
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0, done = false;
      req.on('data', c => {
        if (done) return;
        size += c.length;
        if (size > max) { done = true; reject(new PanelError(413, 'too-large', 'That is too large to send.')); req.resume(); return; }
        chunks.push(c);
      });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
      req.on('error', () => { if (!done) { done = true; reject(new PanelError(400, 'bad-request', 'The request was cut off.')); } });
    });
  }
  /** Requests that change something must come from this panel's own page. */
  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return false;
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    const from = req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : req.headers.referer;
    if (!from) return site === 'same-origin' || (!site && !req.headers.origin);
    try { return new URL(from).host.toLowerCase() === host || new URL(from).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
  }
  const fromEditor = req => req.headers['x-requested-with'] === HEADER;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  /* ---- routes ---- */
  async function login(req, res) {
    if (!ready) return sendHtml(req, res, 503, setupPage(S));
    if (!sameOrigin(req)) return sendHtml(req, res, 403, loginPage('Sign in from this page.'));
    const addr = clientAddress(req);
    if (locked(addr)) { log('sign-in refused: too many wrong passwords'); return sendHtml(req, res, 429, loginPage('Too many wrong passwords. Wait 15 minutes, then try again.')); }
    const raw = (await readBody(req, 4096)).toString('utf8');
    let given = '';
    if (/json/i.test(req.headers['content-type'] || '')) { try { given = String(JSON.parse(raw).password || ''); } catch { given = ''; } }
    else given = new URLSearchParams(raw).get('password') || '';
    await wait(delayMs);
    if (given && safeEqual(given.trim(), S.password)) {
      fails.delete(addr);
      log('signed in');
      return redirect(req, res, '/', cookie(req, newSession(), Math.floor(SESSION_MS / 1000)));
    }
    recordFail(addr);
    log('wrong password from ' + addr + ' (' + allFails.length + ' in the last 15 minutes)');
    return sendHtml(req, res, 401, loginPage('That password is not right.'));
  }

  async function publish(req, res) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new PanelError(415, 'bad-request', 'Send JSON.');
    let body = null;
    try { body = JSON.parse((await readBody(req, MAX_CONFIG_BYTES)).toString('utf8')); } catch (e) { if (e instanceof PanelError) throw e; body = null; }
    if (!body || typeof body !== 'object' || typeof body.baseSha !== 'string') throw new PanelError(400, 'bad-request', 'The request was not understood.');
    const next = body.config;
    const live = await gh.loadLive();
    if (live.sha !== body.baseSha) throw new PanelError(409, 'conflict', 'The live settings changed after you opened this page. Reload to get the latest, then make your changes again.');
    const check = V.publishCheck(C, live.config, next, now());
    if (!check.ok) throw new PanelError(422, check.code, check.error, check.problems ? { problems: check.problems } : null);
    const text = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new PanelError(413, 'too-large', 'The settings file is too large.');
    const n = check.added.length;
    const one = s => String(s).replace(/\s+/g, ' ').trim();
    const cut = (s, m) => (s.length > m ? s.slice(0, m - 1) + '…' : s);
    const message = 'Admin panel: ' + (n === 1 ? cut(one(check.added[0].action), 56) : n + ' changes') + (check.routingChanged ? ' (routing)' : '') + '\n\n' +
      check.added.map(e => '- ' + one(e.action) + ' by ' + one(e.actor) + (e.routing ? ' [routing]' : '') + ': ' + cut(one(e.details), 300) + (e.reason ? ' Reason: ' + cut(one(e.reason), 200) : '')).join('\n') + '\n';
    const out = await gh.commitConfig({ text, baseSha: live.sha, basePath: live.path, message });
    log('published ' + n + ' change(s)' + (check.routingChanged ? ', routing changed' : '') + ', commit ' + out.commit.slice(0, 7));
    if (out.sha !== gitBlobSha(Buffer.from(text, 'utf8'))) log('note: GitHub stored the file with a different checksum than expected');
    return sendJson(req, res, 200, { ok: true, sha: out.sha, commit: out.commit, commitUrl: out.url, paths: out.paths, changes: n, routingChanged: check.routingChanged, at: new Date(now()).toISOString() });
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const s = session(req);
    if (!s) return sendJson(req, res, 401, { ok: false, panel: true, signedIn: false, error: 'Sign in again.' });
    if (!fromEditor(req)) return sendJson(req, res, 403, { ok: false, error: 'This request did not come from the editor.' });
    if (req.method === 'GET' && p === '/api/panel') return sendJson(req, res, 200, { panel: true, signedIn: true, repo: S.repo, branch: S.branch, paths: S.paths, until: s.exp });
    if (req.method === 'GET' && p === '/api/config') {
      const live = await gh.loadLive();
      return sendJson(req, res, 200, { ok: true, config: live.config, sha: live.sha, path: live.path, repo: S.repo, branch: S.branch });
    }
    if (req.method === 'GET' && p === '/api/route-check') {
      const configId = (url.searchParams.get('configId') || '').trim();
      if (!isConfigId(configId)) return sendJson(req, res, 400, { ok: false, error: 'Enter a donate.gg config ID: a base58 ID or 0x followed by 64 hex characters.' });
      const route = await getRoute(configId, { fetchImpl, donateKey: S.donateKey, fresh: true });
      return sendJson(req, res, route.ok ? 200 : 502, Object.assign({ configId, checkedAt: new Date(now()).toISOString() }, route));
    }
    if (req.method === 'GET' && p === '/api/impact') {
      const f = await gh.readJson(S.paths.map(x => x.replace(/hope\.config\.json$/, 'impact.json')));
      if (!f || !f.json) return sendJson(req, res, 200, { status: 'off', reason: 'The donation counter has not saved any numbers to the repo yet. It runs every 15 minutes once the "Update donation counter" action is on.' });
      return sendJson(req, res, 200, f.json);
    }
    if (req.method === 'POST' && p === '/api/publish') {
      if (!sameOrigin(req)) return sendJson(req, res, 403, { ok: false, error: 'This request did not come from the editor.' });
      return publish(req, res);
    }
    return sendJson(req, res, 404, { ok: false, error: 'Not found.' });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://panel.local');
    const p = url.pathname;
    if (p === '/healthz') return sendText(req, res, 200, 'ok');
    if (req.headers['x-forwarded-proto'] === 'http' && !isLocal(req)) {
      baseHeaders(req, res); res.statusCode = 308; res.setHeader('location', 'https://' + req.headers.host + req.url); return res.end();
    }
    if (p === '/robots.txt') return sendText(req, res, 200, 'User-agent: *\nDisallow: /\n');
    if (p === '/login' && req.method === 'POST') return login(req, res);
    if (p === '/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return sendJson(req, res, 403, { ok: false, error: 'Sign out from the editor.' });
      if (session(req)) { sessionsValidFrom = now() + 1; log('signed out'); }
      baseHeaders(req, res);
      res.statusCode = 200;
      res.setHeader('set-cookie', cookie(req, '', 0));
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end('{"ok":true}');
    }
    if (p.startsWith('/api/')) {
      if (!ready) return sendJson(req, res, 503, { ok: false, error: 'The panel is not set up yet.' });
      return api(req, res, url);
    }
    if (p === '/' || p === '/admin.html' || p === '/login') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(req, res, 405, 'Method not allowed');
      if (!ready) return sendHtml(req, res, 503, setupPage(S));
      if (session(req)) {
        if (p !== '/') return redirect(req, res, '/');
        return sendHtml(req, res, 200, html, ADMIN_CSP);
      }
      // A link from another site does not carry the sign-in cookie. One same-site hop does.
      if (p === '/' && req.method === 'GET' && req.headers['sec-fetch-site'] === 'cross-site' && !url.searchParams.has('in')) return sendHtml(req, res, 200, bouncePage);
      return sendHtml(req, res, 200, loginPage(''));
    }
    return sendText(req, res, 404, 'Not found');
  }

  async function handler(req, res) {
    req.url = originalUrl(req.url);
    const started = now();
    try { await route(req, res); }
    catch (e) {
      if (e instanceof PanelError) { if (!res.headersSent) sendJson(req, res, e.status, Object.assign({ ok: false, code: e.code, error: e.message }, e.extra || {})); }
      else { log('error: ' + (e && e.message)); if (!res.headersSent) sendJson(req, res, 500, { ok: false, error: 'Something went wrong on the panel. Try again.' }); else res.end(); }
    }
    if (req.url !== '/healthz') log(req.method + ' ' + String(req.url).split('?')[0] + ' ' + res.statusCode + ' ' + (now() - started) + 'ms');
  }
  return { handler, ready, settings: { repo: S.repo, branch: S.branch, paths: S.paths, missing: S.missing.map(m => m[0]) } };
}

/* ------------------------------------------------------------------ start */
// Vercel loads this file and calls its default export for every request.
let shared = null;
export default function handler(req, res) {
  if (!shared) shared = createApp({ log: msg => console.log(msg) });
  return shared.handler(req, res);
}

// Run directly (npm start) it listens on PORT. On Vercel it never listens.
if (!process.env.VERCEL && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp({ log: msg => console.log(new Date().toISOString() + ' ' + msg) });
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer(app.handler);
  server.listen(port, () => {
    console.log('Turkeycoin admin panel listening on port ' + port + (app.ready ? ' for ' + app.settings.repo + ' (' + app.settings.branch + ')' : '. Setup is not finished: ' + app.settings.missing.join(', ') + ' needed'));
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
