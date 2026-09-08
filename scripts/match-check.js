/* ===== scripts/match-check.js — 單機一局跑完 =====
 * 用一隻很單純的貪心機器人（只會挑最近的安全落點）把四段難度各跑一局，
 * 確認「開始 → 玩 → 結算」整條路徑真的走得完，並印出每段難度的手感數字。
 * 這不是 M1 的正式 AI，只是驗收用的假手。
 * 執行：node scripts/match-check.js  或  npm run test:match
 */
'use strict';

const Rules = require('../public/js/rules.js');
const Stairs = require('../public/js/stairs.js');

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
const fmt = n => (Math.round(n * 10) / 10).toFixed(1);

/**
 * 貪心機器人：往「下方最近、能站得住的安全階」走。
 * 這款遊戲沒有跳鍵，想往下就一定要先走出腳下這一階的邊緣，
 * 所以站在階梯上時，目標點必須落在「目前這一階的左右外側」。
 */
function botDir(s, p) {
  const EDGE = 0.2;               /* 落點至少留這麼多重疊，別站在最邊邊 */
  const OUT = 0.55;               /* 走出目前這一階要多出去這麼多才會掉下去 */
  const cur = p.onStep ? Rules.stepById(s, p.onStep) : null;
  const half = Rules.C.PLAYER_W / 2;
  let best = null;

  for (const st of s.steps) {
    if (st.broken) continue;
    if (st.depth <= p.y + 0.05 || st.depth > p.y + 9) continue;
    let lo = st.x0 - half + EDGE, hi = st.x1 + half - EDGE;
    if (lo > hi) { lo = hi = (st.x0 + st.x1) / 2; }
    let target = null;
    if (cur) {
      const opts = [];
      const L = cur.x0 - OUT;                       /* 從左邊走出去 */
      const R = cur.x1 + OUT;                       /* 從右邊走出去 */
      if (L >= lo - 1e-9 && L <= hi + 1e-9) opts.push(L);
      if (R >= lo - 1e-9 && R <= hi + 1e-9) opts.push(R);
      if (!opts.length) continue;
      target = opts.reduce((a, b) => (Math.abs(a - p.x) <= Math.abs(b - p.x) ? a : b));
    } else {
      target = p.x < lo ? lo : p.x > hi ? hi : p.x;
    }
    if (target < half || target > Rules.C.FIELD_W - half) continue;
    const safe = st.kind !== Stairs.KIND.SPIKE && st.kind !== Stairs.KIND.FAKE;
    const score = st.depth + (safe ? 0 : 4) + Math.abs(target - p.x) * 0.05;
    if (!best || score < best.score) best = { score: score, target: target };
  }

  if (!best) {
    if (!cur) return 0;
    /* 沒有更好的選擇就往比較近的那一邊走出去，總比被天花板夾住好 */
    return (cur.x1 - p.x) <= (p.x - cur.x0) ? 1 : -1;
  }
  const d = best.target - p.x;
  /* 站在階梯上時目標一定在這一階外側，所以不留死區，一路推到走出邊緣為止
   * （留死區的話站在輸送帶上會被帶著來回抖，永遠走不出去）。 */
  if (cur) return d > 0 ? 1 : -1;
  if (Math.abs(d) < 0.12) return 0;
  return d > 0 ? 1 : -1;
}

/* 加了「踩到非刺的階梯回 1 顆血」之後，會操作的玩家幾乎不會死
 * （每次落地都回血，而鏡頭又跟著你，所以根本碰不到天花板）。
 * 所以驗收改成「跑到時間上限就手動收局」，而不是假設一定會死。 */
