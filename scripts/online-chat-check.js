/* ===== scripts/online-chat-check.js — 對局文字聊天驗收 =====
 * 執行：node scripts/online-chat-check.js  或  npm run test:online-chat
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Net = require('../public/js/net.js');
const Rules = require('../public/js/rules.js');
const Characters = require('../public/js/themes/characters.js');
const Nicknames = require('../public/js/themes/nicknames.js');

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.dataset = {};
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
  }

  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }

  dispatch(type) {
    const fn = this.listeners.get(type);
    if (fn) fn({ preventDefault() {}, target: this });
  }

  getAttribute() { return null; }
  setAttribute() {}
  select() {}
}

function loadOnline() {
  const elements = new Map();
  const document = {
    activeElement: null,
    documentElement: new FakeElement(),
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new FakeElement());
      return elements.get(selector);
    },
    querySelectorAll() { return []; }
  };
  const sockets = [];
  class FakeSocket {
    constructor() {
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }

    send(text) { this.sent.push(JSON.parse(text)); }
    close() {}
  }
  const context = {
    self: null,
    document,
    location: { href: 'http://localhost:3060/', search: '' },
    history: { replaceState() {} },
    navigator: {},
    URL,
    setTimeout,
    clearTimeout,
    Date,
    WebSocket: FakeSocket,
    Net,
    Rules,
    Render: { kidAvatarSvg() { return ''; } },
    Characters,
    Nicknames
  };
  context.self = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/online.js'), 'utf8'), context,
    { filename: 'public/js/online.js' });
  return { Online: context.Online, elements, sockets };
}

const { Online, elements, sockets } = loadOnline();
const online = Online.create({
  serverUrl: 'http://localhost:3060',
  nameOf: () => '甲',
  charOf: () => 'yuan'
});

online.connect();
const socket = sockets[0];
socket.onopen();
socket.onmessage({ data: JSON.stringify({
  type: 'welcome', personId: 'A', name: '甲', char: 'yuan', hz: 30
}) });
socket.onmessage({ data: JSON.stringify({
  type: 'joined',
  roomId: 'room-1',
  room: {
    id: 'room-1', name: '測試房', hostId: 'A', isHost: true,
    difficulty: 'normal', difficultyName: '普通', phase: 'playing',
    youAre: 'player', seats: 2, maxSpectators: 20,
    canTakeSeat: false, canStart: false, invite: null,
    members: [{ id: 'A', name: '甲', char: 'yuan', role: 'player',
      ready: true, connected: true, host: true }],
    chat: []
  }
}) });

const input = elements.get('#game-chat-input');
const form = elements.get('#game-chat-form');
input.value = '對局中也可以打字';
form.dispatch('submit');

assert.deepEqual(socket.sent.at(-1), { type: 'chat', text: '對局中也可以打字' },
  '對局聊天室會送出文字訊息');
assert.equal(input.value, '', '送出後清空對局聊天室輸入框');

console.log('✓ 對局中可以輸入並送出文字聊天');
