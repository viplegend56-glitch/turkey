#!/usr/bin/env node
// Re-checks every charity in hope.config.json against donate.gg's public catalog.
//
//   node scripts/refresh-lines.mjs                       shows what changed, writes nothing
//   node scripts/refresh-lines.mjs --apply --actor "Your name" --reason "Weekly check"
//                                                        writes the changes and an audit log entry
//
// What it checks for each charity that has a donate.gg charity ID:
//   - signed up or not (ACTIVE_ONBOARDED). Signing up moves a charity to the paid-out-now turns,
//     so it is a routing change and is logged as one.
//   - its built-in donation ID (configId). A change here is a routing change.
//   - whether donate.gg still lists it. If not, it is set to inactive (a routing change).
//   - city and website, for the site's listing.
// Node 18 or newer. No dependencies. Reads only donate.gg's public endpoint below.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG = 'https://api.donate.gg/api/v1/charities';
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const file = opt('--config') || path.join(here, '..', 'hope.config.json');
const apply = flag('--apply');
const actor = (opt('--actor') || '').trim();
const reason = (opt('--reason') || '').trim();

if (apply && (!actor || reason.length < 3)) {
  console.error('To write changes, add --actor "Your name" and --reason "Why you are refreshing". They go into the audit log.');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) { await sleep((Number(res.headers.get('retry-after')) || 5) * 1000 + 300); continue; }
    if (!res.ok) throw new Error(`donate.gg answered HTTP ${res.status} for ${url}`);
    return res.json();
  }
  throw new Error('donate.gg kept rate-limiting the request. Try again in a few minutes.');
}

async function crawl() {
  const out = new Map();
  let cursor = null, pages = 0;
  for (;;) {
    const url = `${CATALOG}?limit=200&isEnabled=true${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    const j = await getJson(url);
    pages++;
    for (const it of j.response || []) out.set(it.id, it);
    process.stdout.write(`\rReading donate.gg's catalog: page ${pages}, ${out.size} charities`);
    if (!j.pageKey || !(j.response || []).length) break;
    cursor = j.pageKey;
    await sleep(400);
  }
  process.stdout.write('\n');
  return out;
}

const hexId = id => String(id || '').toLowerCase().replace(/^0x/, '');
const titleCity = c => { c = String(c || '').replace(/\s+/g, ' ').trim(); return c === c.toUpperCase() || c === c.toLowerCase() ? c.replace(/\b\w/g, m => m.toUpperCase()).replace(/\B\w/g, m => m.toLowerCase()) : c; };
const payPage = /paypal|gofundme|venmo|cash\.app|givebutter|donorbox/i;

const cfg = JSON.parse(await readFile(file, 'utf8'));
const catalog = await crawl();
const today = new Date().toISOString().slice(0, 10);
const routing = [], other = [];
let checked = 0;

for (const ch of cfg.charities || []) {
  const d = ch.donate || {};
  if (!d.charityId) continue;
  const it = catalog.get(d.charityId);
  if (!it) {
    if (ch.status !== 'inactive') routing.push({ ch, what: `${ch.name}: no longer listed by donate.gg, set to inactive`, fix: c => { c.status = 'inactive'; } });
    continue;
  }
  checked++;
  const signedUp = it.status === 'ACTIVE_ONBOARDED';
  if (!!d.signedUp !== signedUp) routing.push({ ch, what: `${ch.name}: ${signedUp ? 'signed up with donate.gg, moves to the paid-out-now turns' : 'no longer signed up, moves to the long line'}`, fix: c => { c.donate.signedUp = signedUp; } });
  if (it.configId && hexId(it.configId) !== hexId(d.configId)) routing.push({ ch, what: `${ch.name}: donation ID changed at donate.gg (${String(d.configId).slice(0, 10)}… → ${String(it.configId).slice(0, 10)}…)`, fix: c => { c.donate.configId = it.configId; } });
  const city = titleCity(it.city), st = (ch.location || '').split(', ').pop();
  const loc = city && st ? `${city}, ${st}` : ch.location;
  if (loc && loc !== ch.location) other.push({ ch, what: `${ch.name}: location ${ch.location || 'none'} → ${loc}`, fix: c => { c.location = loc; } });
  const site = /^https:\/\/\S+$/i.test(it.website || '') && !payPage.test(it.website) ? it.website : null;
  if ((site || null) !== (ch.website || null) && site) other.push({ ch, what: `${ch.name}: website → ${site}`, fix: c => { c.website = site; } });
  if (it.taxId && it.taxId !== d.taxId) other.push({ ch, what: `${ch.name}: EIN → ${it.taxId}`, fix: c => { c.donate.taxId = it.taxId; } });
}

console.log(`Checked ${checked} charities against ${catalog.size} in donate.gg's catalog.`);
console.log(routing.length ? `\nRouting changes (${routing.length}):\n` + routing.map(r => '  - ' + r.what).join('\n') : '\nNo routing changes.');
console.log(other.length ? `\nListing updates (${other.length}):\n` + other.slice(0, 40).map(r => '  - ' + r.what).join('\n') + (other.length > 40 ? `\n  …and ${other.length - 40} more` : '') : '\nNo listing updates.');

if (!apply) {
  console.log('\nNothing was written. Run again with --apply --actor "Your name" --reason "…" to save these changes.');
  process.exit(0);
}

for (const r of routing.concat(other)) r.fix(r.ch);
for (const ch of cfg.charities || []) if (ch.donate && ch.donate.charityId && catalog.has(ch.donate.charityId)) ch.donate.checkedAt = today;
(cfg.auditLog = cfg.auditLog || []).push({
  at: new Date().toISOString(), actor, action: 'charities.refreshed', routing: routing.length > 0,
  details: `Checked ${checked} charities with donate.gg. ` + (routing.length ? `Routing changes: ${routing.map(r => r.what).join('; ')}. ` : 'No routing changes. ') + (other.length ? `${other.length} listing updates.` : ''),
  reason
});
await writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(`\nSaved ${file} with an audit entry. Deploy it to make the changes live.`);
