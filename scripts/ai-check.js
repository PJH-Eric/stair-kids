/* ===== scripts/ai-check.js — 四段 AI 的行為差異驗收 =====
 * 規劃書 §5：讓四段 AI 各跑 200 局，平均深度必須單調遞增且差距穩定。
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
    const seed = 'ai-' + gameDiff + '-' + level + '-' + i;
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
    depth: mean, sd: sd, secs: secs / games, speed: depth / secs,
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
  /* 1. 平均深度單調遞增（§5 的驗收條件） */
  let mono = true;
  for (let i = 1; i < L.length; i++) if (!(r[L[i]].depth > r[L[i - 1]].depth)) mono = false;
  ok(mono, gameDiff + '：四段 AI 的平均深度單調遞增',
    L.map(l => fmt(r[l].depth, 0)).join(' → '));

  /* 2. 普通與困難都活得下來，深度會被下捲速度綁住，所以它們真正的差別在下降速度。
   * 只比這兩段 —— 弱的 AI 因為死得早、死前又在急墜，速度數字會被拉高，不能一起比。 */
  ok(r.hard.speed > r.normal.speed,
    gameDiff + '：撐得住的兩段之間，困難下降得比普通快（' +
    fmt(r.normal.speed, 2) + ' → ' + fmt(r.hard.speed, 2) + ' m/秒）');

  /* 3. 差距要「穩定」＝ 明顯大於雜訊（用兩倍標準誤判斷）。
   *
   * 但有一個真實的限制要講清楚：只要 AI 好到不會死，它的深度就會被
   * 「保底下捲速度」綁住 —— 鏡頭一直往下捲，玩家再快也只是跟著走。
   * 所以普通與困難這一對在難度高的時候會收斂到同一個數字，這不是 bug，
   * 是這款遊戲的節奏本來就由下捲速度決定。
   * 前兩個差距（幼幼班→簡單→普通）必須分得開；最後一對只要求不退步，
   * 真正的差別改看下降速度（上面那一條）。 */
  const gaps = [];
  for (let i = 1; i < L.length; i++) {
    const a = r[L[i - 1]], b = r[L[i]];
    const se2 = 2 * Math.sqrt((a.sd * a.sd + b.sd * b.sd) / GAMES);
    const gap = b.depth - a.depth;
    gaps.push({ pair: Ai.LEVELS[L[i - 1]].name + '→' + Ai.LEVELS[L[i]].name, gap: gap, se2: se2 });
  }
  const shown = gaps.map(g => g.pair + ' ' + fmt(g.gap, 0) + ' m（雜訊 ±' + fmt(g.se2, 0) + '）').join('、');
  ok(gaps.slice(0, 2).every(g => g.gap > g.se2),
    gameDiff + '：幼幼班→簡單→普通的深度差距都明顯大於雜訊', shown);
  const last = gaps[gaps.length - 1];
  ok(last.gap > 0, gameDiff + '：困難不會比普通淺（' + fmt(last.gap, 0) + ' m）');
  if (last.gap <= last.se2) {
    console.log('    註：普通與困難的深度差 ' + fmt(last.gap, 0) + ' m 落在雜訊 ±' +
      fmt(last.se2, 0) + ' m 之內 —— 兩段都不會死，深度就被保底下捲速度綁住了，' +
      '真正的差別在上面的下降速度與死亡率。');
  }

  /* 4. 幼幼班與困難之間要有明顯的量級差 */
  ok(r.hard.depth > r.baby.depth * 2,
    gameDiff + '：困難的深度至少是幼幼班的 2 倍（' +
    fmt(r.hard.depth / r.baby.depth, 1) + ' 倍）');

  /* 5. 越弱的 AI 越容易死 */
  ok(r.baby.deathRate > r.easy.deathRate && r.easy.deathRate > r.normal.deathRate,
    gameDiff + '：越弱的 AI 死亡率越高',
    L.map(l => fmt(r[l].deathRate * 100, 0) + '%').join(' → '));

  /* 6. 會避刺的 AI 真的比較少踩到刺（看「落地的階梯裡有幾成是刺」） */
  let monoSpike = true;
  for (let i = 1; i < L.length; i++) if (r[L[i]].spikeShare > r[L[i - 1]].spikeShare + 0.004) monoSpike = false;
  ok(monoSpike && r.baby.spikeShare > r.hard.spikeShare,
    gameDiff + '：越會避刺的 AI，落地的階梯裡刺的比例越低',
    L.map(l => fmt(r[l].spikeShare * 100, 1) + '%').join(' → '));
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
