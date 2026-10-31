/* ===== scripts/ai-check.js — 四段 AI 的行為差異驗收 =====
 * 規劃書 §5：讓四段 AI 各跑 200 局，以相同路線比較深度、速度與死亡率。
 * 執行：node scripts/ai-check.js  或  npm run test:ai
 *
 * 一個必須先講清楚的觀察：加了「踩到非刺的階梯回血」之後，只要 AI 好到不會摔死，
 * 它的深度就由「遊戲難度的下捲速度」決定，而不是由它自己的技術決定。
 * 所以普通與困難的深度會很接近 —— 真正分得出高下的是「平均下降速度」與「死亡率」。
 * 這支腳本兩個都驗。
 */
'use strict';

const Rules = require('../public/js/rules.js');
const Ai = require('../public/js/ai.js');
const pairedComparison = require('./paired-comparison.js');

const GAMES = Number(process.env.GAMES) || 200;
const CAP = Number(process.env.CAP) || 90;      /* 每局最長跑幾秒 */
const DIFFS = (process.env.DIFFS || 'normal,hard').split(',');

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
const fmt = (n, d) => (Math.round(n * Math.pow(10, d || 1)) / Math.pow(10, d || 1)).toFixed(d || 1);

/** 讓一段 AI 在某個遊戲難度上跑 n 局，回傳統計 */
function runTier(gameDiff, level, games) {
  let depth = 0, secs = 0, deaths = 0, fell = 0, spikes = 0, heals = 0;
  let lands = 0, landSpike = 0, landFake = 0;
  const depths = [];
  for (let i = 0; i < games; i++) {
    /* 各等級使用同一批樓梯，避免把路線差異誤判成 AI 強弱差異。 */
    const seed = 'ai-' + gameDiff + '-' + i;
    const s = Rules.createMatch({
      difficulty: gameDiff, mode: 'solo',
      players: [{ id: 'a', name: 'AI', char: 'bobo', kind: 'ai', aiLevel: level }]
    }, seed);
    const ai = Ai.create(level, 'a', seed);
    let t = 0;
    while (s.phase !== 'over' && t < CAP) {
      const cmd = ai.read(s, Rules.STEP);
      const r = Rules.stepMatch(s, { a: { dir: cmd.dir } }, Rules.STEP_MS);
      for (const e of r.events) {
        if (e.type !== 'land') continue;
        lands++;
        if (e.kind === 'spike') landSpike++;
        else if (e.kind === 'fake') landFake++;
      }
      t += Rules.STEP;
    }
    if (s.phase !== 'over') Rules.endMatch(s, 'manual');
    else { deaths++; if (s.result.players[0].fell) fell++; }
    const me = s.result.players[0];
    depth += me.meters;
    depths.push(me.meters);
    secs += t;
    spikes += me.stats.spikes;
    heals += me.stats.heals;
  }
  const mean = depth / games;
  const sd = Math.sqrt(depths.reduce((a, b) => a + (b - mean) * (b - mean), 0) / games);
  return {
    depth: mean, sd: sd, samples: depths, secs: secs / games, speed: depth / secs,
    deathRate: deaths / games, fellRate: fell / games,
    /* 「會不會避刺」要看「落地的階梯裡有幾成是刺」。
     * 不能用「每局幾次」也不能用「每 100 公尺幾次」——
     * 強的 AI 落地次數多很多（148 次／局 對 38 次／局），
     * 這兩種算法都會算出「越強越常踩刺」的相反結論。 */
    landsPerGame: lands / games,
    spikeShare: lands ? landSpike / lands : 0,
    fakeShare: lands ? landFake / lands : 0,
    heals: heals / games
  };
}

console.log('四段 AI 驗收（每段 ' + GAMES + ' 局，每局上限 ' + CAP + ' 秒）');

