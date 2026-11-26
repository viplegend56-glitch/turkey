// Generated from api/_lib.js by build.mjs. Do not edit here.
// Shared helpers for the HOPE serverless functions. No dependencies, Node 18 or newer.
// Files in /api that start with an underscore are not deployed as functions.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const RELAY_PROGRAM = 'RLAYHr9TRFcKB2ubYQhspcnXiaGpaVzNQvHytt47RZu'; // donate.gg Donation Relay (Solana)
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const DONATE_API = 'https://api.donate.gg/api/v1';

/* ---------- config ---------- */
let cfgCache = null, cfgAt = 0;
export async function loadConfig() {
  if (cfgCache && Date.now() - cfgAt < 30_000) return cfgCache;
  const file = process.env.HOPE_CONFIG_PATH || path.join(process.cwd(), 'hope.config.json');
  cfgCache = JSON.parse(await readFile(file, 'utf8'));
  cfgAt = Date.now();
  return cfgCache;
}

/* ---------- base58 / ids ---------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(str) {
  if (typeof str !== 'string' || !str) return null;
  const bytes = [];
  for (const ch of str) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === '1') bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}
export function isSolAddress(s) { const b = b58decode(String(s || '').trim()); return !!b && b.length === 32; }
/** donate.gg config IDs come as base58 (a Pubkey) or 0x-prefixed hex; both encode the same 32 bytes. */
export function configIdBytes(id) {
  id = String(id || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(id)) return Uint8Array.from(id.slice(2).match(/../g).map(h => parseInt(h, 16)));
  const b = b58decode(id);
  return b && b.length === 32 ? b : null;
}
export function isConfigId(id) { return !!configIdBytes(id); }
export function containsBytes(hay, needle) {
  if (!hay || !needle || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/* ---------- schedule (same rules as the site) ---------- */
const fmtCache = new Map();
function tzOffsetMs(tz, utcMs) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const p = {};
  for (const part of fmtCache.get(tz).formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
}
export function zonedToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(local || '').trim());
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const off1 = tzOffsetMs(tz, guess);
  let ts = guess - off1;
  const off2 = tzOffsetMs(tz, ts);
  if (off2 !== off1) ts = guess - off2;
  return ts;
}
export function campaignList(cfg) {
  const tz = cfg.schedule?.timezone || 'UTC';
  return (cfg.schedule?.campaigns || [])
    .map(c => ({ ...c, startMs: zonedToUtc(c.start, tz), endMs: zonedToUtc(c.end, tz) }))
    .filter(c => Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/* ---------- HTTP ---------- */
export function sendJson(res, status, body, cacheSeconds) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', cacheSeconds > 0
    ? `public, max-age=10, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 6}`
    : 'no-store');
  res.end(JSON.stringify(body));
}

/* ---------- Solana JSON-RPC ---------- */
function timeout(ms) { return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined; }
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}
export function rpcClient(url, { fetchImpl = fetch, batchSize = 40 } = {}) {
  let seq = 0;
  async function call(method, params) {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: timeout(15_000) });
    if (!res.ok) throw new Error(`RPC ${method} returned HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`RPC ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }
  /** Batched calls. Falls back to single calls if the RPC rejects batches. */
  async function batch(method, paramsList) {
    const out = new Array(paramsList.length);
    for (let i = 0; i < paramsList.length; i += batchSize) {
      const chunk = paramsList.slice(i, i + batchSize);
      let arr = null;
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk.map((p, k) => ({ jsonrpc: '2.0', id: i + k, method, params: p }))), signal: timeout(20_000) });
        if (res.ok) { const j = await res.json(); if (Array.isArray(j)) arr = j; }
      } catch { arr = null; }
      if (arr) for (const r of arr) {
        if (r && Number.isInteger(r.id) && r.id >= i && r.id < i + chunk.length) out[r.id] = r.error ? { error: r.error } : { result: r.result };
      }
      const missing = chunk.map((_, k) => i + k).filter(n => !out[n] || out[n].error);
      await pool(missing, 4, async n => {
        try { out[n] = { result: await call(method, paramsList[n]) }; } catch (e) { out[n] = { error: { message: e.message } }; }
      });
    }
    return out;
  }
  return { call, batch };
}

/* ---------- transaction classification ----------
   Pure function: reads one jsonParsed transaction from the donation wallet's history.
   kind = donation | inflow | outflow | swap | other */
