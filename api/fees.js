// Creator fees for a pump.fun coin, read straight from Solana.
//
// Every trade of a pump.fun coin pays a creator fee into a vault that belongs to the coin's creator:
//   on the bonding curve  a system account, PDA ["creator-vault", creator] of the Pump program
//   after graduation      a wrapped-SOL account owned by PDA ["creator_vault", creator] of PumpSwap
// The creator claims from those vaults whenever they like. So everything the coin has earned is
//   what is still in the vaults + everything the creator has claimed out of them,
// and the claims are found in the creator wallet's own history (a claim has to be signed by the creator).
//
// With pump.fun's fee sharing turned on, the coin's creator is a sharing account of the Pump Fees program
// instead of a wallet. Fees collect in that account's vaults the same way, and anyone can trigger a payout
// to the shareholders; every payout lists all the shareholders, so their histories hold every payout.
//
// The vaults belong to the creator, not to one coin: if the creator wallet launched other coins, their
// fees land in the same vaults. Launch from a wallet that has launched nothing else.
import crypto from 'node:crypto';
import { b58decode, WSOL_MINT } from './_lib.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const SHARING_DISCRIMINATOR = 'd84a0900388c5d4b';

/* ------------------------------------------------------------------ addresses */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
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

// ed25519: is this 32-byte string the encoding of a point on the curve? Program addresses must not be.
const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y %= P;
  const y2 = y * y % P;
  const u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P;
  const w = u * modpow(v, P - 2n, P) % P;           // x² = u / v
  return w === 0n || modpow(w, (P - 1n) / 2n, P) === 1n; // a square, so x exists
}

const enc = s => (typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s));
const key = a => { const b = b58decode(a); if (!b || b.length !== 32) throw new Error('not an address: ' + a); return Buffer.from(b); };
/** Solana's findProgramAddress: the first bump from 255 down whose hash is off the curve. */
export function findPda(seeds, programId) {
  const prog = key(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump])).update(prog).update('ProgramDerivedAddress');
    const out = h.digest();
    if (!isOnCurve(out)) return b58encode(out);
  }
  throw new Error('no program address found');
}

export function feeAccounts(mint, creator) {
  const bondingCurve = findPda([enc('bonding-curve'), key(mint)], PUMP_PROGRAM);
  if (!creator) return { bondingCurve };
  const pumpVault = findPda([enc('creator-vault'), key(creator)], PUMP_PROGRAM);
  const ammAuthority = findPda([enc('creator_vault'), key(creator)], PUMP_AMM_PROGRAM);
  const ammVault = findPda([key(ammAuthority), key(TOKEN_PROGRAM), key(WSOL_MINT)], ATA_PROGRAM);
  return { bondingCurve, pumpVault, ammAuthority, ammVault };
}

/* ------------------------------------------------------------------ reading */
/** The bonding curve account: [8 discriminator][5 × u64 reserves][bool complete][32 creator]... */
export function parseBondingCurve(dataB64) {
  const b = Buffer.from(dataB64 || '', 'base64');
  if (b.length < 81) return null;
  return { complete: b[48] !== 0, creator: b58encode(b.subarray(49, 81)) };
}

/** A fee-sharing account: [8 discriminator][bump][version][status][32 mint][32 admin][admin revoked][u32 n][n × (32 address, u16 bps)] */
export function parseSharingConfig(dataB64) {
  const b = Buffer.from(dataB64 || '', 'base64');
  if (b.length < 80 || b.subarray(0, 8).toString('hex') !== SHARING_DISCRIMINATOR) return null;
  const n = b.readUInt32LE(76);
  if (n > 64 || b.length < 80 + n * 34) return null;
  const shareholders = [];
  for (let i = 0; i < n; i++) {
    const o = 80 + i * 34;
    shareholders.push({ address: b58encode(b.subarray(o, o + 32)), bps: b.readUInt16LE(o + 32) });
  }
  return { mint: b58encode(b.subarray(11, 43)), shareholders };
}

