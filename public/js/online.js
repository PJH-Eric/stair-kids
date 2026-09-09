/* ===== online.js — 線上模式：連線、大廳、房間、觀戰、聊天 =====
 *
 * 規劃書 §6／§7.4。分工刻意切乾淨：
 *   net.js     只管「同步」（預測、校正、內插），不碰 DOM
 *   這一支      只管「畫面與操作」（大廳、房間、聊天）＋ 一條 WebSocket
 *   app.js     只管「遊戲畫面」，透過下面的 callback 被通知該開打／該收局了
 *
 * 為什麼不把 UI 寫進 net.js：net.js 要能在 Node 裡被 netcode-check 直接跑。
 */
(function (root) {
  'use strict';

  const Net = root.Net;
  const Rules = root.Rules;
  const Render = root.Render;
  const Characters = root.Characters;
  const Nicknames = root.Nicknames;

  /* 對局中不能打字（方向鍵會被輸入框吃掉），所以只給短語（規劃書 §7.4） */
  const PHRASES = ['加油！', '小心刺！', '厲害！', '等我一下', '再來一局', '哈哈哈'];

  const $ = (sel, root2) => (root2 || document).querySelector(sel);
  const esc = t => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** http(s):// → ws(s)://…/ws */
  function wsUrl(httpUrl) {
    if (!httpUrl) return null;
    return String(httpUrl).replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';
  }

  /**
   * @param {object} opt
   *   serverUrl   從 config.js 拿，不在這裡硬編碼
   *   onMatchStart(info)  info = { spectating, meId }
   *   onMatchEnd(result)
   *   onBackToLobby()
   *   onNotice(text, kind)
   *   nameOf() / charOf()  目前的暱稱與角色（app.js 保管設定）
   */
  function create(opt) {
    opt = opt || {};
    const notice = (t, k) => { if (opt.onNotice) opt.onNotice(t, k); };

    const els = {
      lobbyStatus: $('#lobby-status'),
      lobbyList: $('#lobby-list'),
      lobbyEmpty: $('#lobby-empty'),
      lobbyMe: $('#lobby-me'),
      btnQuick: $('#btn-quick'),
      btnCreate: $('#btn-create'),
      btnRefresh: $('#btn-refresh'),
      btnReconnect: $('#btn-reconnect'),

      roomTitle: $('#room-title'),
      roomDiff: $('#room-diff'),
      roomSeats: $('#room-seats'),
      roomSpecs: $('#room-specs'),
      roomSpecsBlock: $('#room-specs-block'),
      btnReady: $('#btn-ready'),
      btnStart: $('#btn-start-online'),
      btnSeat: $('#btn-take-seat'),
      btnLeave: $('#btn-leave-room'),
      btnInvite: $('#btn-invite'),
      inviteBox: $('#invite-box'),
      inviteLink: $('#invite-link'),
      btnInviteCopy: $('#btn-invite-copy'),
      btnInviteRevoke: $('#btn-invite-revoke'),
      roomHint: $('#room-hint'),

      chatList: $('#chat-list'),
      chatForm: $('#chat-form'),
      chatInput: $('#chat-input'),
      chatPhrases: $('#chat-phrases'),

      gameChat: $('#side-chat'),
      gameChatList: $('#game-chat-list'),
      gameChatPhrases: $('#game-chat-phrases')
    };

    const S = {
      status: 'offline',          /* offline | connecting | online | error */
      socket: null,
      client: null,
      retries: 0,
      retryTimer: 0,
      wakeTimer: 0,
      pendingInvite: null,        /* 連上線之後要用的邀請碼 */
      wantRoom: null,             /* 連上線之後要進的房號 */
      inMatch: false,
      resultShown: false,
      spectating: false,
      lastRoomPhase: null,
      chatSeen: 0
    };

    /* ---------- 連線 ---------- */

    function client() { return S.client; }

    function setStatus(next, text) {
      S.status = next;
      if (els.lobbyStatus) {
        els.lobbyStatus.textContent = text || ({
          offline: '沒有連線', connecting: '連線中…', online: '已連線', error: '連不上伺服器'
        })[next];
        els.lobbyStatus.dataset.state = next;
      }
      if (els.btnReconnect) els.btnReconnect.hidden = next === 'online' || next === 'connecting';
      const busy = next !== 'online';
      for (const b of [els.btnQuick, els.btnCreate, els.btnRefresh]) if (b) b.disabled = busy;
    }

    function connect(then) {
      if (S.status === 'online') { if (then) then(); return; }
      if (S.status === 'connecting') { if (then) S.afterConnect = then; return; }
      const url = wsUrl(opt.serverUrl);
      if (!url) {
        setStatus('error', '這個網頁沒有設定伺服器位置，只能玩單機');
        return;
      }
      S.afterConnect = then || null;
      setStatus('connecting');

      let socket;
      try { socket = new WebSocket(url); } catch (e) {
        setStatus('error');
        return;
      }
      S.socket = socket;

      /* Render 免費方案會休眠，第一個人進來要等 30～60 秒冷啟動。
       * 三秒還沒連上就把原因寫出來，不然使用者只會看到「連線中…」以為壞了。 */
      clearTimeout(S.wakeTimer);
      S.wakeTimer = setTimeout(() => {
        if (S.status === 'connecting') {
          setStatus('connecting', '喚醒伺服器中…（免費方案會休眠，第一次要等 30～60 秒）');
        }
      }, 3000);

      /* Net 客戶端：送出動作走這條 socket，其他（預測、校正、內插）它自己處理 */
      S.client = Net.createClient({
        name: opt.nameOf ? opt.nameOf() : '',
        char: opt.charOf ? opt.charOf() : 'yuan',
        beforeStep: opt.beforeStep || null,
        send(msg) {
          if (socket.readyState === 1) socket.send(JSON.stringify(msg));
        }
      });

      socket.onopen = () => {
        S.retries = 0;
        clearTimeout(S.wakeTimer);
        setStatus('online');
        /* 伺服器一連上就會送 hello，Net 收到會自己回 hello（帶暱稱與角色） */
      };
      socket.onmessage = ev => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        S.client.receive(msg);
        afterMessage(msg);
      };
      socket.onclose = () => {
        if (S.socket !== socket) return;
        clearTimeout(S.wakeTimer);
        S.socket = null;
        const wasOnline = S.status === 'online';
        setStatus('offline');
        if (S.inMatch) {
          notice('連線斷了，這局判輸', 'bad');
          S.inMatch = false;
          if (opt.onBackToLobby) opt.onBackToLobby();
        }
        renderRoom();
        renderLobby();
        /* 自動重試三次（越試越久），之後交給「重新連線」按鈕 */
        if (wasOnline && S.retries < 3) {
          S.retries++;
          clearTimeout(S.retryTimer);
          S.retryTimer = setTimeout(() => connect(), 600 * S.retries);
        }
      };
      socket.onerror = () => { if (S.status === 'connecting') setStatus('error'); };
    }

    function disconnect() {
      clearTimeout(S.retryTimer);
      clearTimeout(S.wakeTimer);
      S.retries = 99;
      if (S.socket) { const s = S.socket; S.socket = null; try { s.close(); } catch (e) { /* 已經斷了 */ } }
      S.client = null;
      S.inMatch = false;
      setStatus('offline');
    }

    /* ---------- 收到訊息之後：畫面該怎麼變 ---------- */

    function afterMessage(msg) {
      const c = S.client;
      if (!c) return;

      if (msg.type === 'welcome') {
        /* 身分確認之後才處理「進來就要做的事」（邀請連結、指定房號） */
        if (S.pendingInvite) { const t = S.pendingInvite; S.pendingInvite = null; c.actions.useInvite(t); }
        else if (S.wantRoom) { const r = S.wantRoom; S.wantRoom = null; c.actions.join(r, 'player'); }
        if (S.afterConnect) { const f = S.afterConnect; S.afterConnect = null; f(); }
        renderLobby();
        return;
      }
      if (msg.type === 'rooms') { renderLobby(); return; }
      if (msg.type === 'error') { notice(msg.text, 'bad'); renderRoom(); return; }
      if (msg.type === 'notice') { notice(msg.text); return; }
      if (msg.type === 'kicked') { notice('你被房主請出房間了', 'bad'); leaveToLobby(); return; }
      if (msg.type === 'left') { leaveToLobby(); return; }
      if (msg.type === 'invite') { renderRoom(); return; }

      if (msg.type === 'joined' || msg.type === 'room') {
        const room = c.state.room;
        renderRoom();
        renderChat();
        if (msg.type === 'joined' && opt.onEnterRoom) opt.onEnterRoom(room);
        const delayedResult = msg.type === 'room' && room && room.phase === 'lobby' &&
          S.inMatch && c.state.result && !S.resultShown;
        if (delayedResult) {
          notifyMatchEnd();
          return;
        }
        checkPhase(room);
        return;
      }
      if (msg.type === 'snap') {
        checkPhase(c.state.room);
        notifyMatchEnd();
      }
    }

    const myId = () => (S.client ? S.client.state.me.id : null);

    /** 房間的階段變了就通知 app.js 進／出遊戲畫面 */
    function checkPhase(room) {
      if (!room) return;
      const c = S.client;
      if (room.phase !== S.lastRoomPhase) {
        const prev = S.lastRoomPhase;
        S.lastRoomPhase = room.phase;
        if (room.phase === 'playing') S.resultShown = false;
        /* 只有「從對局／結算回到房間」才通知，第一次看到房間（prev 是 null）不算 ——
         * 不然剛進房就會被當成「這局結束了」而被送回大廳。 */
        if (room.phase === 'lobby' && S.inMatch) {
          S.inMatch = false;
        } else if (room.phase === 'lobby' && prev && prev !== 'lobby' && opt.onBackToLobby) {
          opt.onBackToLobby();
        }
      }
      const resultReady = room.phase === 'result' && !S.resultShown;
      if (!S.inMatch && c.match && (room.phase === 'playing' || resultReady)) {
        S.inMatch = true;
        S.spectating = room.youAre !== 'player';
        if (opt.onMatchStart) opt.onMatchStart({ spectating: S.spectating, meId: myId(), room: room });
      }
    }

    function notifyMatchEnd() {
      const c = S.client;
      if (!c || !c.state.result || S.resultShown) return;
      S.resultShown = true;
      S.inMatch = false;
      if (opt.onMatchEnd) opt.onMatchEnd(c.state.result, myId());
    }

    function leaveToLobby() {
      S.inMatch = false;
      S.resultShown = false;
      S.lastRoomPhase = null;
      if (S.client) S.client.state.room = null;
      renderRoom();
      if (opt.onBackToLobby) opt.onBackToLobby();
    }

    /* ---------- 大廳 ---------- */

    function renderLobby() {
      const c = S.client;
      if (els.lobbyMe && c) {
        els.lobbyMe.innerHTML = Render.kidAvatarSvg(Characters.byId(c.state.me.char), 34) +
          '<b>' + esc(c.state.me.name) + '</b>';
      }
      if (!els.lobbyList) return;
      const rooms = (c && c.state.rooms) || [];
      els.lobbyList.innerHTML = rooms.map(r => {
        const full = r.players >= r.seats;
        const playing = r.phase !== 'lobby';
        const label = playing ? '對局中' : full ? '席位已滿' : '等人';
        const act = playing || full ? '觀戰' : '加入';
        /* 整張卡都可以點（手指按整張卡比按右邊那顆小按鈕容易得多）。
         * 裡面那顆按鈕留著當視覺提示，也留給鍵盤操作 —— 點按鈕時
         * closest('[data-join]') 會先命中按鈕，行為一樣。 */
        return '<li class="room-item" data-join="' + esc(r.id) + '" ' +
          'data-role="' + (playing || full ? 'spectator' : 'player') + '">' +
          '<div class="room-item-main">' +
            '<b>' + esc(r.name) + '</b>' +
            '<span class="room-meta">' + esc(r.difficultyName) + '　' +
              r.players + '/' + r.seats + ' 人' +
              (r.spectators ? '　觀戰 ' + r.spectators : '') + '</span>' +
          '</div>' +
          '<span class="room-tag' + (playing ? ' hot' : full ? ' full' : '') + '">' + label + '</span>' +
          '<button class="mini-btn go" type="button" data-join="' + esc(r.id) + '" ' +
            'data-role="' + (playing || full ? 'spectator' : 'player') + '">' + act + '</button>' +
        '</li>';
      }).join('');
      if (els.lobbyEmpty) els.lobbyEmpty.hidden = rooms.length > 0;
    }

    /* ---------- 房間 ---------- */

    function seatCard(m, room, iAmHost) {
      const tags = [];
      if (m.host) tags.push('<span class="pill host">房主</span>');
      if (!m.connected) tags.push('<span class="pill off">離線</span>');
      if (m.ready) tags.push('<span class="pill ready">準備好</span>');
      return '<li class="seat' + (m.ready ? ' is-ready' : '') + (m.connected ? '' : ' is-off') + '">' +
        '<div class="seat-face">' + Render.kidAvatarSvg(Characters.byId(m.char), 56) + '</div>' +
        '<div class="seat-body"><b>' + esc(m.name) + (m.id === myId() ? '（你）' : '') + '</b>' +
          '<div class="seat-tags">' + (tags.join('') || '<span class="pill wait">還沒準備</span>') + '</div>' +
        '</div>' +
        (iAmHost && m.id !== myId()
          ? '<button class="mini-btn danger" type="button" data-kick="' + esc(m.id) + '">請他離開</button>'
          : '') +
      '</li>';
    }

    function renderRoom() {
      const c = S.client;
      const room = c && c.state.room;
      if (!els.roomSeats) return;
      if (!room) {
        els.roomSeats.innerHTML = '';
        if (els.roomTitle) els.roomTitle.textContent = '房間';
        return;
      }
      const iAmHost = !!room.isHost;
      const seats = room.members.filter(m => m.role === 'player');
      const specs = room.members.filter(m => m.role === 'spectator');

      if (els.roomTitle) els.roomTitle.textContent = room.name;
      if (els.roomDiff) {
        els.roomDiff.innerHTML = Rules.DIFFICULTY_LIST
          .filter(id => Rules.DIFFICULTY[id].versus)
          .map(id => '<button class="diff-btn' + (room.difficulty === id ? ' on' : '') +
            '" type="button" data-diff="' + id + '"' + (iAmHost && room.phase === 'lobby' ? '' : ' disabled') +
            '>' + Rules.DIFFICULTY[id].name + '</button>').join('');
      }

      const empty = '<li class="seat is-empty"><div class="seat-face"></div>' +
        '<div class="seat-body"><b>等人進來…</b>' +
        '<div class="seat-tags"><span class="pill wait">空位</span></div></div></li>';
      els.roomSeats.innerHTML = seats.map(m => seatCard(m, room, iAmHost)).join('') +
        (seats.length < room.seats ? empty : '');

      if (els.roomSpecsBlock) els.roomSpecsBlock.hidden = specs.length === 0;
      if (els.roomSpecs) {
        els.roomSpecs.innerHTML = specs.map(m =>
          '<li class="spec' + (m.connected ? '' : ' is-off') + '">' +
            Render.kidAvatarSvg(Characters.byId(m.char), 28) +
            '<span>' + esc(m.name) + (m.id === myId() ? '（你）' : '') + '</span>' +
            (iAmHost && m.id !== myId()
              ? '<button class="mini-btn danger tiny" type="button" data-kick="' + esc(m.id) + '">請他離開</button>'
              : '') +
          '</li>').join('');
      }

      const me = room.members.find(m => m.id === myId());
      const amPlayer = me && me.role === 'player';
      if (els.btnReady) {
        els.btnReady.hidden = !amPlayer || room.phase !== 'lobby';
        els.btnReady.textContent = me && me.ready ? '取消準備' : '我準備好了';
        els.btnReady.classList.toggle('primary', !(me && me.ready));
      }
      if (els.btnStart) {
        els.btnStart.hidden = !iAmHost || room.phase !== 'lobby';
        els.btnStart.disabled = !room.canStart;
      }
      if (els.btnSeat) els.btnSeat.hidden = !room.canTakeSeat;
      if (els.btnInvite) els.btnInvite.hidden = !iAmHost;
      if (els.inviteBox) {
        els.inviteBox.hidden = !room.invite;
        if (room.invite && els.inviteLink) els.inviteLink.value = inviteHref(room.invite);
      }
      if (els.roomHint) {
        els.roomHint.textContent =
          room.phase === 'playing' ? '對局進行中'
          : room.phase === 'result' ? '結算中，等一下就回房間'
          : !amPlayer ? '你在觀戰。席位空出來就可以搶（先按先得）'
          : seats.length < room.seats ? '等另一個人進來，或用邀請連結叫朋友'
          : room.canStart ? '兩個人都準備好了，房主可以開始'
          : '兩個人都按「我準備好了」才能開始';
      }
      renderChat();
    }

    function inviteHref(token) {
      try {
        const u = new URL(root.location.href);
        u.searchParams.set('invite', token);
        u.hash = '';
        return u.toString();
      } catch (e) {
        return root.location.href.split('?')[0] + '?invite=' + token;
      }
    }

    /* ---------- 聊天 ---------- */

    function chatHtml(lines) {
      return lines.map(l => l.sys
        ? '<li class="chat-sys">' + esc(l.text) + '</li>'
        : '<li class="chat-line' + (l.role === 'spectator' ? ' spec' : '') + '">' +
            '<b>' + esc(l.who) + '</b>' + esc(l.text) + '</li>').join('');
    }

    function renderChat() {
      const c = S.client;
      const room = c && c.state.room;
      const lines = (room && room.chat) || [];
      if (els.chatList) {
        els.chatList.innerHTML = chatHtml(lines);
        els.chatList.scrollTop = els.chatList.scrollHeight;
      }
      /* 對局中的側欄只放最後幾行，不然會把資訊欄吃光 */
      if (els.gameChatList) {
        els.gameChatList.innerHTML = chatHtml(lines.slice(-5));
        els.gameChatList.scrollTop = els.gameChatList.scrollHeight;
      }
    }

    function renderPhrases() {
      const html = PHRASES.map(t =>
        '<button class="mini-btn phrase" type="button" data-say="' + esc(t) + '">' + esc(t) + '</button>').join('');
      if (els.chatPhrases) els.chatPhrases.innerHTML = html;
      if (els.gameChatPhrases) els.gameChatPhrases.innerHTML = html;
    }

    /* ---------- 綁事件 ---------- */

    function bind() {
      renderPhrases();

      if (els.btnQuick) els.btnQuick.addEventListener('click', () =>
        connect(() => S.client && S.client.actions.quick()));
      if (els.btnCreate) els.btnCreate.addEventListener('click', () =>
        connect(() => S.client && S.client.actions.create('', 'normal')));
      if (els.btnRefresh) els.btnRefresh.addEventListener('click', () =>
        connect(() => S.client && S.client.actions.rooms()));
      if (els.btnReconnect) els.btnReconnect.addEventListener('click', () => {
        S.retries = 0;
        connect();
      });

      if (els.lobbyList) els.lobbyList.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-join]');
        if (!btn) return;
        const id = btn.getAttribute('data-join');
        const role = btn.getAttribute('data-role') || 'player';
        connect(() => S.client && S.client.actions.join(id, role));
      });

      if (els.roomDiff) els.roomDiff.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-diff]');
        if (!btn || btn.disabled) return;
        if (S.client) S.client.actions.config({ difficulty: btn.getAttribute('data-diff') });
      });

      const kickHandler = ev => {
        const btn = ev.target.closest('[data-kick]');
        if (!btn) return;
        if (S.client) S.client.actions.kick(btn.getAttribute('data-kick'));
      };
      if (els.roomSeats) els.roomSeats.addEventListener('click', kickHandler);
      if (els.roomSpecs) els.roomSpecs.addEventListener('click', kickHandler);

      if (els.btnReady) els.btnReady.addEventListener('click', () => {
        const c = S.client;
        if (!c || !c.state.room) return;
        const me = c.state.room.members.find(m => m.id === myId());
        c.actions.ready(!(me && me.ready));
      });
      if (els.btnStart) els.btnStart.addEventListener('click', () => S.client && S.client.actions.start());
      if (els.btnSeat) els.btnSeat.addEventListener('click', () => S.client && S.client.actions.seat());
      if (els.btnLeave) els.btnLeave.addEventListener('click', () => {
        if (S.client) S.client.actions.leave();
        leaveToLobby();
      });

      if (els.btnInvite) els.btnInvite.addEventListener('click', () => S.client && S.client.actions.invite());
      if (els.btnInviteRevoke) els.btnInviteRevoke.addEventListener('click', () =>
        S.client && S.client.actions.revokeInvite());
      if (els.btnInviteCopy) els.btnInviteCopy.addEventListener('click', () => {
        const v = els.inviteLink ? els.inviteLink.value : '';
        if (!v) return;
        /* clipboard 在非 https 會被擋，所以留 fallback：選起來讓使用者自己複製 */
        const done = () => notice('邀請連結複製好了，貼給朋友就可以進來');
        if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
          root.navigator.clipboard.writeText(v).then(done, () => { els.inviteLink.select(); });
        } else {
          els.inviteLink.select();
          notice('已經選起來了，按 Ctrl+C 複製');
        }
      });

      if (els.chatForm) els.chatForm.addEventListener('submit', ev => {
        ev.preventDefault();
        const text = els.chatInput ? els.chatInput.value : '';
        if (!text.trim()) return;
        if (S.client) S.client.actions.chat(text);
        if (els.chatInput) els.chatInput.value = '';
      });

      const sayHandler = ev => {
        const btn = ev.target.closest('[data-say]');
        if (!btn) return;
        if (S.client) S.client.actions.chat(btn.getAttribute('data-say'));
      };
      if (els.chatPhrases) els.chatPhrases.addEventListener('click', sayHandler);
      if (els.gameChatPhrases) els.gameChatPhrases.addEventListener('click', sayHandler);
    }

    /* ---------- 對外 ---------- */

    /** 網址帶 ?invite=xxx 就直接進那間房（伺服器會驗，無效會給看得懂的提示） */
    function takeInviteFromUrl() {
      let token = '';
      try {
        token = new URLSearchParams(root.location.search).get('invite') || '';
      } catch (e) { token = ''; }
      if (!token) return null;
      S.pendingInvite = token;
      /* 用掉之後把網址清乾淨，重新整理才不會又跳一次 */
      try {
        const u = new URL(root.location.href);
        u.searchParams.delete('invite');
        root.history.replaceState({}, '', u.toString());
      } catch (e) { /* 舊瀏覽器就算了 */ }
      return token;
    }

    bind();
    setStatus('offline');

    return {
      PHRASES,
      connect, disconnect, client,
      renderLobby, renderRoom, renderChat,
      takeInviteFromUrl,
      get status() { return S.status; },
      get inMatch() { return S.inMatch; },
      get spectating() { return S.spectating; },
      get room() { return S.client ? S.client.state.room : null; },
      get meId() { return myId(); },
      /** 對局中每一格：推進本地預測（含送出輸入意圖） */
      frame(nowMs, dir) { return S.client ? S.client.frame(nowMs, dir) : 0; },
      takeEvents() { return S.client ? S.client.takeEvents() : []; },
      stats() { return S.client ? S.client.stats() : null; },
      visualOffset() { return S.client ? S.client.visualOffset() : { x: 0, y: 0 }; },
      alpha() { return S.client ? S.client.alpha() : 0; },
      get match() { return S.client ? S.client.match : null; },
      /** 名字或角色改了要告訴伺服器（房間卡片、名牌都要跟著換） */
      syncMe(name, char) {
        if (!S.client) return;
        if (name && name !== S.client.state.me.name) S.client.actions.rename(name);
        if (char && char !== S.client.state.me.char) S.client.actions.setChar(char);
        renderLobby();
      }
    };
  }

  root.Online = { create, PHRASES };
})(typeof self !== 'undefined' ? self : this);
