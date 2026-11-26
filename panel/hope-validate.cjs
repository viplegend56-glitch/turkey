// Generated from src/validate.js by build.mjs. Do not edit here.
/* HOPE config checks shared by the admin editor (in the browser) and the admin panel server.
   HopeCore is passed in as C so this file works in both places. */
const HopeValidate = (() => {
  'use strict';
  const STALE_DAYS = 7;

  function shapeOk(j) {
    return !!(j && typeof j === 'object' && !Array.isArray(j) && j.schedule && Array.isArray(j.schedule.campaigns) &&
      Array.isArray(j.charities) && j.queues && typeof j.queues === 'object' && j.rotation && j.project);
  }
  function daysSince(date, now) { const t = Date.parse(date); return isFinite(t) ? Math.floor((now - t) / 86400000) : Infinity; }

  /** Returns [{ l: 'e' | 'w', t: text }]. Errors (e) block publishing; warnings (w) do not. */
  function validate(C, cfg, now) {
    now = now == null ? Date.now() : now;
    const out = [];
    const err = t => out.push({ l: 'e', t }), warn = t => out.push({ l: 'w', t });
    const zone = cfg.schedule.timezone;
    if (!C.isValidTz(zone)) { err('The time zone "' + zone + '" is not recognized.'); return out; }
    const camps = cfg.schedule.campaigns || [];
    const ids = new Set();
    for (const c of camps) {
      if (ids.has(c.id)) err('Two campaigns share the ID "' + c.id + '".'); ids.add(c.id);
      const s = C.zonedToUtc(c.start, zone), e = C.zonedToUtc(c.end, zone);
      if (!isFinite(s) || !isFinite(e)) err(c.name + ': the start or end is not a valid date and time.');
      else if (e <= s) err(c.name + ': the end must come after the start.');
      if (!cfg.queues[c.id]) warn(c.name + ' has no line yet.');
    }
    const sorted = C.campaigns(cfg);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].startMs < sorted[i - 1].endMs) err(sorted[i - 1].name + ' and ' + sorted[i].name + ' overlap. Only one campaign can run at a time.');
    const cids = new Set(cfg.charities.map(c => c.id));
    if (cids.size !== cfg.charities.length) err('Two charities share an ID.');
    for (const q of Object.keys(cfg.queues)) {
      if (!Array.isArray(cfg.queues[q])) { err('The line "' + q + '" is not a list.'); continue; }
      for (const id of cfg.queues[q]) if (!cids.has(id)) err('The ' + q + ' line lists "' + id + '", which is not in the charity list.');
      if (!camps.some(c => c.id === q)) warn('The line "' + q + '" has no matching campaign.');
    }
    const seen = {};
    for (const ch of cfg.charities) {
      const cid = ch.donate && ch.donate.configId;
      if (cid) {
        if (!C.isConfigId(cid)) err(ch.name + ': the donate.gg config ID is not valid.');
        else if (seen[cid]) err(ch.name + ' and ' + seen[cid] + ' share a donate.gg config ID. Each charity needs its own.');
        else seen[cid] = ch.name;
      }
      if (ch.status === 'approved' && !C.isConfigId(cid)) err(ch.name + ' is approved but has no valid donation ID, so the site treats it as pending.');
      if (ch.status === 'approved' && !Object.keys(cfg.queues).some(q => Array.isArray(cfg.queues[q]) && cfg.queues[q].includes(ch.id))) warn(ch.name + ' is approved but is not in any line.');
    }
    const approved = cfg.charities.filter(c => c.status === 'approved' && c.donate && c.donate.configId);
    const oldest = approved.reduce((m, c) => Math.max(m, daysSince(c.donate.checkedAt, now)), 0);
    if (approved.length && oldest > STALE_DAYS) warn('Some charities\' donate.gg sign-up status was last checked ' + (oldest === Infinity ? 'never' : oldest + ' days ago') + '. Run "node scripts/refresh-lines.mjs" to check them all.');
    const mode = C.rotationMode(cfg);
    for (const c of sorted) {
      if (c.endMs < now) continue;
      const t = C.tracksFor(cfg, C.queueFor(cfg, c.id));
      if (!t.now.length && !t.line.length) warn('The ' + c.name + ' line has no approved charity with a donation ID yet. The site will show "Waiting for an approved charity".');
      else if (!t.now.length && mode === 'alternate') warn('No charity in the ' + c.name + ' line is signed up with donate.gg, so every turn goes to the long line and donate.gg holds every gift.');
      else if (!t.now.length) warn('Signed-up-only mode is on and no charity in the ' + c.name + ' line is signed up, so the rotation waits.');
    }
    const p = cfg.project || {};
    if (p.donationWallet && !C.isSolAddress(p.donationWallet)) err('The donation wallet is not a valid Solana address.');
    if (p.creatorWallet && !C.isSolAddress(p.creatorWallet)) err('The creator wallet is not a valid Solana address.');
    if (p.contractAddress && !C.isSolAddress(p.contractAddress)) err('The contract address is not a valid Solana address.');
    else if (!p.contractAddress) warn('The contract address is not set. The site shows "Posted here and on X at launch".');
    for (const k of Object.keys(p.links || {})) if (p.links[k] && !/^https:\/\/\S+$/i.test(p.links[k])) err('The ' + k + ' link must start with https://.');
    if (cfg.receipts != null && !Array.isArray(cfg.receipts)) err('The receipts list is not a list.');
    const rids = new Set();
    for (const r of Array.isArray(cfg.receipts) ? cfg.receipts : []) {
      const ch = r && C.charity(cfg, r.charityId);
      const who = ch ? ch.name : 'A receipt';
      if (!r || typeof r !== 'object') { err('A receipt is not valid.'); continue; }
      if (!r.id || rids.has(r.id)) err(who + ': a receipt has a missing or repeated ID.'); rids.add(r.id);
      if (!ch) err('A receipt points to "' + r.charityId + '", which is not in the charity list.');
      if (typeof r.url !== 'string' || !/^https:\/\/[^\s"'<>]+$/i.test(r.url)) err(who + ': the receipt link must start with https://.');
      if (!(Number(r.amount) > 0)) err(who + ': the receipt amount must be more than zero.');
      if (['SOL', 'USD', 'USDC'].indexOf(r.unit) < 0) err(who + ': the receipt must be in SOL, USD or USDC.');
      if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !isFinite(Date.parse(r.date))) err(who + ': the receipt date is not valid.');
      if (r.note != null && (typeof r.note !== 'string' || r.note.length > 140)) err(who + ': the receipt note is too long.');
    }
    if ((Number(cfg.rotation.intervalSeconds) || 0) < 60) err('The rotation interval must be at least 60 seconds.');
    if (cfg.rotation.paused) warn('The rotation is paused. No handoffs are made until it is resumed.');
    if (cfg.display && cfg.display.demo === true) warn('The site is showing demo data to everyone. Turn it off under Token, links & data once the coin launches.');
    return out;
  }

  /** Everything that decides where or when a gift is sent, as one string.
      If this string differs between two configs, donation routing changed. */
  function routingKey(C, cfg) {
    const p = cfg.project || {}, r = cfg.rotation || {}, s = cfg.schedule || {};
    const camps = (s.campaigns || []).map(c => [String(c.id), String(c.start), String(c.end)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const lines = {};
    for (const c of camps) {
      const q = (cfg.queues && Array.isArray(cfg.queues[c[0]])) ? cfg.queues[c[0]] : [];
      lines[c[0]] = q.map(id => C.charity(cfg, id)).filter(ch => C.hasRoute(ch)).map(ch => [ch.id, String(ch.donate.configId).trim(), C.signedUp(ch) ? 1 : 0]);
    }
    return JSON.stringify({
      wallet: p.donationWallet || null,
      relay: (cfg.chain && cfg.chain.relayProgram) || null,
      tz: s.timezone || null,
      camps,
      rot: [Number(r.intervalSeconds) || 0, r.startsAt || null, Number(r.minHandoffSol) || 0, !!r.paused, C.rotationMode(cfg), Object.keys(r.shifts || {}).sort().map(k => [k, Number(r.shifts[k]) || 0])],
      lines
    });
  }

  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  const str = (v, max) => typeof v === 'string' && v.length <= max;

  /** The audit log only grows. Returns { ok, added } or { ok: false, error }. */
  function auditDelta(live, next, now) {
    const a = (live && Array.isArray(live.auditLog)) ? live.auditLog : [];
    const b = next && next.auditLog;
    if (!Array.isArray(b)) return { ok: false, error: 'The audit log is missing.' };
    if (b.length < a.length) return { ok: false, error: 'The audit log is shorter than the published one. Earlier entries can\'t be removed.' };
    for (let i = 0; i < a.length; i++) if (canon(a[i]) !== canon(b[i])) return { ok: false, error: 'An earlier audit log entry was changed. Entries can only be added.' };
    const added = b.slice(a.length);
    for (const e of added) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, error: 'A new audit entry is not valid.' };
      const t = Date.parse(e.at);
      if (!str(e.at, 40) || !isFinite(t)) return { ok: false, error: 'A new audit entry has no valid time.' };
      if (now != null && t > now + 10 * 60000) return { ok: false, error: 'A new audit entry is dated in the future. Check this device\'s clock.' };
      if (!str(e.actor, 80) || !e.actor.trim()) return { ok: false, error: 'A new audit entry has no name. Add your name in the top bar.' };
      if (!str(e.action, 80) || !e.action.trim()) return { ok: false, error: 'A new audit entry has no action.' };
      if (!str(e.details, 60000)) return { ok: false, error: 'A new audit entry has no details.' };
      if (typeof e.routing !== 'boolean') return { ok: false, error: 'A new audit entry does not say whether it changes routing.' };
      if (e.reason != null && !str(e.reason, 2000)) return { ok: false, error: 'A new audit entry has a reason that is too long.' };
    }
    return { ok: true, added };
  }

  /** What a publish must satisfy, given the published config and the new one.
      Returns { ok, added, routingChanged, contractChanged } or { ok: false, code, error }. */
  function publishCheck(C, live, next, now) {
    if (!shapeOk(next)) return { ok: false, code: 'shape', error: 'That does not look like a Turkeycoin config.' };
    const d = auditDelta(live, next, now);
    if (!d.ok) return { ok: false, code: 'audit', error: d.error };
    const strip = c => { const o = Object.assign({}, c); delete o.auditLog; return canon(o); };
    if (!d.added.length) {
      return strip(live) === strip(next)
        ? { ok: false, code: 'nothing', error: 'Nothing has changed, so there is nothing to publish.' }
        : { ok: false, code: 'audit', error: 'The settings changed but the audit log has no new entry. Make the change in this editor so it is recorded.' };
    }
    const errors = validate(C, next, now).filter(i => i.l === 'e');
    if (errors.length) return { ok: false, code: 'invalid', error: 'Fix these first: ' + errors.slice(0, 5).map(i => i.t).join(' ') + (errors.length > 5 ? ' And ' + (errors.length - 5) + ' more.' : ''), problems: errors.map(i => i.t) };
    const routingChanged = routingKey(C, live) !== routingKey(C, next);
    if (routingChanged && !d.added.some(e => e.routing === true)) {
      return { ok: false, code: 'routing-unlogged', error: 'This changes where or when donations are sent, but the audit log has no routing entry for it. Make the change in this editor so it is logged.' };
    }
    const contractChanged = ((live.project || {}).contractAddress || null) !== ((next.project || {}).contractAddress || null);
    return { ok: true, added: d.added, routingChanged, contractChanged };
  }

  return { shapeOk, validate, routingKey, auditDelta, publishCheck, canon };
})();
if (typeof module === 'object' && module.exports) module.exports = HopeValidate;