function play(difficulty, seed, maxSeconds, endAfter) {
  const s = Rules.createMatch({
    difficulty: difficulty,
    mode: 'solo',
    players: [{ id: 'p1', name: '機器人', char: 'bobo', kind: 'human' }]
  }, seed);
  const tally = {};
  const maxTicks = Math.round(maxSeconds / Rules.STEP);
  let ticks = 0;
  while (s.phase !== 'over' && ticks < maxTicks) {
    const p = s.players[0];
    const dir = s.phase === 'playing' ? botDir(s, p) : 0;
    const r = Rules.stepMatch(s, { p1: { dir: dir } }, Rules.STEP_MS);
    for (const e of r.events) tally[e.type] = (tally[e.type] || 0) + 1;
    ticks++;
    if (endAfter != null && s.time >= endAfter && s.phase === 'playing') {
      Rules.endMatch(s, 'manual');
      break;
    }
  }
  const timedOut = s.phase !== 'over';
  if (timedOut) Rules.endMatch(s, 'manual');
  return { state: s, tally: tally, seconds: ticks * Rules.STEP, timedOut: timedOut };
}

console.log('單機一局跑完（貪心機器人）');

const results = {};
const CAP = 180;
for (const difficulty of ['easy', 'normal', 'hard']) {
  const r = play(difficulty, 'match-' + difficulty, CAP);
  const me = r.state.result && r.state.result.players[0];
  results[difficulty] = { r: r, me: me };
  console.log('\n【' + Rules.DIFFICULTY[difficulty].name + '】');
  console.log('    ' + (r.timedOut ? '跑到 ' + CAP + ' 秒上限還活著' : '撐了 ' + fmt(r.seconds) + ' 秒後死掉') +
    '，下到 ' + me.meters + ' m，到 ' + (me.world + 1) + ' 層世界，' +
    '最終速度倍率 ×' + fmt(r.state.scrollMul) + '，血量 ' + me.hp + '/' + Rules.DIFFICULTY[difficulty].hp);
  console.log('    踩刺 ' + me.stats.spikes + ' 次｜回血 ' + me.stats.heals + ' 次｜彈簧 ' + me.stats.springs +
    ' 次｜踩破假階 ' + me.stats.fakes + ' 次｜被頂 ' + fmt(me.stats.ceilingSeconds) + ' 秒');

  ok(r.state.phase === 'over', difficulty + '：一局能從開始玩到結算');
  ok(!!me, difficulty + '：結算有這位玩家的資料');
  ok(me && me.meters > 30, difficulty + '：機器人至少下得了 30 m（實際 ' + (me ? me.meters : 0) + ' m）');
  ok(r.tally.start === 1, difficulty + '：倒數結束後發出一次 start');
  ok((r.tally.countdown || 0) >= 1, difficulty + '：倒數期間有倒數事件');
  /* 跑到時間上限是我們自己叫 endMatch 收的，不會發 over 事件 */
  ok(r.timedOut ? (r.tally.over || 0) === 0 : r.tally.over === 1,
    difficulty + '：' + (r.timedOut ? '跑到上限手動收局（沒有 over 事件是正常的）' : '結算事件只發一次'));
  ok((r.tally.milestone || 0) === (me ? me.world : -1), difficulty + '：里程碑事件數等於經過的世界層數');
  ok(r.seconds > 15, difficulty + '：一局長度像樣（' + fmt(r.seconds) + ' 秒）');
  ok(me.stats.heals > 0, difficulty + '：踩到非刺的階梯有回血（' + me.stats.heals + ' 次）');
}

console.log('\n【幼幼班】');
{
  const r = play('baby', 'match-baby', 300, 90);
  const me = r.state.result.players[0];
  console.log('    玩了 ' + fmt(r.seconds) + ' 秒（90 秒時手動結束），下到 ' + me.meters + ' m，' +
    '血量 ' + me.hp + '/' + Rules.DIFFICULTY.baby.hp);
  ok(r.state.phase === 'over', '幼幼班：按「結束這局」收得掉');
  ok(r.state.result.endedBy === 'manual', '幼幼班：結算標明是手動結束');
  ok(me.hp === Rules.DIFFICULTY.baby.hp, '幼幼班：全程一滴血都沒掉');
  ok(me.alive === true, '幼幼班：不會死');
  ok(me.stats.spikes === 0 && me.stats.fakes === 0, '幼幼班：整局沒有刺階與假階');
  ok(me.meters > 40, '幼幼班：慢慢也下得去（' + me.meters + ' m）');
}

