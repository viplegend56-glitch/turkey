// GET /api/impact
// Reads the HOPE donation wallet's history on Solana and returns the figures the site shows.
// Environment (server-side only):
//   HOPE_RPC_URL          Solana RPC endpoint with your provider key (required)
//   HOPE_DONATION_WALLET  overrides project.donationWallet in hope.config.json (optional)
//   DONATE_API_KEY        donate.gg API key, enables "reported by donate.gg" totals (optional)
import {
  loadConfig, sendJson, rpcClient, parseTx, getRoute, campaignList,
  isSolAddress, configIdBytes, b58decode, USDC_MINT, RELAY_PROGRAM
} from './_lib.js';

const TX_CACHE = new Map(); // signature -> parsed finalized transaction (survives warm invocations)
const TX_CACHE_MAX = 25_000;

export default async function handler(req, res) {
  try {
    const cfg = await loadConfig();
    const wallet = (process.env.HOPE_DONATION_WALLET || cfg.project?.donationWallet || '').trim();
    if (!isSolAddress(wallet)) return sendJson(res, 200, { status: 'not_configured', reason: 'The donation wallet has not been published yet.' }, 60);
    if (!process.env.HOPE_RPC_URL) return sendJson(res, 200, { status: 'not_configured', reason: 'The data service is still being set up.' }, 60);
    const data = await buildImpact({
      cfg, wallet,
      rpc: rpcClient(process.env.HOPE_RPC_URL),
      donateKey: process.env.DONATE_API_KEY,
      now: Date.now()
    });
    return sendJson(res, 200, data, 20);
  } catch (e) {
    console.error('[impact]', e);
    return sendJson(res, 502, { status: 'error', reason: 'The donation wallet could not be read just now.' }, 5);
  }
}

const toHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

