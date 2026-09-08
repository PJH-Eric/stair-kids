/* ===== scripts/result-check.js — 結算內容與本機紀錄驗收 =====
 * 規劃書 §1.5（這局統計）、§1.8（勝負判定）、§13（本機紀錄）。
 * 執行：node scripts/result-check.js  或  npm run test:result
 */
'use strict';

const Rules = require('../public/js/rules.js');

/* storage.js 是給瀏覽器用的，這裡補一個假的 localStorage 就能直接測 */
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
const { Store } = require('../public/js/storage.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}
function group(t) { console.log('\n' + t); }

const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-6 : tol);

/** 跑一局到某個條件成立（或時間到），回傳 state */
function play(cfg, seconds, onStep) {
  const s = Rules.createMatch(cfg, cfg.seed || 'result-check');
  const steps = Math.round(seconds / Rules.STEP);
  for (let i = 0; i < steps; i++) {
    const inputs = onStep ? onStep(s, i) : null;
    Rules.stepMatch(s, inputs || {}, Rules.STEP_MS);
    if (s.phase === 'over') break;
  }
  return s;
}

/* ---------------------------------------------------------- */
group('單機結算（§1.5 這局統計）');
{
  /* 什麼都不按 → 一定會被天花板頂到或掉出畫面，這局會自己收 */
  const s = play({ difficulty: 'normal', mode: 'solo', players: [{ id: 'me', name: '我', char: 'yuan' }] }, 120);
  ok(s.phase === 'over', '不動的話這局會結束');
  const r = s.result;
  ok(!!r, '有結算資料');
  ok(r.endedBy === 'dead' || r.endedBy === 'fell', '結束原因是血歸零或摔死', r.endedBy);
  ok(r.mode === 'solo' && r.difficulty === 'normal', '結算記得模式與難度');
  ok(typeof r.seed === 'string' && r.seed.length > 0, '結算記得 seed（可以重播同一座樓梯）');
  ok(r.elapsed > 0, '有記到這局玩了多久', r.elapsed.toFixed(1) + ' 秒');
  const p = r.players[0];
  ok(p.meters === Math.floor(p.depth), '公尺數＝最深深度取整數');
  ok(p.hp === 0, '死掉的人血是 0');
  ok(p.alive === false, '死掉的人 alive 是 false');
  ok(p.survived > 0 && p.survived <= r.elapsed + 1e-6, '存活時間不會超過整局時間');
  for (const k of ['spikes', 'springs', 'fakes', 'ceilingSeconds', 'pushes', 'heals', 'deepestWorld']) {
    ok(typeof p.stats[k] === 'number', '這局統計有「' + k + '」');
  }
  ok(p.stats.deepestWorld === p.world, '最深世界跟統計一致');
}
{
  /* 幼幼班：不會死，要靠玩家按「結束這局」 */
  const s = play({ difficulty: 'baby', mode: 'solo', players: [{ id: 'me', name: '我', char: 'yuan' }] }, 60);
  ok(s.phase !== 'over', '幼幼班放著不動也不會死（鼓勵式）');
  const r = Rules.endMatch(s, 'manual');
  ok(r.endedBy === 'manual', '幼幼班按「結束這局」收局，原因記為 manual');
  ok(r.players[0].alive === true, '幼幼班收局時人還活著');
  ok(r.players[0].hp > 0, '幼幼班收局時還有血', r.players[0].hp + ' 顆');
  const again = Rules.endMatch(s, 'manual');
  ok(again === r, '重複按「結束這局」不會產生第二份結算');
}

