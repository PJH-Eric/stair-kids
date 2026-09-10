/* ===== lib/rooms.js — 房間、2 席位、觀戰、搶位、邀請、聊天 =====
 * 只管規則以外的事，完全不碰 socket，所以可以直接寫測試。
 * 對局本身交給 public/js/rules.js（前後端同一套規則核心）。
 */
'use strict';

const Rules = require('../public/js/rules.js');
const Ai = require('../public/js/ai.js');
const Characters = require('../public/js/themes/characters.js');
const Nicknames = require('../public/js/themes/nicknames.js');
const RNG = require('../public/js/rng.js');

const CONST = {
  MAX_ROOMS: 40,
  INPUT_AHEAD_MAX: 1.0,      /* 輸入最多可以預約到幾秒後生效（超過就當作亂送，立刻生效） */
  INPUT_QUEUE_MAX: 30,       /* 每個人最多排幾筆還沒生效的輸入 */
  SEATS: 2,                  /* 固定 2 人（規劃書 §0.1） */
  MAX_SPECTATORS: 20,        /* 觀戰上限（§0.3） */
  CHAT_KEEP: 60,
  CHAT_MAX_LEN: 60,
  NAME_MAX_LEN: 8,
  HEARTBEAT_MS: 1000,
  DEAD_AFTER_MISSES: 2,      /* 心跳連兩次沒回就當斷線（§14.1，約 2 秒） */
  RESULT_MS: 10000,          /* 結算停留多久後回房間 */
  EMPTY_GRACE_MS: 60000,     /* 房間沒人之後還留多久才真的關掉（手機切出去再回來） */
  TICK_HZ: 30
};

const DIFFS = ['easy', 'normal', 'hard'];   /* 對戰不開放幼幼班（§0.2） */

let seq = 1;
const nextId = prefix => prefix + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

function token() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}

function clean(text, max) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

