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
    this.doc = null;
    const classes = new Set();
    this.classList = {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, on) => {
        const want = on == null ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
      }
    };
  }

  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }

  dispatch(type, ev) {
    const fn = this.listeners.get(type);
    if (fn) fn(Object.assign({ preventDefault() {}, stopPropagation() {}, target: this }, ev || {}));
  }

  /* 焦點要跟真的瀏覽器一樣會發出 focus／blur 事件 ——
   * 「送出之後有沒有把鍵盤還給遊戲」就是靠這個驗的 */
  focus() {
    if (this.doc) this.doc.activeElement = this;
    this.dispatch('focus');
  }

  blur() {
    if (this.doc && this.doc.activeElement === this) this.doc.activeElement = null;
    this.dispatch('blur');
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
      if (!elements.has(selector)) {
        const el = new FakeElement();
        el.doc = document;
        elements.set(selector, el);
      }
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
  return { Online: context.Online, elements, sockets, document };
}

const { Online, elements, sockets, document } = loadOnline();
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

/* ---------- 打完字要把鍵盤還給遊戲（Eric 回報：打過字之後就不能動） ----------
 *
 * input.js 的 typing() 會在焦點落在輸入框時擋掉所有方向鍵 —— 這是對的，
 * 不然打不了字。問題是送出之後焦點還留在輸入框，玩家就再也不能操作，
 * 而且畫面上完全看不出原因。以下三項就是這個 bug 的回歸驗收。 */

const sideChat = elements.get('#side-chat');

input.focus();
assert.equal(document.activeElement, input, '點進對局聊天框，焦點在輸入框上');
assert.ok(sideChat.classList.contains('typing'), '聚焦時顯示「方向鍵停用」的提示');

input.value = '打完這句要能繼續玩';
form.dispatch('submit');
assert.deepEqual(socket.sent.at(-1), { type: 'chat', text: '打完這句要能繼續玩' }, '訊息有送出去');
assert.equal(document.activeElement, null, '送出後焦點離開輸入框，方向鍵回到遊戲');
assert.ok(!sideChat.classList.contains('typing'), '送出後收掉提示');

console.log('✓ 對局中送出訊息後，鍵盤回到遊戲');

input.focus();
input.dispatch('keydown', { key: 'Escape' });
assert.equal(document.activeElement, null, '按 Esc 也能從輸入框跳回遊戲（不用找滑鼠）');
assert.ok(!sideChat.classList.contains('typing'), 'Esc 之後也收掉提示');

console.log('✓ 對局中按 Esc 可以離開聊天框');

/* 房間裡沒有這個問題（不在玩），焦點留著才好連續聊天 */
const roomInput = elements.get('#chat-input');
const roomForm = elements.get('#chat-form');
roomInput.focus();
roomInput.value = '在房間裡聊天';
roomForm.dispatch('submit');
assert.deepEqual(socket.sent.at(-1), { type: 'chat', text: '在房間裡聊天' }, '房間聊天會送出');
assert.equal(roomInput.value, '', '房間聊天送出後清空');
assert.equal(document.activeElement, roomInput, '房間聊天送出後焦點留著，可以連續打字');

console.log('✓ 房間的聊天室維持原本的連續打字行為');