for (const gameDiff of DIFFS) {
  console.log('\n【遊戲難度：' + Rules.DIFFICULTY[gameDiff].name + '】');
  console.log('    AI      平均深度        平均下降速度   死亡率   落地/局  落地裡的刺');
  const r = {};
  for (const level of Ai.LEVEL_LIST) {
    r[level] = runTier(gameDiff, level, GAMES);
    const x = r[level];
    console.log('    ' + Ai.LEVELS[level].name.padEnd(6) +
      (fmt(x.depth, 0) + ' m').padStart(8) + ' (±' + fmt(x.sd, 0) + ')' +
      (fmt(x.speed, 2) + ' m/秒').padStart(14) +
      (fmt(x.deathRate * 100, 0) + '%').padStart(9) +
      fmt(x.landsPerGame, 0).padStart(8) +
      (fmt(x.spikeShare * 100, 1) + '%').padStart(11));
  }

  const L = Ai.LEVEL_LIST;
  const gaps = [];
  for (let i = 1; i < L.length; i++) {
    const stats = pairedComparison(r[L[i - 1]].samples, r[L[i]].samples);
    gaps.push(Object.assign({ pair: Ai.LEVELS[L[i - 1]].name + '→' + Ai.LEVELS[L[i]].name }, stats));
  }
  /* 配對路線比較：只有超過兩倍標準誤的倒掛才算深度退步。 */
  ok(gaps.every(g => g.gap >= -g.se2), gameDiff + '：四段 AI 深度差異沒有顯著倒掛',
    L.map(l => fmt(r[l].depth, 0)).join(' → '));

  /* 2. 普通與困難都活得下來，深度會被下捲速度綁住，所以它們真正的差別在下降速度。
   * 只比這兩段 —— 弱的 AI 因為死得早、死前又在急墜，速度數字會被拉高，不能一起比。 */
  ok(r.hard.speed > r.normal.speed,
    gameDiff + '：撐得住的兩段之間，困難下降得比普通快（' +
    fmt(r.normal.speed, 2) + ' → ' + fmt(r.hard.speed, 2) + ' m/秒）');

  /* 前兩級的進步必須超過兩倍配對標準誤；普通與困難深度相近時，
   * 拒絕顯著退步，並另驗下降速度與死亡率。 */
  const shown = gaps.map(g => g.pair + ' ' + fmt(g.gap, 0) + ' m（雜訊 ±' + fmt(g.se2, 0) + '）').join('、');
  ok(gaps.slice(0, 2).every(g => g.gap > g.se2),
    gameDiff + '：幼幼班→簡單→普通的深度差距都明顯大於雜訊', shown);
  const last = gaps[gaps.length - 1];
  ok(last.gap >= -last.se2, gameDiff + '：困難相對普通的深度差沒有顯著退步',
    fmt(last.gap, 1) + ' m，配對雜訊 ±' + fmt(last.se2, 1) + ' m');
  if (Math.abs(last.gap) <= last.se2) {
    console.log('    註：普通與困難的深度差 ' + fmt(last.gap, 0) + ' m 落在雜訊 ±' +
      fmt(last.se2, 0) + ' m 之內，尚無顯著深度差異，' +
      '另看上面的下降速度與死亡率。');
  }

  /* 4. 幼幼班與困難之間要有明顯的量級差 */
  ok(r.hard.depth > r.baby.depth * 2,
    gameDiff + '：困難的深度至少是幼幼班的 2 倍（' +
    fmt(r.hard.depth / r.baby.depth, 1) + ' 倍）');

  /* 5. 越弱的 AI 越容易死。
   * 注意「困難」這個遊戲難度會讓四段 AI 全部 100% 陣亡 —— 那不是測試壞了，
   * 是這個難度本來就該致命（傷害 2～5 顆、血量只有 9 顆）。
   * 死亡率天花板打滿的時候，能分辨強弱的就只剩深度與下降速度。 */
  /* 死亡率是比例，200 局的抽樣誤差 SE = √(p(1−p)/n) 最大約 3.5 個百分點，
   * 所以要允許「兩個標準誤以內的倒掛」，不然這一項會隨機紅字。 */
  const se = p => 2 * Math.sqrt(Math.max(p * (1 - p), 0.0001) / GAMES);
  let monoDeath = true;
  for (let i = 1; i < L.length; i++) {
    const prev = r[L[i - 1]].deathRate, cur = r[L[i]].deathRate;
    if (cur > prev + se(prev) + se(cur)) monoDeath = false;
  }
  const saturated = L.every(l => r[l].deathRate >= 0.999);
  ok(monoDeath, gameDiff + '：越弱的 AI 死亡率不會比較低（單調不遞增）',
    L.map(l => fmt(r[l].deathRate * 100, 0) + '%').join(' → '));
  if (saturated) {
    console.log('    註：這個難度四段 AI 全部陣亡（死亡率打滿 100%），強弱要看深度與下降速度。');
  } else {
    ok(r.baby.deathRate > r.hard.deathRate,
      gameDiff + '：最弱的 AI 死亡率明顯高於最強的',
      fmt(r.baby.deathRate * 100, 0) + '% vs ' + fmt(r.hard.deathRate * 100, 0) + '%');
  }

  /* 6. 會避刺的 AI 真的比較少踩到刺（看「落地的階梯裡有幾成是刺」） */
  let monoSpike = true;
  for (let i = 1; i < L.length; i++) if (r[L[i]].spikeShare > r[L[i - 1]].spikeShare + 0.004) monoSpike = false;
  ok(monoSpike && r.baby.spikeShare > r.hard.spikeShare,
    gameDiff + '：越會避刺的 AI，落地的階梯裡刺的比例越低',
    L.map(l => fmt(r[l].spikeShare * 100, 1) + '%').join(' → '));
}