/* ---------------------------------------------------------- */
group('對戰勝負（§1.8：深度優先 → 撐得久 → 平手）');
{
  const mk = (best, aliveTime) => ({ id: 'x' + best + aliveTime, best: best, aliveTime: aliveTime });
  /* 直接驗規則核心的判定：透過一局跑完後的 result 反推 */
  const s = Rules.createMatch({
    difficulty: 'normal', mode: 'versus',
    players: [{ id: 'A', name: '甲', char: 'yuan' }, { id: 'B', name: '乙', char: 'mimi' }]
  }, 'judge-1');
  /* 手動擺出「甲比較深」的局面 */
  s.players[0].best = 120; s.players[0].aliveTime = 30;
  s.players[1].best = 80; s.players[1].aliveTime = 90;
  s.players[0].alive = false; s.players[1].alive = false;
  s.players[0].hp = 0; s.players[1].hp = 0;
  const r1 = Rules.endMatch(s, 'dead');
  ok(r1.winner === 'A' && !r1.draw, '深度深的人贏（就算撐得比較短）');

  const s2 = Rules.createMatch({
    difficulty: 'normal', mode: 'versus',
    players: [{ id: 'A', name: '甲', char: 'yuan' }, { id: 'B', name: '乙', char: 'mimi' }]
  }, 'judge-2');
  s2.players[0].best = 100; s2.players[0].aliveTime = 20;
  s2.players[1].best = 100; s2.players[1].aliveTime = 45;
  const r2 = Rules.endMatch(s2, 'dead');
  ok(r2.winner === 'B' && !r2.draw, '深度一樣就比誰撐得久');

  const s3 = Rules.createMatch({
    difficulty: 'normal', mode: 'versus',
    players: [{ id: 'A', name: '甲', char: 'yuan' }, { id: 'B', name: '乙', char: 'mimi' }]
  }, 'judge-3');
  s3.players[0].best = 77; s3.players[0].aliveTime = 33;
  s3.players[1].best = 77; s3.players[1].aliveTime = 33;
  const r3 = Rules.endMatch(s3, 'dead');
  ok(r3.draw && r3.winner === null, '兩個都一樣＝平手');
  ok(r3.players[0].meters === r3.players[1].meters, '平手時兩邊公尺數相同');
}
{
  /* 一個人先死，另一個人繼續玩 → 這局不會提早結算（§4.4） */
  const s = Rules.createMatch({
    difficulty: 'normal', mode: 'versus',
    players: [{ id: 'A', name: '甲', char: 'yuan' }, { id: 'B', name: '乙', char: 'mimi' }]
  }, 'both-dead');
  s.countdown = 0; s.phase = 'playing';
  s.players[1].hp = 0; s.players[1].alive = false;
  Rules.stepMatch(s, {}, Rules.STEP_MS);
  ok(s.phase === 'playing', '只有一個人死，這局繼續（兩個人都死才結算）');
  s.players[0].hp = 0; s.players[0].alive = false;
  Rules.stepMatch(s, {}, Rules.STEP_MS);
  ok(s.phase === 'over', '兩個人都死才結算');
  ok(s.result.players.length === 2, '結算兩個人都在');
}
{
  /* 斷線判輸要在結算上看得出來 */
  const s = Rules.createMatch({
    difficulty: 'normal', mode: 'versus',
    players: [{ id: 'A', name: '甲', char: 'yuan' }, { id: 'B', name: '乙', char: 'mimi' }]
  }, 'forfeit');
  s.players[1].hp = 0; s.players[1].alive = false; s.players[1].forfeit = true;
  s.players[0].best = 50;
  const r = Rules.endMatch(s, 'dead');
  const b = r.players.find(p => p.id === 'B');
  ok(b.forfeit === true, '結算標明誰是斷線判輸');
  ok(r.players.find(p => p.id === 'A').forfeit === false, '沒斷線的人不會被標成判輸');
  ok(r.winner === 'A', '斷線的人判輸，對手贏');
}

