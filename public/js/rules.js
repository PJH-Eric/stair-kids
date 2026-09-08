/* ===== rules.js — 小朋友下樓梯的規則核心 =====
 *
 * 這是全遊戲唯一的規則來源：單機在瀏覽器跑它，M2 之後由 Node 伺服器 require 同一支檔案，
 * AI 也只是產生和真人一模一樣格式的輸入。純函式、無 DOM、無 socket、無計時器。
 *
 * 座標（規劃書 §1.1）
 *   x：往右 0～12（場地寬 12 格），玩家的 x 是身體中心。
 *   depth／y：往下為正，1 格 = 1 公尺，玩家的 y 是腳底。
 *   玩家 AABB：x ∈ [x−0.5, x+0.5]，y ∈ [y−1.6, y]（頭在 y−1.6）。
 *
 * 時間：呼叫端用固定步長推進（Rules.STEP_MS），才能重播與同步。
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const RNG = isNode ? require('./rng.js') : root.RNG;
  const Stairs = isNode ? require('./stairs.js') : root.Stairs;
  const api = factory(RNG, Stairs);
  if (isNode) module.exports = api;
  else root.Rules = api;
})(typeof self !== 'undefined' ? self : this, function (RNG, Stairs) {
  'use strict';

  const KIND = Stairs.KIND;

  const C = {
    STEP: 1 / 60,                /* 固定步長（秒） */
    STEP_MS: 1000 / 60,          /* 固定步長（毫秒），stepMatch 收的是毫秒 */
    FIELD_W: Stairs.C.FIELD_W,   /* 場地寬 12 格 */
    VIEW_H: 14,                  /* 可見高度（格）。18 → 14 是為了把畫面拉近。
                                  * 每一格的像素變大 → 角色變明顯、場地那 12 格的可操作寬度
                                  * 也跟著吃掉更多畫面寬（近正方形視窗實測 66% → 76%）。
                                  * 這條線同時是「掉出畫面就摔死」的死亡線，所以 CAMERA_LEAD
                                  * 要一起往上收，落後的緩衝才不會被壓掉。 */
    VIEW_H_SHORT: 12,            /* 手機橫向縮短的可見高度（規劃書 §7.1） */
    CAMERA_LEAD: 8.5,            /* 鏡頭跟在「最深存活者 − 8.5 格」，領先者維持在畫面下方 6/10；
                                  * 死亡線之前還留 5.5 格＝約 0.55 秒的下沉緩衝（跟改動前一樣）。 */
    CAMERA_CATCHUP: 8.0,         /* 鏡頭最高追隨速度（格／秒）。
                                  * 這是「掉出畫面外會摔死」成立的關鍵：自由落體最快 18 格／秒，
                                  * 追不上的那 10 格／秒就是你往畫面下緣沉下去的速度。
                                  * 實測連續踩空約 16 格（5～6 層）就會沉出畫面。 */
    SINK_WARN: 2.0,              /* 比正常位置低這麼多格就開始在畫面下緣警示 */
    PLAYER_W: 1.25,              /* 角色放大：1.0 → 1.25 格（畫面上寬了 25%），
                                  * 這樣「這條縫我塞不塞得進去」用眼睛就判斷得出來。
                                  * 高寬比固定 1.6，SVG 的 100×160 本地座標才不會變形。 */
    PLAYER_H: 2.0,
    MOVE_SPEED: 6.0,             /* 水平速度（格／秒），按住就是等速、無加速度 */
    GRAVITY: 30.0,               /* 重力（格／秒²） */
    MAX_FALL: 18.0,              /* 最大落速（格／秒），避免穿階 */
    BELT_SPEED: 3.0,             /* 輸送帶帶動速度：逆走剩 6 − 3 = 3 格／秒 */
    SPRING_VY: 9.0,              /* ★ 彈簧向上初速（規劃書 §1.3）；見 README 待確認清單第 1 條 */
    SPIKE_DAMAGE: 1,             /* 保留給幼幼班等沒有傷害表的情況；實際扣血看 rollSpikeDamage() */
    SPIKE_DEEP_WORLDS: 3,        /* 傷害從「淺處範圍」推到「深處範圍」要幾個世界（＝300 公尺） */
    INVULN: 0.6,                 /* 扣血後的無敵閃爍（只擋「同類」傷害） */
    FAKE_DELAY: 0.25,            /* 假階踩到幾秒後崩解 */
    SPIKE_FLASH: 0.22,           /* 踩到刺時那一階閃白光的長度（純畫面，render.js 用同一個值） */
    CEIL_PUSH: 14.0,             /* 被天花板刺到時往下推的初速（格／秒）。
                                  * 一定要大於保底下捲，否則玩家會「黏」在天花板上：
                                  * 位置每 tick 被夾回 cameraTop+1.6，只能跟著鏡頭走，
                                  * 每踩一階掉 1 顆血，8 秒內必死，完全沒有自主權。 */
    HEAL_ON_LAND: 1,             /* 踩到非刺的階梯回復幾顆愛心（參考原作） */
    MILESTONE: 100,              /* 每 100 公尺慶祝＋換世界 */
    WORLD_COUNT: 6,              /* 六套世界，用完循環並套夜間配色 */
    KEEP_ABOVE: 30,              /* 鏡頭上方保留幾格的舊階梯 */
    KEEP_BELOW: 30,              /* 鏡頭下方預先生成幾格 */
    COUNTDOWN_SOLO: 2.0,         /* 一人挑戰倒數 2 秒 */
    COUNTDOWN_VERSUS: 3.0,       /* 對戰倒數 3 秒 */
    SPAWN_GAP: 3.0               /* 對戰時兩人在出生平台上的間距 */
  };

  /**
   * 四段難度（規劃書 §1.7）。
   * 刺階／假階比例是樓梯生成的參數，單一來源在 stairs.js 的 RATES，這裡只是引用。
   */
  function makeDifficulty(id, name, scrollBase, accelEvery, accelRate, scrollCap, hp, ceilInterval, opt) {
    const rates = Stairs.RATES[id];
    return Object.assign({
      id: id,
      name: name,
      scrollBase: scrollBase,     /* 保底下捲速度（格／秒） */
      accelEvery: accelEvery,     /* 每幾秒加速一次 */
      accelRate: accelRate,       /* 每次加速幾 % */
      scrollCap: scrollCap,       /* 速度上限（倍） */
      hp: hp,                     /* 血量（愛心數） */
      ceilInterval: ceilInterval, /* 被天花板頂住幾秒 −1；null＝不扣血 */
      spikeRate: rates.spike,
      fakeRate: rates.fake,
      cloudCeiling: false,        /* 天花板畫成雲朵（幼幼班） */
      hpAsNumber: false,          /* 愛心＋數字顯示（幼幼班 20 顆太長） */
      endless: false,             /* 沒有終點，靠「結束這局」收局 */
      versus: true,               /* 是否開放對戰 */
      fallOut: true,              /* 掉出畫面下緣會摔死 */
      cameraCatchup: C.CAMERA_CATCHUP  /* 鏡頭追隨上限；null ＝ 無上限（永遠追得上，沉不出去） */
    }, opt || {});
  }

  const DIFFICULTY = {
    /* 幼幼班照 §0.2 的「鼓勵式不死」：鏡頭永遠追得上，所以不可能沉出畫面，也不會摔死 */
    baby: makeDifficulty('baby', '幼幼班', 1.2, 30, 0.05, 1.5, 20, null,
      { cloudCeiling: true, hpAsNumber: true, endless: true, versus: false,
        fallOut: false, cameraCatchup: null, spikeDamage: null }),
    /* 三段對戰難度刻意拉開（Eric：「難易度不太明顯」）。
     * 「大概被刺幾次會死」＝ hp ÷ 平均傷害：簡單 ≈ 9 次、普通 ≈ 5 次、困難 ≈ 2～3 次。 */
    easy: makeDifficulty('easy', '簡單', 1.8, 22, 0.08, 1.8, 14, 1.2,
      { spikeDamage: { base: [1, 2], deep: [1, 3] } }),
    normal: makeDifficulty('normal', '普通', 2.8, 20, 0.12, 2.2, 10, 0.6,
      { spikeDamage: { base: [1, 3], deep: [2, 4] } }),
    hard: makeDifficulty('hard', '困難', 3.6, 18, 0.15, 2.6, 9, 0.4,
      { spikeDamage: { base: [2, 3], deep: [3, 5] } })
  };
  const DIFFICULTY_LIST = ['baby', 'easy', 'normal', 'hard'];

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const EPS = 1e-9;

  /* ---------- 建立一局 ---------- */

  function newPlayer(def, index, spawnX, diff) {
    return {
      id: def.id,
      name: def.name || ('玩家' + (index + 1)),
      char: def.char || 'ami',
      index: index,
      kind: def.kind || 'human',      /* 'human' | 'ai'，AI 走同一個輸入管道 */
      aiLevel: def.aiLevel || null,
      x: spawnX,
      y: 0,                            /* 腳底站在第 0 層出生平台上 */
      vy: 0,
      dir: 0,
      face: 0,                         /* -1 面向左、1 面向右、0 面向前方（沒在動） */
      hp: diff.hp,
      hpMax: diff.hp,
      depth: 0,
      best: 0,
      onStep: 'L0-0',
      state: 'idle',                   /* idle｜walk｜fall｜spring｜spike｜ceiling｜stun */
      invuln: 0,
      ceilAccum: 0,
      hurtBy: null,                    /* 最近一次扣血的來源，前端用來決定要播哪一種受傷特效 */
      hurtAmount: 0,                   /* 最近一次扣了幾顆（傷害是 1～5 隨機，畫面要顯示數字） */
      ceilHits: 0,                     /* 被天花板刺到幾次；當亂數的 tag，保證回溯重演算出同一個值 */
      ceilCool: 0,                     /* 天花板扣血的冷卻（秒），碰到就立刻扣、之後要等冷卻 */
      sinking: 0,                      /* 比正常位置低幾格（超過 SINK_WARN 才算，給前端做警示強度） */
      fell: false,                     /* 是不是掉出畫面下緣摔死的 */
      pressed: false,
      alive: true,
      aliveTime: 0,
      flash: 0,
      hurtFlash: 0,
      healFlash: 0,
      overlapWith: null,
      stats: { spikes: 0, springs: 0, fakes: 0, ceilingSeconds: 0, pushes: 0, heals: 0, deepestWorld: 0 }
    };
  }

  /**
   * @param {object} cfg
   *   difficulty  'baby' | 'easy' | 'normal' | 'hard'
   *   mode        'solo'（一人挑戰）| 'versus'（2 人／對電腦，M1 之後）
   *   players     [{ id, name, char, kind, aiLevel }]
   * @param {string|number} seed 每一局都要換新的（不做同座樓梯重打）
   */
  function createMatch(cfg, seed) {
    cfg = cfg || {};
    const diff = DIFFICULTY[cfg.difficulty] || DIFFICULTY.normal;
    const mode = cfg.mode === 'versus' ? 'versus' : 'solo';
    const useSeed = seed != null ? String(seed) : (cfg.seed != null ? String(cfg.seed) : RNG.newSeed());
    const defs = (cfg.players && cfg.players.length ? cfg.players : [{ id: 'p1', name: '小玩家' }]).slice(0, 2);

    const gen = Stairs.createGen(useSeed, diff.id);
    const steps = Stairs.advance(gen, C.VIEW_H + C.KEEP_BELOW);

    /* 出生點：一人挑戰站平台正中間；對戰左右分開站（規劃書 §7.3） */
    const mid = C.FIELD_W / 2;
    const players = defs.map((def, i) => {
      const spawnX = defs.length > 1
        ? (i === 0 ? mid - C.SPAWN_GAP / 2 : mid + C.SPAWN_GAP / 2)
        : mid;
      return newPlayer(def, i, spawnX, diff);
    });

    return {
      seed: useSeed,
      mode: mode,
      difficulty: diff.id,
      diff: diff,
      phase: 'countdown',            /* countdown｜playing｜over */
      countdown: mode === 'versus' ? C.COUNTDOWN_VERSUS : C.COUNTDOWN_SOLO,
      time: 0,                       /* 開始後經過的秒數（倒數不算） */
      cameraTop: -C.CAMERA_LEAD,     /* 天花板永遠貼在 cameraTop */
      scrollMul: 1,
      scrollSpeed: diff.scrollBase,
      leadDepth: 0,
      world: 0,
      worldCycle: 0,
      worldFade: 0,                  /* 換世界過場的剩餘秒數（0.8 秒漸變） */
      players: players,
      steps: steps,
      gen: gen,
      newSteps: steps.slice(),       /* 這個 tick 新生成的階梯（M2 增量廣播用） */
      goneSteps: [],
      result: null,
      endedBy: null
    };
  }

  /* ---------- 查詢小工具 ---------- */

  const stepById = (s, id) => {
    for (const st of s.steps) if (st.id === id) return st;
    return null;
  };
  /** 玩家腳下這一格的水平範圍 */
  const feetSpan = p => [p.x - C.PLAYER_W / 2, p.x + C.PLAYER_W / 2];
  const overlapsX = (step, x) => (x + C.PLAYER_W / 2) > step.x0 + EPS && (x - C.PLAYER_W / 2) < step.x1 - EPS;
  /** 世界編號 → 六套主題的索引（用完循環） */
  const worldSceneIndex = world => ((world % C.WORLD_COUNT) + C.WORLD_COUNT) % C.WORLD_COUNT;
  const worldIsNight = world => Math.floor(world / C.WORLD_COUNT) % 2 === 1;

  /**
   * 落地判定（純函式）：從 fromY 掃到 toY，找出第一個踩得到的階梯。
   * 只在下墜中（vy > 0）才會踩到階梯，上升時穿過去（規劃書 §1.2 的經典手感）。
   * 用掃掠檢查，高速落下不會漏踩。
   */
  function resolveLanding(steps, x, fromY, toY) {
    let hit = null;
    for (const st of steps) {
      if (st.broken) continue;
      if (st.depth < fromY - EPS || st.depth > toY + EPS) continue;
      if (!overlapsX(st, x)) continue;
      if (!hit || st.depth < hit.depth) hit = st;
    }
    return hit;
  }

  /** 玩家推擠（純函式，對戰唯一的互動；規劃書 §2） */
  function resolvePush(a, b) {
    if (!a.alive || !b.alive) return false;
    const dx = b.x - a.x;
    const overlapX = C.PLAYER_W - Math.abs(dx);
    if (overlapX <= 0) return false;
    /* 垂直沒有交疊就不是同一個高度，不推（所以不會互踩、不會疊人） */
    const aTop = a.y - C.PLAYER_H, bTop = b.y - C.PLAYER_H;
    if (a.y <= bTop + EPS || b.y <= aTop + EPS) return false;

    const halfMin = C.PLAYER_W / 2;
    const halfMax = C.FIELD_W - C.PLAYER_W / 2;
    /* 完全重疊時給一個穩定的方向（編號小的往左），不看誰先動 */
    const sign = Math.abs(dx) < EPS ? (a.index <= b.index ? -1 : 1) : (dx > 0 ? -1 : 1);
    const half = overlapX / 2;

    const wantA = a.x + sign * half;
    const wantB = b.x - sign * half;
    const newA = clamp(wantA, halfMin, halfMax);
    const newB = clamp(wantB, halfMin, halfMax);
    /* 一邊被牆擋住，剩下的位移全給另一邊（推的人自己被擋住，可以卡牆但不穿模） */
    const leftA = wantA - newA;
    const leftB = wantB - newB;
    a.x = clamp(newA - leftB, halfMin, halfMax);
    b.x = clamp(newB - leftA, halfMin, halfMax);
    return true;
  }

  /**
   * 天花板（純函式風格，會改 player）：頭超出鏡頭上緣就把玩家往下推，並依難度扣血。
   * 幼幼班的 ceilInterval 是 null → 只推、不扣血（天花板畫成雲朵）。
   *
   * 推力大於腳下的階梯：被頂到就會被推穿階梯往下掉。天花板的威脅因此不是
   * 「站在原地慢慢被扣血」，而是「把你一路推下去，推到你沉出畫面下緣摔死」。
   */
  /**
   * 被天花板的刺頂住。
   * @param {object} s 這一局的狀態（抽傷害要用 seed 與現在的世界，才能前後端一致）
   */
  function applyCeiling(s, player, cameraTop, diff, dt, out) {
    const headY = player.y - C.PLAYER_H;
    if (headY >= cameraTop - EPS) {
      player.pressed = false;
      return false;
    }
    player.y = cameraTop + C.PLAYER_H;
    player.pressed = true;
    /* 往下推：給一個明確的向下初速。
     * 這同時解掉兩件事 ——
     *   1. 不會再被黏在天花板上（下一個 tick 就脫離接觸）。
     *   2. 踩到彈簧被彈上來撞到天花板時，向上的速度會被抵銷，
     *      不會在天花板下面無限彈跳（原本會一直彈到死）。 */
    if (player.vy < C.CEIL_PUSH) player.vy = C.CEIL_PUSH;
    player.stats.ceilingSeconds += dt;
    if (diff.ceilInterval == null) return true;      /* 幼幼班：軟綿綿的雲朵，不扣血 */
    /* 碰到天花板的刺就「立刻」扣 1 顆，之後要等冷卻才會再扣。
     * 不能用「累計接觸時間滿一個間隔才扣」—— 天花板會把人推穿階梯，接觸都是斷斷續續的
     * （實測平均一次 0.15 秒），玩家會連續被刺 4 次才掉 1 顆血，
     * 從他的角度看就是「刺到我卻沒扣血」。 */
    if (player.ceilCool <= 0) {
      player.ceilCool = diff.ceilInterval;
      player.ceilHits++;
      damage(player, rollSpikeDamage(s, player, 'ceil' + player.ceilHits), 'ceiling', out);
    }
    return true;
  }

  /** 回血（踩到非刺的階梯）。回到滿血就不再有效果 */
  function heal(player, amount, source, out) {
    if (!player.alive || player.hp >= player.hpMax) return false;
    player.hp = Math.min(player.hpMax, player.hp + amount);
    player.healFlash = 0.3;
    player.stats.heals += amount;
    if (out) out.push({ type: 'heal', player: player.id, source: source, hp: player.hp });
    return true;
  }

  /**
   * 這個難度、這個深度，被刺到會扣幾顆愛心的範圍（Eric 指定：1～5 之間，看模式與玩到多深）。
   * base 是淺處、deep 是第 SPIKE_DEEP_WORLDS 個世界之後，中間線性內插。
   */
  function spikeDamageRange(diff, world) {
    const d = diff && diff.spikeDamage;
    if (!d) return [C.SPIKE_DAMAGE, C.SPIKE_DAMAGE];
    const k = clamp((world || 0) / C.SPIKE_DEEP_WORLDS, 0, 1);
    const lo = Math.round(d.base[0] + (d.deep[0] - d.base[0]) * k);
    const hi = Math.round(d.base[1] + (d.deep[1] - d.base[1]) * k);
    return [lo, Math.max(lo, hi)];
  }

  /**
   * 抽這一次的傷害。要「隨機」但也要「可重現」：
   * 客戶端會回溯重演（net.js），連續的亂數序列會被多消耗，兩邊就對不起來，
   * 所以這裡不用亂數序列，而是把 seed ＋ 玩家 ＋ 這次事件揉成雜湊值取餘數。
   * 同一次事件不管算幾遍都是同一個數字，前後端也一定一致。
   */
  function rollSpikeDamage(s, player, tag) {
    const range = spikeDamageRange(s.diff, s.world);
    if (range[1] <= range[0]) return range[0];
    const h = RNG.hashSeed(s.seed + '|' + player.id + '|' + tag);
    return range[0] + (h % (range[1] - range[0] + 1));
  }

  function damage(player, amount, source, out) {
    if (!player.alive) return false;
    if (source === 'spike' && player.invuln > 0) return false;
    player.hp = Math.max(0, player.hp - amount);
    player.hurtFlash = 0.35;
    player.hurtBy = source;
    player.hurtAmount = amount;
    if (source === 'spike') player.invuln = C.INVULN;
    if (out) out.push({ type: 'hurt', player: player.id, source: source, amount: amount, hp: player.hp });
    if (player.hp <= 0) {
      player.alive = false;
      player.state = 'stun';
      player.dir = 0;
      player.vy = 0;
      if (out) out.push({ type: 'eliminated', player: player.id, depth: player.best });
    }
    return true;
  }

  /* ---------- 每一步 ---------- */

  /** 依經過時間算保底下捲的倍率（每 N 秒 +x%，到上限就停） */
  function scrollMultiplier(diff, time) {
    const stepsTaken = Math.floor(time / diff.accelEvery);
    return Math.min(diff.scrollCap, Math.pow(1 + diff.accelRate, stepsTaken));
  }

  /**
   * 推進一步。
   * @param {object} s      createMatch 產生的狀態（會被就地修改）
   * @param {object} inputs { [playerId]: { dir: -1|0|1 } }，AI 與真人格式完全相同
   * @param {number} dtMs   固定步長（毫秒），請用 Rules.STEP_MS
   * @returns {{ state: object, events: Array }}
   */
  function stepMatch(s, inputs, dtMs) {
    const dt = (dtMs == null ? C.STEP_MS : dtMs) / 1000;
    const events = [];
    s.newSteps = [];
    s.goneSteps = [];
    if (s.phase === 'over') return { state: s, events: events };

    /* ---- 倒數：鏡頭不下捲、不能動 ---- */
    if (s.phase === 'countdown') {
      const before = Math.ceil(s.countdown);
      s.countdown -= dt;
      const after = Math.ceil(s.countdown);
      if (after !== before && after > 0) events.push({ type: 'countdown', n: after });
      if (s.countdown <= 0) {
        s.countdown = 0;
        s.phase = 'playing';
        events.push({ type: 'start' });
      }
      for (const p of s.players) {
        if (!p.alive) continue;          /* 別把已經淘汰的人重設回站姿 */
        p.dir = 0;
        p.state = 'idle';
      }
      /* 倒數期間也可能已經分出勝負 —— 線上對戰兩個人都在倒數時斷線判輸的話，
       * 不檢查的話這一局會卡在倒數跑完才收，房間看起來像沒反應。 */
      const early = checkResult(s);
      if (early) {
        s.phase = 'over';
        s.result = early;
        s.endedBy = early.endedBy;
        events.push({ type: 'over', result: early });
      }
      return { state: s, events: events };
    }

    s.time += dt;
    if (s.worldFade > 0) s.worldFade = Math.max(0, s.worldFade - dt);

    /* ---- 假階崩解計時 ---- */
    for (const st of s.steps) {
      if (st.breakIn == null || st.broken) continue;
      st.breakIn -= dt;
      if (st.breakIn <= 0) {
        st.broken = true;
        events.push({ type: 'fakeBreak', step: st.id, depth: st.depth, x: (st.x0 + st.x1) / 2 });
        for (const p of s.players) if (p.onStep === st.id) p.onStep = null;
      }
    }

    /* ---- 每位玩家：水平移動 → 垂直移動 → 落地 ---- */
    for (const p of s.players) {
      if (!p.alive) { p.invuln = Math.max(0, p.invuln - dt); continue; }
      p.aliveTime += dt;
      p.invuln = Math.max(0, p.invuln - dt);
      p.ceilCool = Math.max(0, p.ceilCool - dt);
      p.hurtFlash = Math.max(0, p.hurtFlash - dt);
      p.healFlash = Math.max(0, p.healFlash - dt);

      const cmd = (inputs && inputs[p.id]) || null;
      p.dir = cmd && cmd.dir ? (cmd.dir > 0 ? 1 : -1) : 0;
      /* 朝向就是當下的移動方向；沒在動就是 0 ＝ 面向前方（畫面正面） */
      p.face = p.dir;

      /* 站著的階梯還在不在、還踩不踩得到 */
      let ground = p.onStep ? stepById(s, p.onStep) : null;
      if (ground && (ground.broken || !overlapsX(ground, p.x))) { ground = null; p.onStep = null; }

      /* 水平：等速，站在輸送帶上再加帶動速度 */
      let vx = p.dir * C.MOVE_SPEED;
      if (ground && ground.kind === KIND.BELT) vx += ground.belt * C.BELT_SPEED;
      const half = C.PLAYER_W / 2;
      p.x = clamp(p.x + vx * dt, half, C.FIELD_W - half);

      /* 走出邊緣就掉下去 */
      if (ground && !overlapsX(ground, p.x)) { ground = null; p.onStep = null; }

      if (ground) {
        p.y = ground.depth;
        p.vy = 0;
        p.state = p.dir ? 'walk' : 'idle';
      } else {
        const fromY = p.y;
        p.vy = Math.min(C.MAX_FALL, p.vy + C.GRAVITY * dt);
        const toY = p.y + p.vy * dt;
        if (p.vy > 0) {
          const hit = resolveLanding(s.steps, p.x, fromY, toY);
          if (hit) {
            p.y = hit.depth;
            p.vy = 0;
            p.onStep = hit.id;
            landOn(s, p, hit, events);
          } else {
            p.y = toY;
            p.state = 'fall';
          }
        } else {
          p.y = toY;
          p.state = 'spring';
        }
      }
    }

    /* ---- 推擠（對戰唯一的互動；一人挑戰只有一個角色，跑不到） ---- */
    if (s.players.length > 1) {
      const a = s.players[0], b = s.players[1];
      const pushed = resolvePush(a, b);
      if (pushed) {
        if (!a.overlapWith) { a.stats.pushes++; b.stats.pushes++; events.push({ type: 'push' }); }
        a.overlapWith = b.id; b.overlapWith = a.id;
      } else {
        a.overlapWith = null; b.overlapWith = null;
      }
    }

    /* ---- 鏡頭：跟最深存活者，外加隨時間加快的保底下捲 ---- */
    s.scrollMul = scrollMultiplier(s.diff, s.time);
    s.scrollSpeed = s.diff.scrollBase * s.scrollMul;
    let deepestAlive = null;
    for (const p of s.players) if (p.alive) deepestAlive = deepestAlive == null ? p.y : Math.max(deepestAlive, p.y);
    const follow = deepestAlive == null ? -Infinity : deepestAlive - C.CAMERA_LEAD;
    /* 永遠不回捲：取「跟隨」「保底下捲」「上一格」三者最大 */
    const want = Math.max(s.cameraTop, s.cameraTop + s.scrollSpeed * dt, follow);
    /* 但鏡頭有最高追隨速度 —— 掉得比鏡頭快就會被甩在下面，掉出畫面下緣就摔死。
     * 上限不能低於保底下捲，不然鏡頭反而會被自己的上限拖住。
     * 幼幼班的 cameraCatchup 是 null ＝ 沒有上限，永遠追得上，所以沉不出去也摔不死。 */
    const catchup = s.diff.cameraCatchup;
    const limit = catchup == null ? Infinity : Math.max(s.scrollSpeed, catchup) * dt;
    s.cameraTop = Math.min(want, s.cameraTop + limit);

    /* ---- 天花板 ---- */
    for (const p of s.players) {
      if (!p.alive) continue;
      const pressed = applyCeiling(s, p, s.cameraTop, s.diff, dt, events);
      if (!pressed) continue;
      p.state = 'ceiling';
      /* 被推到腳下那一階以下 → 離開階梯開始往下掉（推力大於階梯） */
      const g = p.onStep ? stepById(s, p.onStep) : null;
      if (g && p.y > g.depth + EPS) p.onStep = null;
    }

    /* ---- 深度、分數、每 100 公尺換世界 ---- */
    for (const p of s.players) {
      if (!p.alive) continue;
      p.depth = p.y;
      if (p.y > p.best) p.best = p.y;
      p.stats.deepestWorld = Math.max(p.stats.deepestWorld, Math.floor(p.best / C.MILESTONE));
    }
    let lead = 0;
    for (const p of s.players) lead = Math.max(lead, p.best);
    s.leadDepth = lead;
    const world = Math.floor(lead / C.MILESTONE);
    if (world > s.world) {
      s.world = world;
      s.worldCycle = Math.floor(world / C.WORLD_COUNT);
      s.worldFade = 0.8;                /* 0.8 秒漸變，不打斷操作、不擋畫面 */
      events.push({
        type: 'milestone',
        meters: world * C.MILESTONE,
        world: world,
        scene: worldSceneIndex(world),
        night: worldIsNight(world)
      });
    }

    /* ---- 沉出畫面下緣 → 直接摔死 ---- */
    for (const p of s.players) {
      if (!p.alive) continue;
      /* 比「鏡頭想把你放的位置」低幾格；超過 SINK_WARN 前端就開始在下緣警示 */
      const sink = p.y - (s.cameraTop + C.CAMERA_LEAD);
      const before = p.sinking;
      p.sinking = Math.max(0, sink - C.SINK_WARN);
      if (p.sinking > 0 && before <= 0) events.push({ type: 'sinking', player: p.id });
      if (!s.diff.fallOut) continue;
      /* 整個人（含頭頂）都到畫面下緣以外才算掉出去，不會有「看起來還在畫面裡卻死了」 */
      if (p.y - C.PLAYER_H > s.cameraTop + C.VIEW_H) {
        p.hp = 0;
        p.alive = false;
        p.fell = true;
        p.state = 'stun';
        p.dir = 0;
        events.push({ type: 'fell', player: p.id, depth: p.best });
        events.push({ type: 'eliminated', player: p.id, depth: p.best });
      }
    }

    /* ---- 樓梯：往下補、把太上面的丟掉 ---- */
    const need = s.cameraTop + C.VIEW_H + C.KEEP_BELOW;
    if (s.gen.depth < need) {
      const fresh = Stairs.advance(s.gen, need);
      for (const st of fresh) { s.steps.push(st); s.newSteps.push(st); }
    }
    const cut = s.cameraTop - C.KEEP_ABOVE;
    if (s.steps.length && s.steps[0].depth < cut) {
      const keep = [];
      for (const st of s.steps) {
        if (st.depth < cut) s.goneSteps.push(st.id);
        else keep.push(st);
      }
      s.steps = keep;
    }

    /* ---- 勝負 ---- */
    const done = checkResult(s);
    if (done) {
      s.phase = 'over';
      s.result = done;
      s.endedBy = done.endedBy;
      events.push({ type: 'over', result: done });
    }

    return { state: s, events: events };
  }

  /** 踩到階梯的當下效果 */
  function landOn(s, p, step, events) {
    events.push({ type: 'land', player: p.id, step: step.id, kind: step.kind });
    /* 踩到非刺的地方回復 1 顆愛心（參考原作）。
     * 這也是「被天花板一路往下推」不會變成死亡螺旋的關鍵：
     * 被扎 −1、踩到下一階 +1，一來一往打平，真正扣血的是刺階。 */
    if (step.kind !== KIND.SPIKE) heal(p, C.HEAL_ON_LAND, step.kind, events);
    if (step.kind === KIND.SPRING) {
      p.vy = -C.SPRING_VY;
      p.onStep = null;
      p.state = 'spring';
      p.stats.springs++;
      step.squash = 0.18;
      events.push({ type: 'spring', player: p.id, step: step.id });
      return;
    }
    if (step.kind === KIND.SPIKE) {
      p.state = 'idle';
      if (p.invuln <= 0) {
        p.stats.spikes++;
        step.flash = C.SPIKE_FLASH;    /* 這一階閃白光（純畫面，不影響規則） */
        events.push({ type: 'spike', player: p.id, step: step.id });
        damage(p, rollSpikeDamage(s, p, step.id), 'spike', events);
      }
      return;
    }
    if (step.kind === KIND.FAKE) {
      if (step.breakIn == null) {
        step.breakIn = C.FAKE_DELAY;
        p.stats.fakes++;
        events.push({ type: 'fakeCrack', player: p.id, step: step.id });
      }
      p.state = 'idle';
      return;
    }
    p.state = 'idle';
  }

  /**
   * 勝負判定（規劃書 §1.6）。回傳 null 表示這局還沒結束。
   *   solo（一人挑戰）  ：血歸零就結束；幼幼班沒有終點，要靠 endMatch 手動收局。
   *   versus 對電腦     ：玩家一死就結束，不必等電腦死。
   *   versus 線上 1v1   ：兩個人都死了才結算。
   */
  function checkResult(s) {
    const ps = s.players;
    if (s.mode === 'solo') {
      const me = ps[0];
      if (me.alive) return null;
      return summarize(s, me.fell ? 'fell' : 'dead', null);
    }
    const human = ps.filter(p => p.kind === 'human');
    const hasAi = ps.some(p => p.kind === 'ai');
    if (hasAi) {
      /* 單機對電腦：玩家一死就結束 */
      if (human.every(p => p.alive)) return null;
    } else {
      /* 線上：兩個人都死了才結算 */
      if (ps.some(p => p.alive)) return null;
    }
    return summarize(s, 'dead', judge(ps));
  }

  /** 比較兩人：深度較深者勝，同深度比存活時間，都同判平手 */
  function judge(ps) {
    const a = ps[0], b = ps[1];
    if (!b) return { winner: a.id, draw: false };
    if (Math.abs(a.best - b.best) > 1e-6) return { winner: a.best > b.best ? a.id : b.id, draw: false };
    if (Math.abs(a.aliveTime - b.aliveTime) > 1e-6) return { winner: a.aliveTime > b.aliveTime ? a.id : b.id, draw: false };
    return { winner: null, draw: true };
  }

  function summarize(s, endedBy, verdict) {
    return {
      mode: s.mode,
      difficulty: s.difficulty,
      endedBy: endedBy,                /* 'dead'（血歸零）｜'fell'（掉出畫面摔死）｜'manual'（幼幼班按結束這局） */
      seed: s.seed,
      elapsed: s.time,
      world: s.world,
      winner: verdict ? verdict.winner : (s.players[0] ? s.players[0].id : null),
      draw: verdict ? verdict.draw : false,
      players: s.players.map(p => ({
        id: p.id, name: p.name, char: p.char, kind: p.kind,
        depth: p.best,
        meters: Math.floor(p.best),
        survived: p.aliveTime,
        hp: p.hp,
        alive: p.alive,
        fell: p.fell,
        forfeit: !!p.forfeit,            /* 線上對戰斷線判輸，結算畫面要寫清楚 */
        world: p.stats.deepestWorld,
        stats: {
          spikes: p.stats.spikes,
          springs: p.stats.springs,
          fakes: p.stats.fakes,
          ceilingSeconds: p.stats.ceilingSeconds,
          pushes: p.stats.pushes,
          heals: p.stats.heals,
          deepestWorld: p.stats.deepestWorld
        }
      }))
    };
  }

  /** 幼幼班的「結束這局」：沒有終點，玩家自己收局（規劃書 §1.6） */
  function endMatch(s, reason) {
    if (s.phase === 'over') return s.result;
    s.phase = 'over';
    s.result = summarize(s, reason || 'manual', s.mode === 'versus' ? judge(s.players) : null);
    s.endedBy = s.result.endedBy;
    return s.result;
  }

  return {
    STEP: C.STEP, STEP_MS: C.STEP_MS,
    C, KIND, DIFFICULTY, DIFFICULTY_LIST,
    createMatch, stepMatch, endMatch,
    makeStairs: Stairs.makeStairs,
    resolveLanding, resolvePush, applyCeiling, checkResult,
    damage, heal, scrollMultiplier, stepById, overlapsX, feetSpan,
    spikeDamageRange, rollSpikeDamage,
    worldSceneIndex, worldIsNight
  };
});
