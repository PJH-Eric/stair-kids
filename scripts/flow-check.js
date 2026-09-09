/* ===== scripts/flow-check.js — 線上完整流程驗收（把整個前端真的跑起來）=====
 *
 * 為什麼要這一支：
 *   「結算畫面殘留」「回到房間開不了下一局」這類 bug 都不在某一個函式裡，
 *   而在四層接起來的縫上 ——
 *     伺服器的房間階段（lib/rooms.js）× 快照（lib/match-loop.js）
 *     × 線上狀態機（public/js/online.js）× 畫面流程（public/js/app.js）
 *   單元測試量不到，只有整條走一遍才看得出來。
 *
 * 做法：在 Node 裡放一個最小的假瀏覽器（DOM、rAF、setTimeout、WebSocket、
 * localStorage、假時鐘），照 index.html 的順序把 public/js 全部載進同一個
 * context；另一端接的是真的 lib/rooms + match-loop + protocol。
 * 對手用第二條真的協定連線（跟 netcode-check 一樣）。
 * 按鈕是真的用 click() 觸發，畫面狀態是真的從 DOM 讀出來的。
 *
 * 走的流程（使用者指定的那一串）：
 *   首頁 → 大廳 → 開房間 → 對手加入 → 兩人準備 → 開始 → 對戰 → 雙方死亡
 *   → 結算畫面（三顆按鈕）→ 再來一局 → 回到房間（按鈕跟原本開房間一樣）
 *   → 等對方準備好才能開始 → 第二局 → 結算 → 回到房間 → 第三局 → 回首頁
 *
 * 執行：node scripts/flow-check.js  或  npm run test:flow
 */