function createHub(opt) {
  opt = opt || {};
  const now = opt.now || (() => Date.now());
  /* 每局的樓梯 seed。預設隨機，測試可以換成固定的，這樣同一局能重播 */
  const newSeed = opt.newSeed || (() => RNG.newSeed());
  const rooms = new Map();
  const invites = new Map();
  const closedRooms = [];

  const seatsOf = room => [...room.members.values()].filter(m => m.role === 'player');
  const specsOf = room => [...room.members.values()].filter(m => m.role === 'spectator');
  const connectedSeats = room => seatsOf(room).filter(m => m.connected);
  const validDiff = id => DIFFS.indexOf(id) >= 0;

  /* ---------- 房間生命週期 ---------- */

  /** 真的關房：邀請連結一起失效（§0.3） */
  function dropRoom(room) {
    if (!room || !rooms.has(room.id)) return false;
    if (room.invite) invites.delete(room.invite.token);
    room.invite = null;
    rooms.delete(room.id);
    closedRooms.push(room.id);
    return true;
  }

  /**
   * 沒人了就準備關房 —— 但「等人」的房間不立刻關。
   *
   * 手機切到別的 App、螢幕暗掉、鎖屏，連線都會斷。立刻關掉的話，
   * 「開好房間 → 切出去把邀請連結貼給朋友 → 切回來」房間就沒了，
   * 剛貼出去的邀請連結也一起失效（Eric 回報「房間在有人的時候會自動關閉」）。
   * 所以「斷線」造成的空房（grace = true）在大廳階段留 EMPTY_GRACE_MS 的寬限，
   * 連邀請連結一起留著，時間到了才由 tick() 收掉。
   * 自己按「離開房間」是真的要走，立刻關；對局中沒人看也沒有留的意義，一樣立刻關。
   */
  function closeIfEmpty(room, grace) {
    if (!room || !rooms.has(room.id)) return false;
    if ([...room.members.values()].some(m => m.connected)) { room.emptyAt = 0; return false; }
    if (grace && room.phase === 'lobby') {
      if (!room.emptyAt) room.emptyAt = now();
      return false;
    }
    return dropRoom(room);
  }

  function createRoom(person, cfg) {
    cfg = cfg || {};
    if (rooms.size >= CONST.MAX_ROOMS) return { error: '房間數量已滿，等一下再試' };
    const room = {
      id: nextId('r'),
      name: clean(cfg.name, 16) || (person.name + ' 的房間'),
      hostId: person.id,
      difficulty: validDiff(cfg.difficulty) ? cfg.difficulty : 'normal',
      phase: 'lobby',                 /* lobby | countdown | playing | result */
      members: new Map(),
      match: null,
      seed: null,
      inputs: new Map(),              /* personId → { dir } 目前生效的方向 */
      inputQ: new Map(),              /* personId → [{ at, dir }] 還沒到生效時間的輸入 */
      lastSeq: new Map(),
      lastStamp: new Map(),
      chat: [],
      invite: null,
      resultUntil: 0,
      emptyAt: 0,                     /* 什麼時候變成沒人的（見 closeIfEmpty 的寬限） */
      createdAt: now()
    };
    rooms.set(room.id, room);
    const joined = join(room.id, person, 'player');
    if (joined.error) { rooms.delete(room.id); return joined; }
    return { room: room, role: 'player' };
  }

  function listRooms() {
    return [...rooms.values()]
      .filter(r => [...r.members.values()].some(m => m.connected))
      .map(r => ({
        id: r.id,
        name: r.name,
        difficulty: r.difficulty,
        difficultyName: Rules.DIFFICULTY[r.difficulty].name,
        players: connectedSeats(r).length,
        seats: CONST.SEATS,
        spectators: specsOf(r).filter(m => m.connected).length,
        phase: r.phase,
        hasInvite: !!r.invite
      }));
  }

  /**
   * 進房。席位滿了自動轉觀戰（§0.3），觀戰也滿了就拒絕。
   * @param {string} wantRole 'player' | 'spectator'
   */
  function join(roomId, person, wantRole) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    room.emptyAt = 0;                 /* 有人進來就取消「沒人了」的倒數 */
    const existing = room.members.get(person.id);
    if (existing) {
      existing.connected = true;
      existing.misses = 0;
      return { room: room, role: existing.role, rejoined: true };
    }
    let role = wantRole === 'spectator' ? 'spectator' : 'player';
    if (role === 'player' && connectedSeats(room).length >= CONST.SEATS) role = 'spectator';
    if (role === 'spectator' && specsOf(room).filter(m => m.connected).length >= CONST.MAX_SPECTATORS) {
      return { error: '觀戰席已滿（上限 ' + CONST.MAX_SPECTATORS + ' 人）' };
    }
    room.members.set(person.id, {
      id: person.id,
      name: clean(person.name, CONST.NAME_MAX_LEN) || Nicknames.random(),
      char: Characters.byId(person.char).id,
      role: role,
      ready: false,
      resultDone: false,               /* 結算看完了（兩邊都看完就提早收場） */
      connected: true,
      misses: 0,
      joinedAt: now()
    });
    if (!room.hostId || !room.members.has(room.hostId)) room.hostId = person.id;
    systemChat(room, room.members.get(person.id).name +
      (role === 'player' ? ' 進來了' : ' 進來觀戰'));
    return { room: room, role: role };
  }

  /** 找不到空房就自己開一間等人（§6 快速加入） */
  function quickJoin(person) {
    const open = [...rooms.values()].find(r =>
      r.phase === 'lobby' && connectedSeats(r).length < CONST.SEATS);
    if (open) return join(open.id, person, 'player');
    return createRoom(person, {});
  }

  function leave(roomId, personId) {
    const room = rooms.get(roomId);
    if (!room) return { ok: true };
    const me = room.members.get(personId);
    if (!me) return { ok: true };
    /* 對局進行中離開＝斷線判輸（§4.4） */
    if (room.phase === 'playing' && me.role === 'player') forfeit(room, personId, '離開了');
    room.members.delete(personId);
    room.inputs.delete(personId);
    if (room.hostId === personId) {
      const next = connectedSeats(room)[0] || [...room.members.values()].find(m => m.connected);
      room.hostId = next ? next.id : null;
      if (next) systemChat(room, next.name + ' 成為房主');
    }
    systemChat(room, (me.name || '有人') + ' 離開了');
    closeIfEmpty(room);
    return { ok: true };
  }

  /** 連線真的斷了（WebSocket close/error，或心跳連兩次沒回） */
  function markDisconnected(personId) {
    for (const room of rooms.values()) {
      const me = room.members.get(personId);
      if (!me || !me.connected) continue;
      me.connected = false;
      if (room.phase === 'playing' && me.role === 'player') forfeit(room, personId, '斷線了');
      else systemChat(room, me.name + ' 離線了');
      /* 等人階段的斷線就當作離開，把席位收回來：重新連上線一定會拿到一個新身分
       * （personId 是每條連線發一個），這個席位永遠不會有人回來坐。
       * 留著的話：席位被佔住、房主還掛在一個回不來的人身上（hostId 還在 members 裡），
       * 本人切回來也只能當觀戰、開不了下一局。 */
      if (room.phase === 'lobby') {
        room.members.delete(personId);
        room.inputs.delete(personId);
      }
      if (room.hostId === personId) {
        const next = connectedSeats(room)[0];
        room.hostId = next ? next.id : room.hostId;
        if (next) systemChat(room, next.name + ' 成為房主');
      }
      closeIfEmpty(room, true);
    }
  }

  /** 斷線判輸：立刻淘汰，對手照常玩完（§4.4） */
  function forfeit(room, personId, why) {
    const m = room.match;
    if (!m) return;
    const p = m.players.find(x => x.id === personId);
    if (!p || !p.alive) return;
    p.hp = 0;
    p.alive = false;
    p.forfeit = true;
    p.state = 'stun';
    p.dir = 0;
    systemChat(room, (room.members.get(personId) || {}).name + ' ' + (why || '斷線了') + '，判輸');
  }

  /* ---------- 房間設定與席位 ---------- */

  function updateRoom(roomId, hostId, cfg) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    if (room.hostId !== hostId) return { error: '只有房主可以改設定' };
    if (room.phase !== 'lobby') return { error: '對局進行中不能改設定' };
    if (cfg.difficulty != null) {
      if (!validDiff(cfg.difficulty)) return { error: '對戰只有簡單／普通／困難' };
      room.difficulty = cfg.difficulty;
      resetReady(room);
      systemChat(room, '難度改成「' + Rules.DIFFICULTY[room.difficulty].name + '」');
    }
    if (cfg.name != null) room.name = clean(cfg.name, 16) || room.name;
    return { room: room };
  }

  function setReady(roomId, personId, ready) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    const me = room.members.get(personId);
    if (!me || me.role !== 'player') return { error: '只有玩家可以按準備好' };
    me.ready = !!ready;
    return { room: room };
  }

  function resetReady(room) {
    for (const m of room.members.values()) { m.ready = false; m.resultDone = false; }
  }

  /**
   * 「結算我看完了」。兩邊都看完就不用把整個結算停留跑完 ——
   * 不然按了結算上的「再來一局／回到房間」還要在房間裡乾等到 10 秒，
   * 準備、開始那些按鈕全都還是灰的，看起來就像壞掉（§14.2）。
   */
  function resultDone(roomId, personId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    const me = room.members.get(personId);
    if (!me) return { error: '你不在房間裡' };
    me.resultDone = true;
    return { room: room };
  }

  const allResultDone = room => {
    const s = connectedSeats(room);
    return s.length > 0 && s.every(m => m.resultDone);
  };

  const allReady = room => {
    const s = connectedSeats(room);
    return s.length === CONST.SEATS && s.every(m => m.ready);
  };

  /**
   * 搶位：席位一空出來就開放搶，先按先得，不做候補排隊（§0.3）。
   * 對局進行中不開放（§14.2）。
   */
  function takeSeat(roomId, personId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    const me = room.members.get(personId);
    if (!me) return { error: '你不在這個房間裡' };
    if (me.role === 'player') return { error: '你已經是玩家了' };
    if (room.phase !== 'lobby') return { error: '這局還沒結束，等結算回房間再搶' };
    if (connectedSeats(room).length >= CONST.SEATS) return { error: '席位已經滿了' };
    me.role = 'player';
    me.ready = false;
    systemChat(room, me.name + ' 坐下了');
    return { room: room, role: 'player' };
  }

  function kick(roomId, hostId, targetId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    if (room.hostId !== hostId) return { error: '只有房主可以踢人' };
    if (targetId === hostId) return { error: '不能踢自己' };
    if (!room.members.has(targetId)) return { error: '找不到這個人' };
    const name = room.members.get(targetId).name;
    room.members.delete(targetId);
    room.inputs.delete(targetId);
    systemChat(room, name + ' 被房主請出去了');
    closeIfEmpty(room);
    return { room: room, kicked: targetId };
  }

  /* ---------- 邀請連結（範圍在該房、可撤銷、與房間同生命；§6） ---------- */

  function makeInvite(roomId, hostId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    if (room.hostId !== hostId) return { error: '只有房主可以產生邀請連結' };
    if (room.invite) invites.delete(room.invite.token);
    const t = token();
    room.invite = { token: t, createdAt: now() };
    invites.set(t, room.id);
    return { token: t, roomId: room.id };
  }

  function revokeInvite(roomId, hostId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    if (room.hostId !== hostId) return { error: '只有房主可以撤銷邀請連結' };
    if (room.invite) invites.delete(room.invite.token);
    room.invite = null;
    return { ok: true };
  }

  /** 加入前由伺服器驗證，給看得懂的提示（§6） */
  function resolveInvite(t) {
    const roomId = invites.get(String(t || ''));
    if (!roomId) return { error: '這個邀請連結無效或已經被撤銷了' };
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    const full = connectedSeats(room).length >= CONST.SEATS;
    return { roomId: roomId, room: room, full: full };
  }

  /* ---------- 聊天 ---------- */

  function chat(roomId, personId, text) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    const me = room.members.get(personId);
    if (!me) return { error: '你不在這個房間裡' };
    const body = clean(text, CONST.CHAT_MAX_LEN);
    if (!body) return { error: '' };
    push(room, { who: me.name, role: me.role, text: body, at: now() });
    return { room: room };
  }

  function systemChat(room, text) {
    push(room, { sys: true, text: clean(text, CONST.CHAT_MAX_LEN), at: now() });
  }

  function push(room, line) {
    room.chat.push(line);
    if (room.chat.length > CONST.CHAT_KEEP) room.chat.splice(0, room.chat.length - CONST.CHAT_KEEP);
  }

  /* ---------- 開局與 30Hz 權威迴圈 ---------- */

  function start(roomId, hostId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    if (room.hostId !== hostId) return { error: '只有房主可以開始' };
    if (room.phase !== 'lobby') return { error: '已經開始了' };
    if (!allReady(room)) return { error: '兩個人都按「準備好」才能開始' };
    beginMatch(room);
    return { room: room };
  }

  function beginMatch(room) {
    /* 每一局都換新的樓梯 seed（不做同座樓梯重打；§0.3） */
    room.seed = newSeed(room);
    const seats = connectedSeats(room);
    room.match = Rules.createMatch({
      difficulty: room.difficulty,
      mode: 'versus',
      players: seats.map(m => ({ id: m.id, name: m.name, char: m.char, kind: 'human' }))
    }, room.seed);
    room.phase = 'playing';
    room.inputs = new Map();
    room.inputQ = new Map();
    room.pending = [];                    /* 這個 tick 要廣播的事件 */
    resetReady(room);
    systemChat(room, '開始了！難度「' + Rules.DIFFICULTY[room.difficulty].name + '」');
  }

  /**
   * 客戶端只送輸入意圖（§4.1）：{ seq, dir, ct }
   * 不送座標，所以不可能靠改前端作弊。
   */
  function setInput(roomId, personId, input) {
    const room = rooms.get(roomId);
    if (!room || !room.match) return { ok: false };
    const me = room.members.get(personId);
    if (!me || me.role !== 'player') return { ok: false };
    const seqNo = Number(input && input.seq) || 0;
    const last = room.lastSeq.get(personId) || 0;
    if (seqNo && seqNo <= last) return { ok: true };      /* 舊的封包，丟掉 */
    if (seqNo) room.lastSeq.set(personId, seqNo);
    const dir = input && input.dir > 0 ? 1 : input && input.dir < 0 ? -1 : 0;
    /* 客戶端會告訴我們「這個方向從對局時間的哪一刻開始生效」（net.js 的 at）。
     * 有 at 就排進隊伍、等跑到那一步才套用 —— 這樣伺服器換方向的那一步跟
     * 客戶端的本地預測完全對齊，改方向才不會被回拉（§4.2）。
     * 沒有 at（舊的客戶端）就照原本的做法：馬上生效。 */
    const at = input && Number.isFinite(input.at) ? Number(input.at) : null;
    const nowT = room.match.time;
    if (at == null || at <= nowT + 1e-9 || at > nowT + CONST.INPUT_AHEAD_MAX) {
      /* 已經過期（延遲太大）或超前得不合理（客戶端亂送）→ 立刻生效 */
      room.inputs.set(personId, { dir: dir });
      room.inputQ.delete(personId);
    } else {
      let q = room.inputQ.get(personId);
      if (!q) { q = []; room.inputQ.set(personId, q); }
      q.push({ at: at, dir: dir });
      q.sort((x, y) => x.at - y.at);
      if (q.length > CONST.INPUT_QUEUE_MAX) q.splice(0, q.length - CONST.INPUT_QUEUE_MAX);
    }
    if (input && input.ct != null) room.lastStamp.set(personId, { ct: input.ct, at: now() });
    if (me.misses) me.misses = 0;
    return { ok: true };
  }

  /** 心跳：連兩次沒回就當連線已死（§14.1） */
  function heartbeat(personId) {
    for (const room of rooms.values()) {
      const me = room.members.get(personId);
      if (me) me.misses = 0;
    }
  }

  function sweepHeartbeats() {
    const dead = [];
    for (const room of rooms.values()) {
      for (const me of room.members.values()) {
        if (!me.connected) continue;
        me.misses = (me.misses || 0) + 1;
        if (me.misses >= CONST.DEAD_AFTER_MISSES + 1) dead.push(me.id);
      }
    }
    for (const id of dead) markDisconnected(id);
    return dead;
  }

  /** 伺服器每個 tick 推進一步，是唯一的真相來源（§4.1） */
  function tick(dtMs) {
    const out = [];
    for (const room of rooms.values()) {
      /* 沒人的房間留了 EMPTY_GRACE_MS 給「切出去再切回來」，時間到了才真的收掉 */
      if (room.emptyAt && now() - room.emptyAt >= CONST.EMPTY_GRACE_MS) { dropRoom(room); continue; }
      if (room.phase === 'playing' && room.match) {
        const seats = connectedSeats(room);
        const inputs = {};
        /* 把「已經到生效時間」的輸入套用進來（見 setInput 的 at）。
         * 每個子步都要重新問一次，方向才會在跟客戶端一模一樣的那一步改變。 */
        const pullInputs = () => {
          for (const m of seats) {
            const q = room.inputQ.get(m.id);
            if (q && q.length) {
              while (q.length && q[0].at <= room.match.time + 1e-9) {
                room.inputs.set(m.id, { dir: q.shift().dir });
              }
            }
            inputs[m.id] = room.inputs.get(m.id) || { dir: 0 };
          }
        };
        pullInputs();
        /* 一定要照規則核心的固定步長（1/60 秒）跑，30Hz 的 tick 就是跑兩個小步。
         * 直接餵 dtMs=33 給 stepMatch 會讓伺服器的物理跟客戶端預測不一樣，
         * 預測校正就會一直抖 —— 這是 §4.2 能成立的前提。 */
        const subs = Math.max(1, Math.round(dtMs / Rules.STEP_MS));
        let events = [];
        const fresh = [];
        const gone = [];
        for (let i = 0; i < subs; i++) {
          if (i > 0) pullInputs();
          const r = Rules.stepMatch(room.match, inputs, Rules.STEP_MS);
          if (r.events.length) {
            /* 蓋上「這件事發生在第幾個固定步」。客戶端的本地預測會先播自己的
             * 反饋（見 net.js 的 emitPredicted），之後要靠這個編號一對一對消，
             * 才不會同一次受傷播兩次、也不會把沒預測到的那次吃掉。
             * 用「步號」而不是秒數：快照的 time 只帶到小數三位，客戶端從那個
             * 四捨五入過的值往前跑，秒數會差幾十微秒，對不起來；步號不會。 */
            const at = Math.round(room.match.time / Rules.STEP);
            for (const e of r.events) if (e.at == null) e.at = at;
            events = events.concat(r.events);
          }
          for (const st of room.match.newSteps) fresh.push(st);
          for (const id of room.match.goneSteps) gone.push(id);
          if (room.match.phase === 'over') break;
        }
        room.match.newSteps = fresh;
        room.match.goneSteps = gone;
        room.pending = events;
        if (room.match.phase === 'over') {
          room.phase = 'result';
          room.resultUntil = now() + CONST.RESULT_MS;
          systemChat(room, matchResultText(room));
        }
        out.push(room);
      } else if (room.phase === 'result' && room.pending && room.pending.length) {
        /* 結算停留期間只送狀態，不要再重送事件。
         * pending 是「上一個 tick 發生的事」，而結算階段不再推進對局，所以它會停在
         * 最後那一份（含最後一次受傷、淘汰）。快照每個 tick 都帶著它送出去的話，
         * 客戶端會在結算的十秒內以 30Hz 重播死掉那一下的音效、震動與粒子
         * （實測同一次受傷被送了 50 次以上）。 */
        room.pending = [];
        out.push(room);
      }
      if (room.phase === 'result' && (now() >= room.resultUntil || allResultDone(room))) {
        /* 結算停留結束 → 回房間，席位開放搶（§14.2） */
        room.phase = 'lobby';
        room.match = null;
        room.pending = [];
        resetReady(room);
        systemChat(room, '回到房間，房主可以開下一局');
        out.push(room);
      }
    }
    return out;
  }

  function matchResultText(room) {
    const m = room.match;
    if (!m || !m.result) return '這局結束';
    const r = m.result;
    if (r.draw) return '平手！兩個人都下到 ' + r.players[0].meters + ' m';
    const win = r.players.find(p => p.id === r.winner);
    const lose = r.players.find(p => p.id !== r.winner);
    if (!win || !lose) return '這局結束';
    return win.name + ' 贏了（' + win.meters + ' m）vs ' + lose.name + '（' + lose.meters + ' m）';
  }

  /* ---------- 給前端看的視圖 ---------- */

  function roomView(room, viewerId) {
    const me = room.members.get(viewerId);
    return {
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      isHost: room.hostId === viewerId,
      difficulty: room.difficulty,
      difficultyName: Rules.DIFFICULTY[room.difficulty].name,
      phase: room.phase,
      youAre: me ? me.role : null,
      seats: CONST.SEATS,
      maxSpectators: CONST.MAX_SPECTATORS,
      canTakeSeat: !!me && me.role === 'spectator' &&
        room.phase === 'lobby' && connectedSeats(room).length < CONST.SEATS,
      canStart: room.hostId === viewerId && room.phase === 'lobby' && allReady(room),
      invite: room.invite ? room.invite.token : null,
      members: [...room.members.values()].map(m => ({
        id: m.id, name: m.name, char: m.char, role: m.role,
        ready: m.ready, connected: m.connected, host: m.id === room.hostId
      })),
      chat: room.chat.slice(-30)
    };
  }

  /**
   * 對局快照（§4.1）。樓梯用增量傳，不每個 tick 傳整座樓梯。
   * @param {object} opts { viewerId, full }
   */
  function snapshot(room, opts) {
    const m = room.match;
    if (!m) return null;
    opts = opts || {};
    const snap = {
      tick: Math.round(m.time * CONST.TICK_HZ),
      time: +m.time.toFixed(3),
      matchPhase: m.phase,
      countdown: +m.countdown.toFixed(3),
      cameraTop: +m.cameraTop.toFixed(4),
      scrollMul: +m.scrollMul.toFixed(3),
      world: m.world,
      players: m.players.map(p => ({
        id: p.id, x: +p.x.toFixed(4), y: +p.y.toFixed(4), vy: +p.vy.toFixed(3),
        dir: p.dir, face: p.face, hp: p.hp, best: +p.best.toFixed(3),
        state: p.state, alive: p.alive, fell: !!p.fell, forfeit: !!p.forfeit,
        invuln: +p.invuln.toFixed(3), sinking: +p.sinking.toFixed(3),
        onStep: p.onStep,
        /* 天花板傷害的亂數 tag 是「被刺到第幾次」（rules.js 的 ceilHits），
         * 所以它也要同步 —— 客戶端多預測一次就會永遠算出不同的傷害數字。 */
        ceilHits: p.ceilHits, ceilCool: +p.ceilCool.toFixed(3)
      })),
      newSteps: m.newSteps,
      goneSteps: m.goneSteps,
      /* 假階的崩解狀態是可變的，跟著快照走（其他階梯由 seed 決定，不會變） */
      dirty: m.steps.filter(st => st.breakIn != null || st.broken)
        .map(st => ({ id: st.id, breakIn: st.breakIn == null ? null : +st.breakIn.toFixed(3), broken: !!st.broken })),
      events: room.pending || [],
      ackSeq: opts.viewerId ? (room.lastSeq.get(opts.viewerId) || 0) : 0
    };
    const stamp = opts.viewerId ? room.lastStamp.get(opts.viewerId) : null;
    if (stamp) {
      snap.ackCt = stamp.ct;
      snap.ackAge = +((now() - stamp.at) / 1000).toFixed(4);
    }
    if (m.phase === 'over' && m.result) snap.result = m.result;
    if (opts.full) {
      snap.full = true;
      snap.seed = room.seed;
      snap.difficulty = room.difficulty;
      snap.steps = m.steps;
      snap.meta = m.players.map(p => ({ id: p.id, name: p.name, char: p.char, kind: p.kind, index: p.index }));
    }
    return snap;
  }

  function consumeClosedRooms() {
    const out = closedRooms.slice();
    closedRooms.length = 0;
    return out;
  }

  return {
    rooms, invites, CONST, DIFFS,
    createRoom, listRooms, join, quickJoin, leave, markDisconnected, heartbeat, sweepHeartbeats,
    resultDone,
    updateRoom, setReady, allReady, takeSeat, kick,
    makeInvite, revokeInvite, resolveInvite,
    chat, systemChat,
    start, beginMatch, setInput, tick, snapshot, roomView,
    matchResultText, consumeClosedRooms, closeIfEmpty,
    seatsOf, specsOf, connectedSeats
  };
}

module.exports = { createHub, CONST, DIFFS };