export function parseTx(tx, wallet, { relayProgram = RELAY_PROGRAM, usdcMint = USDC_MINT } = {}) {
  const meta = tx?.meta || {};
  const msg = tx?.transaction?.message || {};
  const keys = (msg.accountKeys || []).map(k => (typeof k === 'string' ? { pubkey: k, signer: false } : k));
  const idx = keys.findIndex(k => k.pubkey === wallet);
  const walletSigner = idx >= 0 && !!keys[idx].signer;
  const walletPaysFee = keys[0]?.pubkey === wallet;
  const feeSol = (meta.fee || 0) / 1e9;
  const failed = meta.err != null;
  const lamportDelta = idx >= 0 && meta.preBalances && meta.postBalances ? meta.postBalances[idx] - meta.preBalances[idx] : 0;

  const tb = new Map();
  for (const b of meta.preTokenBalances || []) tb.set(b.accountIndex, { mint: b.mint, owner: b.owner, pre: BigInt(b.uiTokenAmount.amount), post: 0n, dec: b.uiTokenAmount.decimals });
  for (const b of meta.postTokenBalances || []) {
    const e = tb.get(b.accountIndex) || { mint: b.mint, owner: b.owner, pre: 0n, post: 0n, dec: b.uiTokenAmount.decimals };
    e.post = BigInt(b.uiTokenAmount.amount);
    e.owner = e.owner || b.owner;
    tb.set(b.accountIndex, e);
  }
  const walletTok = {}, othersIn = {};
  for (const e of tb.values()) {
    const d = e.post - e.pre;
    if (d === 0n) continue;
    const amt = Number(d) / 10 ** e.dec;
    if (e.owner === wallet) walletTok[e.mint] = (walletTok[e.mint] || 0) + amt;
    else if (d > 0n) othersIn[e.mint] = (othersIn[e.mint] || 0) + amt;
  }

  const ixs = [...(msg.instructions || [])];
  for (const inner of meta.innerInstructions || []) ixs.push(...(inner.instructions || []));
  const progOf = ix => ix.programId || (Number.isInteger(ix.programIdIndex) ? keys[ix.programIdIndex]?.pubkey : null);
  const relayIx = ixs.filter(ix => progOf(ix) === relayProgram);

  if (relayIx.length && walletSigner) {
    const relayData = relayIx.map(ix => (typeof ix.data === 'string' ? ix.data : null)).filter(Boolean);
    const mints = Object.keys(othersIn);
    const mintKey = mints.includes(usdcMint) ? usdcMint : mints.includes(WSOL_MINT) ? WSOL_MINT : mints[0] || null;
    const amount = failed || !mintKey ? null : othersIn[mintKey];
    const mint = mintKey === usdcMint ? 'USDC' : mintKey === WSOL_MINT ? 'SOL' : mintKey;
    const spentSol = -lamportDelta / 1e9;
    const nativeOut = mint === 'SOL' && amount ? amount : 0;
    const networkSol = failed ? feeSol : Math.max(0, spentSol - nativeOut);
    return { kind: 'donation', failed, relayData, mint, amount, networkSol: round9(networkSol) };
  }
  if (failed) return { kind: 'other', failed: true, networkSol: walletPaysFee ? feeSol : 0 };

  const EPS = 1e-6;
  const sol = lamportDelta / 1e9 + (walletPaysFee ? feeSol : 0) + (walletTok[WSOL_MINT] || 0);
  const usdc = walletTok[usdcMint] || 0;
  const otherMints = Object.keys(walletTok).filter(m => m !== usdcMint && m !== WSOL_MINT);
  const up = [], down = [];
  if (sol > EPS) up.push('SOL'); else if (sol < -EPS) down.push('SOL');
  if (usdc > EPS) up.push('USDC'); else if (usdc < -EPS) down.push('USDC');
  for (const m of otherMints) { if (walletTok[m] > 0) up.push(m); else if (walletTok[m] < 0) down.push(m); }
  if (up.length && down.length) return { kind: 'swap', failed: false };
  if ((up.includes('SOL') || up.includes('USDC')) && !down.length) return { kind: 'inflow', failed: false, sol: round9(Math.max(0, sol)), usdc: Math.max(0, usdc) };
  if ((down.includes('SOL') || down.includes('USDC')) && !up.length) return { kind: 'outflow', failed: false, sol: round9(Math.max(0, -sol)), usdc: Math.max(0, -usdc) };
  return { kind: 'other', failed: false };
}
function round9(x) { return Math.round(x * 1e9) / 1e9; }

/* ---------- donate.gg (only documented endpoints) ----------
   GET {DONATE_API}/configs/{configId}         public: beneficiaries, charity status, stored feeBps
   GET {DONATE_API}/configs/{configId}/stats   needs donate-api-key: usdDonatedE6, donationCount */
const routeCache = new Map();
export async function getRoute(configId, { fetchImpl = fetch, donateKey, fresh = false } = {}) {
  const hit = routeCache.get(configId);
  if (!fresh && hit && Date.now() - hit.at < (hit.value.ok ? 10 * 60_000 : 60_000)) return hit.value;
  const headers = { accept: 'application/json' };
  if (donateKey) headers['donate-api-key'] = donateKey;
  let value;
  try {
    const res = await fetchImpl(`${DONATE_API}/configs/${encodeURIComponent(configId)}`, { headers, signal: timeout(8_000) });
    if (res.status === 404) value = { ok: false, error: 'donate.gg has no config with this ID.' };
    else if (res.status === 409) value = { ok: false, error: 'This config includes campaign beneficiaries. HOPE expects one charity per config.' };
    else if (!res.ok) value = { ok: false, error: `donate.gg did not answer (HTTP ${res.status}). Try again in a minute.` };
    else {
      const j = await res.json();
      const charities = (j.charities || []).map(c => ({ id: c.id, name: c.name, slug: c.slug, status: c.status, isEnabled: c.isEnabled, weight: c.weight, website: c.website, city: c.city, state: c.state, country: c.country }));
      value = {
        ok: true,
        id: j.id,
        feeBps: j.feeBps != null ? Number(j.feeBps) : null,
        charities,
        userBeneficiaries: (j.users || []).length,
        singleCharity: charities.length === 1 && !(j.users || []).length,
        status: charities.length === 1 ? charities[0].status : charities.length ? 'MULTIPLE' : 'NONE',
        onboarded: charities.length > 0 && charities.every(c => c.status === 'ACTIVE_ONBOARDED' && c.isEnabled !== false)
      };
      if (donateKey) {
        try {
          const s = await fetchImpl(`${DONATE_API}/configs/${encodeURIComponent(configId)}/stats`, { headers, signal: timeout(8_000) });
          if (s.ok) { const sj = await s.json(); value.reported = { usd: Number(sj.usdDonatedE6 || 0) / 1e6, count: Number(sj.donationCount || 0) }; }
        } catch { /* stats are optional */ }
      }
    }
  } catch (e) {
    value = { ok: false, error: 'Could not reach donate.gg. Try again in a minute.' };
  }
  routeCache.set(configId, { at: Date.now(), value });
  return value;
}
