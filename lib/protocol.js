/* ===== lib/protocol.js — 線上模式的訊息協定 =====
 *
 * 客戶端能做的每一件事都在這裡收，故意跟 socket 分開，
 * 這樣 scripts/netcode-check.js 可以直接餵訊息、加延遲，不用真的開網路。
 *
 * 重要原則（規劃書 §4.1）：客戶端只送「輸入意圖」{ seq, dir, ct }，
 * 永遠不送座標與血量，所以改前端不可能作弊。
 */
'use strict';

const Characters = require('../public/js/themes/characters.js');
const Nicknames = require('../public/js/themes/nicknames.js');

const NAME_MAX = 8;

const clean = (t, max) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @param {object} hub   lib/rooms.js
 * @param {object} loop  lib/match-loop.js
 * @param {{send:(id:string,msg:object)=>void}} io
 */
function createProtocol(hub, loop, io) {

  const fail = (person, text) => { io.send(person.id, { type: 'error', text: text }); return false; };

  /** 進房成功之後統一做的事：記住房號、推房間狀態、推大廳 */
  function entered(person, res, wantRole) {
    if (res.error) return fail(person, res.error);
    person.roomId = res.room.id;
    person.role = res.role;
    io.send(person.id, {
      type: 'joined', roomId: res.room.id, role: res.role,
      room: hub.roomView(res.room, person.id)
    });
    loop.sendRoom(res.room);
    /* 對局中進來的（觀戰、重新連線）要立刻拿一份完整快照才畫得出來 */
    if (res.room.match) loop.sendSnapshot(res.room, person.id, true);
    loop.sendLobby(true);
    return true;
  }

  function myRoom(person) {
    if (!person.roomId) return null;
    return hub.rooms.get(person.roomId) || null;
  }

  /** 離開目前的房間（切回大廳、關掉分頁前都走這裡） */
  function dropRoom(person) {
    const room = myRoom(person);
    person.roomId = null;
    person.role = null;
    loop.forgetFull(person.id);
    if (!room) return;
    hub.leave(room.id, person.id);
    if (hub.rooms.has(room.id)) loop.sendRoom(room);
    loop.sendLobby(true);
  }

  /**
   * 處理一則客戶端訊息。
   * @param {{id:string,name:string,char:string,roomId:?string}} person 連線身分
   */
  function handle(person, msg) {
    if (!msg || typeof msg.type !== 'string') return false;
    const room = myRoom(person);

    switch (msg.type) {

      /* ---- 身分與大廳 ---- */
      case 'hello': {
        person.name = clean(msg.name, NAME_MAX) || Nicknames.random();
        person.char = Characters.byId(msg.char).id;
        io.send(person.id, {
          type: 'welcome',
          personId: person.id, name: person.name, char: person.char,
          seats: hub.CONST.SEATS, maxSpectators: hub.CONST.MAX_SPECTATORS,
          difficulties: hub.DIFFS, hz: loop.hz,
          chatMaxLen: hub.CONST.CHAT_MAX_LEN, nameMaxLen: NAME_MAX
        });
        loop.sendLobbyTo(person.id);
        return true;
      }
      case 'rename': {
        const name = clean(msg.name, NAME_MAX);
        if (!name) return fail(person, '暱稱不能空白');
        person.name = name;
        if (room && room.members.has(person.id)) {
          room.members.get(person.id).name = name;
          if (room.match) {
            const p = room.match.players.find(x => x.id === person.id);
            if (p) p.name = name;
          }
          loop.sendRoom(room);
        }
        io.send(person.id, { type: 'me', name: person.name, char: person.char });
        return true;
      }
      case 'char': {
        person.char = Characters.byId(msg.char).id;
        if (room && room.members.has(person.id)) {
          room.members.get(person.id).char = person.char;
          loop.sendRoom(room);
        }
        io.send(person.id, { type: 'me', name: person.name, char: person.char });
        return true;
      }
      case 'rooms':
        loop.sendLobbyTo(person.id);
        return true;

      /* ---- 開房、進房 ---- */
      case 'create':
        if (room) dropRoom(person);
        return entered(person, hub.createRoom(person, { name: msg.name, difficulty: msg.difficulty }));
      case 'join':
        if (room && room.id !== msg.roomId) dropRoom(person);
        return entered(person, hub.join(msg.roomId, person, msg.role));
      case 'quick':
        if (room) dropRoom(person);
        return entered(person, hub.quickJoin(person));
      case 'leave':
        dropRoom(person);
        io.send(person.id, { type: 'left' });
        loop.sendLobbyTo(person.id);
        return true;

      /* ---- 邀請連結 ---- */
      case 'invite': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.makeInvite(room.id, person.id);
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room);
        io.send(person.id, { type: 'invite', token: r.token, roomId: r.roomId });
        return true;
      }
      case 'invite:revoke': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.revokeInvite(room.id, person.id);
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room);
        io.send(person.id, { type: 'invite', token: null });
        return true;
      }
      case 'invite:resolve': {
        const r = hub.resolveInvite(msg.token);
        if (r.error) return fail(person, r.error);
        if (room && room.id !== r.roomId) dropRoom(person);
        /* 席位滿了就自動轉觀戰，並且明確告訴他為什麼（§6） */
        const res = hub.join(r.roomId, person, r.full ? 'spectator' : 'player');
        const okJoin = entered(person, res);
        if (okJoin && r.full) io.send(person.id, { type: 'notice', text: '席位已滿，先幫你安排觀戰，空出來可以搶位' });
        return okJoin;
      }

      /* ---- 房間設定與席位 ---- */
      case 'config': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.updateRoom(room.id, person.id, { difficulty: msg.difficulty, name: msg.name });
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room);
        loop.sendLobby(true);
        return true;
      }
      case 'ready': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.setReady(room.id, person.id, msg.ready);
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room);
        return true;
      }
      case 'seat': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.takeSeat(room.id, person.id);
        if (r.error) return fail(person, r.error);
        person.role = 'player';
        loop.sendRoom(room);
        loop.sendLobby(true);
        return true;
      }
      case 'kick': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.kick(room.id, person.id, msg.targetId);
        if (r.error) return fail(person, r.error);
        io.send(msg.targetId, { type: 'kicked' });
        if (hub.rooms.has(room.id)) loop.sendRoom(room);
        loop.sendLobby(true);
        return true;
      }

      /* ---- 開局與輸入 ---- */
      case 'start': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.start(room.id, person.id);
        if (r.error) return fail(person, r.error);
        loop.forgetRoomFull(room.id);
        loop.sendRoom(room);
        for (const m of room.members.values()) {
          if (m.connected) loop.sendSnapshot(room, m.id, true);
        }
        loop.sendLobby(true);
        return true;
      }
      case 'input': {
        if (!room) return false;
        hub.setInput(room.id, person.id, msg);
        return true;
      }

      /* ---- 聊天 ---- */
      case 'chat': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.chat(room.id, person.id, msg.text);
        if (r.error) return r.error ? fail(person, r.error) : false;
        loop.sendRoom(room);
        return true;
      }

      /* ---- 心跳與測速 ---- */
      case 'hb':
        hub.heartbeat(person.id);
        return true;
      case 'ping':
        hub.heartbeat(person.id);
        io.send(person.id, { type: 'pong', t: msg.t, serverTime: Date.now() });
        return true;

      default:
        return false;
    }
  }

  return { handle, dropRoom, myRoom };
}

module.exports = { createProtocol, NAME_MAX };