/* ---- 神話：只給電腦對手用的第五段，要明確強過困難 ---- */
console.log('\n【神話】');
{
  const N = Number(process.env.MYTH_GAMES) || 20;
  const h = runTier('hard', 'hard', N), m = runTier('hard', 'mythic', N);
  const hn = runTier('normal', 'hard', N), mn = runTier('normal', 'mythic', N);
  console.log('    困難遊戲：困難 ' + fmt(h.depth, 0) + ' m／神話 ' + fmt(m.depth, 0) + ' m；普通遊戲：困難 ' +
    fmt(hn.depth, 0) + ' m／神話 ' + fmt(mn.depth, 0) + ' m');
  ok(Ai.AI_LIST.join(',') === 'baby,easy,normal,hard,mythic', '電腦共五段（含神話），遊戲難度 LEVEL_LIST 仍是四段');
  ok(m.depth > h.depth * 1.5, '困難遊戲：神話平均深度至少是困難的 1.5 倍');
  ok(mn.depth > hn.depth && mn.deathRate <= hn.deathRate, '普通遊戲：神話比困難深，而且死得不比較多');
  ok(m.spikeShare < h.spikeShare + 0.004 || m.depth > h.depth, '神話不會比困難更常踩刺（或深度明顯更好）');
  /* 對打：神話打困難要大勝（左右位置各打一半，排除出生點優勢） */
  let win = 0, games = 0;
  for (let i = 0; i < 6; i++) for (const swap of [0, 1]) {
    const ids = swap ? ['p2', 'p1'] : ['p1', 'p2'];
    const seed = 'myth-vs-' + i;
    const s = Rules.createMatch({ difficulty: 'normal', mode: 'versus',
      players: [{ id: 'p1', kind: 'ai' }, { id: 'p2', kind: 'ai' }] }, seed);
    const A = Ai.create('mythic', ids[0], seed), B = Ai.create('hard', ids[1], seed);
    let t = 0;
    while (s.phase !== 'over' && t < 150) {
      const ca = A.read(s, Rules.STEP), cb = B.read(s, Rules.STEP);
      const cmd = {}; cmd[ids[0]] = { dir: ca.dir }; cmd[ids[1]] = { dir: cb.dir };
      Rules.stepMatch(s, cmd, Rules.STEP_MS); t += Rules.STEP;
    }
    if (s.phase !== 'over') Rules.endMatch(s, 'manual');
    games++; if (s.result.winner === ids[0]) win++;
  }
  ok(win / games >= 0.8, '神話對打困難（雙方位置互換）勝率至少 80%（' + win + '/' + games + '）');
  /* 不作弊：規劃用的模擬不會改動真實局面 */
  const seed = 'myth-fair';
  const s = Rules.createMatch({ difficulty: 'normal', mode: 'solo', players: [{ id: 'a', kind: 'ai', aiLevel: 'mythic' }] }, seed);
  const ai = Ai.create('mythic', 'a', seed);
  for (let i = 0; i < 400; i++) { const c = ai.read(s, Rules.STEP); Rules.stepMatch(s, { a: { dir: c.dir } }, Rules.STEP_MS); }
  const snap = JSON.stringify({ hp: s.players[0].hp, x: s.players[0].x, y: s.players[0].y, t: s.time, n: s.steps.length, g: s.gen.depth });
  for (let i = 0; i < 30; i++) ai.read(s, 0.2);
  ok(snap === JSON.stringify({ hp: s.players[0].hp, x: s.players[0].x, y: s.players[0].y, t: s.time, n: s.steps.length, g: s.gen.depth }),
    '神話在規劃時不會改動真實局面（含樓梯生成器）');
}

