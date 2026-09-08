/* ===== stairs.js — 樓梯程序生成器（純函式、可重現、保證可達） =====
 *
 * 規劃書 §3。重點：
 *   1. 同一個 seed + 同一個難度 → 完全同一座樓梯（測試、線上同步都靠這個）。
 *   2. 無限往下，一次只算鏡頭附近的區段（呼叫端負責丟掉太上面的舊階梯）。
 *   3. 可達性用「直接算出合法的 x 範圍再抽」，不是抽完再退回重抽，
 *      所以生成不會失敗，也保證每一層都走得到。
 *
 * 座標：x 往右 0～12（場地寬 12 格），depth 往下為正，1 格 = 1 公尺。
 * 每一階是 { id, layer, depth, x0, x1, kind, belt?, wide?, spawn? }，
 * depth 是「踩得到的上表面」。
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const RNG = isNode ? require('./rng.js') : root.RNG;
  const api = factory(RNG);
  if (isNode) module.exports = api;
  else root.Stairs = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  /* 五種階梯（規劃書 §1.3） */
  const KIND = {
    NORMAL: 'normal',   /* 普通階：木頭／磚塊，站著不動 */
    BELT: 'belt',       /* 輸送帶：滾輪＋箭頭，帶著走 ±3 格／秒 */
    SPRING: 'spring',   /* 彈簧跳床：踩到往上彈 */
    SPIKE: 'spike',     /* 刺階：紅底尖刺，踩到 −1 愛心 */
    FAKE: 'fake'        /* 假階：偏白有裂痕，0.25 秒後崩解 */
  };
  const KIND_LIST = [KIND.NORMAL, KIND.BELT, KIND.SPRING, KIND.SPIKE, KIND.FAKE];
  /** 安全落點＝普通階或輸送帶（規劃書 §3「保底安全落點」） */
  const SAFE_KINDS = [KIND.NORMAL, KIND.BELT];

  const C = {
    FIELD_W: 12.0,        /* 場地寬（格），左右是牆 */
    GAP_MIN: 2.0,         /* 層間垂直間距下限 */
    GAP_MAX: 3.0,         /* 層間垂直間距上限 */
    WIDTH_MIN: 2.5,       /* 一般階梯寬下限 */
    WIDTH_MAX: 4.0,       /* 一般階梯寬上限 */
    SPAWN_WIDTH: 8.0,     /* 第 0 層出生大平台（唯一的例外層） */
    WIDE_WIDTH: 5.0,      /* 喘息點的較寬普通階 */
    WIDE_EVERY: 12,       /* 每 12 層一個喘息點 */
    SAFE_WINDOW: 4,       /* 每 4 層至少一層安全落點 */
    MAX_SAME_RUN: 2,      /* 同一種特殊階梯不連續超過 2 層 */
    WALK_SPEED: 6.0,      /* 走路速度（格／秒），可達性算式用 */
    GRAVITY: 30.0,        /* 重力（格／秒²），可達性算式用 */
    REACH_SAFETY: 0.8,    /* 可達性安全係數（規劃書 §3 的 ×0.8） */
    TWO_STEP_CHANCE: 0.18,/* 「偶爾兩階」的機率 */
    TWO_STEP_MIN_GAP: 0.9,/* 同一層兩階之間至少留這麼寬，免得看起來像一整片 */
    TWO_STEP_MAX_SEP: 6.0,/* 同一層兩階最遠只能隔這麼開；理由見 x0RangeAll() 的註解 */
    BELT_RATE: 0.14,      /* ★ 規劃書沒給輸送帶比例，這是實作假設值（見 README 待確認清單） */
    SPRING_RATE: 0.10     /* ★ 規劃書沒給彈簧比例，這是實作假設值（見 README 待確認清單） */
  };

  /**
   * 各難度的刺階／假階比例（規劃書 §1.7）。
   * 只有這兩個比例跟樓梯生成有關，所以放在生成器這邊當單一來源，
   * rules.js 的難度表直接讀這裡，避免兩邊各寫一份而漂移。
   */
  const RATES = {
    baby:   { spike: 0.00, fake: 0.00 },   /* 幼幼班：完全不出現 */
    easy:   { spike: 0.08, fake: 0.08 },
    normal: { spike: 0.14, fake: 0.14 },
    hard:   { spike: 0.20, fake: 0.18 }
  };

  function ratesOf(difficulty) {
    if (difficulty && typeof difficulty === 'object') {
      return { spike: Number(difficulty.spike) || 0, fake: Number(difficulty.fake) || 0 };
    }
    return RATES[difficulty] || RATES.normal;
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /** 兩段水平區間之間的空隙（重疊就是 0） */
  function spanGap(a0, a1, b0, b1) {
    if (a1 < b0) return b0 - a1;
    if (b1 < a0) return a0 - b1;
    return 0;
  }

  /**
   * 從上一層落到這一層，走路來得及涵蓋的水平距離。
   * 落下時間 t = √(2·gap/g)，可涵蓋距離 = t × 走路速度 × 0.8（規劃書 §3）。
   * 「水平距離」在這裡定義為兩階水平區間之間的空隙（邊到邊，重疊算 0），
   * 因為玩家站在上一階時就能先走到靠近的那一端，這是物理上真正需要跨越的距離。
   */
  function reachSpan(gap) {
    const t = Math.sqrt(2 * gap / C.GRAVITY);
    return t * C.WALK_SPEED * C.REACH_SAFETY;
  }

  /** 建立生成器狀態（不含已產出的階梯，階梯由呼叫端保管與丟棄） */
  function createGen(seed, difficulty) {
    return {
      seed: String(seed),
      rates: ratesOf(difficulty),
      rng: RNG.create('stairs|' + seed + '|' + JSON.stringify(ratesOf(difficulty))),
      layer: 0,                 /* 下一層要產出的編號 */
      depth: 0,                 /* 上一層的深度 */
      prev: null,               /* 上一層：{ depth, steps: [...] } */
      run: { belt: 0, spring: 0, spike: 0, fake: 0 },  /* 特殊階連續幾層 */
      unsafeRun: 0              /* 連續幾層沒有安全落點 */
    };
  }

  /** 這一層可以用哪些種類（套完所有連續性限制） */
  function allowedKinds(gen, isWide, mustSafe) {
    if (isWide) return [KIND.NORMAL];                   /* 喘息點固定普通階 */
    if (mustSafe) return SAFE_KINDS.slice();            /* 保底安全落點 */
    const out = [KIND.NORMAL];
    const prevKinds = gen.prev ? gen.prev.steps.map(s => s.kind) : [];
    for (const k of [KIND.BELT, KIND.SPRING, KIND.SPIKE, KIND.FAKE]) {
      if (gen.run[k] >= C.MAX_SAME_RUN) continue;                       /* 不連續超過 2 層 */
      if (k === KIND.SPIKE && prevKinds.indexOf(KIND.SPIKE) >= 0) continue; /* 刺階不連續出現 */
      if (k === KIND.SPIKE && gen.rates.spike <= 0) continue;
      if (k === KIND.FAKE && gen.rates.fake <= 0) continue;
      out.push(k);
    }
    return out;
  }

  function pickKind(gen, allowed) {
    const weight = {};
    weight[KIND.BELT] = C.BELT_RATE;
    weight[KIND.SPRING] = C.SPRING_RATE;
    weight[KIND.SPIKE] = gen.rates.spike;
    weight[KIND.FAKE] = gen.rates.fake;
    let special = 0;
    const items = [];
    for (const k of allowed) {
      if (k === KIND.NORMAL) continue;
      const w = weight[k] || 0;
      if (w > 0) { items.push({ v: k, w: w }); special += w; }
    }
    if (allowed.indexOf(KIND.NORMAL) >= 0) items.push({ v: KIND.NORMAL, w: Math.max(0.02, 1 - special) });
    if (!items.length) return KIND.NORMAL;
    return gen.rng.weighted(items);
  }

  /**
   * 算出「以 prevStep 為起跳點、寬度 width」時，新階左端 x0 的合法範圍。
   * 由 spanGap ≤ span 反解：x0 ≤ p1 + span 且 x0 + width ≥ p0 − span。
   */
  function x0Range(prevStep, width, span) {
    const lo = Math.max(0, prevStep.x0 - span - width);
    const hi = Math.min(C.FIELD_W - width, prevStep.x1 + span);
    if (lo > hi) {
      /* 只會發生在超寬階貼牆的極端情況：直接對齊上一階，空隙 0 一定走得到 */
      const x = clamp(prevStep.x0, 0, C.FIELD_W - width);
      return { lo: x, hi: x };
    }
    return { lo: lo, hi: hi };
  }

  /**
   * 對「上一層的每一階」都可達的 x0 範圍（各自範圍的交集）。
   *
   * 為什麼要交集而不是隨便挑一階當起跳點：上一層若有兩階，玩家可能站在任何一階上，
   * 只保證從其中一階走得到，站在另一階的人就會遇到死路。
   * 兩階同層的最大間隔（TWO_STEP_MAX_SEP = 6.0）就是從這裡反推的：
   * 交集非空的條件是「右階左緣 − 左階右緣 ≤ 2·span + width」，
   * 最壞情況（間距 2.0 格 → span ≈ 1.79、階寬最小 2.5）算出來是 6.07，取 6.0 保守值。
   */
  function x0RangeAll(prevSteps, width, span) {
    let lo = 0, hi = C.FIELD_W - width;
    for (const p of prevSteps) {
      const r = x0Range(p, width, span);
      lo = Math.max(lo, r.lo);
      hi = Math.min(hi, r.hi);
    }
    if (lo > hi) return x0Range(prevSteps[0], width, span);   /* 理論上不會發生，留個保險 */
    return { lo: lo, hi: hi };
  }

  function makeStep(gen, layer, n, depth, x0, width, kind) {
    const step = {
      id: 'L' + layer + '-' + n,
      layer: layer,
      depth: depth,
      x0: x0,
      x1: x0 + width,
      kind: kind
    };
    if (kind === KIND.BELT) step.belt = gen.rng.chance(0.5) ? 1 : -1;
    return step;
  }

  /** 產生下一層，回傳這一層的階梯陣列（1 階，偶爾 2 階） */
  function nextLayer(gen) {
    /* ---- 第 0 層：寬 8 格的出生大平台，唯一的例外層 ---- */
    if (gen.layer === 0) {
      const x0 = (C.FIELD_W - C.SPAWN_WIDTH) / 2;
      const step = makeStep(gen, 0, 0, 0, x0, C.SPAWN_WIDTH, KIND.NORMAL);
      step.spawn = true;
      step.wide = true;
      gen.prev = { depth: 0, steps: [step] };
      gen.depth = 0;
      gen.layer = 1;
      gen.unsafeRun = 0;
      return [step];
    }

    const layer = gen.layer;
    const gap = gen.rng.range(C.GAP_MIN, C.GAP_MAX);
    const depth = gen.depth + gap;
    const span = reachSpan(gap);
    const isWide = layer % C.WIDE_EVERY === 0;
    const mustSafe = gen.unsafeRun >= C.SAFE_WINDOW - 1;
    const allowed = allowedKinds(gen, isWide, mustSafe);
    const prevSteps = gen.prev.steps;
    const prevSpikes = prevSteps.filter(s => s.kind === KIND.SPIKE);

    /* ---- 主階 ---- */
    let kind = pickKind(gen, allowed);
    const width = isWide ? C.WIDE_WIDTH : gen.rng.range(C.WIDTH_MIN, C.WIDTH_MAX);
    const r = x0RangeAll(prevSteps, width, span);
    const x0 = gen.rng.range(r.lo, r.hi);
    /* 彈簧階不緊接在刺階正下方（彈上去馬上被頂又落回刺上，太惡意） */
    if (kind === KIND.SPRING && prevSpikes.some(s => spanGap(x0, x0 + width, s.x0, s.x1) <= 0)) {
      kind = KIND.NORMAL;
    }
    const steps = [makeStep(gen, layer, 0, depth, x0, width, kind)];

    /* ---- 偶爾兩階 ---- */
    if (!isWide && gen.rng.chance(C.TWO_STEP_CHANCE)) {
      const w2 = gen.rng.range(C.WIDTH_MIN, C.WIDTH_MAX);
      const r2 = x0RangeAll(prevSteps, w2, span);
      let placed = null;
      for (let attempt = 0; attempt < 12 && !placed; attempt++) {
        const cand = gen.rng.range(r2.lo, r2.hi);
        const sep = spanGap(cand, cand + w2, steps[0].x0, steps[0].x1);
        /* 太近看起來像一整片，太遠會讓下一層找不到「兩邊都走得到」的落點 */
        if (sep >= C.TWO_STEP_MIN_GAP && sep <= C.TWO_STEP_MAX_SEP) placed = cand;
      }
      if (placed !== null) {
        const allowed2 = mustSafe ? allowed : allowedKinds(gen, false, false);
        let kind2 = pickKind(gen, allowed2);
        /* 同一層不放兩個刺階，免得整層變成死路的觀感 */
        if (kind2 === KIND.SPIKE && kind === KIND.SPIKE) kind2 = KIND.NORMAL;
        if (kind2 === KIND.SPRING && prevSpikes.some(s => spanGap(placed, placed + w2, s.x0, s.x1) <= 0)) {
          kind2 = KIND.NORMAL;
        }
        steps.push(makeStep(gen, layer, 1, depth, placed, w2, kind2));
      }
    }

    /* ---- 更新連續性計數 ---- */
    const kinds = steps.map(s => s.kind);
    for (const k of [KIND.BELT, KIND.SPRING, KIND.SPIKE, KIND.FAKE]) {
      gen.run[k] = kinds.indexOf(k) >= 0 ? gen.run[k] + 1 : 0;
    }
    gen.unsafeRun = kinds.some(k => SAFE_KINDS.indexOf(k) >= 0) ? 0 : gen.unsafeRun + 1;
    if (isWide) steps[0].wide = true;

    gen.prev = { depth: depth, steps: steps };
    gen.depth = depth;
    gen.layer = layer + 1;
    return steps;
  }

  /** 一直生成到「最後一層的深度 ≥ toDepth」，回傳這次新產生的階梯（增量） */
  function advance(gen, toDepth) {
    const fresh = [];
    let guard = 0;
    while (gen.depth < toDepth || gen.layer === 0) {
      const layerSteps = nextLayer(gen);
      for (const s of layerSteps) fresh.push(s);
      if (++guard > 200000) break;   /* 保險：不讓錯誤的參數把瀏覽器鎖死 */
    }
    return fresh;
  }

  /**
   * 純函式版本（規劃書 §3 的簽名）：從第 0 層算起，取回 [fromDepth, toDepth] 之間的階梯。
   * 測試與工具用；遊戲中請用 createGen + advance 逐段生成，才不會每次都從頭算。
   */
  function makeStairs(seed, difficulty, fromDepth, toDepth) {
    const gen = createGen(seed, difficulty);
    const all = advance(gen, toDepth);
    const lo = Number(fromDepth) || 0;
    return all.filter(s => s.depth >= lo && s.depth <= toDepth);
  }

  return {
    KIND, KIND_LIST, SAFE_KINDS, RATES, C,
    createGen, nextLayer, advance, makeStairs,
    ratesOf, reachSpan, spanGap, x0Range, x0RangeAll
  };
});
