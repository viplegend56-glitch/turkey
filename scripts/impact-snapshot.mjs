// Updates docs/impact.json, the numbers behind the site's counter. GitHub Actions runs it every 15 minutes
// (.github/workflows/impact.yml); you can also run it by hand with `node scripts/impact-snapshot.mjs`.
//
// Two readings, both from Solana:
//   fees    once the contract address is set: every creator fee the coin has earned on pump.fun, claimed or
//           not (api/fees.js). The site's big number is this, in dollars at the SOL price of the run.
//   wallet  once the donation wallet is set: gifts sent from it through donate.gg's relay (api/impact.js).
//
// Environment (repository secrets, never in the page):
//   HOPE_RPC_URL     Solana RPC URL with your provider key. Optional: without it a public endpoint is used,
//                    slowly and politely.
//   DONATE_API_KEY   optional donate.gg key, as in api/impact.js.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildImpact } from '../api/impact.js';
import { readCreatorFees } from '../api/fees.js';
import { rpcClient, isSolAddress } from '../api/_lib.js';

export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
// Tried in order; the first that answers is used. Solana's own endpoint refuses some networks.
export const PUBLIC_RPCS = [PUBLIC_RPC, 'https://solana-rpc.publicnode.com'];
const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const REWRITE_MS = 2 * 60 * 60 * 1000; // rewrite at least this often so the price and "updated" time stay fresh
const PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One run. Returns { written, out }. `dir` is the repo folder, ending in a slash. */
export async function snapshot({ dir, rpc, fetchImpl = fetch, now = Date.now(), env = process.env, log = () => {} }) {
  const read = (p, fallback) => { try { return JSON.parse(fs.readFileSync(dir + p, 'utf8')); } catch { return fallback; } };
  const cfg = read('docs/hope.config.json', null);
  if (!cfg || !Array.isArray(cfg.charities)) throw new Error('docs/hope.config.json is missing or not a HOPE config');
  const prev = read('docs/impact.json', null);
  const wallet = (env.HOPE_DONATION_WALLET || cfg.project?.donationWallet || '').trim();
  const mint = String(cfg.project?.contractAddress || '').trim();
  const maxSignatures = Math.max(100, Math.min(20_000, Number(cfg.data?.maxSignatures) || 3000));
  const stamp = new Date(now).toISOString();

  // Creator fees. Finalized transactions never change, so they are kept between runs and only new ones are read.
  let fees = null;
  if (isSolAddress(mint)) {
    const saved = read('data/fee-cache.json', {});
    const cache = new Map(saved.mint === mint ? Object.entries(saved.entries || {}) : []);
    try {
      fees = await readCreatorFees({ mint, rpc, cache, maxSignatures, budgetMs: 4 * 60_000 });
      fs.mkdirSync(dir + 'data', { recursive: true });
      fs.writeFileSync(dir + 'data/fee-cache.json', JSON.stringify({ mint, entries: Object.fromEntries(cache) }));
    } catch (e) {
      log('Creator fees could not be read: ' + e.message);
      const last = prev && prev.fees;
      fees = last && last.mint === mint && last.status === 'live'
        ? Object.assign({}, last, { stale: true })
        : { status: 'error', mint, reason: 'Solana could not be read just now. The next update tries again.' };
    }
  }

  let out;
  if (isSolAddress(wallet)) {
    const saved = read('data/tx-cache.json', {});
    const cache = new Map(saved.wallet === wallet ? Object.entries(saved.entries || {}) : []);
    out = await buildImpact({ cfg, wallet, rpc, donateKey: env.DONATE_API_KEY, now, fetchImpl, cache, budgetMs: 8 * 60_000, routeBudgetMs: 30_000 });
    fs.mkdirSync(dir + 'data', { recursive: true });
    fs.writeFileSync(dir + 'data/tx-cache.json', JSON.stringify({ wallet, entries: Object.fromEntries(cache) }));
  } else if (fees && fees.status === 'live') {
    out = { status: 'live', generatedAt: stamp };
  } else {
    out = { status: 'not_configured', reason: fees ? fees.reason : 'The contract address has not been published yet.', generatedAt: stamp };
  }
  if (fees) out.fees = fees;
  if (out.status === 'live') out.prices = await solPrice({ fetchImpl, now, prev: prev && prev.prices });

  const same = prev && JSON.stringify(withoutClock(prev)) === JSON.stringify(withoutClock(out));
  const recent = prev && Date.parse(prev.generatedAt) > now - REWRITE_MS;
  if (same && recent) { log('No change since ' + prev.generatedAt + '.'); return { written: false, out: prev }; }
  fs.writeFileSync(dir + 'docs/impact.json', JSON.stringify(out));
  // If GitHub Pages publishes the main folder instead of docs, the page looks for the file there.
  if (fs.existsSync(dir + 'index.html')) fs.writeFileSync(dir + 'impact.json', JSON.stringify(out));
  log('Wrote docs/impact.json: ' + out.status + (out.fees && out.fees.status === 'live' ? ', ' + out.fees.earnedSol + ' SOL in creator fees' : out.fees ? ', fees: ' + out.fees.status : '') + (out.totals ? ', ' + out.totals.settled.count + ' gifts settled' : '') + '.');
  return { written: true, out };
}

// The run time and the SOL price change every run; they alone are not worth a new commit.
function withoutClock(o) {
  const c = { ...o };
  delete c.generatedAt;
  delete c.prices;
  return c;
}

async function solPrice({ fetchImpl, now, prev }) {
  try {
    const r = await fetchImpl(PRICE_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const usd = Number((await r.json())?.solana?.usd);
      if (usd > 0) return { solUsd: usd, source: 'CoinGecko', at: new Date(now).toISOString() };
    }
  } catch { /* keep the last known price below */ }
  if (prev && prev.solUsd > 0 && Date.parse(prev.at) > now - PRICE_MAX_AGE_MS) return prev;
  return null;
}

/** The public RPC allows about 100 requests per 10 seconds: go one at a time and back off when told to. */
export function politeFetch(fetchImpl = fetch, { gapMs = 150, tries = 6 } = {}) {
  let queue = Promise.resolve();
  const turn = () => (queue = queue.then(() => new Promise(r => setTimeout(r, gapMs)))); // one request per gap, in order
  return async (url, opts) => {
    for (let attempt = 0; ; attempt++) {
      await turn();
      const res = await fetchImpl(url, opts);
      if ((res.status !== 429 && res.status < 500) || attempt >= tries - 1) return res;
      const after = Number(res.headers.get('retry-after'));
      await new Promise(r => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt));
    }
  };
}

/** The first public endpoint that answers. */
export async function pickPublicRpc({ fetchImpl = fetch, urls = PUBLIC_RPCS, log = () => {} } = {}) {
  for (const url of urls) {
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }), signal: AbortSignal.timeout(10_000) });
      const j = r.ok ? await r.json() : null;
      if (j && Number.isFinite(j.result)) return url;
      log(url + ' did not answer (HTTP ' + r.status + ').');
    } catch (e) { log(url + ' did not answer (' + e.message + ').'); }
  }
  return urls[urls.length - 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  const own = (process.env.HOPE_RPC_URL || '').trim();
  (async () => {
    const polite = politeFetch();
    const rpc = own ? rpcClient(own, { batchSize: 100 }) : rpcClient(await pickPublicRpc({ fetchImpl: polite, log: console.log }), { fetchImpl: polite, batchSize: 1 });
    await snapshot({ dir, rpc, log: console.log });
  })().catch(e => { console.error(e); process.exit(1); });
}
