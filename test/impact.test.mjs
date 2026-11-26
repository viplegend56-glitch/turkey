// node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTx, zonedToUtc, configIdBytes, campaignList, RELAY_PROGRAM, USDC_MINT, WSOL_MINT } from '../api/_lib.js';
import { buildImpact } from '../api/impact.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of bytes) { if (byte === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
const key = n => b58encode(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7 + 1) % 256));
const W = key(1), DEB = key(2), VAULT = key(3), OTHER = key(4), WALLET_USDC = key(5), TMP = key(6);
const CONFIG_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const CONFIG_ID = b58encode(CONFIG_BYTES);
const relayData = b58encode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, ...CONFIG_BYTES, 0, 194, 235, 11, 0, 0, 0, 0]));
const tokBal = (accountIndex, mint, owner, amount, decimals) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount), decimals } });
const acct = (pubkey, signer = false) => ({ pubkey, signer, writable: true });

function nativeDonation({ err = null } = {}) {
  const lamports = 200_000_000, fee = 5000, rent = 5_018_160;
  return {
    blockTime: Date.parse('2026-11-26T12:00:00Z') / 1000,
    meta: {
      err, fee,
      preBalances: [10_000_000_000, 0, 0, 0, 1, 0],
      postBalances: err ? [10_000_000_000 - fee, 0, 0, 0, 1, 0] : [10_000_000_000 - lamports - fee - rent, 1, 1, 1, 1, 0],
      preTokenBalances: [],
      postTokenBalances: err ? [] : [tokBal(3, WSOL_MINT, DEB, lamports, 9)],
      innerInstructions: []
    },
    transaction: { message: { accountKeys: [acct(W, true), acct(key(7)), acct(DEB), acct(VAULT), acct(WSOL_MINT), acct(TMP), acct(RELAY_PROGRAM)], instructions: [{ programId: RELAY_PROGRAM, accounts: [], data: relayData }] } }
  };
}
function usdcDonation() {
  return {
    blockTime: Date.parse('2026-11-26T12:05:00Z') / 1000,
    meta: {
      err: null, fee: 5000,
      preBalances: [5_000_000_000, 0, 0, 0], postBalances: [5_000_000_000 - 5000, 0, 0, 0],
      preTokenBalances: [tokBal(1, USDC_MINT, W, 50_000_000, 6), tokBal(2, USDC_MINT, DEB, 0, 6)],
      postTokenBalances: [tokBal(1, USDC_MINT, W, 20_000_000, 6), tokBal(2, USDC_MINT, DEB, 30_000_000, 6)],
      innerInstructions: [{ index: 0, instructions: [{ programId: RELAY_PROGRAM, accounts: [], data: relayData }] }]
    },
    transaction: { message: { accountKeys: [acct(W, true), acct(WALLET_USDC), acct(VAULT), acct(USDC_MINT)], instructions: [{ programId: key(9), accounts: [], data: '1' }] } }
  };
}
function transfer(fromIsWallet, sol) {
  const lamports = Math.round(sol * 1e9);
  const keys = fromIsWallet ? [acct(W, true), acct(OTHER)] : [acct(OTHER, true), acct(W)];
  const pre = [5_000_000_000, 5_000_000_000];
  const post = [pre[0] - lamports - 5000, pre[1] + lamports];
  return { blockTime: Date.parse('2026-11-26T11:58:00Z') / 1000, meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { accountKeys: keys, instructions: [{ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer' } }] } } };
}
function swap() {
  return {
    blockTime: Date.parse('2026-11-26T11:59:00Z') / 1000,
    meta: { err: null, fee: 5000, preBalances: [5_000_000_000], postBalances: [4_700_000_000 - 5000], preTokenBalances: [tokBal(1, USDC_MINT, W, 0, 6)], postTokenBalances: [tokBal(1, USDC_MINT, W, 40_000_000, 6)] },
    transaction: { message: { accountKeys: [acct(W, true), acct(WALLET_USDC)], instructions: [] } }
  };
}

test('config IDs decode from base58 and hex to the same bytes', () => {
  const hex = '0x' + Buffer.from(CONFIG_BYTES).toString('hex');
  assert.deepEqual(configIdBytes(CONFIG_ID), CONFIG_BYTES);
  assert.deepEqual(configIdBytes(hex), CONFIG_BYTES);
  assert.equal(configIdBytes('not-an-id'), null);
});

test('native SOL donation through the relay', () => {
  const p = parseTx(nativeDonation(), W);
  assert.equal(p.kind, 'donation');
  assert.equal(p.mint, 'SOL');
  assert.equal(p.amount, 0.2);
  assert.equal(p.networkSol, 0.000005 + 0.00501816);
  assert.deepEqual(p.relayData, [relayData]);
});

test('USDC donation found in an inner instruction', () => {
  const p = parseTx(usdcDonation(), W);
  assert.equal(p.kind, 'donation');
  assert.equal(p.mint, 'USDC');
  assert.equal(p.amount, 30);
  assert.equal(p.networkSol, 0.000005);
});

test('failed donation sends nothing and costs only the fee', () => {
  const p = parseTx(nativeDonation({ err: { InstructionError: [0, 'Custom'] } }), W);
  assert.equal(p.kind, 'donation');
  assert.equal(p.failed, true);
  assert.equal(p.amount, null);
  assert.equal(p.networkSol, 0.000005);
});

test('inflow, outflow and swap are told apart', () => {
  assert.deepEqual(parseTx(transfer(false, 0.3), W), { kind: 'inflow', failed: false, sol: 0.3, usdc: 0 });
  const out = parseTx(transfer(true, 1), W);
  assert.equal(out.kind, 'outflow'); assert.equal(out.sol, 1);
  assert.equal(parseTx(swap(), W).kind, 'swap');
});

test('campaign times follow the configured time zone, including DST', () => {
  assert.equal(new Date(zonedToUtc('2026-11-23T00:00', 'America/New_York')).toISOString(), '2026-11-23T05:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-11-27T00:00', 'America/New_York')).toISOString(), '2026-11-27T05:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-07-04T12:00', 'America/New_York')).toISOString(), '2026-07-04T16:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-11-27T00:00', 'America/Los_Angeles')).toISOString(), '2026-11-27T08:00:00.000Z');
});

