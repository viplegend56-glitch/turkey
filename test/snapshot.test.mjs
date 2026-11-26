// The GitHub Actions job behind the donation counter: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, politeFetch } from '../scripts/impact-snapshot.mjs';
import { RELAY_PROGRAM, WSOL_MINT } from '../api/_lib.js';

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
const W = key(1), DEB = key(2), VAULT = key(3), OTHER = key(4), TMP = key(6);
const CONFIG_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const relayData = b58encode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, ...CONFIG_BYTES, 0, 194, 235, 11, 0, 0, 0, 0]));
const acct = (pubkey, signer = false) => ({ pubkey, signer, writable: true });
const T0 = Date.parse('2026-11-27T15:00:00Z');

// A 0.2 SOL gift through the relay, and a 0.5 SOL claim into the wallet.
function gift() {
  const lamports = 200_000_000, fee = 5000, rent = 5_018_160;
  return {
    blockTime: T0 / 1000 - 600,
    meta: {
      err: null, fee,
      preBalances: [10_000_000_000, 0, 0, 0, 1, 0], postBalances: [10_000_000_000 - lamports - fee - rent, 1, 1, 1, 1, 0],
      preTokenBalances: [], postTokenBalances: [{ accountIndex: 3, mint: WSOL_MINT, owner: DEB, uiTokenAmount: { amount: String(lamports), decimals: 9 } }],
      innerInstructions: []
    },
    transaction: { message: { accountKeys: [acct(W, true), acct(key(7)), acct(DEB), acct(VAULT), acct(WSOL_MINT), acct(TMP), acct(RELAY_PROGRAM)], instructions: [{ programId: RELAY_PROGRAM, accounts: [], data: relayData }] } }
  };
}
function claim() {
  const lamports = 500_000_000;
  return {
    blockTime: T0 / 1000 - 900,
    meta: { err: null, fee: 5000, preBalances: [5_000_000_000, 5_000_000_000], postBalances: [5_000_000_000 - lamports - 5000, 5_000_000_000 + lamports], preTokenBalances: [], postTokenBalances: [] },
    transaction: { message: { accountKeys: [acct(OTHER, true), acct(W)], instructions: [{ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer' } }] } }
  };
}

function fakeRpc() {
  const txs = { g1: gift(), c1: claim() };
  const rpc = {
    txCalls: 0,
    async call(method) {
      if (method === 'getSignaturesForAddress') return Object.entries(txs).map(([signature, tx]) => ({ signature, confirmationStatus: 'finalized', err: null, blockTime: tx.blockTime }));
      if (method === 'getBalance') return { value: 300_000_000 };
      if (method === 'getTokenAccountsByOwner') return { value: [] };
      throw new Error('unexpected ' + method);
    },
    async batch(method, list) {
      assert.equal(method, 'getTransaction');
      rpc.txCalls += list.length;
      return list.map(([sig]) => ({ result: txs[sig] }));
    }
  };
  return rpc;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body });
const fakeFetch = price => async url => (String(url).includes('coingecko') ? (price ? json(200, { solana: { usd: price } }) : json(503, {})) : json(404, {}));

function repo({ wallet = W } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hope-snap-')) + path.sep;
  const cfg = JSON.parse(fs.readFileSync(new URL('../hope.config.json', import.meta.url)));
  cfg.project.donationWallet = wallet;
  const ch = cfg.charities.find(c => c.id === 'feeding-america-tampa-bay-inc');
  ch.donate.configId = '0x' + Buffer.from(CONFIG_BYTES).toString('hex');
  fs.mkdirSync(dir + 'docs');
  fs.writeFileSync(dir + 'docs/hope.config.json', JSON.stringify(cfg));
  return dir;
}
const readOut = dir => JSON.parse(fs.readFileSync(dir + 'docs/impact.json', 'utf8'));

test('counts the gift, the claim and the wallet balance, and adds the SOL price', async () => {
  const dir = repo();
  const r = await snapshot({ dir, rpc: fakeRpc(), fetchImpl: fakeFetch(150), now: T0, env: {} });
  assert.equal(r.written, true);
  const out = readOut(dir);
  assert.equal(out.status, 'live');
  assert.equal(out.totals.settled.count, 1);
  assert.equal(out.totals.settled.sol, 0.2);
  assert.equal(out.totals.collected.sol, 0.5);
  assert.equal(out.totals.charitiesSupported, 1);
  assert.equal(out.wallet.sol, 0.3);
  assert.deepEqual(out.prices, { solUsd: 150, source: 'CoinGecko', at: new Date(T0).toISOString() });
  assert.ok(fs.existsSync(dir + 'data/tx-cache.json'));
});

test('a second run reuses saved transactions and skips the commit when nothing changed', async () => {
  const dir = repo();
  await snapshot({ dir, rpc: fakeRpc(), fetchImpl: fakeFetch(150), now: T0, env: {} });
  const rpc = fakeRpc();
  const r = await snapshot({ dir, rpc, fetchImpl: fakeFetch(151), now: T0 + 15 * 60_000, env: {} });
  assert.equal(rpc.txCalls, 0, 'finalized transactions come from data/tx-cache.json');
  assert.equal(r.written, false, 'a new SOL price alone is not a new commit');
  const later = await snapshot({ dir, rpc: fakeRpc(), fetchImpl: fakeFetch(152), now: T0 + 3 * 60 * 60_000, env: {} });
  assert.equal(later.written, true, 'rewritten after two hours so the price stays fresh');
  assert.equal(readOut(dir).prices.solUsd, 152);
});

test('keeps the last price when CoinGecko is down, and drops it once it is a day old', async () => {
  const dir = repo();
  await snapshot({ dir, rpc: fakeRpc(), fetchImpl: fakeFetch(150), now: T0, env: {} });
  await snapshot({ dir, rpc: fakeRpc(), fetchImpl: fakeFetch(null), now: T0 + 3 * 60 * 60_000, env: {} });
  assert.equal(readOut(dir).prices.solUsd, 150);
  await snapshot({ dir, rpc: fakeRpc(), fetchImpl: fakeFetch(null), now: T0 + 30 * 60 * 60_000, env: {} });
  assert.equal(readOut(dir).prices, null);
});

test('a copy goes beside a main-folder index.html, for a site published from the main folder', async () => {
  const dir = repo();
  await snapshot({ dir, rpc: fakeRpc(), fetchImpl: fakeFetch(150), now: T0, env: {} });
  assert.equal(fs.existsSync(dir + 'impact.json'), false, 'no main-folder copy without a main-folder page');
  fs.writeFileSync(dir + 'index.html', '<!doctype html>');
  await snapshot({ dir, rpc: fakeRpc(), fetchImpl: fakeFetch(150), now: T0 + 3 * 60 * 60_000, env: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(dir + 'impact.json', 'utf8')), readOut(dir));
});

test('before launch it writes "not configured" and never calls Solana', async () => {
  const dir = repo({ wallet: '' });
  const rpc = { call: () => { throw new Error('no calls expected'); }, batch: () => { throw new Error('no calls expected'); } };
  await snapshot({ dir, rpc, fetchImpl: fakeFetch(150), now: T0, env: {} });
  const out = readOut(dir);
  assert.equal(out.status, 'not_configured');
  assert.equal(fs.existsSync(dir + 'data/tx-cache.json'), false);
});

test('the polite fetch spaces requests and retries when rate-limited', async () => {
  const seen = [];
  let n = 0;
  const inner = async () => { seen.push(Date.now()); n++; return { status: n === 1 ? 429 : 200, headers: new Headers({ 'retry-after': '0' }) }; };
  const f = politeFetch(inner, { gapMs: 20 });
  const [a, b] = await Promise.all([f('x'), f('y')]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(seen.length, 3);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] - seen[i - 1] >= 15, 'requests are spaced out');
});

/* ------------------------------------------------------------------ creator fees */
import { PUMP_PROGRAM, b58encode as enc58 } from '../api/fees.js';
import { b58decode as dec58 } from '../api/_lib.js';
import crypto from 'node:crypto';
const MINT = 'B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump';
function feeRpc({ fail = false, vaultLamports = 650_240 + 2_500_000_000 } = {}) {
  const creator = enc58(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const curve = Buffer.alloc(150); curve[48] = 0; Buffer.from(dec58(creator)).copy(curve, 49);
  return {
    async call(method) {
      if (fail) throw new Error('RPC getAccountInfo returned HTTP 403');
      if (method === 'getAccountInfo') return { value: { owner: PUMP_PROGRAM, data: [curve.toString('base64'), 'base64'] } };
      if (method === 'getMinimumBalanceForRentExemption') return 650_240;
      if (method === 'getMultipleAccounts') return { value: [null, { lamports: vaultLamports }, null] };
      if (method === 'getSignaturesForAddress') return [];
      throw new Error('unexpected ' + method);
    },
    async batch() { return []; }
  };
}
function repoWithCa() {
  const dir = repo({ wallet: '' });
  const cfg = JSON.parse(fs.readFileSync(dir + 'docs/hope.config.json', 'utf8'));
  cfg.project.contractAddress = MINT;
  fs.writeFileSync(dir + 'docs/hope.config.json', JSON.stringify(cfg));
  return dir;
}

test('with a contract address, the counter gets the creator fees and the SOL price, even without a donation wallet', async () => {
  const dir = repoWithCa();
  const r = await snapshot({ dir, rpc: feeRpc(), fetchImpl: fakeFetch(150), now: T0, env: {} });
  assert.equal(r.written, true);
  const out = readOut(dir);
  assert.equal(out.status, 'live');
  assert.equal(out.fees.status, 'live');
  assert.equal(out.fees.mint, MINT);
  assert.equal(out.fees.earnedSol, 2.5);
  assert.equal(out.prices.solUsd, 150);
  assert.equal(out.totals, undefined, 'no donation wallet, no wallet totals');
  assert.ok(fs.existsSync(dir + 'data/fee-cache.json'));
});

test('when Solana can\'t be read, the last fee reading stays up, marked as stale', async () => {
  const dir = repoWithCa();
  await snapshot({ dir, rpc: feeRpc(), fetchImpl: fakeFetch(150), now: T0, env: {} });
  await snapshot({ dir, rpc: feeRpc({ fail: true }), fetchImpl: fakeFetch(150), now: T0 + 3 * 60 * 60_000, env: {} });
  const out = readOut(dir);
  assert.equal(out.status, 'live');
  assert.equal(out.fees.earnedSol, 2.5);
  assert.equal(out.fees.stale, true);
});

test('a first reading that fails says so instead of showing a number', async () => {
  const dir = repoWithCa();
  await snapshot({ dir, rpc: feeRpc({ fail: true }), fetchImpl: fakeFetch(150), now: T0, env: {} });
  const out = readOut(dir);
  assert.equal(out.status, 'not_configured');
  assert.equal(out.fees.status, 'error');
  assert.match(out.reason, /could not be read/);
});