/* ---------------------------------------------------------- */
group('本機紀錄（§13：只存在這台裝置）');
{
  Store.clearRecords(Store.load());
  let d = Store.load();
  ok(Object.keys(d.records).length === 0, '一開始沒有紀錄');

  let r = Store.record(d, { difficulty: 'normal', depth: 123.7, world: 2, char: 'yuan' });
  ok(r.record === true, '第一次玩就是破紀錄');
  ok(r.best.depth === 123, '紀錄的公尺數是取整數');
  ok(r.best.world === 2, '紀錄記到最深世界');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(r.best.date), '紀錄有日期');

  d = Store.load();
  r = Store.record(d, { difficulty: 'normal', depth: 50, world: 1, char: 'yuan' });
  ok(r.record === false, '比較差的一局不算破紀錄');
  ok(r.best.depth === 123, '紀錄不會被比較差的一局蓋掉');
  ok(r.best.world === 2, '最深世界也不會退回去');

  d = Store.load();
  r = Store.record(d, { difficulty: 'hard', depth: 40, world: 0, char: 'mimi' });
  ok(r.record === true, '不同難度的紀錄各自算');
  d = Store.load();
  ok(d.records.normal.depth === 123 && d.records.hard.depth === 40, '兩個難度的紀錄都在');
  ok(d.plays === 3, '玩過的局數會累加');
  ok(d.charUse.yuan === 2 && d.charUse.mimi === 1, '各角色使用次數有記');
  ok(Store.favoriteChar(d) === 'yuan', '算得出最常用的角色');
  ok(d.bestWorld === 2, '到達過的最深世界有記');

  d = Store.load();
  Store.record(d, { difficulty: 'normal', depth: 10, world: 0, char: 'yuan', versus: { kind: 'ai', win: true } });
  d = Store.load();
  Store.record(d, { difficulty: 'normal', depth: 10, world: 0, char: 'yuan', versus: { kind: 'ai', win: false } });
  d = Store.load();
  Store.record(d, { difficulty: 'normal', depth: 10, world: 0, char: 'yuan', versus: { kind: 'online', win: true } });
  d = Store.load();
  ok(d.versus.ai.win === 1 && d.versus.ai.lose === 1, '跟電腦對戰的勝敗分開累計');
  ok(d.versus.online.win === 1 && d.versus.online.lose === 0, '線上對戰的勝敗分開累計');

  /* 設定改了 → 恢復預設不該把紀錄清掉 */
  d = Store.load();
  d.bgmVol = 0.9; d.colorAssist = true; d.nickname = '小明';
  Store.save(d);
  d = Store.resetSettings(Store.load());
  ok(near(d.bgmVol, Store.DEFAULTS.bgmVol), '恢復預設會把音量調回出廠值');
  ok(d.colorAssist === false, '恢復預設會把色彩輔助關掉');
  ok(d.records.normal.depth === 123, '恢復預設不會清掉紀錄');
  ok(d.nickname === '小明', '恢復預設不會清掉暱稱');

  /* 清除紀錄 → 設定不該被動到 */
  d = Store.load();
  d.bgmVol = 0.5; Store.save(d);
  d = Store.clearRecords(Store.load());
  ok(Object.keys(d.records).length === 0, '清除紀錄真的清掉了');
  ok(d.bestWorld === 0 && d.plays === 0, '清除紀錄也把最深世界與局數歸零');
  ok(near(d.bgmVol, 0.5), '清除紀錄不會動到設定');
}

/* ---------------------------------------------------------- */
group('結算 → 紀錄（兩邊接得上）');
{
  Store.clearRecords(Store.load());
  const s = play({ difficulty: 'easy', mode: 'solo', players: [{ id: 'me', name: '我', char: 'ping' }] }, 120);
  const r = s.result || Rules.endMatch(s, 'dead');
  const p = r.players[0];
  const res = Store.record(Store.load(), {
    difficulty: r.difficulty, depth: p.depth, world: p.world, char: p.char
  });
  ok(res.best.depth === p.meters, '結算的公尺數寫得進紀錄，數字一致');
  const d = Store.load();
  ok(d.records.easy && d.records.easy.depth === p.meters, '紀錄存在對應的難度底下');
  ok(d.charUse[p.char] === 1, '結算用的角色會被記成使用次數');
}

/* ---------------------------------------------------------- */
console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n沒過的項目：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
