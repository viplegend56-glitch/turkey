// Creator fees (api/fees.js). Addresses and account bytes below were read from Solana mainnet
// on 2026-11-24, so the address math and the account layouts are checked against the real thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  findPda, isOnCurve, feeAccounts, parseBondingCurve, parseSharingConfig, claimedIn, readCreatorFees, b58encode,
  PUMP_PROGRAM, PUMP_FEES_PROGRAM
} from '../api/fees.js';
import { b58decode, WSOL_MINT } from '../api/_lib.js';

const STARECAT = 'H326JWMHo1iUSzFVy6pRJG1JpZZTt6cqtfczFfXVpump';
const STARECAT_CURVE_HEX = '17b7f83760d8ac6063f00e51909d0300a7e05c5d070000006358fc04ff9e0200a7343961000000000080c6a47e8d030000a324389468103f0fdd48c1b75c8a22a0274fcedeee14bad97289c40785a04163000000000000000000';
const FIONA = 'B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump';
const FIONA_SHARING = 'GReWRrUR5ydD5fRDr1a45CoSUry3NzqA9d3kGuwH7Pwy';
const FIONA_SHARING_HEX = ('d84a0900388c5d4bff0201951c4f7a0d599471471fdf2e296000f9332b670fb5f242ef92108c4f271583ef11a065be1732a0bcf333e595ea4b785453dc920d4b8f8e243a6aa0cc939e357901010000001b35a83c2bb153951ea0ef07a0a2e696c9cf3fd2cef5e5aec04779459203aba31027').padEnd(2048, '0');
const WALLET_CREATOR = '9tH2zRYdS3X7PEcsPno3GST1EHe8GX8CSNih1pKpamAp';
const hexB64 = h => Buffer.from(h, 'hex').toString('base64');

test('program addresses match the ones on Solana', () => {
  assert.equal(findPda([Buffer.from('global')], PUMP_PROGRAM), '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(findPda([Buffer.from('__event_authority')], PUMP_PROGRAM), 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  assert.equal(feeAccounts(STARECAT).bondingCurve, 'AWVxiKTMkGK9ngTtDGfcU6SmYfm73ZrrKwJyY8kdtAKQ');
  // A wallet creator's vaults, and a fee-sharing creator's vaults: all four exist on chain.
  const w = feeAccounts(FIONA, WALLET_CREATOR);
  assert.equal(w.pumpVault, '5u2P92TCZ7p5SSzDjpWorMxNzkimE8U1ZUrZvpZTHjs5');
  assert.equal(w.ammVault, 'AdJaQX5X7Enj4BmeWUy13Vdo8t8kTXhMMSf6jG9fseeP');
  const s = feeAccounts(FIONA, FIONA_SHARING);
  assert.equal(s.pumpVault, 'A5Kh7JQViQS7PuM3HRKCBTo9Y8qxgfBRAYAmaKV5mwru');
  assert.equal(s.ammVault, '6Da5wbWJHqwQiRD1SF29yufW88aRnoGiPwCu3qfNx2T');
});

test('the curve check: real keys are on it, program addresses are not, random bytes are half and half', () => {
  for (let i = 0; i < 50; i++) {
    const raw = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    assert.equal(isOnCurve(raw), true);
  }
  for (const a of ['AWVxiKTMkGK9ngTtDGfcU6SmYfm73ZrrKwJyY8kdtAKQ', FIONA_SHARING, '6Da5wbWJHqwQiRD1SF29yufW88aRnoGiPwCu3qfNx2T']) assert.equal(isOnCurve(b58decode(a)), false, a);
  let on = 0;
  for (let i = 0; i < 1000; i++) if (isOnCurve(crypto.randomBytes(32))) on++;
  assert.ok(on > 400 && on < 600, on + ' of 1000');
});

test('reads the creator from a bonding curve, and shareholders from a fee-sharing account', () => {
  assert.deepEqual(parseBondingCurve(hexB64(STARECAT_CURVE_HEX)), { complete: false, creator: 'ByqVMGcNVRf8Cwt69wCPuqeKG5qipkTS8WCvu8PV4c4J' });
  assert.equal(parseBondingCurve(hexB64('00'.repeat(40))), null);
  assert.deepEqual(parseSharingConfig(hexB64(FIONA_SHARING_HEX)), { mint: FIONA, shareholders: [{ address: '2qDTptTY7p4N95aANTSNgxQk51p5qmxoAJDnCh8TyggJ', bps: 10000 }] });
  assert.equal(parseSharingConfig(hexB64('00'.repeat(200))), null);
});

/* ------------------------------------------------------------------ a fake chain */
const key = n => b58encode(Uint8Array.from({ length: 32 }, (_, i) => (n * 37 + i * 11 + 3) % 256));
function walletKey(seed) { return b58encode(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)); }
function curveB64(creator, complete) {
  const b = Buffer.alloc(150);
  Buffer.from('17b7f83760d8ac60', 'hex').copy(b, 0);
  b[48] = complete ? 1 : 0;
  Buffer.from(b58decode(creator)).copy(b, 49);
  return b.toString('base64');
}
/** A transaction that changes the two vaults by these amounts (lamports). */
function tx(v, { pump = 0, amm = 0, err = null, blockTime = 1_795_500_000 } = {}) {
  const keys = [{ pubkey: key(99), signer: true }, { pubkey: v.pumpVault }, { pubkey: v.ammVault }];
  const ammPre = 5_000_000_000, pumpPre = 3_000_000_000;
  return {
    blockTime,
    meta: {
      err, fee: 5000,
      preBalances: [1e9, pumpPre, 2_039_280], postBalances: [1e9, pumpPre + pump, 2_039_280],
      preTokenBalances: [{ accountIndex: 2, mint: WSOL_MINT, uiTokenAmount: { amount: String(ammPre), decimals: 9 } }],
      postTokenBalances: [{ accountIndex: 2, mint: WSOL_MINT, uiTokenAmount: { amount: String(ammPre + amm), decimals: 9 } }]
    },
    transaction: { message: { accountKeys: keys } }
  };
}

