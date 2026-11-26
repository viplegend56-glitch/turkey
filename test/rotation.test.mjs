// node --test test/*.test.mjs
// The rotation rule shared by the site, the admin and the payout worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../lib/hope-core.cjs');
const CFG = JSON.parse(readFileSync(new URL('../hope.config.json', import.meta.url), 'utf8'));

const hex = n => '0x' + n.toString(16).padStart(64, '0');
function makeCfg(charities, mode) {
  return {
    schedule: { timezone: 'America/New_York', campaigns: [{ id: 'c', name: 'Test', start: '2026-11-23T00:00', end: '2026-11-24T00:00' }] },
    rotation: { intervalSeconds: 300, mode },
    charities,
    queues: { c: charities.map(c => c.id) }
  };
}
const ch = (id, signedUp, extra) => Object.assign({ id, name: id, status: 'approved', donate: { configId: hex(id.charCodeAt(0)), signedUp } }, extra);

test('turns alternate between signed-up charities and the long line, each keeping its own place', () => {
  const cfg = makeCfg([ch('a', true), ch('b', false), ch('c', false), ch('d', true), ch('e', false)], 'alternate');
  const camp = C.campaigns(cfg)[0];
  const seq = Array.from({ length: 12 }, (_, k) => C.turnAt(cfg, camp, k).charity.id + ':' + C.turnAt(cfg, camp, k).track);
  assert.deepEqual(seq, ['a:now', 'b:line', 'd:now', 'c:line', 'a:now', 'e:line', 'd:now', 'b:line', 'a:now', 'c:line', 'd:now', 'e:line']);
});

test('signed-up-only mode never uses the long line', () => {
  const cfg = makeCfg([ch('a', true), ch('b', false), ch('d', true)], 'signed-up-only');
  const camp = C.campaigns(cfg)[0];
  assert.deepEqual([0, 1, 2, 3].map(k => C.turnAt(cfg, camp, k).charity.id), ['a', 'd', 'a', 'd']);
  assert.equal(C.turnAt(cfg, camp, 1).track, 'now');
});

test('with one empty track every turn uses the other', () => {
  const onlyHeld = makeCfg([ch('b', false), ch('c', false)], 'alternate');
  const camp = C.campaigns(onlyHeld)[0];
  assert.deepEqual([0, 1, 2].map(k => C.turnAt(onlyHeld, camp, k).charity.id), ['b', 'c', 'b']);
  const strictNone = makeCfg([ch('b', false)], 'signed-up-only');
  assert.equal(C.turnAt(strictNone, C.campaigns(strictNone)[0], 0), null);
  assert.equal(C.rotation(strictNone, C.campaigns(strictNone)[0], C.campaigns(strictNone)[0].startMs + 1000).state, 'waiting');
});

test('pending, inactive and route-less charities never get a turn', () => {
  const cfg = makeCfg([ch('a', true), ch('p', true, { status: 'pending' }), ch('i', false, { status: 'inactive' }), ch('n', false, { donate: { configId: null, signedUp: false } }), ch('b', false)], 'alternate');
  const camp = C.campaigns(cfg)[0];
  const ids = new Set(Array.from({ length: 20 }, (_, k) => C.turnAt(cfg, camp, k).charity.id));
  assert.deepEqual([...ids].sort(), ['a', 'b']);
  assert.equal(C.effectiveStatus(cfg.charities[0]), 'ready');
  assert.equal(C.effectiveStatus(cfg.charities[4]), 'held');
  assert.equal(C.effectiveStatus(cfg.charities[1]), 'pending');
  assert.equal(C.effectiveStatus(cfg.charities[2]), 'inactive');
});

test('rotation() reports the same charity as turnAt for the current, next and up-next turns', () => {
  const cfg = makeCfg([ch('a', true), ch('b', false), ch('c', false), ch('d', true)], 'alternate');
  const camp = C.campaigns(cfg)[0];
  const now = camp.startMs + 7 * 300_000 + 42_000;
  const rot = C.rotation(cfg, camp, now);
  assert.equal(rot.state, 'running');
  assert.equal(rot.slot, 7);
  assert.equal(C.turnIndexAt(cfg, camp, now), 7);
  assert.equal(rot.current.id, C.turnAt(cfg, camp, 7).charity.id);
  assert.equal(rot.next.id, C.turnAt(cfg, camp, 8).charity.id);
  assert.equal(rot.upNext.id, C.turnAt(cfg, camp, 9).charity.id);
  assert.equal(rot.currentTurn.track, 'line');
  assert.equal(rot.nextHandoffMs, camp.startMs + 8 * 300_000);
});

test('rotation.startsAt moves turn 0 to the launch time, so the line starts from the top', () => {
  const cfg = makeCfg([ch('a', true), ch('b', false), ch('c', false)], 'alternate');
  cfg.rotation.startsAt = '2026-11-23T10:00';
  const camp = C.campaigns(cfg)[0];
  const launch = C.zonedToUtc('2026-11-23T10:00', 'America/New_York');
  assert.equal(C.anchorMs(cfg, camp), launch);
  assert.equal(C.turnAt(cfg, camp, 0).startMs, launch);
  assert.equal(C.turnAt(cfg, camp, 0).charity.id, 'a');
  assert.equal(C.turnAt(cfg, camp, 1).charity.id, 'b');
  const before = C.rotation(cfg, camp, launch - 60_000);
  assert.equal(before.state, 'scheduled');
  assert.equal(before.nextHandoffMs, launch);
  assert.equal(before.next.id, 'a');
  const after = C.rotation(cfg, camp, launch + 300_000 + 5_000);
  assert.equal(after.state, 'running');
  assert.equal(after.slot, 1);
  assert.equal(after.current.id, 'b');
  // a start time before the campaign changes nothing
  cfg.rotation.startsAt = '2026-11-01T00:00';
  assert.equal(C.anchorMs(cfg, camp), camp.startMs);
});

test('the shipped config: the line is valid and every charity has a unique donation ID', () => {
  const ids = new Set(CFG.charities.map(c => c.id));
  assert.equal(ids.size, CFG.charities.length);
  const cfgIds = new Set(CFG.charities.map(c => c.donate.configId));
  assert.equal(cfgIds.size, CFG.charities.length);
  for (const c of CFG.charities) assert.ok(C.isConfigId(c.donate.configId), c.name);
  for (const camp of C.campaigns(CFG)) {
    const q = CFG.queues[camp.id];
    assert.ok(q.length > 0, camp.id);
    for (const id of q) assert.ok(ids.has(id), id);
    const t = C.tracksFor(CFG, C.queueFor(CFG, camp.id));
    assert.ok(t.now.length > 0 && t.line.length > 0, camp.id + ' has both tracks');
    assert.equal(t.now.length + t.line.length, q.length);
  }
  const tg = C.tracksFor(CFG, C.queueFor(CFG, 'thanksgiving'));
  assert.ok(tg.now.every(c => c.donate.signedUp) && tg.line.every(c => !c.donate.signedUp));
  // owner's requests: 15-minute turns, a food-focused Thanksgiving line of at least 100 charities
  assert.equal(CFG.rotation.intervalSeconds, 900);
  assert.ok(CFG.queues.thanksgiving.length >= 100);
  assert.ok(C.queueFor(CFG, 'thanksgiving').every(c => c.focus.includes('food-security') || c.id === 'the-thanks-giving-foundation'));
});