'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHub } = require('../lib/rooms.js');
const { createLoop } = require('../lib/match-loop.js');
const { createProtocol } = require('../lib/protocol.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const STEP_MS = 1000 / 60;

/* ---------------------------------------------------------- */
/* 驗收輸出                                                    */
/* ---------------------------------------------------------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : '')); }
  else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}
const group = t => console.log('\n' + t);

/* ---------------------------------------------------------- */
/* 假時鐘、假計時器、假 rAF                                     */
/* ---------------------------------------------------------- */
let T = 1767225600000;                 /* 固定起點，同一份程式每次跑起來都一樣 */
const clockNow = () => T;

let timerSeq = 1;
const timers = new Map();
function fakeSetTimeout(fn, ms) {
  const id = timerSeq++;
  timers.set(id, { at: T + (ms || 0), fn: fn, every: 0 });
  return id;
}
function fakeSetInterval(fn, ms) {
  const id = timerSeq++;
  timers.set(id, { at: T + (ms || 0), fn: fn, every: Math.max(1, ms || 1) });
  return id;
}
function fakeClearTimer(id) { timers.delete(id); }
function runTimers() {
  for (let guard = 0; guard < 500; guard++) {
    let hitId = null, hit = null;
    for (const [id, t] of timers) {
      if (t.at <= T && (!hit || t.at < hit.at)) { hitId = id; hit = t; }
    }
    if (!hit) return;
    if (hit.every) hit.at = T + hit.every;
    else timers.delete(hitId);
    hit.fn();
  }
}

let rafSeq = 1;
let rafQueue = [];
function fakeRaf(cb) { const id = rafSeq++; rafQueue.push({ id: id, cb: cb }); return id; }
function fakeCancelRaf(id) { rafQueue = rafQueue.filter(r => r.id !== id); }
function pumpRaf() {
  const q = rafQueue;
  rafQueue = [];
  for (const r of q) r.cb(T);
}

/* ---------------------------------------------------------- */
/* 最小 DOM                                                    */
/* ---------------------------------------------------------- */
function fakeContext2d() {
  const gradient = () => ({ addColorStop() {} });
  const target = {
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    measureText: () => ({ width: 0 })
  };
  return new Proxy(target, {
    get(obj, name) { return name in obj ? obj[name] : () => {}; },
    set(obj, name, value) { obj[name] = value; return true; }
  });
}

let doc = null;

const dataKey = name => name.slice(5).replace(/-(\w)/g, (m, c) => c.toUpperCase());

class El {
  constructor(tag, id) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id || '';
    this.className = '';
    this.classes = new Set();
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.placeholder = '';
    this.checked = false;
    this.style = { setProperty() {}, removeProperty() {} };
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.offsetParent = {};
    this.listeners = new Map();
    this.lookups = new Map();
    const self = this;
    this.classList = {
      add() { for (const n of arguments) self.classes.add(n); },
      remove() { for (const n of arguments) self.classes.delete(n); },
      contains(n) { return self.classes.has(n); },
      toggle(n, on) {
        const want = on == null ? !self.classes.has(n) : !!on;
        if (want) self.classes.add(n); else self.classes.delete(n);
        return want;
      }
    };
  }

  /* --- 事件 --- */
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, extra) {
    const ev = Object.assign({
      type: type, target: this, currentTarget: this,
      preventDefault() {}, stopPropagation() {}
    }, extra || {});
    for (const fn of (this.listeners.get(type) || []).slice()) fn.call(this, ev);
    return ev;
  }
  click() { return this.dispatch('click'); }
  focus() { if (doc) doc.activeElement = this; }
  blur() { if (doc && doc.activeElement === this) doc.activeElement = null; }
  select() {}

  /* --- 屬性 --- */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') {
      this.className = String(value);
      this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    }
    if (name.indexOf('data-') === 0) this.dataset[dataKey(name)] = String(value);
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  getBoundingClientRect() {
    return { width: 980, height: 660, left: 0, top: 0, right: 980, bottom: 660 };
  }
  getContext() {
    if (!this.ctx2d) this.ctx2d = fakeContext2d();
    return this.ctx2d;
  }

  /* --- 樹 --- */
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, before) {
    const i = this.children.indexOf(before);
    child.parentNode = this;
    if (i < 0) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  /* --- 選取 --- */
  matches(sel) {
    if (!sel) return false;
    if (sel[0] === '#') return this.id === sel.slice(1);
    if (sel[0] === '.') return this.classes.has(sel.slice(1));
    if (sel[0] === '[') {
      const m = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(sel);
      if (!m) return false;
      const raw = this.attributes.has(m[1]) ? this.attributes.get(m[1])
        : (m[1].indexOf('data-') === 0 ? this.dataset[dataKey(m[1])] : undefined);
      if (raw == null) return false;
      return m[2] == null || String(raw) === m[2];
    }
    return this.tagName === sel.toUpperCase();
  }
  closest(sel) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(sel)) return node;
      node = node.parentNode;
    }
    return null;
  }
  all() {
    const out = [];
    const walk = node => { for (const c of node.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelectorAll(sel) { return this.all().filter(n => n.matches(sel)); }
  querySelector(sel) {
    const hit = this.querySelectorAll(sel)[0];
    if (hit) return hit;
    /* innerHTML 疊出來的內容（角色 SVG）在假 DOM 裡沒有真的節點，
     * 但 poseKid() 需要拿得到 .k-armL 這些子群組，所以給一個穩定的替身。 */
    if (!this.lookups.has(sel)) this.lookups.set(sel, new El('g'));
    return this.lookups.get(sel);
  }
}

/** 照 index.html 把有 id／有 data-go／是畫面的節點先建好 */
function buildDom() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const body = new El('body', 'body');
  const byId = new Map();
  const dataGo = [];
  const screens = [];
  const tagRe = /<([a-z][\w-]*)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = m[2];
    const id = (/\bid="([^"]+)"/.exec(attrs) || [])[1] || '';
    const cls = (/\bclass="([^"]+)"/.exec(attrs) || [])[1] || '';
    const go = (/\bdata-go="([^"]+)"/.exec(attrs) || [])[1] || '';
    if (!id && !go && !/\bscreen\b/.test(cls) && !/game-wrap/.test(cls)) continue;
    const el = new El(m[1], id);
    if (cls) el.setAttribute('class', cls);
    if (go) el.setAttribute('data-go', go);
    body.appendChild(el);
    if (id) byId.set(id, el);
    if (go) dataGo.push(el);
    if (el.classes.has('screen')) screens.push(el);
  }
  return { body: body, byId: byId, dataGo: dataGo, screens: screens };
}

