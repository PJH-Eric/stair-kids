/* ===== scripts/stairs-check.js — 樓梯生成驗收 =====
 * 一萬層檢查：可達性、特殊階比例、無死路、喘息階間隔、出生平台、同 seed 完全重現。
 * 執行：node scripts/stairs-check.js  或  npm run test:stairs
 */
'use strict';

const Stairs = require('../public/js/stairs.js');
const Rules = require('../public/js/rules.js');
const C = Stairs.C;
const KIND = Stairs.KIND;
const LAYERS = Number(process.env.LAYERS) || 10000;

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

/** 產生 LAYERS 層，回傳每一層的階梯陣列 */
function build(seed, difficulty) {
  const gen = Stairs.createGen(seed, difficulty);
  const layers = [];
  while (gen.layer < LAYERS) layers.push(Stairs.nextLayer(gen));
  return layers;
}

/**
 * 「真的走得到嗎」的幾何模擬：貪心從第 0 層一路走到最後一層。
 *
 * 模型跟規則核心一致：
 *   - 玩家只要身體（寬 1.0 格）跟階梯有重疊就站得住，所以身體中心的可站範圍是
 *     [x0 − 0.5 + 邊緣餘裕, x1 + 0.5 − 邊緣餘裕]。
 *   - 站在階梯上時想橫走多久都可以（只有天花板在催），所以起點是「整段可站範圍」。
 *   - 離開階梯後落到下一層的時間 t = √(2·gap/g)，這段時間能橫移 t × 6 格。
 * 優先挑安全落點（普通／輸送帶／彈簧），挑不到才踩刺或假階；一層都挑不到 → 死路。
 */
const EDGE = 0.15;                        /* 落點至少要有這麼多重疊才算站得住 */

function standable(st) {
  const lo = st.x0 - 0.5 + EDGE;
  const hi = st.x1 + 0.5 - EDGE;
  return lo <= hi ? [lo, hi] : [(st.x0 + st.x1) / 2, (st.x0 + st.x1) / 2];
}

function walk(layers) {
  let cur = layers[0][0];
  let deadEnds = 0, forcedUnsafe = 0, worstRun = 0, run = 0, maxNeeded = 0;
  const firstDeadEnd = [];

  for (let i = 1; i < layers.length; i++) {
    const layer = layers[i];
    const gap = layer[0].depth - cur.depth;
    const budget = Math.sqrt(2 * gap / C.GRAVITY) * C.WALK_SPEED;
    const src = standable(cur);
    const reach = [src[0] - budget, src[1] + budget];
    let best = null;
    for (const st of layer) {
      const dst = standable(st);
      if (dst[1] < reach[0] - 1e-9 || dst[0] > reach[1] + 1e-9) continue;
      /* 真正需要橫走的距離：從最靠近的起點走到最靠近的落點 */
      const need = Math.max(0, Math.max(dst[0] - src[1], src[0] - dst[1]));
      const safe = st.kind !== KIND.SPIKE && st.kind !== KIND.FAKE;
      const score = (safe ? 0 : 100) + need;
      if (!best || score < best.score) best = { score: score, st: st, need: need, safe: safe };
    }
    if (!best) {
      deadEnds++;
      if (firstDeadEnd.length < 3) firstDeadEnd.push(i);
      cur = layer[0];
      continue;
    }
    maxNeeded = Math.max(maxNeeded, best.need);
    if (best.safe) run = 0;
    else { forcedUnsafe++; run++; worstRun = Math.max(worstRun, run); }
    cur = best.st;
  }
  return { deadEnds, forcedUnsafe, worstRun, maxNeeded, firstDeadEnd };
}

console.log('樓梯生成驗收（每個難度 ' + LAYERS + ' 層）');