test('only money taken out of the vaults counts as claimed', () => {
  const v = feeAccounts(FIONA, WALLET_CREATOR);
  assert.equal(claimedIn(tx(v, { pump: -2_000_000_000 }), v), 2_000_000_000, 'claim on the bonding curve');
  assert.equal(claimedIn(tx(v, { amm: -1_500_000_000 }), v), 1_500_000_000, 'claim after graduation');
  assert.equal(claimedIn(tx(v, { amm: -1_000_000_000, pump: 1_000_000_000 }), v), 0, 'a sweep between the vaults');
  assert.equal(claimedIn(tx(v, { amm: -1_000_000_000, pump: 400_000_000 }), v), 600_000_000, 'sweep, then pay out part');
  assert.equal(claimedIn(tx(v, { pump: 12_345 }), v), 0, 'a trade paying a fee in');
  assert.equal(claimedIn(tx(v, { pump: -2_000_000_000, err: { InstructionError: [0, 'x'] } }), v), 0, 'a failed transaction');
});

function fakeRpc({ mint, creator, complete = true, owner = PUMP_PROGRAM, creatorAcct = null, pumpLamports = 650_240, ammAmount = 0, history = {}, scanFor = null }) {
  const v = feeAccounts(mint, creator);
  const calls = { tx: 0, sigs: [] };
  const rpc = {
    calls,
    async call(method, params) {
      if (method === 'getAccountInfo') return { value: params[0] === v.bondingCurve ? { owner, data: [curveB64(creator, complete), 'base64'], lamports: 1 } : null };
      if (method === 'getMinimumBalanceForRentExemption') return 650_240;
      if (method === 'getMultipleAccounts') {
        assert.deepEqual(params[0], [creator, v.pumpVault, v.ammVault]);
        return { value: [creatorAcct, { owner: '11111111111111111111111111111111', lamports: pumpLamports, data: ['', 'base64'] }, ammAmount ? { owner: 'Tokenkeg', lamports: ammAmount + 2_039_280, data: { parsed: { info: { tokenAmount: { amount: String(ammAmount) } } } } } : null] };
      }
      if (method === 'getSignaturesForAddress') {
        calls.sigs.push(params[0]);
        if (scanFor) assert.ok(scanFor.includes(params[0]), 'scans ' + params[0]);
        return Object.entries(history).map(([signature, t], i) => ({ signature, err: null, blockTime: 1_795_500_000 - i, confirmationStatus: 'finalized' }));
      }
      throw new Error('unexpected ' + method);
    },
    async batch(method, list) {
      assert.equal(method, 'getTransaction');
      calls.tx += list.length;
      return list.map(([sig]) => ({ result: history[sig] }));
    }
  };
  return { rpc, v };
}