/* ---------------------------------------------------------- */
/* 假瀏覽器 ＋ 前端載入                                         */
/* ---------------------------------------------------------- */
function bootBrowser(bridge) {
  const dom = buildDom();
  const store = new Map();
  const sockets = [];

  class FakeSocket {
    constructor(url) {
      const self = this;
      this.url = url;
      this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      sockets.push(this);
      /* 真的瀏覽器也是下一輪才 onopen */
      fakeSetTimeout(function () {
        if (self.readyState !== 0) return;
        self.readyState = 1;
        bridge.accept(self);
        if (self.onopen) self.onopen();
      }, 1);
    }
    send(text) {
      if (this.readyState !== 1) return;
      bridge.fromClient(this, JSON.parse(text));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      bridge.drop(this);
      if (this.onclose) this.onclose();
    }
  }

  const RealDate = Date;
  function FakeDate(a, b, c, d, e, f, g) {
    if (arguments.length === 0) return new RealDate(T);
    return new RealDate(a, b, c, d, e, f, g);
  }
  FakeDate.now = () => T;
  FakeDate.prototype = RealDate.prototype;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;

  doc = {
    body: dom.body,
    documentElement: new El('html'),
    activeElement: null,
    hidden: false,
    visibilityState: 'visible',
    listeners: new Map(),
    createElement: tag => new El(tag),
    createElementNS: (ns, tag) => new El(tag),
    querySelector(sel) {
      if (sel[0] === '#') {
        const id = sel.slice(1);
        if (!dom.byId.has(id)) dom.byId.set(id, new El('div', id));
        return dom.byId.get(id);
      }
      return dom.body.querySelectorAll(sel)[0] || new El('div');
    },
    querySelectorAll(sel) {
      if (sel === '.screen') return dom.screens;
      if (sel === '[data-go]') return dom.dataGo;
      return dom.body.querySelectorAll(sel);
    },
    addEventListener(type, fn) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, extra) {
      const ev = Object.assign({ type: type, preventDefault() {}, stopPropagation() {} }, extra || {});
      for (const fn of (doc.listeners.get(type) || []).slice()) fn(ev);
    }
  };

  const win = {
    document: doc,
    innerWidth: 1280,
    innerHeight: 820,
    devicePixelRatio: 1,
    location: {
      href: 'http://localhost:3060/', search: '',
      protocol: 'http:', origin: 'http://localhost:3060'
    },
    history: { replaceState() {} },
    navigator: { userAgent: 'flow-check', maxTouchPoints: 0 },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
      clear: () => store.clear()
    },
    matchMedia: q => ({
      matches: /any-hover: hover|pointer: fine|orientation: landscape/.test(q),
      media: q,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}
    }),
    requestAnimationFrame: fakeRaf,
    cancelAnimationFrame: fakeCancelRaf,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimer,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearTimer,
    performance: { now: () => T },
    /* 首頁的「現在有幾個人在玩」是加分資訊，測試裡一律當成拿不到 */
    fetch: () => Promise.reject(new Error('flow-check 沒有 HTTP')),
    Date: FakeDate,
    WebSocket: FakeSocket,
    URL: URL,
    URLSearchParams: URLSearchParams,
    console: console,
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!win.listeners.has(type)) win.listeners.set(type, []);
      win.listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, extra) {
      const ev = Object.assign({ type: type, preventDefault() {}, stopPropagation() {} }, extra || {});
      for (const fn of (win.listeners.get(type) || []).slice()) fn(ev);
    }
  };
  win.self = win;
  win.window = win;

  const context = vm.createContext(win);
  const files = [
    'js/config.js', 'js/rng.js', 'js/stairs.js', 'js/rules.js', 'js/ai.js',
    'js/themes/characters.js', 'js/themes/scenes.js', 'js/themes/nicknames.js',
    'js/svgui.js', 'js/render.js', 'js/input.js', 'js/audio.js', 'js/storage.js',
    'js/net.js', 'js/online.js', 'js/app.js'
  ];
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), context, { filename: 'public/' + f });
  }

  return {
    win: win, doc: doc, dom: dom, sockets: sockets,
    el: id => doc.querySelector('#' + id),
    screenNow() {
      const hit = dom.screens.find(s => s.classes.has('active'));
      return hit ? hit.id.replace('screen-', '') : '(沒有)';
    }
  };
}

