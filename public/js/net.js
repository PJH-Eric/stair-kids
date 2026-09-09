/* ===== net.js — 線上對戰的客戶端腦袋（預測、校正、內插）=====
 *
 * 規劃書 §4.1／§4.2：
 *   · 客戶端只送輸入意圖 { seq, dir, ct }，永遠不送座標 → 改前端也作弊不了。
 *   · 自己的角色本地即時預測（按了就動，不等封包）。
 *   · 收到伺服器快照 → 把權威狀態蓋回來 → 用手上的輸入紀錄重演到現在（rollback & replay）。
 *   · 對手畫在 100ms 前，兩個快照之間用內插補，所以封包抖動看不出來。
 *
 * 這一支故意不碰 WebSocket，也不碰 DOM：送出動作是注入進來的。
 * 所以 scripts/netcode-check.js 可以用「假網路 ＋ 可設定延遲」直接跑同一份程式。
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const Rules = isNode ? require('./rules.js') : root.Rules;
  const api = factory(Rules);
  if (isNode) module.exports = api;
  else root.Net = api;
})(typeof self !== 'undefined' ? self : this, function (Rules) {
  'use strict';

  const STEP = Rules.STEP;
  const STEP_MS = Rules.STEP_MS;

  const C = {
    LOG_KEEP: 360,        /* 保留 6 秒的輸入紀錄（60Hz × 6），重演夠用了 */
    SNAP_KEEP: 20,        /* 對手內插用的快照緩衝 */
    RENDER_DELAY: 0.10,   /* 對手畫在 100ms 前（§4.2） */
    HARD_SNAP: 4.0,       /* 誤差大於 4 格就直接歸位（傳送、重新連線） */
    DEAD_ZONE: 0.02,      /* 誤差小於這個就當沒事，免得一直微抖 */
    SMOOTH: 0.12,         /* 校正的視覺位移在幾秒內補完 */
    INPUT_MIN_MS: 33,     /* 輸入意圖最快多久送一次（沒變就用這個節流） */
    MAX_REPLAY: 40,       /* 一次最多重演幾步，避免延遲爆掉時卡死 */
    LEAD_PAD_MS: 10,      /* 超前量的安全邊際 */
    LEAD_SLACK_MS: 150,   /* 超前太多才需要放慢，免得一直微調 */
    PING_MS: 1500         /* 多久量一次 rtt（超前量要靠它算） */
  };

  /* ---------------------------------------------------------- */

  /**
   * @param {{send:(msg:object)=>void, now?:()=>number, name?:string, char?:string}} opt
   */
  function createClient(opt) {
    opt = opt || {};
    const now = opt.now || (() => Date.now());
    const send = opt.send;
    /* 每一個固定步之前呼叫一次（不含回溯重演）。
     * app.js 用它記下「上一格」的位置來做畫面內插，跟單機走同一套。 */
    const beforeStep = opt.beforeStep || null;

    const st = {
      /* 身分 */
      me: { id: null, name: opt.name || '', char: opt.char || 'yuan' },
      server: null,                 /* welcome 帶回來的伺服器設定 */
      /* 大廳與房間 */
      rooms: [],
      room: null,
      notice: null,
      error: null,
      /* 對局 */
      match: null,                  /* 本地鏡像（跟伺服器同一支規則核心、同一個 seed） */
      meta: [],
      seed: null,
      difficulty: null,
      result: null,
      /* 預測 */
      dir: 0,
      inputSeq: 0,
      lastInputAt: 0,
      lastSentDir: null,
      log: [],                      /* [{ time, dir }] 每一步實際用的方向 */
      snaps: [],                    /* [{ time, at, players }] 對手內插用 */
      offset: { x: 0, y: 0, t: 0 }, /* 校正後的視覺補正（自己） */
      /* 連線品質 */
      rtt: 0, jitter: 0, lastPongAt: 0, lastPingAt: 0, hb: 0,
      /* 本地模擬要比「收到的伺服器時間」超前多少（＝單向延遲＋一個 tick），
       * 這樣按鍵送到伺服器時剛好是它正在算的那一格，預測才不會被打回來（§4.2）。 */
      aheadMs: 0, leadMs: 0, slowMs: 0,
      /* 統計（給 netcode-check 驗） */
      count: { snaps: 0, corrections: 0, hardSnaps: 0, replays: 0, replaySteps: 0 },
      err: { last: 0, sum: 0, n: 0, max: 0 },
      events: []                    /* 這一格要給音效／畫面用的事件 */
    };

    const isMe = id => id === st.me.id;

    /* ---------- 送出 ---------- */

    function out(msg) { if (send) send(msg); }

    function hello() { out({ type: 'hello', name: st.me.name, char: st.me.char }); }

    const actions = {
      rooms: () => out({ type: 'rooms' }),
      create: (name, difficulty) => out({ type: 'create', name: name, difficulty: difficulty }),
      join: (roomId, role) => out({ type: 'join', roomId: roomId, role: role }),
      quick: () => out({ type: 'quick' }),
      leave: () => out({ type: 'leave' }),
      ready: r => out({ type: 'ready', ready: !!r }),
      start: () => out({ type: 'start' }),
      /* 結算看完了：兩邊都送出之後，伺服器不用等滿 10 秒就把房間收回大廳 */
      resultDone: () => out({ type: 'result-done' }),
      seat: () => out({ type: 'seat' }),
      kick: id => out({ type: 'kick', targetId: id }),
      config: cfg => out({ type: 'config', difficulty: cfg.difficulty, name: cfg.name }),
      chat: text => out({ type: 'chat', text: text }),
      invite: () => out({ type: 'invite' }),
      revokeInvite: () => out({ type: 'invite:revoke' }),
      useInvite: (token, name) => {
        const msg = { type: 'invite:resolve', token: token };
        if (name != null) msg.name = name;
        out(msg);
      },
      rename: name => { st.me.name = name; out({ type: 'rename', name: name }); },
      setChar: ch => { st.me.char = ch; out({ type: 'char', char: ch }); },
      ping: () => out({ type: 'ping', t: now() })
    };

    /** 輸入意圖：方向變了就馬上送，沒變就節流（§4.1） */
    function setDir(dir) {
      const d = dir > 0 ? 1 : dir < 0 ? -1 : 0;
      st.dir = d;
      if (!st.match) return;
      const t = now();
      if (d === st.lastSentDir && t - st.lastInputAt < C.INPUT_MIN_MS) return;
      st.lastSentDir = d;
      st.lastInputAt = t;
      st.inputSeq++;
      out({ type: 'input', seq: st.inputSeq, dir: d, ct: t });
    }

    /* ---------- 收到訊息 ---------- */

    function receive(msg) {
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'hello':
          st.me.id = msg.personId || st.me.id;
          hello();
          break;
        case 'welcome':
          st.me.id = msg.personId;
          st.me.name = msg.name;
          st.me.char = msg.char;
          st.server = msg;
          break;
        case 'me':
          st.me.name = msg.name;
          st.me.char = msg.char;
          break;
        case 'rooms':
          st.rooms = msg.rooms || [];
          break;
        case 'joined':
          st.room = msg.room;
          st.error = null;
          break;
        case 'room':
          st.room = msg.room;
          if (msg.room && msg.room.phase === 'lobby') { st.match = null; st.result = st.result; }
          break;
        case 'left':
        case 'kicked':
          st.room = null;
          st.match = null;
          if (msg.type === 'kicked') st.notice = '你被房主請出房間了';
          break;
        case 'invite':
          if (st.room) st.room.invite = msg.token || null;
          break;
        case 'notice':
          st.notice = msg.text;
          break;
        case 'error':
          st.error = msg.text;
          break;
        case 'hb':
          st.hb++;
          out({ type: 'hb' });
          break;
        case 'pong': {
          const rtt = now() - msg.t;
          st.jitter = st.rtt ? Math.abs(rtt - st.rtt) * 0.3 + st.jitter * 0.7 : 0;
          st.rtt = st.rtt ? st.rtt * 0.7 + rtt * 0.3 : rtt;
          st.lastPongAt = now();
          break;
        }
        case 'snap':
          onSnapshot(msg.snap);
          break;
      }
    }

    /* ---------- 快照 → 本地鏡像 ---------- */

    /** 完整快照：用同一個 seed 在本地重建一份鏡像（樓梯不必靠網路傳，算出來就一樣） */
    function rebuild(snap) {
      st.seed = snap.seed;
      st.difficulty = snap.difficulty;
      st.meta = snap.meta || [];
      st.match = Rules.createMatch({
        difficulty: snap.difficulty,
        mode: 'versus',
        players: (snap.meta || []).map(m => ({ id: m.id, name: m.name, char: m.char, kind: m.kind }))
      }, snap.seed);
      st.log.length = 0;
      st.snaps.length = 0;
      st.offset.x = st.offset.y = st.offset.t = 0;
      st.result = null;
      /* 上一局的事件不能留到下一局：沒人在讀的時候（結算已經停掉畫面迴圈）
       * 這個佇列會一直積著，下一局第一格一次倒出來，其中那顆 'over' 會
       * 直接把剛開始的新對局蓋成結算畫面 —— 這就是「開新的一局卻殘留上一局
       * 結算」的成因（實測真的會卡住）。 */
      st.events.length = 0;
      /* 快照時間也要跟著歸零：新的一局從 time=0 開始，而舊值可能是上一局的
       * 幾十秒。不清掉的話，下面那個「舊封包直接丟掉」的判斷會把新一局的每一份
       * 快照都當成舊封包丟掉，客戶端就完全收不到權威狀態（整局都在自己亂算）。 */
      st.lastSnapTime = null;
      st.count.corrections = 0;
      st.err.sum = 0; st.err.n = 0; st.err.max = 0;
    }

    /** 把伺服器的權威狀態蓋到鏡像上（這是唯一的真相；§4.1） */
    function apply(snap) {
      const m = st.match;
      m.time = snap.time;
      m.phase = snap.matchPhase;
      m.countdown = snap.countdown;
      m.cameraTop = snap.cameraTop;
      m.scrollMul = snap.scrollMul;
      m.world = snap.world;

      /* 樓梯：本地自己也會長出一模一樣的（id 由 seed 決定），所以照 id 併，不會重複 */
      if (snap.steps) {
        m.steps = snap.steps.map(s => Object.assign({}, s));
      } else {
        if (snap.newSteps && snap.newSteps.length) {
          const have = new Set(m.steps.map(s => s.id));
          for (const s of snap.newSteps) if (!have.has(s.id)) m.steps.push(Object.assign({}, s));
          m.steps.sort((a, b) => a.depth - b.depth);
        }
        if (snap.goneSteps && snap.goneSteps.length) {
          const gone = new Set(snap.goneSteps);
          m.steps = m.steps.filter(s => !gone.has(s.id));
        }
      }
      /* 假階的崩解狀態是會變的，只能靠快照 */
      if (snap.dirty) {
        for (const d of snap.dirty) {
          const s = m.steps.find(x => x.id === d.id);
          if (s) { s.breakIn = d.breakIn; s.broken = d.broken; }
        }
      }

      for (const sp of snap.players) {
        const p = m.players.find(x => x.id === sp.id);
        if (!p) continue;
        p.x = sp.x; p.y = sp.y; p.vy = sp.vy;
        p.dir = sp.dir; p.face = sp.face;
        p.hp = sp.hp; p.best = sp.best;
        p.state = sp.state; p.alive = sp.alive;
        p.fell = sp.fell; p.forfeit = sp.forfeit;
        p.invuln = sp.invuln; p.sinking = sp.sinking;
        p.onStep = sp.onStep;
      }
      if (snap.result) { m.result = snap.result; st.result = snap.result; }
    }

    /** 重演：從快照的時間點，用手上的輸入紀錄跑回「現在」 */
    function replay(toTime) {
      const m = st.match;
      let steps = Math.round((toTime - m.time) / STEP);
      if (steps <= 0) return 0;
      if (steps > C.MAX_REPLAY) steps = C.MAX_REPLAY;
      st.count.replays++;
      st.count.replaySteps += steps;
      for (let i = 0; i < steps; i++) {
        Rules.stepMatch(m, inputsAt(m.time), STEP_MS);
      }
      return steps;
    }

    /** 某個時間點大家的方向：自己查紀錄，對手用伺服器最後給的方向（dead reckoning） */
    function inputsAt(time) {
      const cmd = {};
      for (const p of st.match.players) {
        cmd[p.id] = { dir: isMe(p.id) ? dirAt(time) : p.dir };
      }
      return cmd;
    }

    function dirAt(time) {
      for (let i = st.log.length - 1; i >= 0; i--) {
        if (st.log[i].time <= time + 1e-6) return st.log[i].dir;
      }
      return st.log.length ? st.log[0].dir : st.dir;
    }

    function onSnapshot(snap) {
      if (!snap) return;
      st.count.snaps++;
      if (snap.full || !st.match) {
        if (!snap.full) return;         /* 還沒拿到完整快照，增量的先丟掉 */
        rebuild(snap);
      }
      const m = st.match;
      const localTime = m.time;

      /* 舊封包（比手上的快照還舊）直接丟掉 */
      if (st.lastSnapTime != null && snap.time < st.lastSnapTime - 1e-6) return;
      st.lastSnapTime = snap.time;

      /* 記下對手的位置，給內插用 */
      st.snaps.push({
        time: snap.time, at: now(),
        players: snap.players.map(p => ({ id: p.id, x: p.x, y: p.y, alive: p.alive, face: p.face, state: p.state }))
      });
      if (st.snaps.length > C.SNAP_KEEP) st.snaps.shift();

      /* 校正前先記住自己預測到哪，才能算誤差、做視覺平滑 */
      /* 本地模擬比「收到的伺服器時間」超前多少：正常應該約等於單向延遲＋半個 tick。
       * 這個數字太小＝預測沒有真的在超前跑，按鍵就會感覺鈍（M2 除錯用得上）。 */
      st.aheadMs = (localTime - snap.time) * 1000;

      const mine = m.players.find(p => isMe(p.id));
      const before = mine ? { x: mine.x, y: mine.y } : null;

      apply(snap);
      /* 超前量：本地要跑到「這份快照的時間 ＋ 單向延遲 ＋ 一個 tick」。
       * 不補這一段的話，本地時鐘會被延遲的快照綁住，按鍵會被下一份快照打回去。 */
      const hz = (st.server && st.server.hz) || snap.hz || 30;
      const target = (st.rtt / 2 + 1000 / hz + C.LEAD_PAD_MS) / 1000;
      st.leadMs = Math.round(target * 1000);
      const want = snap.time + target;
      const to = localTime > want ? localTime : want;
      const jumped = to > localTime + 1e-6;
      replay(to);
      /* 超前太多（例如延遲突然變好）就讓接下來的畫面跑慢一點，慢慢收回來 */
      st.slowMs = localTime > want + C.LEAD_SLACK_MS / 1000 ? (localTime - want) * 1000 : 0;

      if (before && mine && !jumped) {
        const dx = before.x - mine.x;
        const dy = before.y - mine.y;
        const e = Math.sqrt(dx * dx + dy * dy);
        st.err.last = e;
        st.err.sum += e; st.err.n++;
        if (e > st.err.max) st.err.max = e;
        if (e > C.HARD_SNAP) {
          st.count.hardSnaps++;
          st.offset.x = st.offset.y = st.offset.t = 0;   /* 太遠就直接歸位，不平滑 */
        } else if (e > C.DEAD_ZONE) {
          st.count.corrections++;
          st.offset.x = dx; st.offset.y = dy; st.offset.t = C.SMOOTH;
        }
      }

      if (snap.events && snap.events.length) {
        for (const ev of snap.events) st.events.push(ev);
      }
      /* 結算只能來自伺服器的快照（上面的 apply 會設 st.result）。
       * 本地鏡像是超前跑的預測，而且對手是用「最後收到的方向」推的 ——
       * 它很容易先自己算出「兩個人都死了」，然後客戶端就會在對手還在玩的時候
       * 跳出結算，勝負也可能是錯的。所以這裡刻意不看本地鏡像的 result。 */
    }

    /* ---------- 每一格畫面 ---------- */

    /**
     * 本地推進。dir 是這一格玩家按的方向。
     * @returns {number} 這次跑了幾個固定步
     */
    let acc = 0, last = null;
    function frame(nowMs, dir) {
      const t = nowMs == null ? now() : nowMs;
      if (dir != null) setDir(dir);
      if (last == null) { last = t; return 0; }
      let dt = t - last;
      last = t;
      if (dt < 0) dt = 0;
      if (dt > 250) dt = 250;                /* 分頁切回來別一次爆衝 */
      if (t - st.lastPingAt > C.PING_MS) { st.lastPingAt = t; actions.ping(); }
      if (!st.match) { acc = 0; return 0; }
      /* 超前太多：這幾格跑慢 15%，把多出來的時間吃掉（不硬拉時鐘，畫面才不會抽） */
      if (st.slowMs > 0) {
        const eat = dt * 0.15;
        st.slowMs = Math.max(0, st.slowMs - eat);
        dt -= eat;
      }
      acc += dt;

      let ran = 0;
      while (acc >= STEP_MS) {
        acc -= STEP_MS;
        st.log.push({ time: st.match.time, dir: st.dir });
        if (st.log.length > C.LOG_KEEP) st.log.shift();
        if (beforeStep) beforeStep(st.match);
        Rules.stepMatch(st.match, inputsAt(st.match.time), STEP_MS);
        ran++;
      }
      if (st.offset.t > 0) st.offset.t = Math.max(0, st.offset.t - dt / 1000);
      applyRemoteInterpolation();
      return ran;
    }

    /** 對手：畫在 100ms 前，兩個快照之間內插（§4.2） */
    function applyRemoteInterpolation() {
      if (!st.match || st.snaps.length < 2) return;
      const newest = st.snaps[st.snaps.length - 1];
      const target = newest.time - C.RENDER_DELAY + (now() - newest.at) / 1000;
      let a = st.snaps[0], b = st.snaps[st.snaps.length - 1];
      for (let i = 0; i < st.snaps.length - 1; i++) {
        if (st.snaps[i].time <= target && st.snaps[i + 1].time >= target) {
          a = st.snaps[i]; b = st.snaps[i + 1];
          break;
        }
      }
      const span = b.time - a.time;
      const k = span > 1e-6 ? Math.min(1, Math.max(0, (target - a.time) / span)) : 1;
      for (const p of st.match.players) {
        if (isMe(p.id)) continue;
        const pa = a.players.find(x => x.id === p.id);
        const pb = b.players.find(x => x.id === p.id);
        if (!pa || !pb) continue;
        p.x = pa.x + (pb.x - pa.x) * k;
        p.y = pa.y + (pb.y - pa.y) * k;
      }
    }

    /** 自己的視覺補正量（render 時把它加回去，校正就不會看到瞬移） */
    function visualOffset() {
      if (st.offset.t <= 0) return { x: 0, y: 0 };
      const k = st.offset.t / C.SMOOTH;
      return { x: st.offset.x * k, y: st.offset.y * k };
    }

    /** 這一格畫到兩個固定步之間的哪裡（0～1），給畫面內插用 */
    function alpha() {
      return Math.max(0, Math.min(1, acc / STEP_MS));
    }

    function takeEvents() {
      const out = st.events;
      st.events = [];
      return out;
    }

    function stats() {
      return {
        rtt: Math.round(st.rtt),
        jitter: Math.round(st.jitter),
        snaps: st.count.snaps,
        corrections: st.count.corrections,
        hardSnaps: st.count.hardSnaps,
        replays: st.count.replays,
        replayStepsAvg: st.count.replays ? +(st.count.replaySteps / st.count.replays).toFixed(2) : 0,
        errLast: +st.err.last.toFixed(4),
        errAvg: st.err.n ? +(st.err.sum / st.err.n).toFixed(4) : 0,
        errMax: +st.err.max.toFixed(4),
        aheadMs: Math.round(st.aheadMs || 0)
      };
    }

    return {
      C: C, state: st, actions: actions,
      hello, receive, setDir, frame, visualOffset, alpha, takeEvents, stats,
      get match() { return st.match; },
      get room() { return st.room; },
      get me() { return st.me; }
    };
  }

  return { createClient, C };
});
