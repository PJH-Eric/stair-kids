/* ===== scripts/online-check.js — 房間生命週期驗收 =====
 * 直接測 lib/rooms.js（它完全不碰 socket，所以不用起伺服器）。
 * 執行：node scripts/online-check.js  或  npm run test:online
 */
'use strict';

const { createHub, CONST } = require('../lib/rooms.js');
const Rules = require('../public/js/rules.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}
function group(t) { console.log('\n' + t); }

const person = (id, name) => ({ id: id, name: name || id, char: 'yuan' });

/** 開一間已經在對局中的房，回傳 { hub, room } */
function playingRoom(diff) {
  const hub = createHub();
  const r = hub.createRoom(person('A', '甲'), { difficulty: diff || 'normal' }).room;
  hub.join(r.id, person('B', '乙'), 'player');
  hub.setReady(r.id, 'A', true);
  hub.setReady(r.id, 'B', true);
  hub.start(r.id, 'A');
  return { hub, room: r };
}

/** 推進 n 秒 */
function run(hub, seconds) {
  const steps = Math.round(seconds * CONST.TICK_HZ);
  for (let i = 0; i < steps; i++) hub.tick(1000 / CONST.TICK_HZ);
}

/* ---------------------------------------------------------- */
group('大廳與開房');
{
  const hub = createHub();
  ok(hub.listRooms().length === 0, '一開始沒有房間');
  const a = hub.createRoom(person('A', '甲'), {});
  ok(!a.error && a.role === 'player', '開房的人自己是玩家');
  ok(hub.listRooms().length === 1, '大廳看得到這間房');
  const view = hub.listRooms()[0];
  ok(view.players === 1 && view.seats === 2, '房間列表顯示 1/2 席');
  ok(view.difficultyName === '普通', '預設難度是普通');
  ok(view.phase === 'lobby', '一開始在房間等待狀態');
}
{
  /* 快速加入：有空房就進、沒有就自己開一間等人 */
  const hub = createHub();
  const first = hub.quickJoin(person('A'));
  ok(!first.error, '第一個人快速加入 → 自己開一間');
  const second = hub.quickJoin(person('B'));
  ok(second.room.id === first.room.id, '第二個人快速加入 → 進同一間');
  ok(hub.connectedSeats(second.room).length === 2, '兩個人都坐到席位上');
  const third = hub.quickJoin(person('C'));
  ok(third.room.id !== first.room.id, '第三個人快速加入 → 房間滿了就另開一間');
}

/* ---------------------------------------------------------- */
group('2 席位與自動轉觀戰');
{
  const hub = createHub();
  const r = hub.createRoom(person('A'), {}).room;
  ok(hub.join(r.id, person('B'), 'player').role === 'player', '第 2 個人還坐得到席位');
  ok(hub.join(r.id, person('C'), 'player').role === 'spectator', '第 3 個人自動轉觀戰');
  ok(hub.join(r.id, person('D'), 'player').role === 'spectator', '第 4 個人也是觀戰');
  ok(hub.connectedSeats(r).length === 2, '席位固定 2 人');
}
{
  /* 觀戰上限 20 人，滿了要給看得懂的提示 */
  const hub = createHub();
  const r = hub.createRoom(person('A'), {}).room;
  hub.join(r.id, person('B'), 'player');
  for (let i = 0; i < CONST.MAX_SPECTATORS; i++) hub.join(r.id, person('s' + i), 'spectator');
  ok(hub.specsOf(r).length === CONST.MAX_SPECTATORS, '觀戰席收滿 ' + CONST.MAX_SPECTATORS + ' 人');
  const over = hub.join(r.id, person('over'), 'spectator');
  ok(!!over.error && /觀戰席已滿/.test(over.error), '第 21 個觀戰者被拒絕，且提示看得懂', over.error);
}

/* ---------------------------------------------------------- */
group('準備、難度與開局');
{
  const hub = createHub();
  const r = hub.createRoom(person('A'), {}).room;
  ok(!!hub.start(r.id, 'A').error, '只有一個人不能開始');
  hub.join(r.id, person('B'), 'player');
  ok(!!hub.start(r.id, 'A').error, '兩個人都沒準備好也不能開始');
  hub.setReady(r.id, 'A', true);
  ok(!!hub.start(r.id, 'A').error, '只有一個人準備好還是不能開始');
  hub.setReady(r.id, 'B', true);
  ok(!hub.start(r.id, 'A').error, '兩個人都準備好才能開始');
  ok(r.phase === 'playing' && !!r.match, '開始之後進入對局');
  ok(!!r.seed, '這一局有自己的樓梯 seed');
}
{
  const hub = createHub();
  const r = hub.createRoom(person('A'), {}).room;
  hub.join(r.id, person('B'), 'player');
  ok(!!hub.start(r.id, 'B').error, '不是房主不能開始');
  ok(!!hub.updateRoom(r.id, 'B', { difficulty: 'hard' }).error, '不是房主不能改難度');
  ok(!hub.updateRoom(r.id, 'A', { difficulty: 'hard' }).error, '房主可以改難度');
  ok(r.difficulty === 'hard', '難度真的改了');
  ok(!!hub.updateRoom(r.id, 'A', { difficulty: 'baby' }).error, '對戰不開放幼幼班');
  hub.setReady(r.id, 'A', true);
  hub.updateRoom(r.id, 'A', { difficulty: 'easy' });
  ok(!hub.allReady(r), '改難度會把準備狀態重設（條件變了要重新確認）');
}
{
  /* 每一局都換新的樓梯 seed */
  const { hub, room } = playingRoom();
  const first = room.seed;
  room.phase = 'lobby'; room.match = null;
  hub.setReady(room.id, 'A', true); hub.setReady(room.id, 'B', true);
  hub.start(room.id, 'A');
  ok(room.seed !== first, '再來一局換新的樓梯 seed（不做同座樓梯重打）');
}

/* ---------------------------------------------------------- */
group('搶位（先按先得、對局中不開放）');
{
  const hub = createHub();
  const r = hub.createRoom(person('A'), {}).room;
  hub.join(r.id, person('B'), 'player');
  hub.join(r.id, person('C'), 'spectator');
  ok(!!hub.takeSeat(r.id, 'C').error, '席位滿的時候搶不到');
  hub.leave(r.id, 'B');
  ok(!hub.takeSeat(r.id, 'C').error, '有人離開就開放搶位');
  ok(r.members.get('C').role === 'player', '搶到的人變成玩家');
}
{
  const hub = createHub();
  const r = hub.createRoom(person('A'), {}).room;
  hub.join(r.id, person('B'), 'player');
  hub.join(r.id, person('C'), 'spectator');
  hub.join(r.id, person('D'), 'spectator');
  hub.leave(r.id, 'B');
  const c = hub.takeSeat(r.id, 'C');
  const d = hub.takeSeat(r.id, 'D');
  ok(!c.error && !!d.error, '先按的人先得，不做候補排隊');
}
{
  const { hub, room } = playingRoom();
  hub.join(room.id, person('C'), 'spectator');
  ok(!!hub.takeSeat(room.id, 'C').error, '對局進行中不開放搶位');
  run(hub, 0.1);
  /* 讓這局結束：兩個人都判輸（還在倒數中就斷線也要立刻收） */
  hub.markDisconnected('A');
  hub.markDisconnected('B');
  run(hub, 0.2);
  ok(room.phase === 'result', '兩個人都在倒數中斷線 → 立刻收掉這局（不用等倒數跑完）');
  ok(room.match.result && room.match.result.players.every(p => p.forfeit),
    '結果標明兩個人都是斷線判輸');
}

/* ---------------------------------------------------------- */
group('斷線判輸（§4.4：不暫停、不給寬限秒數）');
{
  const { hub, room } = playingRoom();
  run(hub, 3);
  hub.markDisconnected('A');
  const pa = room.match.players.find(p => p.id === 'A');
  const pb = room.match.players.find(p => p.id === 'B');
  ok(!pa.alive && pa.hp === 0, '斷線的人立刻判輸（淘汰）');
  ok(pa.forfeit === true, '結果標明是斷線判輸');
  ok(pb.alive, '對手還活著，可以繼續玩完');
  ok(room.phase === 'playing', '對局沒有因為一個人斷線就結束（兩個人都死才結算）');
  run(hub, 2);
  ok(room.phase === 'playing', '對手可以繼續把深度跑完');
}
{
  /* 心跳連兩次沒回就當斷線 */
  const { hub, room } = playingRoom();
  hub.sweepHeartbeat = null;
  ok(hub.sweepHeartbeats().length === 0, '第 1 次沒回還不算斷線');
  ok(hub.sweepHeartbeats().length === 0, '第 2 次沒回還不算斷線');
  const dead = hub.sweepHeartbeats();
  ok(dead.length === 2, '連續 3 次沒回（約 2 秒）才判定連線已死', dead.join(','));
}
{
  /* 有回心跳就不會被誤判 */
  const { hub, room } = playingRoom();
  for (let i = 0; i < 10; i++) {
    hub.heartbeat('A');
    hub.heartbeat('B');
    hub.sweepHeartbeats();
  }
  ok(room.match.players.every(p => p.alive), '一直有回心跳就不會被誤判斷線');
}
{
  /* 對局中離開＝判輸 */
  const { hub, room } = playingRoom();
  run(hub, 1);
  hub.leave(room.id, 'B');
  const pb = room.match.players.find(p => p.id === 'B');
  ok(!pb.alive && pb.forfeit, '對局中離開房間也是判輸');
}