for (const difficulty of ['baby', 'easy', 'normal', 'hard']) {
  const rates = Stairs.RATES[difficulty];
  const layers = build('check-' + difficulty, difficulty);
  const steps = layers.flat();
  console.log('\n【' + difficulty + '】共 ' + steps.length + ' 階 / ' + layers.length + ' 層');

  /* ---- 比例 ---- */
  const count = {};
  for (const st of steps) count[st.kind] = (count[st.kind] || 0) + 1;
  const ratio = k => (count[k] || 0) / steps.length;
  const pct = k => (ratio(k) * 100).toFixed(2) + '%';
  console.log('    普通 ' + pct(KIND.NORMAL) + '｜輸送帶 ' + pct(KIND.BELT) +
    '｜彈簧 ' + pct(KIND.SPRING) + '｜刺 ' + pct(KIND.SPIKE) + '｜假 ' + pct(KIND.FAKE));

  if (rates.spike === 0) {
    ok(!count[KIND.SPIKE], difficulty + '：完全不出現刺階');
    ok(!count[KIND.FAKE], difficulty + '：完全不出現假階');
  } else {
    /* 連續性限制會把實際比例壓得比名目值低一些，抓在名目的 65%～115% 之間 */
    const sOk = ratio(KIND.SPIKE) >= rates.spike * 0.65 && ratio(KIND.SPIKE) <= rates.spike * 1.15;
    const fOk = ratio(KIND.FAKE) >= rates.fake * 0.65 && ratio(KIND.FAKE) <= rates.fake * 1.15;
    ok(sOk, difficulty + '：刺階比例接近名目 ' + (rates.spike * 100).toFixed(0) + '%（實際 ' + pct(KIND.SPIKE) + '）');
    ok(fOk, difficulty + '：假階比例接近名目 ' + (rates.fake * 100).toFixed(0) + '%（實際 ' + pct(KIND.FAKE) + '）');
  }
  ok(ratio(KIND.BELT) > 0.05 && ratio(KIND.SPRING) > 0.03,
    difficulty + '：輸送帶與彈簧都有出現（實作假設值 14% / 10%）');

  /* ---- 幾何限制 ---- */
  let outOfField = 0, badWidth = 0, badGap = 0, reachBad = 0;
  for (let i = 0; i < layers.length; i++) {
    for (const st of layers[i]) {
      if (st.x0 < -1e-9 || st.x1 > C.FIELD_W + 1e-9) outOfField++;
      const w = st.x1 - st.x0;
      if (st.spawn) { if (Math.abs(w - C.SPAWN_WIDTH) > 1e-9) badWidth++; }
      else if (st.wide) { if (Math.abs(w - C.WIDE_WIDTH) > 1e-9) badWidth++; }
      else if (w < C.WIDTH_MIN - 1e-9 || w > C.WIDTH_MAX + 1e-9) badWidth++;
    }
    if (i === 0) continue;
    const gap = layers[i][0].depth - layers[i - 1][0].depth;
    if (gap < C.GAP_MIN - 1e-9 || gap > C.GAP_MAX + 1e-9) badGap++;
    const span = Stairs.reachSpan(gap);
    for (const st of layers[i]) {
      let bestGap = Infinity;
      for (const prev of layers[i - 1]) bestGap = Math.min(bestGap, Stairs.spanGap(st.x0, st.x1, prev.x0, prev.x1));
      if (bestGap > span + 1e-6) reachBad++;
    }
  }
  ok(outOfField === 0, difficulty + '：所有階梯都在場地寬 12 格內', outOfField + ' 階超出');
  ok(badWidth === 0, difficulty + '：階梯寬度都在規格內', badWidth + ' 階不合');
  ok(badGap === 0, difficulty + '：層間垂直間距都在 2.0～3.0 格', badGap + ' 層不合');
  ok(reachBad === 0, difficulty + '：可達性保證（走路速度一定來得及）', reachBad + ' 階超距');

  /* ---- 連續性限制 ---- */
  let spikeAdj = 0, runTooLong = 0;
  const runOf = {};
  for (let i = 0; i < layers.length; i++) {
    const kinds = layers[i].map(s => s.kind);
    if (i > 0 && kinds.indexOf(KIND.SPIKE) >= 0 && layers[i - 1].some(s => s.kind === KIND.SPIKE)) spikeAdj++;
    for (const k of [KIND.BELT, KIND.SPRING, KIND.SPIKE, KIND.FAKE]) {
      runOf[k] = kinds.indexOf(k) >= 0 ? (runOf[k] || 0) + 1 : 0;
      if (runOf[k] > C.MAX_SAME_RUN) runTooLong++;
    }
  }
  ok(spikeAdj === 0, difficulty + '：刺階不連續出現', spikeAdj + ' 次相鄰');
  ok(runTooLong === 0, difficulty + '：同一種特殊階梯不連續超過 2 層', runTooLong + ' 次過長');

  /* ---- 保底安全落點：每 4 層至少一層是普通階或輸送帶 ---- */
  let windowBad = 0, unsafeRun = 0, worstUnsafeRun = 0;
  for (const layer of layers) {
    const safe = layer.some(s => Stairs.SAFE_KINDS.indexOf(s.kind) >= 0);
    unsafeRun = safe ? 0 : unsafeRun + 1;
    worstUnsafeRun = Math.max(worstUnsafeRun, unsafeRun);
    if (unsafeRun >= C.SAFE_WINDOW) windowBad++;
  }
  ok(windowBad === 0, difficulty + '：每 4 層至少有一層安全落點（最長連續不安全 ' + worstUnsafeRun + ' 層）');

  /* ---- 喘息點：每 12 層一個寬 5 格的普通階 ---- */
  let wideBad = 0;
  for (let i = C.WIDE_EVERY; i < layers.length; i += C.WIDE_EVERY) {
    const l = layers[i];
    if (!l[0].wide || l[0].kind !== KIND.NORMAL || Math.abs((l[0].x1 - l[0].x0) - C.WIDE_WIDTH) > 1e-9) wideBad++;
  }
  ok(wideBad === 0, difficulty + '：每 12 層都有一個寬 5 格的普通階當喘息點', wideBad + ' 層缺少');

  /* ---- 彈簧不緊接在刺階正下方 ---- */
  let springUnderSpike = 0;
  for (let i = 1; i < layers.length; i++) {
    for (const st of layers[i]) {
      if (st.kind !== KIND.SPRING) continue;
      for (const prev of layers[i - 1]) {
        if (prev.kind === KIND.SPIKE && Stairs.spanGap(st.x0, st.x1, prev.x0, prev.x1) <= 0) springUnderSpike++;
      }
    }
  }
  ok(springUnderSpike === 0, difficulty + '：彈簧階不緊接在刺階正下方', springUnderSpike + ' 次');

  /* ---- 無死路：貪心走完一萬層 ---- */
  const w = walk(layers);
  console.log('    貪心走完：被迫踩刺／假階 ' + w.forcedUnsafe + ' 次（最長連續 ' + w.worstRun +
    '），最遠一次要橫走 ' + w.maxNeeded.toFixed(2) + ' 格');
  ok(w.deadEnds === 0, difficulty + '：一萬層零死路（每一層都有走得到的落點）',
    w.deadEnds + ' 層走不到，前幾層：' + w.firstDeadEnd.join(','));
  ok(w.worstRun <= 3, difficulty + '：不會被連續逼著踩刺或假階超過 3 層（實際 ' + w.worstRun + '）');

  /* ---- 出生平台 ---- */
  const first = layers[0][0];
  ok(first.spawn === true && first.depth === 0 && Math.abs((first.x1 - first.x0) - C.SPAWN_WIDTH) < 1e-9,
    difficulty + '：第 0 層是出生大平台（寬 ' + Stairs.C.SPAWN_WIDTH + ' 格）');
}

