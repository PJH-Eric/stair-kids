/* ===== server.js — 靜態檔案 ＋ WebSocket 骨架（零依賴）=====
 *
 * 靜態檔案用 Node 內建 http，連線用自己寫的 lib/ws.js（原生 WebSocket），
 * 所以整個專案不需要 npm install，雙擊 .bat 就能玩，丟到 Render 也一樣。
 *
 * M0 只有單機一人挑戰，所以這裡只做：靜態檔案、/health、/api/presence，
 * 加上一個會回應 hello／ping 的 WebSocket 端點，證明連線通道是活的。
 * M2 才會接上 lib/rooms.js 與 30Hz 的房間迴圈（規則核心 require 同一支 public/js/rules.js）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ws = require('./lib/ws.js');
const Rules = require('./public/js/rules.js');

const PORT = Number(process.env.PORT) || 3060;
const ROOT = path.join(__dirname, 'public');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const GAME_ID = 'stair-kids';

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

const clients = new Set();

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);

  /* 給前端跨網域用（GitHub Pages 前端 ＋ Render 伺服器的組合） */
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);

  /* 給遊戲大廳問「現在有幾個人在玩」 */
  if (url === '/api/presence') {
    json(res, 200, {
      gameId: GAME_ID,
      online: clients.size,
      players: 0,
      spectators: 0,
      lobby: clients.size,
      rooms: 0,
      updatedAt: new Date().toISOString()
    });
    return;
  }

  /* Render 免費方案會休眠，前端靠這支輪詢判斷伺服器醒了沒 */
  if (url === '/health') {
    json(res, 200, {
      ok: true,
      game: GAME_ID,
      milestone: 'M0',
      rooms: 0,
      players: clients.size,
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

/* ---------- WebSocket（M0 只做最小的活著證明） ---------- */

ws.attach(server, {
  path: '/ws',
  onConnection(socket) {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'hello', game: GAME_ID, milestone: 'M0' }));
    socket.on('message', text => {
      let msg = null;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg && msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong', t: msg.t }));
    });
    socket.on('close', () => clients.delete(socket));
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

server.listen(PORT, () => {
  console.log('小朋友下樓梯（M0）已啟動');
  console.log('  本機：http://localhost:' + PORT);
  for (const ip of localAddresses()) console.log('  同網路：http://' + ip + ':' + PORT);
  console.log('  健康檢查：http://localhost:' + PORT + '/health');
});