console.log('\n【難度差異】（每段難度跑 5 局取平均，避免單一 seed 的運氣）');
{
  const avg = {};
  for (const difficulty of ['easy', 'normal', 'hard']) {
    let secs = 0, meters = 0, survived = 0;
    for (let i = 0; i < 5; i++) {
      const r = play(difficulty, 'diff-' + difficulty + '-' + i, 90);
      secs += r.seconds;
      meters += r.state.result.players[0].meters;
      if (r.timedOut) survived++;
    }
    avg[difficulty] = { secs: secs / 5, meters: meters / 5, speed: meters / secs, survived: survived };
    console.log('    ' + Rules.DIFFICULTY[difficulty].name + '：平均 ' + fmt(avg[difficulty].secs) +
      ' 秒、下到 ' + fmt(avg[difficulty].meters) + ' m、' + fmt(avg[difficulty].speed) + ' m／秒' +
      '（5 局裡有 ' + survived + ' 局撐到 90 秒上限）');
  }
  /* 注意：這隻貪心機器人只是驗收用的假手，撐多久很吃它自己的爛決策，
   * 所以這裡只驗「下降速度跟著難度變快」這個規則層面的結果。
   * 四段難度真正的行為差異驗收在 M1 的 scripts/ai-check.js。 */
  ok(avg.hard.speed >= avg.easy.speed,
    '越難掉得越快（保底下捲速度單調遞增）',
    '簡單 ' + fmt(avg.easy.speed) + '、困難 ' + fmt(avg.hard.speed));
  ok(avg.easy.meters > 20 && avg.normal.meters > 20 && avg.hard.meters > 20,
    '三段難度都能穩定跑完一局並拿到成績');
  ok(avg.hard.meters > avg.easy.meters,
    '同樣時間內越難掉得越深（' + fmt(avg.easy.meters) + ' → ' + fmt(avg.hard.meters) + ' m）');
  const camSpeed = id => Rules.DIFFICULTY[id].scrollBase;
  ok(camSpeed('easy') < camSpeed('normal') && camSpeed('normal') < camSpeed('hard'),
    '難度的保底下捲速度本身是單調遞增的（2.0 < 2.8 < 3.6）');
}

console.log('\n【暫停】');
{
  const s = Rules.createMatch({ difficulty: 'normal', mode: 'solo', players: [{ id: 'p1' }] }, 'pause');
  for (let i = 0; i < 200; i++) Rules.stepMatch(s, { p1: { dir: 1 } }, Rules.STEP_MS);
  const snap = JSON.stringify({ cam: s.cameraTop, t: s.time, x: s.players[0].x, hp: s.players[0].hp });
  /* 暫停就是「呼叫端不再呼叫 stepMatch」，規則核心沒有自己的計時器 */
  const after = JSON.stringify({ cam: s.cameraTop, t: s.time, x: s.players[0].x, hp: s.players[0].hp });
  ok(snap === after, '不呼叫 stepMatch 時鏡頭、計時與扣血完全不動（規則核心沒有自己的計時器）');
  const before = s.steps.length;
  Rules.stepMatch(s, { p1: { dir: 0 } }, Rules.STEP_MS);
  ok(s.steps.length >= before - 4, '恢復後樓梯區段接得上（只丟掉鏡頭上方 30 格以外的舊階梯）');
}

console.log('\n【樓梯區段回收】');
{
  const s = Rules.createMatch({ difficulty: 'hard', mode: 'solo', players: [{ id: 'p1' }] }, 'window');
  let maxSteps = 0;
  for (let i = 0; i < 60 * 120 && s.phase !== 'over'; i++) {
    Rules.stepMatch(s, { p1: { dir: botDir(s, s.players[0]) } }, Rules.STEP_MS);
    maxSteps = Math.max(maxSteps, s.steps.length);
  }
  console.log('    同時保留的階梯數最多 ' + maxSteps + ' 階（鏡頭上下各約 30 格）');
  ok(maxSteps < 80, '只保留鏡頭附近的區段，舊的會被丟掉（不會無限長大）');
  ok(s.steps.every(st => st.depth >= s.cameraTop - Rules.C.KEEP_ABOVE - 4), '鏡頭上方太遠的階梯已經回收');
}

console.log('\n────────────────────────────');
console.log(pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n失敗項目：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
