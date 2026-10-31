'use strict';

const assert = require('node:assert/strict');
const Rules = require('../public/js/rules.js');
const Stairs = require('../public/js/stairs.js');
const Net = require('../public/js/net.js');
const { createHub } = require('../lib/rooms.js');
const C = Rules.C;

function sandbox(count = 1) {
  const s = Rules.createMatch({ difficulty: 'baby',
    players: Array.from({ length: count }, (_, i) => ({ id: 'p' + i })) }, 'flip-test');
  s.phase = 'playing'; s.cameraTop = -20; s.gen.depth = Infinity;
  s.steps = [{ id: 'flip', kind: 'flip', depth: 0, x0: 0, x1: C.FIELD_W }];
  for (const p of s.players) Object.assign(p, { x: 4, y: -0.01, vy: 1, onStep: null });
  if (count > 1) s.players[1].x = 10;
  return s;
}
const tick = s => Rules.stepMatch(s, {}, C.STEP_MS).events;
function advance(s, seconds) {
  const events = [];
  for (let i = 0; i < Math.round(seconds / C.STEP); i++) events.push(...tick(s));
  return events;
}

const s = sandbox(2);
const step = s.steps[0];
const events = tick(s);
assert.equal(events.filter(e => e.type === 'flipReady').length, 1, '兩人共用一次倒數');
assert.equal(step.flipIn, C.FLIP_DELAY);
assert.ok(s.players.every(p => p.onStep === step.id));
advance(s, C.FLIP_DELAY - C.STEP);
assert.ok(step.flipIn > 0, '預告結束前仍可站立');
const flipped = tick(s);
assert.equal(flipped.filter(e => e.type === 'flip').length, 1);
assert.equal(step.flipLeft, C.FLIP_RECOVER);
assert.ok(s.players.every(p => p.onStep === null && p.y > step.depth), '翻轉放下所有站立者');
assert.equal(Rules.resolveLanding([step], 4, -1, 1), null, '翻轉期間不能落地');
advance(s, C.FLIP_RECOVER);
assert.equal(step.flipLeft, 0, '0.5 秒後恢復');
assert.equal(Rules.resolveLanding([step], 4, -1, 1), step);
Object.assign(s.players[0], { x: 4, y: -0.01, vy: 1, onStep: null });
assert.ok(tick(s).some(e => e.type === 'flipReady'), '恢復後可以再次觸發');

const late = sandbox(2);
late.players[1].y = -10;
tick(late);
advance(late, C.FLIP_DELAY / 2);
const remaining = late.steps[0].flipIn;
Object.assign(late.players[1], { y: -0.01, vy: 1 });
tick(late);
assert.ok(Math.abs(late.steps[0].flipIn - (remaining - C.STEP)) < 1e-9,
  '第二位玩家較晚落地不重設倒數');
late.phase = 'over';
const frozen = late.steps[0].flipIn;
tick(late);
assert.equal(late.steps[0].flipIn, frozen, '結算後停止階梯計時');

const left = sandbox();
tick(left);
left.players[0].x = C.FIELD_W;
left.steps[0].x1 = 8;
advance(left, C.FLIP_DELAY);
assert.ok(left.steps[0].flipLeft > 0, '離開階梯不取消倒數');
const replica = JSON.parse(JSON.stringify(left));
replica.gen = { depth: Infinity };
for (let i = 0; i < 120; i++) { tick(left); tick(replica); }
assert.deepEqual(replica.steps, left.steps, '序列化後重演階梯狀態完全一致');
assert.deepEqual(replica.players, left.players, '序列化後重演玩家狀態完全一致');

for (const difficulty of ['baby', 'easy', 'normal', 'hard']) {
  const stairs = Stairs.makeStairs('flip-generation', difficulty, 0, 3000);
  const flips = stairs.filter(st => st.kind === Stairs.KIND.FLIP);
  assert.equal(flips.length > 0, difficulty !== 'baby', difficulty + '：生成範圍正確');
  assert.deepEqual(stairs, Stairs.makeStairs('flip-generation', difficulty, 0, 3000));
  let unsafe = 0, consecutive = 0;
  for (const layer of [...new Set(stairs.map(st => st.layer))]) {
    const row = stairs.filter(st => st.layer === layer);
    unsafe = row.some(st => Stairs.SAFE_KINDS.includes(st.kind)) ? 0 : unsafe + 1;
    consecutive = row.some(st => st.kind === 'flip') ? consecutive + 1 : 0;
    assert.ok(unsafe < Stairs.C.SAFE_WINDOW, '保留安全落點');
    assert.ok(consecutive <= Stairs.C.MAX_SAME_RUN, '翻轉階不連續超過兩層');
    if (row.some(st => st.wide)) assert.ok(row.every(st => st.kind === 'normal'));
  }
}

const hub = createHub({ newSeed: () => 'flip-network' });
const room = hub.createRoom({ id: 'A', name: '甲' }).room;
hub.join(room.id, { id: 'B', name: '乙' }, 'player');
hub.setReady(room.id, 'A', true); hub.setReady(room.id, 'B', true);
hub.start(room.id, 'A');
room.match.steps = [{ id: 'flip', kind: 'flip', depth: 0, x0: 0, x1: 16, flipIn: 0.05 }];
const client = Net.createClient({ send() {}, now: () => 0 });
const receive = full => client.receive({ type: 'snap', snap: JSON.parse(JSON.stringify(hub.snapshot(room, { full }))) });
receive(true);
assert.equal(client.match.steps[0].flipIn, 0.05, '新加入者收到完整倒數');
Object.assign(room.match.steps[0], { flipIn: null, flipLeft: 0.4 });
receive(false);
assert.equal(client.match.steps[0].flipLeft, 0.4, '增量同步翻轉期間');
Object.assign(client.match.steps[0], { flipIn: 0.1, flipLeft: 0.3 });
Object.assign(room.match.steps[0], { flipIn: null, flipLeft: 0 });
receive(false);
assert.equal(client.match.steps[0].flipIn, null, '完整 dirty 清單清除錯誤預測倒數');
assert.equal(client.match.steps[0].flipLeft, 0, '恢復狀態同步');
console.log('✓ 翻轉階倒數、共同掉落、恢復、重演、生成及快照同步');