/* ---------------------------------------------------------- */
/* 伺服器（真的 rooms + match-loop + protocol）                 */
/* ---------------------------------------------------------- */
function bootServer() {
  const people = new Map();            /* personId → { person, deliver } */
  let seq = 0;

  const io = {
    send(personId, msg) {
      const it = people.get(personId);
      if (!it) return;
      it.deliver(JSON.parse(JSON.stringify(msg)));
    },
    lobbyIds() {
      const out = [];
      for (const entry of people) if (!entry[1].person.roomId) out.push(entry[0]);
      return out;
    },
    aliveIds() { return [...people.keys()]; },
    pingAll() {}
  };

  let matchNo = 0;
  const hub = createHub({ now: clockNow, newSeed: () => 'flow-' + (++matchNo) });
  const loop = createLoop(hub, io, { now: clockNow });
  const proto = createProtocol(hub, loop, io);

  function connect(deliver) {
    const person = { id: 'ws' + (++seq), name: '', char: 'yuan', roomId: null, role: null };
    people.set(person.id, { person: person, deliver: deliver });
    io.send(person.id, { type: 'hello', game: 'stair-kids', personId: person.id });
    return person;
  }
  function drop(personId) {
    people.delete(personId);
    hub.markDisconnected(personId);
    loop.forgetFull(personId);
    const room = [...hub.rooms.values()].find(r => r.members.has(personId));
    if (room) loop.sendRoom(room);
    loop.sendLobby(true);
  }
  return {
    hub: hub, loop: loop, io: io, people: people,
    connect: connect, drop: drop,
    handle: (person, msg) => proto.handle(person, msg)
  };
}

/* ---------------------------------------------------------- */
/* 把兩邊接起來                                                */
/* ---------------------------------------------------------- */
const server = bootServer();
const wire = [];                        /* 待送的封包（下一格才到，才有網路的感覺） */
const socketPerson = new Map();

const bridge = {
  accept(socket) {
    const person = server.connect(msg => wire.push({ socket: socket, msg: msg }));
    socketPerson.set(socket, person);
  },
  fromClient(socket, msg) {
    const person = socketPerson.get(socket);
    if (person) wire.push({ person: person, msg: msg });
  },
  drop(socket) {
    const person = socketPerson.get(socket);
    if (!person) return;
    socketPerson.delete(socket);
    server.drop(person.id);
  }
};

const browser = bootBrowser(bridge);

/** 對手：不跑前端，直接用協定講話（跟 netcode-check 一樣） */
const foeInbox = [];
const foe = server.connect(msg => foeInbox.push(msg));
const foeSay = msg => wire.push({ person: foe, msg: msg });

/** 推進一格（1/60 秒）：封包、計時器、伺服器 tick、瀏覽器畫面 */
function tickOnce() {
  T += STEP_MS;
  const due = wire.splice(0, wire.length);
  for (const it of due) {
    if (it.person) server.handle(it.person, it.msg);
    else if (it.socket.readyState === 1 && it.socket.onmessage) {
      it.socket.onmessage({ data: JSON.stringify(it.msg) });
    }
  }
  runTimers();
  server.loop.frame(T);
  pumpRaf();
}
function advance(ms) {
  const end = T + ms;
  while (T < end) tickOnce();
}
/** 推進到條件成立（最多等 limitMs），回傳有沒有等到 */
function until(fn, limitMs) {
  const end = T + (limitMs == null ? 30000 : limitMs);
  while (T < end) {
    if (fn()) return true;
    tickOnce();
  }
  return !!fn();
}