/* ---- 同 seed 完全重現 ---- */
console.log('\n【重現性】');
{
  const a = JSON.stringify(build('repeat-me', 'normal'));
  const b = JSON.stringify(build('repeat-me', 'normal'));
  ok(a === b, '同一個 seed 產生完全一樣的一萬層');
  const c = JSON.stringify(build('repeat-me', 'hard'));
  ok(a !== c, '難度不同就長出不一樣的樓梯');
  const pure = Stairs.makeStairs('repeat-me', 'normal', 0, 200);
  const gen = Stairs.createGen('repeat-me', 'normal');
  const inc = [];
  while (gen.depth < 200) inc.push(...Stairs.nextLayer(gen));
  ok(JSON.stringify(pure) === JSON.stringify(inc.filter(s => s.depth <= 200)),
    'makeStairs（純函式）與 createGen＋nextLayer（逐段生成）結果一致');
}

/* ---- 空隙一定看得出來過不過得去（Eric：「間隙判斷不夠明顯，以為能下去」） ---- */
console.log('\n【空隙的可讀性】');
{
  const PW = Rules.C.PLAYER_W;
  const MIN = Stairs.C.MIN_PASS;
  ok(MIN > PW + 0.5,
    '「一定過得去」的門檻比玩家寬度還多留半格以上（' + MIN + ' > ' + PW + '）');

  for (const diff of ['baby', 'easy', 'normal', 'hard']) {
    const gen = Stairs.createGen('gap-' + diff, diff);
    const layers = [];
    while (gen.layer < LAYERS) layers.push(Stairs.nextLayer(gen));
    let wallBad = 0, sepBad = 0, passable = 0;
    for (const layer of layers) {
      for (const st of layer) {
        /* 貼牆的縫：0（貼死）或 ≥ MIN，不允許中間的模糊值 */
        const left = st.x0;
        const right = Stairs.C.FIELD_W - st.x1;
        for (const g of [left, right]) {
          if (g > 1e-9 && g < MIN - 1e-9) wallBad++;
          if (g >= MIN - 1e-9) passable++;
        }
      }
      if (layer.length === 2) {
        const sep = Stairs.spanGap(layer[0].x0, layer[0].x1, layer[1].x0, layer[1].x1);
        if (sep > 1e-9 && sep < MIN - 1e-9) sepBad++;
        else if (sep >= MIN - 1e-9) passable++;
      }
    }
    ok(wallBad === 0, diff + '：牆邊沒有「看起來能過、其實過不去」的細縫', wallBad + ' 處');
    ok(sepBad === 0, diff + '：同一層兩階之間也沒有模糊的細縫', sepBad + ' 處');
    ok(gen.blurry === 0, diff + '：不需要為了可達性放行模糊細縫', gen.blurry + ' 層');
    ok(passable > LAYERS * 0.5, diff + '：真的過得去的縫夠多（不是靠塞滿階梯規避）',
      passable + ' 處 / ' + LAYERS + ' 層');
  }
}

/* ---- 垂直空間夠玩家站（角色放大之後要重新確認） ---- */
{
  ok(Stairs.C.GAP_MIN > Rules.C.PLAYER_H + 0.5,
    '層間最小垂直間距容得下放大後的角色再加半格（' + Stairs.C.GAP_MIN + ' > ' + Rules.C.PLAYER_H + '）');
}

console.log('\n────────────────────────────');
console.log(pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n失敗項目：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
