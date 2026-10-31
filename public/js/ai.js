/* ===== ai.js — 電腦對手（四段 ＋ 神話） =====
 *
 * 規劃書 §5。AI 只輸出 { dir: -1 | 0 | 1 }，跟真人走同一個輸入管道，不作弊：
 *   - 只看得到 state.steps 裡「已經生成」的階梯（也就是畫面附近那一段），
 *     而且還會依難度再砍成「預看 N 層」，看不到更下面的東西。
 *   - 不加速、不改血量、不改物理，全部都由 rules.js 算。
 *
 * 決策方式（§5）：對每一個「走得到的落點」評分 —— 落點安全性、要橫走多遠、
 * 離天花板的餘裕、對手位置（困難才加權）—— 取最高分，方向就是往那個落點走。
 * 規劃書寫的是「對往左／不動／往右各評分」，這裡改成先挑落點再換成方向，
 * 結果一樣但穩定得多：這款遊戲沒有跳鍵，想往下一定要先走出腳下那一階的邊緣，
 * 直接對三個方向評分很容易在邊緣來回抖而永遠走不出去。
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const RNG = isNode ? require('./rng.js') : root.RNG;
  const Stairs = isNode ? require('./stairs.js') : root.Stairs;
  const Rules = isNode ? require('./rules.js') : root.Rules;
  const api = factory(RNG, Stairs, Rules);
  if (isNode) module.exports = api;
  else root.Ai = api;
})(typeof self !== 'undefined' ? self : this, function (RNG, Stairs, Rules) {
  'use strict';

  const KIND = Stairs.KIND;
  const C = Rules.C;

  /**
   * 四段 AI 的行為參數（規劃書 §5 的表）。
   *   react     反應延遲（秒）：每隔這麼久才重新決策一次，中間沿用上一個方向
   *   lookahead 預看層數：只考慮下方這麼多層的階梯
   *   avoid     各種階梯的嫌惡程度（分數，越大越避）
   *   springUse 彈簧的看法：0 當普通階、負值＝喜歡（救命用）、正值＝避開
   *   wideBonus 挑寬階的偏好（困難才有）
   *   layerCost 每往下多一層要付的代價：正值＝保守（只挑最近的下一層），
   *             負值＝積極往下鑽（跳過幾層直接落到更深的地方）。
   *             這是四段 AI「深度」拉開差距的主要來源 —— 光靠失誤率的話，
   *             普通與困難都會被鏡頭速度綁住而打平。
   *   push      推人的積極度（0＝不推）
   *   mistake   每次決策的失誤率
   *   idleSlip  失誤時「乾脆不動」的比例（幼幼班常常撞牆停住）
   */
  const LEVELS = {
    baby: {
      name: '幼幼班', react: 0.50, lookahead: 1,
      avoid: { spike: 0.15, fake: 0.15, belt: 0 }, springUse: 0, wideBonus: 0,
      layerCost: 1.1, push: 0, mistake: 0.32, idleSlip: 0.7
    },
    easy: {
      name: '簡單', react: 0.32, lookahead: 2,
      avoid: { spike: 9, fake: 1.2, belt: 0.3 }, springUse: 0.5, wideBonus: 0,
      layerCost: 0.7, push: 0, mistake: 0.16, idleSlip: 0.45
    },
    normal: {
      name: '普通', react: 0.18, lookahead: 3,
      avoid: { spike: 14, fake: 8, belt: 0.6 }, springUse: 3, wideBonus: 0.2,
      layerCost: 0.25, push: 0.35, mistake: 0.06, idleSlip: 0.25
    },
    hard: {
      name: '困難', react: 0.08, lookahead: 5,
      avoid: { spike: 18, fake: 12, belt: 0.8 }, springUse: 4, wideBonus: 1.2,
      layerCost: -0.55, push: 1.0, mistake: 0.015, idleSlip: 0.1
    },
    /* 神話：只有「跟電腦對戰」才選得到的第五段，不是遊戲難度（物理、傷害、下捲速度
     * 仍然看玩家選的遊戲難度）。比困難多了：每一格都重新決策（react 0.02）、
     * 完全不失誤、看得更深、對刺與假階幾乎零容忍，並且會主動貼近對手把他往危險那邊擠。
     * 一樣只輸出 -1／0／1，不改血量、不加速、不偷看還沒生成的階梯。 */
    mythic: {
      name: '神話', react: 0.08, lookahead: 8,
      avoid: { spike: 40, fake: 26, belt: 1.0 }, springUse: 4, wideBonus: 1.5,
      layerCost: -0.75, push: 2.2, mistake: 0, idleSlip: 0,
      /* 神話獨有：往前「模擬」規則核心 plan 秒（假設對手維持現在的動作），
       * 挑掉血最少、下得最深、能把對手擠進危險的那一串動作 */
      plan: 0.8, planEvery: 0.1
    }
  };
  /* LEVEL_LIST ＝ 跟遊戲難度一一對應的四段；AI_LIST ＝ 再加上只給電腦對手用的神話 */
  const LEVEL_LIST = ['baby', 'easy', 'normal', 'hard'];
  const AI_LIST = LEVEL_LIST.concat(['mythic']);

  const EDGE = 0.22;      /* 落點至少要留這麼多重疊才算站得住 */
  const OUT = 0.55;       /* 要走出腳下這一階多少才會掉下去 */
  const HALF = C.PLAYER_W / 2;

  /** 這一階「身體中心站得住」的範圍 */
  function standable(st) {
    const lo = st.x0 - HALF + EDGE;
    const hi = st.x1 + HALF - EDGE;
    return lo <= hi ? [lo, hi] : [(st.x0 + st.x1) / 2, (st.x0 + st.x1) / 2];
  }

  /**
   * 建一個 AI 控制器。
   * @param {string} level  'baby' | 'easy' | 'normal' | 'hard'
   * @param {string} selfId 自己的 player id
   * @param {string|number} seed 讓同一個 seed 跑出同一套決策（測試與線上重現用）
   */
  function create(level, selfId, seed) {
    const cfg = LEVELS[level] || LEVELS.normal;
    const rng = RNG.create('ai|' + level + '|' + selfId + '|' + (seed == null ? 'x' : seed));
    let hold = 0;             /* 目前沿用的方向 */
    let wait = 0;             /* 距離下一次決策還有多久 */
    let slip = 0;             /* 失誤持續時間 */

    /** 這一格要往哪走 */
    function read(s, dtSec) {
      const me = s.players.find(p => p.id === selfId);
      if (!me || !me.alive || s.phase !== 'playing') return { dir: 0 };

      wait -= dtSec;
      slip -= dtSec;
      if (slip > 0) return { dir: hold };      /* 失誤中：繼續做錯的事 */
      if (wait > 0) return { dir: hold };      /* 反應延遲：沿用上一個決定 */
      wait = cfg.plan ? cfg.planEvery : cfg.react;

      /* 失誤：有時候乾脆不動（幼幼班常常撞牆停住），有時候往反方向 */
      if (rng.chance(cfg.mistake)) {
        hold = rng.chance(cfg.idleSlip) ? 0 : (rng.chance(0.5) ? -1 : 1);
        slip = cfg.react * rng.range(1, 2.5);
        return { dir: hold };
      }

      hold = cfg.plan ? plan(s, me, cfg, rng) : decide(s, me, cfg, rng);
      return { dir: hold };
    }

    return { read, level: level, cfg: cfg, get dir() { return hold; } };
  }

  /** 真正的決策：挑一個落點，方向就是往它走 */
  function decide(s, me, cfg, rng) {
    let cur = me.onStep ? Rules.stepById(s, me.onStep) : null;
    const foe = s.players.find(p => p.id !== me.id && p.alive) || null;
    /* 頭頂也是支撐面：要先走離對方身體，才能落到下方階梯。 */
    const onHead = !cur && foe && me.onPlayer === foe.id;
    if (onHead) cur = { x0: foe.x - HALF, x1: foe.x + HALF, depth: me.y };
    const exitMargin = onHead ? HALF + 0.08 : OUT;

    /* 只看下方 lookahead 層，看不到更下面的東西（不作弊） */
    const layers = [];
    for (const st of s.steps) {
      if (st.broken || st.flipLeft > 0) continue;
      if (st.depth <= me.y + 0.05) continue;
      let row = layers.find(r => Math.abs(r.depth - st.depth) < 0.01);
      if (!row) { row = { depth: st.depth, steps: [] }; layers.push(row); }
      row.steps.push(st);
    }
    layers.sort((a, b) => a.depth - b.depth);
    const visible = layers.slice(0, cfg.lookahead);
    if (!visible.length) return cur ? edgeDir(cur, me) : 0;

    /* 離天花板的餘裕：越少就越急著往下走 */
    const headroom = (me.y - C.PLAYER_H) - s.cameraTop;
    const panic = headroom < 3 ? (3 - headroom) : 0;

    let best = null;
    visible.forEach((row, depthRank) => {
      for (const st of row.steps) {
        const dst = standable(st);
        let target;
        if (cur) {
          /* 站在階梯上：一定要走出這一階的邊緣才掉得下去 */
          const opts = [];
          const L = cur.x0 - exitMargin, R = cur.x1 + exitMargin;
          if (L >= dst[0] - 1e-9 && L <= dst[1] + 1e-9) opts.push(L);
          if (R >= dst[0] - 1e-9 && R <= dst[1] + 1e-9) opts.push(R);
          if (!opts.length) continue;
          target = opts.reduce((a, b) => (Math.abs(a - me.x) <= Math.abs(b - me.x) ? a : b));
        } else {
          target = me.x < dst[0] ? dst[0] : me.x > dst[1] ? dst[1] : me.x;
        }
        if (target < HALF || target > C.FIELD_W - HALF) continue;

        /* 路徑要真的通：瞄準下面第 N 層沒有用，物理上會先被中間那幾層接住。
         * 所以只要中間有任何一階擋在「這一路橫移會經過的範圍」裡，這個落點就不算 ——
         * 反正那一階自己就是另一個候選落點。
         * 少了這一步，積極往下鑽的 AI 會一直誤踩中途的刺階。 */
        if (depthRank > 0) {
          const lo = Math.min(me.x, target) - HALF;
          const hi = Math.max(me.x, target) + HALF;
          let blocked = false;
          for (const other of s.steps) {
            if (other === st || other.broken || other.flipLeft > 0) continue;
            if (other.depth <= me.y + 0.05 || other.depth >= st.depth - 0.01) continue;
            if (other.x1 > lo + 1e-9 && other.x0 < hi - 1e-9) { blocked = true; break; }
          }
          if (blocked) continue;
        }

        /* ---- 評分（越小越好） ---- */
        let score = depthRank * cfg.layerCost;             /* 保守的挑最近一層，積極的往下鑽 */
        /* 但不能鑽到摔死：連續下墜約 16 格沒踩到東西就會沉出畫面，
         * 落在 12 格以內都還安全，超過就開始加重罰。 */
        const drop = st.depth - me.y;
        if (drop > 12) score += (drop - 12) * 3;
        score += Math.abs(target - me.x) * 0.22;           /* 要橫走多遠 */
        score += cfg.avoid[st.kind] || 0;                  /* 落點安全性 */
        if (st.kind === KIND.FLIP) {
          /* 可恢復且不造成傷害，風險接近輸送帶；倒數不足以落地時才排除。 */
          score += cfg.avoid.belt || 0;
          if (st.flipIn != null && st.flipIn < Math.sqrt(2 * drop / C.GRAVITY)) continue;
        }
        if (st.kind === KIND.SPRING) {
          /* 彈簧會把人往上彈：平常要避開，快被天花板頂到時反而不能踩 */
          score += cfg.springUse * (1 + panic);
        }
        if (st.wide) score -= cfg.wideBonus;               /* 困難會挑寬階 */
        score -= panic * 0.5;                              /* 快被頂到就別挑了，先往下 */
        /* 血量低的時候更不想冒險 */
        if (me.hp <= 2) score += (cfg.avoid[st.kind] || 0) * 0.5;

        /* 對手位置（困難才認真加權）：往對手那邊走順便把他推向危險 */
        if (foe && cfg.push > 0) {
          const toFoe = Math.sign(foe.x - me.x);
          const toTarget = Math.sign(target - me.x);
          const sameWay = toFoe !== 0 && toFoe === toTarget;
          const close = Math.abs(foe.x - me.x) < 2.2 &&
            Math.abs(foe.y - me.y) < C.PLAYER_H * 0.9;
          if (sameWay && close) score -= cfg.push * 0.8;
        }

        if (!best || score < best.score) best = { score: score, target: target };
      }
    });

    if (!best) return cur ? edgeDir(cur, me) : 0;
    const d = best.target - me.x;
    /* 站在階梯上時目標一定在這一階外側，所以不留死區，一路推到走出邊緣為止
     * （留死區的話站在輸送帶上會被帶著來回抖，永遠走不出去）。 */
    if (cur) return d > 0 ? 1 : -1;
    if (Math.abs(d) < 0.12) return 0;
    return d > 0 ? 1 : -1;
  }

  /**
   * 神話的決策：複製一份「只含已生成階梯」的局面，把規則核心往前跑 cfg.plan 秒，
   * 每個候選動作（先 a 再 b 兩段）各評分一次，取最高分的第一個方向。
   * 模擬用的是真正的 Rules.stepMatch，所以傷害、彈簧、假階崩解、推擠都算得準；
   * 但它只看得到已經生成的階梯、也不會改動真實局面（不作弊）。
   */
  function cloneForSim(s) {
    return {
      seed: s.seed, mode: s.mode, difficulty: s.difficulty, diff: s.diff, viewH: s.viewH,
      phase: s.phase, countdown: s.countdown, time: s.time, cameraTop: s.cameraTop,
      scrollMul: s.scrollMul, scrollSpeed: s.scrollSpeed, leadDepth: s.leadDepth,
      world: s.world, worldCycle: s.worldCycle, worldFade: s.worldFade,
      players: JSON.parse(JSON.stringify(s.players)),
      steps: JSON.parse(JSON.stringify(s.steps)),
      gen: { depth: Infinity },            /* 不往下生新階梯：看不到未生成的東西 */
      newSteps: [], goneSteps: [], result: null, endedBy: null
    };
  }

  function plan(s, me, cfg, rng) {
    const foe = s.players.find(p => p.id !== me.id) || null;
    const foeDir = foe ? (foe.dir || 0) : 0;
    const half = Math.max(1, Math.round(cfg.plan / 2 / C.STEP));
    let best = null;
    for (const a of [-1, 0, 1]) {
      for (const b of [-1, 0, 1]) {
        if (b === 0 && a !== 0) continue;           /* 先動再停意義不大，少算幾組 */
        const sim = cloneForSim(s);
        const mePl = sim.players.find(p => p.id === me.id);
        const foePl = foe ? sim.players.find(p => p.id === foe.id) : null;
        const hp0 = mePl.hp, fhp0 = foePl ? foePl.hp : 0;
        let minHead = Infinity;
        for (let i = 0; i < half * 2 && sim.phase !== 'over'; i++) {
          const inp = {};
          inp[me.id] = { dir: i < half ? a : b };
          if (foe) inp[foe.id] = { dir: foeDir };
          Rules.stepMatch(sim, inp, C.STEP_MS);
          if (mePl.alive) minHead = Math.min(minHead, (mePl.y - C.PLAYER_H) - sim.cameraTop);
        }
        let score = 0;
        if (!mePl.alive) score -= 1e6;
        score -= (hp0 - mePl.hp) * 10;                      /* 掉的血 */
        score += Math.min(mePl.y - me.y, 6) * 0.9;           /* 往下多深（封頂：沒階梯的空中不算進度） */
        if (mePl.alive && mePl.sinking > 0) score -= 20 + mePl.sinking * 10;   /* 快沉出畫面 */
        if (isFinite(minHead) && minHead < 1.2) score -= (1.2 - minHead) * 6;   /* 別被天花板頂 */
        if (foePl) {
          score += (fhp0 - foePl.hp) * cfg.push * 3;        /* 讓對手掉血 */
          if (!foePl.alive) score += 5e4;
        }
        /* 站不穩（空中、沒踩任何階）就小扣一點：落地才算數 */
        if (mePl.alive && !mePl.onStep) score -= 3;
        score -= (a === 0 && b === 0 ? 0 : 0.02) + rng.range(0, 1e-3);
        if (!best || score > best.score) best = { score: score, dir: a };
      }
    }
    return best ? best.dir : 0;
  }

  /** 沒有任何看得到的落點：往比較近的那一邊走出去，總比被天花板頂住好 */
  function edgeDir(cur, me) {
    return (cur.x1 - me.x) <= (me.x - cur.x0) ? 1 : -1;
  }

  return { create, LEVELS, LEVEL_LIST, AI_LIST, standable };
});