test('a wallet creator: what is left in the vaults plus every claim, and claims are not read twice', async () => {
  const creator = walletKey();
  const v = feeAccounts(FIONA, creator);
  const history = { a: tx(v, { amm: -7_086_251_955 }), b: tx(v, { amm: -14_785_171_922 }), c: tx(v, { pump: 5_000 }), d: tx(v, {}) };
  const { rpc } = fakeRpc({ mint: FIONA, creator, pumpLamports: 650_240 + 250_000_000, ammAmount: 1_444_559_899, history, scanFor: [creator] });
  const cache = new Map();
  const f = await readCreatorFees({ mint: FIONA, rpc, cache });
  assert.equal(f.status, 'live');
  assert.equal(f.mode, 'wallet');
  assert.equal(f.creator, creator);
  assert.equal(f.graduated, true);
  assert.equal(f.unclaimedSol, 1.694559899);
  assert.equal(f.claimedSol, 21.871423877);
  assert.equal(f.earnedSol, 23.565983776);
  assert.equal(f.claims.length, 2);
  assert.equal(rpc.calls.tx, 4);
  const again = await readCreatorFees({ mint: FIONA, rpc, cache });
  assert.equal(rpc.calls.tx, 4, 'finalized transactions come from the cache');
  assert.equal(again.earnedSol, f.earnedSol);
});

test('fee sharing: payouts are found in the shareholders\' history', async () => {
  const v = feeAccounts(FIONA, FIONA_SHARING);
  const history = { p1: tx(v, { amm: -20_922_488_983, pump: 0 }), p2: tx(v, { amm: -1_000_000_000, pump: 1_000_000_000 }) };
  const creatorAcct = { owner: PUMP_FEES_PROGRAM, lamports: 5_852_160, data: [hexB64(FIONA_SHARING_HEX), 'base64'] };
  const { rpc } = fakeRpc({ mint: FIONA, creator: FIONA_SHARING, creatorAcct, ammAmount: 11_006_241_157, history, scanFor: ['2qDTptTY7p4N95aANTSNgxQk51p5qmxoAJDnCh8TyggJ'] });
  const f = await readCreatorFees({ mint: FIONA, rpc });
  assert.equal(f.status, 'live');
  assert.equal(f.mode, 'sharing');
  assert.equal(f.claimedSol, 20.922488983);
  assert.equal(f.unclaimedSol, 11.006241157);
  assert.equal(f.earnedSol, 31.92873014);
});

test('a contract that is not a pump.fun coin, or a creator the counter can\'t read, says so', async () => {
  const notPump = await readCreatorFees({ mint: FIONA, rpc: { call: async () => ({ value: null }) } });
  assert.equal(notPump.status, 'not_pump');
  assert.match(notPump.reason, /not a pump\.fun coin/);
  const { rpc } = fakeRpc({ mint: STARECAT, creator: 'ByqVMGcNVRf8Cwt69wCPuqeKG5qipkTS8WCvu8PV4c4J', complete: false, creatorAcct: { owner: '11111111111111111111111111111111', lamports: 650_242, data: ['', 'base64'] } });
  const odd = await readCreatorFees({ mint: STARECAT, rpc });
  assert.equal(odd.status, 'unsupported');
});
