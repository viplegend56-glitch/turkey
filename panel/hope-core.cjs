// Generated from src/core.js by build.mjs. Do not edit here.
/* HOPE core: schedule, rotation, validation and formatting shared by the site and the admin editor. */
const HopeCore = (() => {
  'use strict';

  /* ---------- base58 / Solana identifiers ---------- */
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58decode(str) {
    if (typeof str !== 'string' || !str) return null;
    const bytes = [];
    for (const ch of str) {
      let carry = B58.indexOf(ch);
      if (carry < 0) return null;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (const ch of str) { if (ch === '1') bytes.push(0); else break; }
    return Uint8Array.from(bytes.reverse());
  }
  function isSolAddress(s) {
    const b = b58decode(String(s || '').trim());
    return !!b && b.length === 32;
  }
  function isConfigId(s) {
    s = String(s || '').trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(s)) return true;
    return isSolAddress(s);
  }

  /* ---------- time zones (no libraries) ---------- */
  const dtfCache = new Map();
  function partsFmt(tz) {
    if (!dtfCache.has(tz)) {
      dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }));
    }
    return dtfCache.get(tz);
  }
  function tzOffsetMs(tz, utcMs) {
    const p = {};
    for (const part of partsFmt(tz).formatToParts(new Date(utcMs))) p[part.type] = part.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  }
  /** "2026-11-27T00:00" wall-clock time in `tz` -> UTC milliseconds */
  function zonedToUtc(local, tz) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(local || '').trim());
    if (!m) return NaN;
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    const off1 = tzOffsetMs(tz, guess);
    let ts = guess - off1;
    const off2 = tzOffsetMs(tz, ts);
    if (off2 !== off1) ts = guess - off2;
    return ts;
  }
  function isValidTz(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }

  /* ---------- campaigns ---------- */
  function campaigns(cfg) {
    const tz = (cfg.schedule && cfg.schedule.timezone) || 'UTC';
    return ((cfg.schedule && cfg.schedule.campaigns) || [])
      .map(c => Object.assign({}, c, { startMs: zonedToUtc(c.start, tz), endMs: zonedToUtc(c.end, tz) }))
      .filter(c => isFinite(c.startMs) && isFinite(c.endMs) && c.endMs > c.startMs)
      .sort((a, b) => a.startMs - b.startMs);
  }
  function campaignAt(cfg, now) {
    const list = campaigns(cfg);
    const current = list.find(c => now >= c.startMs && now < c.endMs) || null;
    const next = list.find(c => c.startMs > now) || null;
    const prev = list.slice().reverse().find(c => c.endMs <= now) || null;
    const phase = current ? 'active' : next ? (prev ? 'between' : 'before') : 'after';
    return { list, current, next, prev, phase };
  }
  function campaignById(cfg, id) { return campaigns(cfg).find(c => c.id === id) || null; }
  function campaignForTime(cfg, ms) {
    return campaigns(cfg).find(c => ms >= c.startMs && ms < c.endMs) || null;
  }

  /* ---------- charities ----------
     A charity can receive from HOPE once the team approved it and it has a donate.gg donation ID
     (every charity in donate.gg's catalog has a built-in one). Then:
       signed up     -> donate.gg pays it out now (status ACTIVE_ONBOARDED)
       not signed up -> donate.gg holds the gift until the charity signs up and claims it */
  const byIdCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function charity(cfg, id) {
    const list = cfg.charities || [];
    if (!byIdCache) return list.find(c => c.id === id) || null;
    let m = byIdCache.get(list);
    if (!m) { m = new Map(list.map(c => [c.id, c])); byIdCache.set(list, m); }
    return m.get(id) || null;
  }
  function hasRoute(ch) { return !!ch && ch.status === 'approved' && isConfigId(ch.donate && ch.donate.configId); }
  function signedUp(ch) { return !!(ch && ch.donate && ch.donate.signedUp); }
  /** Approved, has a donation ID, and signed up with donate.gg: paid out now. */
  function payoutReady(ch) { return hasRoute(ch) && signedUp(ch); }
  /** Approved and has a donation ID, but not signed up yet: donate.gg holds the gift. */
  function lineReady(ch) { return hasRoute(ch) && !signedUp(ch); }
  /** ready = paid out now; held = gift held until the charity signs up; pending; inactive */
  function effectiveStatus(ch) {
    if (!ch || ch.status === 'inactive') return 'inactive';
    if (payoutReady(ch)) return 'ready';
    if (lineReady(ch)) return 'held';
    return 'pending';
  }
  function queueFor(cfg, campaignId) {
    return ((cfg.queues && cfg.queues[campaignId]) || []).map(id => charity(cfg, id)).filter(Boolean);
  }
  function placeOf(ch) {
    if (!ch) return '';
    if (ch.location) return ch.location;
    return [ch.city, ch.state].filter(Boolean).join(', ');
  }

  /* ---------- rotation ----------
     Turn k of a campaign happens at campaign.start + k * interval.
     Two tracks, in queue order:
       now  = charities that are signed up with donate.gg (paid out now)
       line = everyone else in the queue with a donation ID (donate.gg holds their gifts)
     In "alternate" mode turns go now, line, now, line, ... Each track keeps its own place, so
     turn k's charity depends only on k and the queue. In "signed-up-only" mode only the now track
     is used. If one track is empty, every turn uses the other.
     The payout worker must use this exact rule (see turnAt) so the site and the chain agree. */
  // "signed-up-first": one turn each, signed-up charities first (line order), then everyone else (line order), then repeat.
  function rotationMode(cfg) {
    const m = cfg.rotation && cfg.rotation.mode;
    return m === 'signed-up-only' || m === 'signed-up-first' ? m : 'alternate';
  }
  /** A fixed shuffle: the same charities always come out in the same mixed order (not alphabetical),
      so the site and the admin agree on who is next. */
  function shuffled(list) {
    let h = 2166136261;
    const key = list.map(c => c.id).sort().join('|');
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    const rnd = () => { h = (h + 0x6D2B79F5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = out[i]; out[i] = out[j]; out[j] = x; }
    return out;
  }
  function tracksFor(cfg, queue, opts) {
    opts = opts || {};
    const isReady = opts.isReady || payoutReady;
    const isHeld = opts.isHeld || lineReady;
    const now = queue.filter(isReady);
    const line = rotationMode(cfg) === 'signed-up-only' ? [] : queue.filter(ch => !isReady(ch) && isHeld(ch));
    if (rotationMode(cfg) === 'signed-up-first') { const mixed = cfg.rotation && cfg.rotation.keepOrder ? line.slice() : shuffled(line); /* keepOrder: the line runs in the order it is listed */ const seq = now.concat(mixed); return { now, line: mixed, seq, pattern: seq.length ? ['seq'] : [] }; }
    const pattern = now.length && line.length ? ['now', 'line'] : now.length ? ['now'] : line.length ? ['line'] : [];
    return { now, line, pattern };
  }
  /** The charity for turn k (k = 0 is the first turn of the campaign), or null. */
  function pickTurn(tracks, k) {
    const P = tracks.pattern, L = P.length;
    if (!L || !(k >= 0)) return null;
    if (P[0] === 'seq') { const pos = k % tracks.seq.length; return { charity: tracks.seq[pos], track: pos < tracks.now.length ? 'now' : 'line', pos, k }; }
    const track = P[k % L];
    const list = track === 'now' ? tracks.now : tracks.line;
    let per = 0, before = 0;
    for (let i = 0; i < L; i++) if (P[i] === track) { per++; if (i < k % L) before++; }
    const pos = (Math.floor(k / L) * per + before) % list.length;
    return { charity: list[pos], track, pos, k };
  }
  function intervalMs(cfg) { return Math.max(60, Number(cfg.rotation && cfg.rotation.intervalSeconds) || 1800) * 1000; }
  /** When turn 0 of a campaign happens: the campaign start, or rotation.startsAt (your launch time) if that is later.
      Setting startsAt at launch makes each line start from the top instead of partway through. */
  function anchorMs(cfg, campaign) {
    const s = cfg.rotation && cfg.rotation.startsAt;
    const ms = s ? zonedToUtc(s, (cfg.schedule && cfg.schedule.timezone) || 'UTC') : NaN;
    const base = isFinite(ms) ? Math.max(campaign.startMs, ms) : campaign.startMs;
    // "Skip to next" in the admin moves this campaign's turns earlier by the time that was left
    const sh = cfg.rotation && cfg.rotation.shifts && Number(cfg.rotation.shifts[campaign.id]);
    return sh > 0 ? base - sh * 1000 : base;
  }
  /** For the payout worker and previews: who gets turn k, and when it starts. */
  function turnAt(cfg, campaign, k, opts) {
    const t = tracksFor(cfg, (opts && opts.queue) || queueFor(cfg, campaign.id), opts);
    const turn = pickTurn(t, k);
    const startMs = anchorMs(cfg, campaign) + k * intervalMs(cfg);
    return turn && startMs < campaign.endMs ? Object.assign(turn, { startMs }) : null;
  }
  function turnIndexAt(cfg, campaign, ms) {
    const a = anchorMs(cfg, campaign);
    if (ms < a || ms >= campaign.endMs) return -1;
    return Math.floor((ms - a) / intervalMs(cfg));
  }
  function rotation(cfg, campaign, now, opts) {
    opts = opts || {};
    const interval = intervalMs(cfg);
    const all = opts.queue || queueFor(cfg, campaign.id);
    const tracks = tracksFor(cfg, all, opts);
    const eligible = tracks.now.concat(tracks.line);
    const paused = !!(cfg.rotation && cfg.rotation.paused);
    const base = { interval, all, eligible, tracks, mode: rotationMode(cfg), paused, campaign };
    const at = k => pickTurn(tracks, k);
    const who = t => (t ? t.charity : null);
    const anchor = anchorMs(cfg, campaign);
    base.anchorMs = anchor;
    if (now >= campaign.endMs) return Object.assign(base, { state: 'ended', current: null, next: null, upNext: null });
    if (now < anchor) {
      const t0 = at(0), t1 = at(1);
      return Object.assign(base, { state: 'scheduled', nextHandoffMs: anchor, current: null, currentTurn: null,
        next: who(t0), nextTurn: t0, upNext: who(t1), upNextTurn: t1, slot: -1, round: 0 });
    }
    const slot = Math.floor((now - anchor) / interval);
    const slotStartMs = anchor + slot * interval;
    const nextAt = slotStartMs + interval;
    const tc = at(slot), tn = at(slot + 1), tu = at(slot + 2);
    return Object.assign(base, {
      state: paused ? 'paused' : eligible.length ? 'running' : 'waiting',
      slot, round: slot + 1, slotStartMs,
      nextHandoffMs: nextAt < campaign.endMs ? nextAt : null,
      current: who(tc), currentTurn: tc, next: who(tn), nextTurn: tn, upNext: who(tu), upNextTurn: tu
    });
  }
  /** What happened in the current round, judged only from on-chain records. */
  function roundStatus(cfg, rot, donations, now, walletSol) {
    if (!rot || rot.state !== 'running' || !rot.current) return null;
    const grace = (Number(cfg.rotation && cfg.rotation.graceSeconds) || 120) * 1000;
    const from = rot.slotStartMs - 60000;
    const to = rot.slotStartMs + rot.interval;
    const hit = (donations || []).find(d => {
      const t = d.blockTime ? d.blockTime * 1000 : now;
      return d.charityId === rot.current.id && t >= from && t < to;
    });
    if (hit) return { kind: hit.status, donation: hit };
    if (now - rot.slotStartMs < grace) return { kind: 'awaiting' };
    const min = Number(cfg.rotation && cfg.rotation.minHandoffSol) || 0;
    if (walletSol != null && walletSol < min) return { kind: 'skipped-low' };
    return { kind: 'none' };
  }

  /* ---------- formatting ---------- */
  function fmtNum(x, dp) {
    return Number(x || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function solDp(x) { x = Math.abs(x); return x >= 1000 ? 1 : x >= 100 ? 2 : x >= 1 ? 3 : x >= 0.001 ? 4 : 6; }
  function fmtSol(x) { x = Number(x || 0); return (x === 0 ? '0' : fmtNum(x, solDp(x))) + ' SOL'; }
  function fmtUsdc(x) { return fmtNum(x, 2) + ' USDC'; }
  function fmtAmt(a) {
    const s = (a && a.sol) || 0, u = (a && a.usdc) || 0;
    if (s && u) return fmtSol(s) + ' + ' + fmtUsdc(u);
    if (u) return fmtUsdc(u);
    return fmtSol(s);
  }
  function fmtUsd(x) { x = Number(x || 0); return '$' + fmtNum(x, x >= 1000 ? 0 : 2); }
  function shortAddr(a, n) { n = n || 4; return a ? a.slice(0, n) + '…' + a.slice(-n) : ''; }
  function splitDuration(ms) {
    ms = Math.max(0, ms);
    const s = Math.floor(ms / 1000);
    return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtClock(ms) { const p = splitDuration(ms); return (p.d * 24 + p.h ? pad2(p.d * 24 + p.h) + ':' : '') + pad2(p.m) + ':' + pad2(p.s); }
  function fmtDateTime(ms, tz) {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);
  }
  function fmtTime(ms, tz) {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(ms);
  }
  function fmtDay(ms, tz, withYear) {
    const o = { timeZone: tz, month: 'short', day: 'numeric' };
    if (withYear) o.year = 'numeric';
    return new Intl.DateTimeFormat('en-US', o).format(ms);
  }
  /** inclusive date range for a campaign, e.g. "Nov 23 – 26" or "Nov 27 – Dec 25" */
  function fmtRange(c, tz) {
    const a = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).formatToParts(c.startMs);
    const b = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).formatToParts(c.endMs - 1);
    const g = (p, t) => (p.find(x => x.type === t) || {}).value;
    if (g(a, 'month') === g(b, 'month')) return g(a, 'month') + ' ' + g(a, 'day') + ' – ' + g(b, 'day');
    return g(a, 'month') + ' ' + g(a, 'day') + ' – ' + g(b, 'month') + ' ' + g(b, 'day');
  }
  function tzAbbr(tz, ms) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(ms || Date.now());
    return (p.find(x => x.type === 'timeZoneName') || {}).value || tz;
  }
  function relTime(ms, now) {
    const s = Math.round((now - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- explorer links ---------- */
  function explorer(cfg) { return ((cfg.chain && cfg.chain.explorer) || 'https://solscan.io').replace(/\/$/, ''); }
  function txUrl(cfg, sig) { return explorer(cfg) + '/tx/' + encodeURIComponent(sig); }
  function accountUrl(cfg, a) { return explorer(cfg) + '/account/' + encodeURIComponent(a); }
  function tokenUrl(cfg, a) { return explorer(cfg) + '/token/' + encodeURIComponent(a); }

  return {
    b58decode, isSolAddress, isConfigId, zonedToUtc, isValidTz, tzOffsetMs,
    campaigns, campaignAt, campaignById, campaignForTime,
    charity, hasRoute, signedUp, payoutReady, lineReady, effectiveStatus, queueFor, placeOf,
    rotationMode, tracksFor, pickTurn, intervalMs, anchorMs, turnAt, turnIndexAt, rotation, roundStatus,
    fmtNum, fmtSol, fmtUsdc, fmtAmt, fmtUsd, shortAddr, splitDuration, pad2, fmtClock,
    fmtDateTime, fmtTime, fmtDay, fmtRange, tzAbbr, relTime, esc,
    txUrl, accountUrl, tokenUrl
  };
})();
if (typeof module === 'object' && module.exports) module.exports = HopeCore;