export async function buildImpact({ cfg, wallet, rpc, donateKey, now, fetchImpl = fetch, cache = TX_CACHE, budgetMs = 18_000, routeBudgetMs = 6_000 }) {
  const relayProgram = cfg.chain?.relayProgram || RELAY_PROGRAM;
  const usdcMint = cfg.chain?.usdcMint || USDC_MINT;
  const max = Math.max(100, Math.min(20_000, Number(cfg.data?.maxSignatures) || 3000));

  // 1. Signatures, newest first.
  const sigs = [];
  let before, complete = true;
  for (;;) {
    const limit = Math.min(1000, max - sigs.length);
    const page = await rpc.call('getSignaturesForAddress', [wallet, { limit, before, commitment: 'confirmed' }]);
    if (!page?.length) break;
    sigs.push(...page);
    if (page.length < limit) break;
    if (sigs.length >= max) { complete = false; break; }
    before = page[page.length - 1].signature;
  }

  // 2. Transactions. Finalized ones are cached; recent ones are re-read until final.
  //    Newest first, within a time budget; a warm instance picks up where the last one stopped.
  const fresh = new Map();
  const need = sigs.filter(s => !cache.has(s.signature));
  const deadline = Date.now() + budgetMs;
  for (let i = 0; i < need.length; i += 200) {
    if (Date.now() > deadline) { complete = false; break; }
    const part = need.slice(i, i + 200);
    const results = await rpc.batch('getTransaction', part.map(s => [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]));
    part.forEach((s, k) => {
      const tx = results[k]?.result;
      if (!tx) return;
      const entry = { parsed: parseTx(tx, wallet, { relayProgram, usdcMint }), blockTime: tx.blockTime ?? s.blockTime ?? null };
      if (s.confirmationStatus === 'finalized') {
        if (cache.size >= TX_CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(s.signature, entry);
      } else fresh.set(s.signature, entry);
    });
  }

  // 3. Recipients from config, matched by their donate.gg donation ID (32 bytes) inside the relay instruction.
  //    Indexed by those bytes so a line of hundreds of charities costs one lookup per 32-byte window.
  const recips = (cfg.charities || [])
    .map(c => ({ id: c.id, configId: c.donate?.configId, bytes: configIdBytes(c.donate?.configId) }))
    .filter(r => r.bytes);
  const byBytes = new Map(recips.map(r => [toHex(r.bytes), r]));
  const findRecipient = datas => {
    for (const d of datas) for (let i = 0; i + 32 <= d.length; i++) {
      const r = byBytes.get(toHex(d.subarray(i, i + 32)));
      if (r) return r;
    }
    return null;
  };
  const feeOnFile = new Map((cfg.charities || []).map(c => [c.id, Number(c.donate?.feeBps)]));

  // First pass: which recipients did the wallet actually give to? Only those are looked up at donate.gg,
  // a few at a time and within a time budget (donate.gg rate-limits). The rest use the fee on file.
  const recOf = new Map();
  for (const s of sigs) {
    const e = cache.get(s.signature) || fresh.get(s.signature);
    if (!e || e.parsed.kind !== 'donation') continue;
    const rec = findRecipient((e.parsed.relayData || []).map(b58decode).filter(Boolean));
    recOf.set(s.signature, rec);
  }
  const wanted = [...new Set([...recOf.values()].filter(Boolean))];
  const routes = {};
  const routeDeadline = Date.now() + routeBudgetMs;
  let ri = 0;
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => {
    while (ri < wanted.length && Date.now() < routeDeadline) {
      const r = wanted[ri++];
      routes[r.id] = await getRoute(r.configId, { fetchImpl, donateKey });
    }
  }));

  const campaigns = campaignList(cfg);
  const zero = () => ({ sol: 0, usdc: 0, count: 0 });
  const add = (o, mint, amt) => { if (mint === 'USDC') o.usdc += amt; else if (mint === 'SOL') o.sol += amt; };
  const totals = {
    collected: { sol: 0, usdc: 0 }, settled: zero(), processing: zero(), failed: { count: 0 },
    networkSol: 0, processingFeeEst: { sol: 0, usdc: 0 }, otherOutflows: zero(), conversions: 0,
    unlisted: zero(), charitiesSupported: 0, reportedUsd: null
  };
  const byCampaign = Object.fromEntries(campaigns.map(c => [c.id, zero()]));
  const recipients = {};
  const recFor = id => recipients[id] || (recipients[id] = { settled: zero(), lastSignature: null, lastBlockTime: 0, route: null, reported: null });
  const donations = [], inflows = [];

  for (const s of sigs) {
    const e = cache.get(s.signature) || fresh.get(s.signature);
    if (!e) continue;
    const p = e.parsed;
    const bt = e.blockTime || s.blockTime || null;
    const status = s.err != null || p.failed ? 'failed' : s.confirmationStatus === 'finalized' ? 'settled' : 'processing';
    if (p.kind === 'donation') {
      const rec = recOf.get(s.signature) || null;
      const camp = bt ? campaigns.find(c => bt * 1000 >= c.startMs && bt * 1000 < c.endMs) : null;
      const route = rec ? routes[rec.id] : null;
      const onFile = rec ? feeOnFile.get(rec.id) : NaN;
      const feeBps = route?.ok && Number.isFinite(route.feeBps) ? route.feeBps : Number.isFinite(onFile) ? onFile : null;
      const d = {
        signature: s.signature, blockTime: bt, status,
        charityId: rec ? rec.id : null, campaignId: camp ? camp.id : null,
        mint: p.mint, amount: status === 'failed' ? null : p.amount, networkSol: p.networkSol,
        feeBps, processingFeeEst: null, netEst: null
      };
      totals.networkSol += p.networkSol || 0;
      if (status === 'failed') totals.failed.count++;
      else if (status === 'processing' && p.amount) { add(totals.processing, p.mint, p.amount); totals.processing.count++; }
      else if (status === 'settled' && p.amount) {
        add(totals.settled, p.mint, p.amount); totals.settled.count++;
        if (camp) { add(byCampaign[camp.id], p.mint, p.amount); byCampaign[camp.id].count++; }
        if (feeBps != null) {
          d.processingFeeEst = p.amount * feeBps / 10_000;
          d.netEst = p.amount - d.processingFeeEst;
          add(totals.processingFeeEst, p.mint, d.processingFeeEst);
        }
        if (rec) {
          const r = recFor(rec.id);
          add(r.settled, p.mint, p.amount); r.settled.count++;
          if (bt && bt > r.lastBlockTime) { r.lastBlockTime = bt; r.lastSignature = s.signature; }
        } else { add(totals.unlisted, p.mint, p.amount); totals.unlisted.count++; }
      }
      donations.push(d);
    } else if (p.kind === 'inflow' && status !== 'failed') {
      totals.collected.sol += p.sol || 0;
      totals.collected.usdc += p.usdc || 0;
      inflows.push({ signature: s.signature, blockTime: bt, sol: p.sol || 0, usdc: p.usdc || 0, status });
    } else if (p.kind === 'outflow' && status !== 'failed') {
      totals.otherOutflows.sol += p.sol || 0;
      totals.otherOutflows.usdc += p.usdc || 0;
      totals.otherOutflows.count++;
    } else if (p.kind === 'swap') totals.conversions++;
  }

  // 4. donate.gg route status and reported totals per recipient.
  let reported = 0, anyReported = false;
  for (const r of recips) {
    const route = routes[r.id];
    if (!route) continue;
    const rec = recipients[r.id] || (route.ok ? recFor(r.id) : null);
    if (!rec) continue;
    rec.route = route.ok ? { ok: true, status: route.status, feeBps: route.feeBps, onboarded: route.onboarded } : { ok: false, error: route.error };
    if (route.reported) { rec.reported = route.reported; reported += route.reported.usd; anyReported = true; }
  }
  totals.reportedUsd = anyReported ? reported : null;
  totals.charitiesSupported = Object.values(recipients).filter(r => r.settled.count > 0).length;

  // 5. Current balances.
  const [bal, toks] = await Promise.all([
    rpc.call('getBalance', [wallet, { commitment: 'confirmed' }]),
    rpc.call('getTokenAccountsByOwner', [wallet, { mint: usdcMint }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  ]);
  const usdc = (toks?.value || []).reduce((sum, a) => sum + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);

  // Floating-point tidy-up: lamport precision for SOL, micro-units for USDC.
  const r9 = x => Math.round(x * 1e9) / 1e9, r6 = x => Math.round(x * 1e6) / 1e6;
  const tidy = o => { if (o) { o.sol = r9(o.sol || 0); o.usdc = r6(o.usdc || 0); } };
  [totals.collected, totals.settled, totals.processing, totals.processingFeeEst, totals.otherOutflows, totals.unlisted, ...Object.values(byCampaign), ...Object.values(recipients).map(r => r.settled)].forEach(tidy);
  totals.networkSol = r9(totals.networkSol);
  for (const d of donations) { if (d.processingFeeEst != null) { d.processingFeeEst = r9(d.processingFeeEst); d.netEst = r9(d.netEst); } }

  return {
    status: 'live',
    generatedAt: new Date(now).toISOString(),
    wallet: { address: wallet, sol: (bal?.value ?? 0) / 1e9, usdc },
    scan: { signatures: sigs.length, complete },
    totals, byCampaign, recipients,
    donations: donations.slice(0, 500), donationsTruncated: donations.length > 500,
    inflows: inflows.slice(0, 100)
  };
}