/* ---- AI 不作弊：只用得到跟真人一樣的輸入 ---- */
console.log('\n【不作弊】');
{
  const seed = 'fair';
  const s = Rules.createMatch({
    difficulty: 'normal', mode: 'solo',
    players: [{ id: 'a', kind: 'ai', aiLevel: 'hard' }]
  }, seed);
  const ai = Ai.create('hard', 'a', seed);
  const dirs = new Set();
  const before = JSON.stringify({ hp: s.players[0].hp, x: s.players[0].x, cam: s.cameraTop });
  for (let i = 0; i < 60; i++) dirs.add(ai.read(s, Rules.STEP).dir);
  const after = JSON.stringify({ hp: s.players[0].hp, x: s.players[0].x, cam: s.cameraTop });
  ok(before === after, 'AI 讀取狀態時不會改動任何東西（不加速、不改血量）');
  ok([...dirs].every(d => d === -1 || d === 0 || d === 1),
    'AI 只輸出 -1 / 0 / 1，跟真人完全同一個輸入格式', [...dirs].join(','));
  ok(Ai.LEVEL_LIST.join(',') === 'baby,easy,normal,hard', '四段 AI：幼幼班／簡單／普通／困難');
}
{
  /* 預看層數：AI 看得到的階梯不能超過難度上限 */
  const seed = 'look';
  const s = Rules.createMatch({
    difficulty: 'normal', mode: 'solo',
    players: [{ id: 'a', kind: 'ai', aiLevel: 'baby' }]
  }, seed);
  s.phase = 'playing'; s.countdown = 0;
  const deep = s.steps.filter(st => st.depth > s.players[0].y + 0.05).length;
  ok(deep > Ai.LEVELS.baby.lookahead,
    '狀態裡確實有比「預看層數」更多的階梯（所以砍層數才有意義，共 ' + deep + ' 階）');
  ok(Ai.LEVELS.baby.lookahead < Ai.LEVELS.hard.lookahead,
    '幼幼班的預看層數比困難少（' + Ai.LEVELS.baby.lookahead + ' < ' + Ai.LEVELS.hard.lookahead + '）');
  ok(Ai.LEVELS.baby.react > Ai.LEVELS.hard.react,
    '幼幼班的反應延遲比困難久（' + Ai.LEVELS.baby.react + ' 秒 > ' + Ai.LEVELS.hard.react + ' 秒）');
  ok(Ai.LEVELS.baby.mistake > Ai.LEVELS.hard.mistake,
    '幼幼班的失誤率比困難高（' + Ai.LEVELS.baby.mistake + ' > ' + Ai.LEVELS.hard.mistake + '）');
}
{
  /* 同一個 seed 要跑出同一套決策（線上重現與測試的前提） */
  const play = () => {
    const s = Rules.createMatch({
      difficulty: 'normal', mode: 'solo',
      players: [{ id: 'a', kind: 'ai', aiLevel: 'normal' }]
    }, 'repeat');
    const ai = Ai.create('normal', 'a', 'repeat');
    const out = [];
    for (let i = 0; i < 1200; i++) {
      const c = ai.read(s, Rules.STEP);
      out.push(c.dir);
      Rules.stepMatch(s, { a: { dir: c.dir } }, Rules.STEP_MS);
      if (s.phase === 'over') break;
    }
    return out.join('');
  };
  ok(play() === play(), '同一個 seed 跑出完全一樣的一串決策');
}

console.log('\n────────────────────────────');
console.log(pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n失敗項目：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
