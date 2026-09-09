/* ===== scripts/fake-browser.js — 在 Node 裡跑真前端用的最小假瀏覽器 =====
 *
 * 給 flow-check.js（流程）與 smooth-check.js（畫面順暢度）共用。
 *
 * 提供：DOM（照 index.html 建好有 id 的節點）、requestAnimationFrame、
 * setTimeout／setInterval、WebSocket、localStorage、假時鐘；
 * 另一端接真的 lib/rooms + lib/match-loop + lib/protocol。
 *
 * 三個節奏是分開的，才驗得出「interval 相關」的問題：
 *   · 畫面：frameMs（60Hz、144Hz、30Hz，或一次跳 250ms 的節流）
 *   · 伺服器：serverTickMs（權威迴圈的 setInterval，預設 1000/30）
 *   · 網路：lag / jitter（單向延遲 = lag / 2）
 *
 * 時間一律走假時鐘，所以同一份程式每次跑起來都一樣，可以重播。
 */
'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHub } = require('../lib/rooms.js');
const { createLoop } = require('../lib/match-loop.js');
const { createProtocol } = require('../lib/protocol.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const SERVER_TICK_MS = 1000 / 30;
const FRAME_60 = 1000 / 60;

/* ---------------------------------------------------------- */
/* DOM                                                        */
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

const dataKey = name => name.slice(5).replace(/-(\w)/g, (m, c) => c.toUpperCase());

function makeEl(activeRef) {
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
    focus() { activeRef.el = this; }
    blur() { if (activeRef.el === this) activeRef.el = null; }
    select() {}

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
  return El;
}

/** 照 index.html 把有 id／有 data-go／是畫面的節點先建好 */
function buildDom(El) {
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
/* 主體                                                        */
/* ---------------------------------------------------------- */
/**
 * @param {{lag?:number, jitter?:number, frameMs?:number, serverTickMs?:number, seed?:number}} [opt]
 */
function boot(opt) {
  opt = opt || {};
  const seedBase = opt.seed == null ? 1 : opt.seed;

  /* ---- 假時鐘與計時器 ---- */
  let T = 1767225600000;
  const clockNow = () => T;
  let timerSeq = 1;
  const timers = new Map();
  const setTimeoutFake = (fn, ms) => {
    const id = timerSeq++;
    timers.set(id, { at: T + (ms || 0), fn: fn, every: 0 });
    return id;
  };
  const setIntervalFake = (fn, ms) => {
    const id = timerSeq++;
    timers.set(id, { at: T + (ms || 0), fn: fn, every: Math.max(1, ms || 1) });
    return id;
  };
  const clearTimerFake = id => timers.delete(id);
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
  const rafFake = cb => { const id = rafSeq++; rafQueue.push({ id: id, cb: cb }); return id; };
  const cancelRafFake = id => { rafQueue = rafQueue.filter(r => r.id !== id); };
  function pumpRaf() {
    const q = rafQueue;
    rafQueue = [];
    for (const r of q) r.cb(T);
  }

  /* ---- 亂數（jitter 用，固定 seed 才可重播） ---- */
  let rngState = seedBase * 2654435761 % 4294967296;
  function rng() {
    rngState = (rngState * 1103515245 + 12345) % 2147483648;
    return rngState / 2147483648;
  }

  /* ---- 伺服器 ---- */
  const people = new Map();
  let personSeq = 0;
  const io = {
    send(personId, msg) {
      const it = people.get(personId);
      if (it) it.deliver(JSON.parse(JSON.stringify(msg)));
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
  const hub = createHub({ now: clockNow, newSeed: () => 'fb-' + seedBase + '-' + (++matchNo) });
  const loop = createLoop(hub, io, { now: clockNow });
  const proto = createProtocol(hub, loop, io);

  /* ---- 網路（單向延遲 = lag / 2） ---- */
  const wire = [];
  const lag = opt.lag || 0;
  const jitter = opt.jitter || 0;
  function later(run) {
    let d = lag / 2;
    if (jitter) d += (rng() - 0.5) * jitter;
    if (d < 0) d = 0;
    wire.push({ at: T + d, run: run });
  }
  function deliverDue() {
    for (let i = 0; i < wire.length; i++) {
      if (wire[i].at <= T) { const it = wire.splice(i, 1)[0]; i--; it.run(); }
    }
  }

  function connectPerson(deliver) {
    const person = {
      id: 'ws' + (++personSeq), name: '', char: 'yuan', roomId: null, role: null
    };
    people.set(person.id, { person: person, deliver: msg => later(() => deliver(msg)) });
    io.send(person.id, { type: 'hello', game: 'stair-kids', personId: person.id });
    return person;
  }
  function dropPerson(personId) {
    people.delete(personId);
    hub.markDisconnected(personId);
    loop.forgetFull(personId);
    const room = [...hub.rooms.values()].find(r => r.members.has(personId));
    if (room) loop.sendRoom(room);
    loop.sendLobby(true);
  }

  /* ---- 瀏覽器 ---- */
  const activeRef = { el: null };
  const El = makeEl(activeRef);
  const dom = buildDom(El);
  const store = new Map();
  const sockets = [];
  const socketPerson = new Map();

  class FakeSocket {
    constructor(url) {
      const self = this;
      this.url = url;
      this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      sockets.push(this);
      setTimeoutFake(() => {
        if (self.readyState !== 0) return;
        self.readyState = 1;
        const person = connectPerson(msg => {
          if (self.readyState === 1 && self.onmessage) self.onmessage({ data: JSON.stringify(msg) });
        });
        socketPerson.set(self, person);
        if (self.onopen) self.onopen();
      }, 1);
    }
    send(text) {
      if (this.readyState !== 1) return;
      const person = socketPerson.get(this);
      if (!person) return;
      const msg = JSON.parse(text);
      later(() => proto.handle(person, msg));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const person = socketPerson.get(this);
      if (person) { socketPerson.delete(this); dropPerson(person.id); }
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

  const doc = {
    body: dom.body,
    documentElement: new El('html'),
    hidden: false,
    visibilityState: 'visible',
    listeners: new Map(),
    get activeElement() { return activeRef.el; },
    set activeElement(v) { activeRef.el = v; },
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
    navigator: { userAgent: 'fake-browser', maxTouchPoints: 0 },
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
    requestAnimationFrame: rafFake,
    cancelAnimationFrame: cancelRafFake,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimerFake,
    setInterval: setIntervalFake,
    clearInterval: clearTimerFake,
    performance: { now: () => T },
    Date: FakeDate,
    WebSocket: FakeSocket,
    URL: URL,
    URLSearchParams: URLSearchParams,
    console: console,
    /* 首頁的「現在有幾個人在玩」是加分資訊，測試裡一律當成拿不到 */
    fetch: () => Promise.reject(new Error('fake-browser 沒有 HTTP')),
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

  /* ---- 節奏 ---- */
  let frameMs = opt.frameMs || FRAME_60;
  let serverTickMs = opt.serverTickMs || SERVER_TICK_MS;
  let nextFrame = T + frameMs;
  let nextServer = T + serverTickMs;

  /**
   * 推進 ms 毫秒。畫面、伺服器 interval、網路各走自己的節奏。
   * @param {number} ms
   * @param {{frameMs?:number, serverTickMs?:number, onFrame?:Function}} [o]
   */
  function advance(ms, o) {
    o = o || {};
    if (o.frameMs) { frameMs = o.frameMs; nextFrame = Math.min(nextFrame, T + frameMs); }
    if (o.serverTickMs) { serverTickMs = o.serverTickMs; nextServer = Math.min(nextServer, T + serverTickMs); }
    const end = T + ms;
    while (T < end) {
      /* 下一件事什麼時候發生（1ms 為最小刻度，夠細也跑得動） */
      T = Math.min(end, T + 1);
      deliverDue();
      runTimers();
      if (T >= nextServer) { nextServer = T + serverTickMs; loop.frame(T); }
      if (T >= nextFrame) {
        nextFrame = T + frameMs;
        pumpRaf();
        if (o.onFrame) o.onFrame(T);
      }
    }
  }

  /** 推進到條件成立（最多等 limitMs） */
  function until(fn, limitMs, o) {
    const end = T + (limitMs == null ? 30000 : limitMs);
    while (T < end) {
      if (fn()) return true;
      advance(frameMs, o);
    }
    return !!fn();
  }

  const el = id => doc.querySelector('#' + id);
  const screenNow = () => {
    const hit = dom.screens.find(s => s.classes.has('active'));
    return hit ? hit.id.replace('screen-', '') : '(沒有)';
  };

  /** 對手：不跑前端，直接用協定講話（跟 netcode-check 一樣） */
  function connectFoe() {
    const inbox = [];
    const person = connectPerson(msg => inbox.push(msg));
    return {
      person: person,
      inbox: inbox,
      say: msg => later(() => proto.handle(person, msg)),
      room() {
        for (let i = inbox.length - 1; i >= 0; i--) {
          const m = inbox[i];
          if (m.type === 'room' || m.type === 'joined') return m.room;
        }
        return null;
      }
    };
  }

  return {
    win: win, doc: doc, dom: dom, sockets: sockets, socketPerson: socketPerson,
    hub: hub, loop: loop, proto: proto, people: people,
    el: el, screenNow: screenNow,
    advance: advance, until: until, connectFoe: connectFoe,
    now: () => T,
    theRoom: () => [...hub.rooms.values()][0],
    myPerson: () => socketPerson.get(sockets[sockets.length - 1]) || null
  };
}

module.exports = { boot, SERVER_TICK_MS, FRAME_60 };
