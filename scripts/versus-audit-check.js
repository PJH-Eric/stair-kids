'use strict';

const assert = require('node:assert/strict');
const Rules = require('../public/js/rules.js');
const Ai = require('../public/js/ai.js');
const { createHub } = require('../lib/rooms.js');

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('✓ ' + name); }
  catch (e) { failed++; console.error('✗ ' + name + ': ' + e.message); }
}

function playingRoom() {
  const hub = createHub({ newSeed: () => 'versus-audit' });
  const room = hub.createRoom({ id: 'A', name: '甲', char: 'yuan' }).room;
  hub.join(room.id, { id: 'B', name: '乙', char: 'mimi' }, 'player');
  hub.setReady(room.id, 'A', true);
  hub.setReady(room.id, 'B', true);
  assert.ok(!hub.start(room.id, 'A').error);
  return { hub, room };
}

check('先下得較深再斷線，仍必須判輸', () => {
  const { hub, room } = playingRoom();
  room.match.players[0].best = 100;
  room.match.players[1].best = 20;
  hub.markDisconnected('A');
  room.match.players[1].alive = false;
  room.match.players[1].hp = 0;
  hub.tick(Rules.STEP_MS);
  assert.equal(room.match.result.winner, 'B');
});

check('已淘汰但暫時領先的人離開，也必須判輸', () => {
  const { hub, room } = playingRoom();
  Object.assign(room.match.players[0], { best: 100, hp: 0, alive: false });
  hub.leave(room.id, 'A');
  Object.assign(room.match.players[1], { best: 20, hp: 0, alive: false });
  hub.tick(Rules.STEP_MS);
  assert.equal(room.match.result.winner, 'B');
});

check('雙方都棄權時判平手，不依深度選勝方', () => {
  const { hub, room } = playingRoom();
  room.match.players[0].best = 100;
  // 保留觀戰者，讓房間可推進到結算以檢查判定。
  hub.join(room.id, { id: 'S', name: '觀眾' }, 'spectator');
  hub.markDisconnected('A');
  hub.markDisconnected('B');
  hub.tick(Rules.STEP_MS);
  assert.equal(room.match.result.draw, true);
  assert.equal(room.match.result.winner, null);
});

check('正常死亡仍依深度與存活時間決勝', () => {
  const { room } = playingRoom();
  const [a, b] = room.match.players;
  Object.assign(a, { best: 100, alive: false, hp: 0, aliveTime: 1 });
  Object.assign(b, { best: 20, alive: false, hp: 0, aliveTime: 2 });
  assert.equal(Rules.endMatch(room.match).winner, 'A');
});

check('對局中出現空位，新加入者只能觀戰', () => {
  const { hub, room } = playingRoom();
  hub.leave(room.id, 'B');
  const joined = hub.join(room.id, { id: 'C', name: '丙' }, 'player');
  assert.equal(joined.role, 'spectator');
  assert.equal(room.match.players.some(p => p.id === 'C'), false);
  assert.equal(hub.setInput(room.id, 'C', { seq: 1, dir: 1 }).ok, false);
});

check('房主不能在對局中踢掉上場玩家', () => {
  const { hub, room } = playingRoom();
  assert.ok(hub.kick(room.id, 'A', 'B').error);
  assert.ok(room.members.has('B'));
});

check('對局尚未結束，不能預先送出看完結算', () => {
  const { hub, room } = playingRoom();
  assert.ok(hub.resultDone(room.id, 'A').error);
  assert.equal(room.members.get('A').resultDone, false);
  hub.resultDone(room.id, 'B');
  for (const p of room.match.players) { p.alive = false; p.hp = 0; }
  hub.tick(Rules.STEP_MS);
  assert.equal(room.phase, 'result');
  assert.ok(room.match.result);
  assert.ok(!hub.resultDone(room.id, 'A').error);
  assert.ok(!hub.resultDone(room.id, 'B').error);
  hub.tick(Rules.STEP_MS);
  assert.equal(room.phase, 'lobby');
  assert.ok(!hub.join(room.id, { id: 'C', name: '丙' }, 'spectator').error);
});

check('等人階段仍可踢人，對局中仍可管理觀戰者', () => {
  const { hub, room } = playingRoom();
  hub.join(room.id, { id: 'S', name: '觀眾' }, 'spectator');
  assert.ok(!hub.kick(room.id, 'A', 'S').error);
  room.phase = 'lobby';
  room.match = null;
  assert.ok(!hub.kick(room.id, 'A', 'B').error);
});

for (const level of ['normal', 'hard']) {
  check(level + ' 電腦站在人頭上時會主動走下來', () => {
    const s = Rules.createMatch({ mode: 'versus', difficulty: 'normal',
      players: [{ id: 'A', kind: 'human' }, { id: 'B', kind: 'ai' }] }, 'head-audit');
    s.phase = 'playing';
    s.countdown = 0;
    s.steps = [{ id: 'floor', kind: 'normal', depth: 4, x0: 0, x1: Rules.C.FIELD_W }];
    s.gen.depth = 1e9;
    Object.assign(s.players[0], { x: 8, y: 4, vy: 0, onStep: 'floor' });
    Object.assign(s.players[1], { x: 8, y: 2, vy: 0, onStep: null, onPlayer: 'A' });
    const brain = Ai.create(level, 'B', 'head-audit');
    const events = [];
    for (let i = 0; i < 90; i++) {
      events.push(...Rules.stepMatch(s, { B: brain.read(s, Rules.STEP) }, Rules.STEP_MS).events);
    }
    assert.ok(events.some(e => e.type === 'land' && e.player === 'B' && e.step === 'floor'),
      '1.5 秒內應走離頭頂並落到安全階梯');
  });
}

console.log(passed + ' 項通過，' + failed + ' 項失敗');
if (failed) process.exitCode = 1;
