/* ===== lib/match-loop.js — 30Hz 權威迴圈 =====
 *
 * 把 lib/rooms.js（純邏輯）跟外面的連線接起來：
 *   1. 固定 30Hz 推進每一間在對局中的房間（規劃書 §4.1）
 *   2. 每個 tick 把「對局快照」推給房裡的每一個人（含觀戰者）
 *   3. 每秒掃一次心跳，連兩次沒回就當斷線判輸（§14.1）
 *   4. 房間狀態／大廳列表有變才推，不無腦刷
 *
 * 這裡完全不碰 WebSocket：時鐘與送出動作都是注入進來的，
 * 所以 scripts/netcode-check.js 可以用假時鐘、假網路（加延遲）跑同一份程式。
 */
'use strict';

const Rules = require('../public/js/rules.js');

/**
 * @param {object} hub  lib/rooms.js 的 createHub() 結果
 * @param {{send:(personId:string,msg:object)=>void, lobbyIds:()=>string[]}} io
 * @param {{hz?:number, now?:()=>number, maxCatchup?:number}} opt
 */
function createLoop(hub, io, opt) {
  opt = opt || {};
  const hz = opt.hz || hub.CONST.TICK_HZ;
  const tickMs = 1000 / hz;
  const now = opt.now || (() => Date.now());
  /* 一個 frame 最多補幾個 tick：分頁被切到背景後別一次爆衝（§14.1） */
  const maxCatchup = opt.maxCatchup || 6;

  let last = null;
  let acc = 0;
  let hbAcc = 0;
  let timer = null;
  let ticks = 0;

  const fullSent = new Set();      /* roomId|personId|seed → 已經送過完整快照 */
  const lastPhase = new Map();     /* roomId → phase，用來判斷要不要重推房間狀態 */
  let lobbySig = '';

  const fullKey = (room, personId) => room.id + '|' + personId + '|' + room.seed;

  /* ---------- 送東西 ---------- */

  /** 房間狀態（成員、準備好、難度、聊天）→ 推給房裡每一個人 */
  function sendRoom(room) {
    for (const m of room.members.values()) {
      if (!m.connected) continue;
      io.send(m.id, { type: 'room', room: hub.roomView(room, m.id) });
    }
  }

  function sendRoomTo(room, personId) {
    io.send(personId, { type: 'room', room: hub.roomView(room, personId) });
  }

  /** 對局快照。第一次一定送完整版（seed、整座樓梯、玩家名牌），之後只送增量 */
  function sendSnapshot(room, personId, forceFull) {
    if (!room.match) return;
    const key = fullKey(room, personId);
    const full = forceFull || !fullSent.has(key);
    const snap = hub.snapshot(room, { viewerId: personId, full: full });
    if (!snap) return;
    fullSent.add(key);
    snap.serverTime = now();
    snap.hz = hz;
    io.send(personId, { type: 'snap', snap: snap });
  }

  function broadcastSnapshots(room) {
    for (const m of room.members.values()) {
      if (m.connected) sendSnapshot(room, m.id);
    }
  }

  /** 大廳房間列表。有變才推，避免 30Hz 洗頻 */
  function sendLobby(force) {
    const rooms = hub.listRooms();
    const sig = JSON.stringify(rooms);
    if (!force && sig === lobbySig) return;
    lobbySig = sig;
    const msg = { type: 'rooms', rooms: rooms };
    for (const id of io.lobbyIds()) io.send(id, msg);
  }

  function sendLobbyTo(personId) {
    io.send(personId, { type: 'rooms', rooms: hub.listRooms() });
  }

  /** 忘掉整間房的完整快照紀錄（開新的一局時要重新送一份完整的） */
  function forgetRoomFull(roomId) {
    for (const key of [...fullSent]) {
      if (key.indexOf(roomId + '|') === 0) fullSent.delete(key);
    }
  }

  /** 忘掉某個人的完整快照紀錄（重新連線時要重新送一份完整的） */
  function forgetFull(personId) {
    for (const key of [...fullSent]) {
      if (key.indexOf('|' + personId + '|') >= 0) fullSent.delete(key);
    }
  }

  /* ---------- 推進 ---------- */

  /** 跑完一個 tick 之後該廣播什麼 */
  function afterTick() {
    for (const room of hub.rooms.values()) {
      const before = lastPhase.get(room.id);
      if (before !== room.phase) {
        lastPhase.set(room.id, room.phase);
        sendRoom(room);
        /* 一局結束（result → lobby）就把完整快照紀錄清掉，下一局重新送 */
        if (room.phase === 'lobby') {
          for (const key of [...fullSent]) {
            if (key.indexOf(room.id + '|') === 0) fullSent.delete(key);
          }
        }
      }
      if (room.match && (room.phase === 'playing' || room.phase === 'result')) {
        broadcastSnapshots(room);
      }
    }
    for (const id of hub.consumeClosedRooms()) lastPhase.delete(id);
    sendLobby();
  }

  /**
   * 外面每畫一格（或每個 setInterval）呼叫一次。
   * 用累加器補足 tick，所以就算 timer 抖動，遊戲時間還是固定 30Hz。
   */
  function frame(nowMs) {
    const t = nowMs == null ? now() : nowMs;
    if (last == null) { last = t; return 0; }
    let dt = t - last;
    last = t;
    if (dt < 0) dt = 0;
    if (dt > tickMs * maxCatchup) dt = tickMs * maxCatchup;
    acc += dt;
    hbAcc += dt;

    let ran = 0;
    while (acc >= tickMs) {
      acc -= tickMs;
      ticks++;
      hub.tick(tickMs);
      afterTick();
      ran++;
    }

    while (hbAcc >= hub.CONST.HEARTBEAT_MS) {
      hbAcc -= hub.CONST.HEARTBEAT_MS;
      heartbeatRound();
    }
    return ran;
  }

  /** 先掃掉已經死掉的連線，再對所有人發出心跳詢問 */
  function heartbeatRound() {
    /* 網路層還在回 pong 的人一律算活著（見 lib/ws.js 的 lastSeen）。
     * 只靠應用層的心跳訊息會誤判：分頁被瀏覽器節流、或這一格畫得比較久，
     * 都可能讓 JS 晚幾秒才回話，然後就被當成斷線判輸 —— 實測真的會發生。 */
    if (io.aliveIds) {
      for (const id of io.aliveIds()) hub.heartbeat(id);
    }
    const dead = hub.sweepHeartbeats();
    if (dead.length) {
      /* 這行在營運時很有用：真的斷線與「被誤判斷線」長得一模一樣，只有 log 分得出來 */
      if (opt.log) opt.log('[hb] 心跳連續沒回，判定離線：' + dead.join(', '));
      for (const room of hub.rooms.values()) sendRoom(room);
      sendLobby(true);
    }
    const asked = new Set();
    for (const room of hub.rooms.values()) {
      for (const m of room.members.values()) {
        if (m.connected && !asked.has(m.id)) { asked.add(m.id); io.send(m.id, { type: 'hb' }); }
      }
    }
    for (const id of io.lobbyIds()) if (!asked.has(id)) io.send(id, { type: 'hb' });
    /* 同時發網路層的 ping，瀏覽器會自動回 pong（不需要跑到 JS） */
    if (io.pingAll) io.pingAll();
    return dead;
  }

  function start() {
    if (timer) return;
    last = now();
    timer = setInterval(() => frame(now()), tickMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    hz: hz, tickMs: tickMs,
    frame, start, stop, heartbeatRound,
    sendRoom, sendRoomTo, sendSnapshot, sendLobby, sendLobbyTo, forgetFull, forgetRoomFull,
    stats: () => ({ ticks: ticks, fullSent: fullSent.size, rooms: hub.rooms.size })
  };
}

module.exports = { createLoop, STEP_MS: Rules.STEP_MS };