const el = browser.el;
const screenNow = () => browser.screenNow();
const theRoom = () => [...server.hub.rooms.values()][0];
const myId = () => {
  const p = socketPerson.get(browser.sockets[0]);
  return p ? p.id : null;
};
const mySeat = () => {
  const r = theRoom();
  return r ? r.members.get(myId()) : null;
};

/* ---------------------------------------------------------- */
group('開場：首頁 → 大廳 → 開房間');
advance(200);
ok(screenNow() === 'home', '一開始在首頁', screenNow());

const goLobby = browser.dom.dataGo.find(b => b.dataset.go === 'lobby');
ok(!!goLobby, '首頁有「跟別人玩」的入口');
goLobby.click();
ok(until(() => screenNow() === 'lobby' && el('lobby-status').textContent === '已連線', 3000),
  '進大廳並連上伺服器', el('lobby-status').textContent);

el('btn-create').click();
ok(until(() => screenNow() === 'room', 3000), '開房間之後進到房間畫面', screenNow());
ok(!!theRoom(), '伺服器真的開了一間房');
ok(el('btn-ready').hidden === false, '房間裡看得到「我準備好了」');
ok(el('btn-start-online').hidden === false && el('btn-start-online').disabled === true,
  '房主看得到「開始」，但還不能按（人不夠）');

/* ---------------------------------------------------------- */
group('對手加入 → 兩人準備 → 開始');
foeSay({ type: 'hello', name: '小乙', char: 'mimi' });
advance(100);
foeSay({ type: 'join', roomId: theRoom().id, role: 'player' });
ok(until(() => server.hub.connectedSeats(theRoom()).length === 2, 3000), '對手坐上第二個位子');

el('btn-ready').click();
ok(until(() => mySeat() && mySeat().ready, 2000), '我按了「我準備好了」');
ok(el('btn-start-online').disabled === true, '只有我準備好，還不能開始');
foeSay({ type: 'ready', ready: true });
ok(until(() => el('btn-start-online').disabled === false, 3000), '兩個人都準備好，開始鈕亮了');

el('btn-start-online').click();
ok(until(() => screenNow() === 'game', 3000), '開打之後切到遊戲畫面', screenNow());
ok(el('ov-result').hidden === true, '剛開打不會有結算畫面殘留');
ok(until(() => el('actors').children.length === 2, 5000), '畫面上有兩個小朋友',
  el('actors').children.length + ' 個');

/* ---------------------------------------------------------- */
group('對戰 → 雙方死亡 → 結算');
/* 兩個人都不動：被天花板一路往下推，最後掉出畫面下緣摔死（真的走規則核心） */
ok(until(() => el('ov-result').hidden === false, 120000), '兩個人都死了之後跑出結算畫面');
ok(theRoom().phase === 'result', '伺服器也進到結算階段', theRoom().phase);
ok(screenNow() === 'game', '結算蓋在遊戲畫面上（樓梯定格留在後面）', screenNow());
ok(el('actors').children.length === 0, '結算時畫面上沒有殘留的角色',
  el('actors').children.length + ' 個');
ok(el('btn-again').hidden === false && el('btn-again').textContent === '再來一局',
  '結算有「再來一局」', el('btn-again').textContent);
ok(el('btn-change-diff').hidden === false && el('btn-change-diff').textContent === '回到房間',
  '結算有「回到房間」', el('btn-change-diff').textContent);
ok(el('btn-result-home').textContent === '回首頁', '結算有「回首頁」',
  el('btn-result-home').textContent);

