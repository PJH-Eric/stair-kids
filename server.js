/* ===== server.js — 靜態檔案 ＋ 房間伺服器（零依賴）=====
 *
 * 靜態檔案用 Node 內建 http，連線用自己寫的 lib/ws.js（原生 WebSocket），
 * 所以整個專案不需要 npm install，雙擊 .bat 就能玩，丟到 Render 也一樣。
 *
 * 分工：
 *   lib/rooms.js       房間、席位、觀戰、邀請、聊天（純邏輯，不碰 socket）
 *   lib/match-loop.js  30Hz 權威迴圈、快照廣播、心跳掃描
 *   lib/protocol.js    客戶端訊息 → 上面兩支的呼叫
 *   這一支              只負責 HTTP、WebSocket 與身分（誰是誰）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ws = require('./lib/ws.js');
const Rules = require('./public/js/rules.js');
const { createHub } = require('./lib/rooms.js');
const { createLoop } = require('./lib/match-loop.js');
const { createProtocol } = require('./lib/protocol.js');

const PORT = Number(process.env.PORT) || 3060;
const ROOT = path.join(__dirname, 'public');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const GAME_ID = 'stair-kids';
const MILESTONE = 'M2';

/* ---------- 靜態檔案 ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到這個檔案');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/* ---------- 連線名冊 ---------- */

/** personId → { socket, person } */
const people = new Map();

const io = {
  send(personId, msg) {
    const it = people.get(personId);
    if (it && it.socket.alive) it.socket.sendJSON(msg);
  },
  /** 還沒進任何房間的人＝在大廳看列表的人 */
  lobbyIds() {
    const out = [];
    for (const [id, it] of people) if (!it.person.roomId) out.push(id);
    return out;
  }
};

const hub = createHub();
const loop = createLoop(hub, io, {});
const proto = createProtocol(hub, loop, io);
loop.start();

function counts() {
  let players = 0, spectators = 0;
  for (const room of hub.rooms.values()) {
    players += hub.connectedSeats(room).length;
    spectators += hub.specsOf(room).filter(m => m.connected).length;
  }
  return { players, spectators };
}

/* ---------- HTTP ---------- */

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);

  /* 給前端跨網域用（GitHub Pages 前端 ＋ Render 伺服器的組合） */
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);

  /* 給遊戲大廳問「現在有幾個人在玩」 */
  if (url === '/api/presence') {
    const c = counts();
    json(res, 200, {
      gameId: GAME_ID,
      online: people.size,
      players: c.players,
      spectators: c.spectators,
      lobby: io.lobbyIds().length,
      rooms: hub.rooms.size,
      updatedAt: new Date().toISOString()
    });
    return;
  }

  /* 大廳／前端要先看得到有哪些房間才決定要不要連 WebSocket */
  if (url === '/api/rooms') {
    json(res, 200, { rooms: hub.listRooms(), seats: hub.CONST.SEATS });
    return;
  }

  /* Render 免費方案會休眠，前端靠這支輪詢判斷伺服器醒了沒 */
  if (url === '/health') {
    const c = counts();
    json(res, 200, {
      ok: true,
      game: GAME_ID,
      milestone: MILESTONE,
      rooms: hub.rooms.size,
      players: c.players,
      spectators: c.spectators,
      online: people.size,
      hz: loop.hz,
      difficulties: Rules.DIFFICULTY_LIST,
      time: Date.now()
    });
    return;
  }

  if (url === '/') url = '/index.html';
  const file = path.join(ROOT, path.normalize(url).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('不可以跑出 public 目錄');
    return;
  }
  sendFile(res, file);
});

/* ---------- WebSocket ---------- */

ws.attach(server, {
  path: '/ws',
  onConnection(socket) {
    const person = {
      id: 'p' + crypto.randomBytes(6).toString('hex'),
      name: '',
      char: 'yuan',
      roomId: null,
      role: null
    };
    people.set(person.id, { socket: socket, person: person });
    socket.data.personId = person.id;
    socket.sendJSON({ type: 'hello', game: GAME_ID, milestone: MILESTONE, personId: person.id });

    socket.on('message', text => {
      let msg = null;
      try { msg = JSON.parse(text); } catch (e) { return; }
      try {
        proto.handle(person, msg);
      } catch (e) {
        console.error('[proto] ' + (msg && msg.type) + ' 出錯：', e && e.message);
        io.send(person.id, { type: 'error', text: '伺服器處理這個動作時出錯了' });
      }
    });

    socket.on('close', () => {
      people.delete(person.id);
      /* 對局中斷線＝判輸（§4.4），房間邏輯自己會處理 */
      hub.markDisconnected(person.id);
      loop.forgetFull(person.id);
      if (person.roomId) {
        const room = hub.rooms.get(person.roomId);
        if (room) loop.sendRoom(room);
      }
      loop.sendLobby(true);
    });
  }
});

/* ---------- 起飛 ---------- */

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name in nets) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('小朋友下樓梯（' + MILESTONE + '：線上對戰）已啟動');
    console.log('  本機：http://localhost:' + PORT);
    for (const ip of localAddresses()) console.log('  同網路：http://' + ip + ':' + PORT);
    console.log('  健康檢查：http://localhost:' + PORT + '/health');
    console.log('  權威迴圈：' + loop.hz + 'Hz');
  });
}

module.exports = { server, hub, loop, proto, io, people, PORT };
