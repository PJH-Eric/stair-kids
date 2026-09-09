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
    CLOCK_EASE: 0.10,     /* 對手播放時鐘每一格往目標收多少（0～1） */
    CLOCK_SNAP: 0.25,     /* 差超過這麼多秒就直接對時（重連、分頁切回來） */
    HARD_SNAP: 4.0,       /* 誤差大於 4 格就直接歸位（傳送、重新連線） */
    DEAD_ZONE: 0.02,      /* 誤差小於這個就當沒事，免得一直微抖 */
    SMOOTH: 0.12,         /* 校正的視覺位移在幾秒內補完（有在動的時候） */
    /* 站著不動的時候，補正要抹得非常慢。
     * 抹掉補正等於讓角色自己移動幾像素 —— 在移動中完全看不見（混在速度裡），
     * 但站著不動時就是「沒按方向鍵卻自己滑一下」。實測 200ms 延遲時有 10.6% 的
     * 畫格會這樣滑（單機是 0%），這就是使用者說的「滑動」。 */
    IDLE_SMOOTH_RATE: 0.15,
    OFFSET_MAX: 0.5,      /* 視覺補正的上限（格）；超過就不再疊，避免站太久累積 */
    INPUT_MIN_MS: 33,     /* 輸入意圖最快多久送一次（沒變就用這個節流） */
    MAX_REPLAY: 40,       /* 一次最多重演幾步，避免延遲爆掉時卡死 */
    LEAD_PAD_MS: 10,      /* 超前量的安全邊際 */
    LEAD_SLACK_MS: 150,   /* 超前太多才需要放慢，免得一直微調 */
    PING_MS: 1500,        /* 多久量一次 rtt（超前量要靠它算） */
    /* 本地預測出來的「自己被打到」特效，最多留多久等伺服器那份來對消。
     * 一個來回 ＋ 一個 tick 綽綽有餘；對不到就當它是預測錯，讓它自然過期。 */
    PREDICT_KEEP_MS: 1500
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
      playAt: null,                 /* 對手的播放時鐘（對局時間） */
      playWall: null,               /* 上面那個時鐘對應的真實時間 */
      /* 校正後的視覺補正（只加在自己身上）。
       * 兩個軸各有自己的計時器：抹掉補正等於讓角色自己動幾像素，
       * 所以水平的補正要等「有在左右移動」才抹，垂直的要等「有在上下移動」才抹。 */
      offset: { x: 0, y: 0, tx: 0, ty: 0 },
      /* 連線品質 */
      rtt: 0, jitter: 0, lastPongAt: 0, lastPingAt: 0, hb: 0,
      /* 本地模擬要比「收到的伺服器時間」超前多少（＝單向延遲＋一個 tick），
       * 這樣按鍵送到伺服器時剛好是它正在算的那一格，預測才不會被打回來（§4.2）。 */
      aheadMs: 0, leadMs: 0, slowMs: 0,
      /* 統計（給 netcode-check 驗） */
      count: { snaps: 0, corrections: 0, hardSnaps: 0, replays: 0, replaySteps: 0 },
      err: { last: 0, sum: 0, n: 0, max: 0 },
      events: [],                   /* 這一格要給音效／畫面用的事件 */
      predicted: []                 /* [{ key, wall }] 已經先播過的自己的事件，等伺服器那份來對消 */
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
      /* at ＝ 這個方向從「對局時間」的哪一刻開始生效。
       * 本地預測就是從下一個固定步（也就是現在的 match.time）開始用它，
       * 所以把同一個時間點告訴伺服器，兩邊才會在同一步換方向。
       * 少了這個，伺服器只能「封包到了就整個 tick 都用新方向」，
       * 跟本地預測差最多一個 tick（33ms ＝ 0.2 格），每次改方向都會被拉一下 ——
       * 手感就是「往右移一格卻被往左拉一點點」。 */
      out({ type: 'input', seq: st.inputSeq, dir: d, ct: t, at: +st.match.time.toFixed(4) });
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
      st.playAt = st.playWall = null;
      st.offset.x = st.offset.y = st.offset.tx = st.offset.ty = 0;
      st.result = null;
      /* 上一局的事件不能留到下一局：沒人在讀的時候（結算已經停掉畫面迴圈）
       * 這個佇列會一直積著，下一局第一格一次倒出來，其中那顆 'over' 會
       * 直接把剛開始的新對局蓋成結算畫面 —— 這就是「開新的一局卻殘留上一局
       * 結算」的成因（實測真的會卡住）。 */
      st.events.length = 0;
      st.predicted.length = 0;
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
      /* 假階的崩解狀態是會變的，只能靠快照。
       * dirty 是「所有正在裂或已經碎掉的階梯」的完整清單，所以不在清單裡的一律要
       * 清回原狀 —— 這一段以前只更新清單裡的那幾階，於是：
       *   本地預測比伺服器超前 100ms 左右，會先踩上假階、先把 0.25 秒的引信點著；
       *   這時伺服器還沒踩到，清單裡當然沒有這一階，引信就不會被回捲；
       *   而回溯重演是「從快照時間點重跑到現在」，每收一份快照就把同一段時間
       *   再扣一次（實測平均 6.75 步／份 × 30 份／秒），引信等於以四倍速在燒。
       * 結果假階比伺服器早很多就碎了，人先掉下去、下一份快照又被拉回階梯上，
       * 一來一回誤差可以到 2.35 格 —— 這就是「站到會消失的平面上，消失的時候
       * 人物跟平面會不正常跳動」。清單當成完整真相之後，引信只會被扣一次。 */
      if (snap.dirty) {
        const marked = new Map();
        for (const d of snap.dirty) marked.set(d.id, d);
        for (const s of m.steps) {
          const d = marked.get(s.id);
          if (d) { s.breakIn = d.breakIn; s.broken = d.broken; }
          else if (s.breakIn != null || s.broken) { s.breakIn = null; s.broken = false; }
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
        if (sp.ceilHits != null) p.ceilHits = sp.ceilHits;
        if (sp.ceilCool != null) p.ceilCool = sp.ceilCool;
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
        /* 最後一步之前重新記一次「上一格」。
         * 回溯重演等於把「現在」搬到新的時間軸上，而畫面內插用的「上一格」
         * 還停在校正前的舊時間軸 —— 兩邊相減，校正的那一幀畫面就會甩一下
         * （實測角色甩到 1.3 格）。把基準記在重演的最後一步，內插的兩端就都
         * 在同一條時間軸上了。 */
        if (beforeStep && i === steps - 1) beforeStep(m);
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
          st.offset.x = st.offset.y = st.offset.tx = st.offset.ty = 0;   /* 太遠就直接歸位，不平滑 */
        } else if (e > C.DEAD_ZONE) {
          st.count.corrections++;
          /* 還沒補完的視覺位移要「疊上去」，不能直接蓋掉。
           * 蓋掉的話，剩下那一段就會在同一幀補完 —— 而且校正常常一次只偏一個軸，
           * 一次純水平的校正（dy≈0）會把還在補的垂直位移直接清成 0，
           * 角色就瞬移一整格（實測 1.29 格，站到假階上崩解時最明顯）。 */
          const left = visualOffset();
          st.offset.x = clampOffset(left.x + dx);
          st.offset.y = clampOffset(left.y + dy);
          st.offset.tx = C.SMOOTH;
          st.offset.ty = C.SMOOTH;
        }
      }

      if (snap.events && snap.events.length) {
        /* 自己的反饋已經在本地預測時就播過了，這裡要對消掉，不然會播兩次 */
        for (const ev of snap.events) if (!alreadyPlayed(ev)) st.events.push(ev);
      }
      /* 結算只能來自伺服器的快照（上面的 apply 會設 st.result）。
       * 本地鏡像是超前跑的預測，而且對手是用「最後收到的方向」推的 ——
       * 它很容易先自己算出「兩個人都死了」，然後客戶端就會在對手還在玩的時候
       * 跳出結算，勝負也可能是錯的。所以這裡刻意不看本地鏡像的 result。 */
    }

    /* ---------- 自己的反饋要即時（不等伺服器） ---------- */

    /**
     * 哪些事件可以靠本地預測先播。
     * 只有「自己身上、看得到摸得到的反饋」：踩到刺、扣血、落地、假階裂開、
     * 彈簧、回血、開始下沉。刻意不含死亡與結算 —— 那些一定要伺服器說了才算，
     * 預測錯的話畫面會先演一次死亡，代價太大。
     */
    const PREDICTABLE = new Set(['spike', 'hurt', 'land', 'fakeCrack', 'spring', 'heal', 'sinking']);

    /**
     * 事件的比對鑰匙：同一件事，伺服器那份跟預測那份要算出同一個鑰匙。
     * 關鍵是 at（發生在第幾個固定步，伺服器在 lib/rooms.js 蓋上）——
     * 兩邊跑的是同一份規則核心、同一個固定步長，所以同一件事的步號一模一樣。
     * 少了 at，連續兩次受傷或「預測錯的那一次」會把別次的伺服器事件吃掉。
     */
    function eventKey(e) {
      return e.type + '|' + (e.player || '') + '|' + (e.step || '') + '|' + (e.source || '') +
        '|' + (e.kind || '') + '|' + (e.at == null ? '' : e.at);
    }

    /**
     * 本地預測跑出來的事件，挑「自己的」先播。
     * 為什麼要這樣：踩到刺的閃光、震動、噴出來的火花如果等伺服器的快照才播，
     * 就會比「畫面上踩到刺的那一刻」晚一個單向延遲 ＋ 一個 tick（實測 40～120ms），
     * 手感上就是「踩到了但特效慢半拍」。傷害數字是用 seed 雜湊算的（見 rules.js 的
     * rollSpikeDamage），本地算出來跟伺服器一模一樣，所以先播是安全的。
     * 播過的事件記下鑰匙，等伺服器那份到了就對消掉，不會播第二次。
     */
    function emitPredicted(events) {
      if (!events || !events.length) return;
      const t = now();
      const at = Math.round(st.match.time / STEP);   /* 跟伺服器同一個慣例：跑完這一步的步號 */
      for (const e of events) {
        if (e.at == null) e.at = at;
        if (!PREDICTABLE.has(e.type)) continue;
        if (e.player && !isMe(e.player)) continue;
        if (!e.player) continue;                 /* 沒有主角的事件（換世界等）交給伺服器 */
        st.events.push(e);
        st.predicted.push({ key: eventKey(e), wall: t });
      }
      if (st.predicted.length > 60) st.predicted.splice(0, st.predicted.length - 60);
    }

    /** 伺服器那份事件是不是「已經先播過了」；是的話對消掉一筆 */
    function alreadyPlayed(e) {
      if (!st.predicted.length) return false;
      const t = now();
      const key = eventKey(e);
      for (let i = 0; i < st.predicted.length; i++) {
        const p = st.predicted[i];
        if (t - p.wall > C.PREDICT_KEEP_MS) continue;
        if (p.key !== key) continue;
        st.predicted.splice(i, 1);               /* 一對一對消，連續兩次受傷不會被吃掉 */
        return true;
      }
      return false;
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
        const r = Rules.stepMatch(st.match, inputsAt(st.match.time), STEP_MS);
        /* 只有「往前跑」的這一步才播預測反饋；回溯重演會把同一段時間再跑一遍，
         * 那裡的事件一律丟掉（replay() 沒有收），不然同一次受傷會播好幾次。 */
        emitPredicted(r.events);
        ran++;
      }
      /* 補正的衰減速度看「自己有沒有在動」：
       * 動的時候正常抹掉（0.12 秒，混在移動裡看不見）；
       * 站著不動時抹得很慢（每秒只走 0.15 個 SMOOTH），
       * 那點殘留差幾像素根本看不出來，但可以完全避免「沒按卻自己滑」。 */
      if (st.offset.tx > 0 || st.offset.ty > 0) {
        const mine = st.match.players.find(p => isMe(p.id));
        const sec = dt / 1000;
        /* 水平：有按方向鍵才抹（混在移動裡看不見）；沒按就幾乎不動它 ——
         * 硬要在站著的時候抹掉，看起來就是「沒按卻自己滑一下」。 */
        const rx = st.dir === 0 ? C.IDLE_SMOOTH_RATE : 1;
        /* 垂直：在空中（有垂直速度）才抹；站在階梯上就先留著。 */
        const ry = (!mine || Math.abs(mine.vy) < 0.5) ? C.IDLE_SMOOTH_RATE : 1;
        st.offset.tx = Math.max(0, st.offset.tx - sec * rx);
        st.offset.ty = Math.max(0, st.offset.ty - sec * ry);
      }
      applyRemoteInterpolation();
      return ran;
    }

    /**
     * 對手的播放時鐘。要畫在「最新快照 − RENDER_DELAY」那個時間點上，但不能直接
     * 用 newest.time − RENDER_DELAY + (now − newest.at) 算 ——
     * 伺服器的權威迴圈是 setInterval ＋ 累加器，只要遲到一次就會在同一輪補兩個
     * tick、兩份快照同一瞬間抵達。那個算式會因此瞬間往前跳一整個 tick，
     * 對手就在畫面上瞬移（實測 0.65 格，144Hz 特別明顯）。
     * 所以時鐘自己跟著真實時間走，再用每格 10% 慢慢往目標收；差太多才直接對時。
     */
    function remoteClock() {
      const newest = st.snaps[st.snaps.length - 1];
      const wall = now();
      const want = newest.time - C.RENDER_DELAY + (wall - newest.at) / 1000;
      if (st.playAt == null || st.playWall == null) {
        st.playAt = want;
        st.playWall = wall;
        return want;
      }
      let t = st.playAt + (wall - st.playWall) / 1000;   /* 先照真實時間前進 */
      st.playWall = wall;
      const diff = want - t;
      if (Math.abs(diff) > C.CLOCK_SNAP) t = want;       /* 差太多：直接對時 */
      else t += diff * C.CLOCK_EASE;                     /* 差一點：慢慢收 */
      st.playAt = t;
      return t;
    }

    /**
     * 「擠在一起」的權重（0～1）：越貼近越接近 1。
     *
     * 對手平常畫在 100ms 前（RENDER_DELAY），這樣看起來才順。但推擠的時候，
     * 物理上「剛好貼著」的兩個人在畫面上會疊進去半個身體 —— 因為對手的圖是他
     * 100ms ＋ 本地超前量之前的位置（實測重疊 0.65 格，身寬的 52%；200ms 延遲時
     * 是 0.88 格）。伺服器上的重疊永遠是 0，所以那純粹是畫面的落差。
     *
     * 解法：越靠近就越把畫面位置拉回「預測位置」（推擠判定用的那個），貼上去的
     * 時候完全用預測位置。這樣遠處保留內插的平順，近處不會重疊，中間是連續的
     * （靠近的過程中圖自己追上來），不會有接觸瞬間彈一下的問題。
     */
    function contactWeight(me, foe) {
      const W = Rules.C.PLAYER_W, H = Rules.C.PLAYER_H;
      /* 垂直的判斷要跟規則核心一致：resolvePush 只要「高度有交疊」就會把兩個人
       * 分開，也就是 dy < PLAYER_H 都算擠在一起。之前這裡從 0.6H 就開始淡出，
       * 結果一個人從另一個人身邊掉下去時（dy 1.2～2.0）畫面又疊回去了。 */
      const dy = Math.abs(me.y - foe.y);
      /* 淡出的終點就是這裡的門檻，兩個數字一定要一致 ——
       * 不一致的話權重會在門檻上從 0 跳到 0.76，對手的畫面就跳 0.46 格。 */
      if (dy >= H * 1.8) return 0;                 /* 高度差這麼多，擠不到了 */
      const dx = Math.abs(me.x - foe.x);
      const full = W * 1.15;                       /* 這麼近就完全用預測位置 */
      const none = W * 2.6;                        /* 這麼遠就完全用內插位置 */
      let t = dx <= full ? 1 : dx >= none ? 0 : (none - dx) / (none - full);
      /* 垂直只在「已經超出推擠範圍」之後才淡出，而且淡得長一點（0.95H → 1.8H），
       * 這樣一個人從另一個人身邊掉過去的時候是慢慢交還給內插位置，不會彈一下 */
      if (dy > H * 0.95) t *= 1 - (dy - H * 0.95) / (H * 0.85);
      return Math.max(0, Math.min(1, t));
    }

    /** 對手：畫在 100ms 前，兩個快照之間內插（§4.2）；貼在一起時拉回預測位置 */
    function applyRemoteInterpolation() {
      if (!st.match || st.snaps.length < 2) return;
      const target = remoteClock();
      let a = st.snaps[0], b = st.snaps[st.snaps.length - 1];
      for (let i = 0; i < st.snaps.length - 1; i++) {
        if (st.snaps[i].time <= target && st.snaps[i + 1].time >= target) {
          a = st.snaps[i]; b = st.snaps[i + 1];
          break;
        }
      }
      const span = b.time - a.time;
      const k = span > 1e-6 ? Math.min(1, Math.max(0, (target - a.time) / span)) : 1;
      const mine = st.match.players.find(p => isMe(p.id));
      for (const p of st.match.players) {
        if (isMe(p.id)) continue;
        const pa = a.players.find(x => x.id === p.id);
        const pb = b.players.find(x => x.id === p.id);
        if (!pa || !pb) continue;
        /* 對手有兩個位置，故意不一樣：
         *   viewX／viewY ＝ 畫面用。照快照時間軸內插、刻意畫在 100ms 前，才會順。
         *   x／y         ＝ 邏輯用。權威快照 ＋ 本地重演推到「現在」的推測位置。
         * 以前這裡直接蓋掉 x／y，於是推擠是拿「快 180ms 前的對手」在算 ——
         * 伺服器用的是當下的對手，兩邊算出來的推擠量不同，每份快照都把我拉回去
         * 一次，推的時候畫面就一直閃一直抖（實測 x 誤差到 1.0 格）。
         * 現在畫面照舊用延遲位置，推擠改用推測位置，兩邊就對得上了。 */
        let vx = pa.x + (pb.x - pa.x) * k;
        let vy = pa.y + (pb.y - pa.y) * k;
        /* 擠在一起就把畫面位置拉回預測位置，畫面上才不會重疊（見 contactWeight）。
         * 權重只看「物理上的距離」（預測位置）——
         * 試過連畫面上的距離也一起看（想順手修掉「一個人從旁邊掉過去時，
         * 物理上錯開、畫面上卻看起來疊到」的那 3 幀），但那會讓權重在進出接觸時
         * 忽然切換，對手的畫面就跳 0.75 格。用物理距離就完全不會跳，
         * 而真正在推擠（伺服器判定兩人接觸）的時候重疊是 0。 */
        if (mine && mine.alive && p.alive) {
          const near = contactWeight(mine, p);
          if (near > 0) {
            vx += (p.x - vx) * near;
            vy += (p.y - vy) * near;
          }
        }
        p.viewX = vx;
        p.viewY = vy;
      }
    }

    const clampOffset = v => Math.max(-C.OFFSET_MAX, Math.min(C.OFFSET_MAX, v));

    /** 自己的視覺補正量（render 時把它加回去，校正就不會看到瞬移） */
    function visualOffset() {
      if (st.offset.tx <= 0 && st.offset.ty <= 0) return { x: 0, y: 0 };
      return {
        x: st.offset.x * Math.max(0, st.offset.tx) / C.SMOOTH,
        y: st.offset.y * Math.max(0, st.offset.ty) / C.SMOOTH
      };
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