/** How much a transaction took out of the creator's vaults, in lamports (0 when it put money in or didn't touch them). */
export function claimedIn(tx, { pumpVault, ammVault }) {
  const meta = tx && tx.meta;
  if (!meta || meta.err != null) return 0;
  const keys = ((tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || []).map(k => (typeof k === 'string' ? k : k.pubkey));
  let net = 0n;
  const ip = keys.indexOf(pumpVault);
  if (ip >= 0 && meta.preBalances && meta.postBalances) net += BigInt(meta.postBalances[ip]) - BigInt(meta.preBalances[ip]);
  const ia = keys.indexOf(ammVault);
  if (ia >= 0) {
    const amt = list => { const t = (list || []).find(x => x.accountIndex === ia); return t ? BigInt(t.uiTokenAmount.amount) : 0n; };
    net += amt(meta.postTokenBalances) - amt(meta.preTokenBalances);
  }
  return net < 0n ? Number(-net) : 0;
}

/**
 * Everything a pump.fun coin's creator fees add up to.
 * `cache` maps signature → { c: lamports taken out of the vaults, t: blockTime } for finalized transactions;
 * keep it between runs so only new transactions are read.
 */
export async function readCreatorFees({ mint, rpc, cache = new Map(), maxSignatures = 3000, budgetMs = 120_000 }) {
  const { bondingCurve } = feeAccounts(mint);
  const info = await rpc.call('getAccountInfo', [bondingCurve, { encoding: 'base64', commitment: 'confirmed' }]);
  const acct = info && info.value;
  const curve = acct && acct.owner === PUMP_PROGRAM ? parseBondingCurve(acct.data && acct.data[0]) : null;
  if (!curve) return { status: 'not_pump', mint, reason: 'This contract address is not a pump.fun coin, so its creator fees can\'t be read.' };
  const creator = curve.creator;
  const v = feeAccounts(mint, creator);

  // Who the creator is decides whose history holds the payouts.
  const [rent, accts] = await Promise.all([
    rpc.call('getMinimumBalanceForRentExemption', [0]),
    rpc.call('getMultipleAccounts', [[creator, v.pumpVault, v.ammVault], { encoding: 'jsonParsed', commitment: 'confirmed' }])
  ]);
  const [ca, pv, av] = (accts && accts.value) || [];
  let mode = 'wallet', scan = [creator], shareholders = null;
  if (!isOnCurve(key(creator))) {
    const sc = ca && ca.owner === PUMP_FEES_PROGRAM && Array.isArray(ca.data) ? parseSharingConfig(ca.data[0]) : null;
    if (!sc || sc.mint !== mint || !sc.shareholders.length) {
      return { status: 'unsupported', mint, creator, graduated: curve.complete, reason: 'This coin\'s creator is a program account the counter can\'t read.' };
    }
    mode = 'sharing'; shareholders = sc.shareholders; scan = sc.shareholders.slice(0, 10).map(h => h.address);
  }

  // Still in the vaults. A claim leaves an empty account's rent behind in the bonding-curve vault.
  const keep = Number(rent) > 0 ? Number(rent) : 0;
  const pumpLeft = pv ? Math.max(0, Number(pv.lamports || 0) - keep) : 0;
  const ammLeft = av && av.data && av.data.parsed ? Number(av.data.parsed.info.tokenAmount.amount || 0) : 0;

  // Taken out: every transaction of the creator wallet (or of the shareholders), newest first.
  const sigs = [], seen = new Set();
  let complete = true;
  for (const addr of scan) {
    let before, got = 0;
    for (;;) {
      const limit = Math.min(1000, maxSignatures - got);
      if (limit <= 0) { complete = false; break; }
      const page = await rpc.call('getSignaturesForAddress', [addr, { limit, before, commitment: 'confirmed' }]);
      if (!page || !page.length) break;
      got += page.length;
      for (const s of page) if (!seen.has(s.signature)) { seen.add(s.signature); sigs.push(s); }
      if (page.length < limit) break;
      before = page[page.length - 1].signature;
    }
  }
  sigs.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));
  const fresh = new Map();
  const need = sigs.filter(s => s.err == null && !cache.has(s.signature));
  const deadline = Date.now() + budgetMs;
  for (let i = 0; i < need.length; i += 100) {
    if (Date.now() > deadline) { complete = false; break; }
    const part = need.slice(i, i + 100);
    const results = await rpc.batch('getTransaction', part.map(s => [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]));
    part.forEach((s, k) => {
      const tx = results[k] && results[k].result;
      if (!tx) { complete = false; return; }
      const entry = { c: claimedIn(tx, v), t: tx.blockTime || s.blockTime || null };
      if (s.confirmationStatus === 'finalized') cache.set(s.signature, entry); else fresh.set(s.signature, entry);
    });
  }
  let takenLamports = 0;
  const claims = [];
  for (const s of sigs) {
    const e = cache.get(s.signature) || fresh.get(s.signature);
    if (!e || !e.c) continue;
    takenLamports += e.c;
    claims.push({ signature: s.signature, blockTime: e.t, sol: e.c / 1e9 });
  }
  const r9 = x => Math.round(x * 1e9) / 1e9;
  const unclaimedSol = r9((pumpLeft + ammLeft) / 1e9), claimedSol = r9(takenLamports / 1e9);
  return {
    status: 'live', mint, creator, mode, shareholders, graduated: curve.complete,
    earnedSol: r9(unclaimedSol + claimedSol), claimedSol, unclaimedSol,
    vaults: { pump: v.pumpVault, amm: v.ammVault },
    claims: claims.slice(0, 50),
    scan: { signatures: sigs.length, complete }
  };
}