test('buildImpact counts only settled donations and separates everything else', async () => {
  const cfg = JSON.parse(readFileSync(new URL('../hope.config.json', import.meta.url)));
  const fa = cfg.charities.find(c => c.id === 'feeding-america-tampa-bay-inc');
  fa.status = 'approved';
  fa.donate.configId = CONFIG_ID;
  let routeCalls = 0;
  const txs = {
    s1: nativeDonation(), s2: usdcDonation(),
    s3: nativeDonation({ err: { InstructionError: [0, 'Custom'] } }),
    s4: transfer(false, 0.5), s5: transfer(true, 0.1), s6: swap(), s7: nativeDonation()
  };
  const sigInfo = [
    { signature: 's7', confirmationStatus: 'confirmed', err: null, blockTime: txs.s7.blockTime },
    { signature: 's1', confirmationStatus: 'finalized', err: null, blockTime: txs.s1.blockTime },
    { signature: 's2', confirmationStatus: 'finalized', err: null, blockTime: txs.s2.blockTime },
    { signature: 's3', confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] }, blockTime: txs.s3.blockTime },
    { signature: 's4', confirmationStatus: 'finalized', err: null, blockTime: txs.s4.blockTime },
    { signature: 's5', confirmationStatus: 'finalized', err: null, blockTime: txs.s5.blockTime },
    { signature: 's6', confirmationStatus: 'finalized', err: null, blockTime: txs.s6.blockTime }
  ];
  const rpc = {
    async call(method) {
      if (method === 'getSignaturesForAddress') return sigInfo;
      if (method === 'getBalance') return { value: 123_000_000 };
      if (method === 'getTokenAccountsByOwner') return { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 4 } } } } } }] };
      throw new Error('unexpected ' + method);
    },
    async batch(method, list) { assert.equal(method, 'getTransaction'); return list.map(([sig]) => ({ result: txs[sig] })); }
  };
  const fetchImpl = async url => {
    assert.match(url, /^https:\/\/api\.donate\.gg\/api\/v1\/configs\//);
    routeCalls++;
    return { ok: true, status: 200, json: async () => ({ id: { hex: '0x', base58: CONFIG_ID }, feeBps: '300', users: [], charities: [{ id: 'c1', name: 'Slice Out Hunger', status: 'ACTIVE_ONBOARDED', isEnabled: true, weight: '1' }] }) };
  };
  const out = await buildImpact({ cfg, wallet: W, rpc, fetchImpl, now: Date.parse('2026-11-26T12:10:00Z'), cache: new Map() });
  assert.equal(out.status, 'live');
  assert.equal(out.totals.settled.count, 2);
  assert.equal(out.totals.settled.sol, 0.2);
  assert.equal(out.totals.settled.usdc, 30);
  assert.equal(out.totals.processing.count, 1);
  assert.equal(out.totals.failed.count, 1);
  assert.equal(out.totals.collected.sol, 0.5);
  assert.equal(out.totals.otherOutflows.count, 1);
  assert.equal(out.totals.conversions, 1);
  assert.equal(out.totals.charitiesSupported, 1);
  assert.equal(out.byCampaign.thanksgiving.count, 2);
  assert.equal(out.recipients['feeding-america-tampa-bay-inc'].route.status, 'ACTIVE_ONBOARDED');
  const d1 = out.donations.find(d => d.signature === 's1');
  assert.equal(d1.charityId, 'feeding-america-tampa-bay-inc');
  assert.equal(d1.campaignId, 'thanksgiving');
  assert.ok(Math.abs(d1.processingFeeEst - 0.006) < 1e-12);
  assert.deepEqual(out.wallet, { address: W, sol: 0.123, usdc: 4 });
  assert.equal(campaignList(cfg).length, 1);
  // Only charities that actually received something are looked up at donate.gg, not the whole line.
  assert.equal(routeCalls, 1);
});