/* ---------------------------------------------------------- */
group('再來一局：回房間、自動準備好、等對方');
el('btn-again').click();
ok(until(() => screenNow() === 'room', 3000), '按「再來一局」馬上回到房間', screenNow());
ok(el('ov-result').hidden === true, '結算畫面收掉了，沒有殘留');
foeSay({ type: 'result-done' });
ok(until(() => theRoom().phase === 'lobby', 12000), '兩邊都看完結算，房間回到大廳階段',
  theRoom().phase);
ok(until(() => mySeat() && mySeat().ready, 3000), '「再來一局」幫我自動按好準備');
ok(el('btn-ready').hidden === false && el('btn-start-online').hidden === false,
  '房間的按鈕跟原本開房間一樣（準備、開始都在）');
ok(el('btn-start-online').disabled === true, '對方還沒準備好，開始鈕還是不能按');
foeSay({ type: 'ready', ready: true });
ok(until(() => el('btn-start-online').disabled === false, 3000), '對方準備好之後才可以開始');

el('btn-start-online').click();
ok(until(() => screenNow() === 'game' && el('ov-result').hidden === true, 3000),
  '第二局正常開打，沒有上一局的結算殘留', screenNow());
ok(until(() => el('actors').children.length === 2, 5000), '第二局也有兩個小朋友');

/* ---------------------------------------------------------- */
group('第二局結算 → 回到房間 → 第三局');
ok(until(() => el('ov-result').hidden === false, 120000), '第二局也跑得出結算');
el('btn-change-diff').click();
ok(until(() => screenNow() === 'room', 3000), '按「回到房間」回到房間', screenNow());
ok(el('ov-result').hidden === true, '結算收掉了');
foeSay({ type: 'result-done' });
ok(until(() => theRoom().phase === 'lobby', 12000), '房間回到大廳階段');
ok(mySeat() && mySeat().ready === false,
  '「回到房間」不會自動幫我準備（跟「再來一局」不一樣）');
el('btn-ready').click();
foeSay({ type: 'ready', ready: true });
ok(until(() => el('btn-start-online').disabled === false, 3000), '兩個人準備好，可以開第三局');
el('btn-start-online').click();
ok(until(() => screenNow() === 'game', 3000), '第三局開打');

/* ---------------------------------------------------------- */
group('結算 → 回首頁：座位要放掉、連線要收掉');
ok(until(() => el('ov-result').hidden === false, 120000), '第三局跑得出結算');
el('btn-result-home').click();
advance(500);
ok(screenNow() === 'home', '回到首頁', screenNow());
ok(el('ov-result').hidden === true, '首頁不會殘留結算畫面');
ok(browser.sockets[0].readyState === 3, '離開線上區域會把連線收掉');
const gone = !theRoom() || !theRoom().members.has(myId()) || !theRoom().members.get(myId()).connected;
ok(gone, '伺服器那邊的座位放掉了');

/* ---------------------------------------------------------- */
group('連線斷掉：不要留在一間按什麼都沒反應的幽靈房間');
/* 重連會拿到新的身分，回不到原本的座位，所以本地也要把房間收掉、退回大廳。
 * 以前只有「對局中」才通知，坐在房間裡斷線的人會停在一間死掉的房間畫面上。 */
goLobby.click();
ok(until(() => screenNow() === 'lobby' && browser.sockets.length >= 2 &&
  browser.sockets[browser.sockets.length - 1].readyState === 1, 5000), '重新連上大廳');
el('btn-create').click();
ok(until(() => screenNow() === 'room', 3000), '又開了一間房', screenNow());
browser.sockets[browser.sockets.length - 1].close();
advance(300);
ok(screenNow() === 'lobby', '連線斷了會退回大廳，不會卡在房間畫面', screenNow());
ok(el('toast').textContent.indexOf('連線斷了') === 0, '而且有講原因',
  el('toast').textContent);

/* ---------------------------------------------------------- */
console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n沒過的項目：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
