/* ===== scripts/online-ui-check.js — 線上結算生命週期驗收 =====
 * 用最小 DOM／WebSocket 外殼跑瀏覽器的 online.js，驗證 result snapshot
 * 重複抵達時不會重開對局，也不會重複觸發結算 callback。
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const Net = require('../public/js/net.js');
const Rules = require('../public/js/rules.js');
const Characters = require('../public/js/themes/characters.js');
const Nicknames = require('../public/js/themes/nicknames.js');
const { createHub } = require('../lib/rooms.js');

let pass = 0, fail = 0;
function ok(condition, name) {
  if (condition) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

function element() {
  return {
    hidden: false, disabled: false, textContent: '', innerHTML: '', value: '',
    dataset: {}, style: {}, scrollTop: 0, scrollHeight: 0,
    classList: {
      add() {}, remove() {}, toggle() {}
    },
    addEventListener() {},
    getAttribute() { return null; },
    setAttribute() {},
    select() {}
  };
}

function loadOnline() {
  const doc = {
    documentElement: element(),
    querySelector() { return element(); },
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
    document: doc,
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
  return { Online: context.Online, sockets };
}

function roomFixture() {
  const hub = createHub({ newSeed: () => 'online-ui-check' });
  const person = (id, name) => ({ id, name, char: 'yuan' });
  const room = hub.createRoom(person('A', '甲'), { difficulty: 'normal' }).room;
  hub.join(room.id, person('B', '乙'), 'player');
  hub.setReady(room.id, 'A', true);
  hub.setReady(room.id, 'B', true);
  hub.start(room.id, 'A');
  return { hub, room };
}

const { Online, sockets } = loadOnline();
let starts = 0;
let ends = 0;
const online = Online.create({
  serverUrl: 'http://localhost:3060',
  onMatchStart() { starts++; },
  onMatchEnd() { ends++; }
});

online.connect();
const socket = sockets[0];
socket.onopen();
const receive = msg => socket.onmessage({ data: JSON.stringify(msg) });
const { hub, room } = roomFixture();

receive({ type: 'welcome', personId: 'A', name: '甲', char: 'yuan', hz: 30 });
receive({ type: 'joined', roomId: room.id, room: hub.roomView(room, 'A') });
receive({ type: 'room', room: hub.roomView(room, 'A') });
receive({ type: 'snap', snap: Object.assign(hub.snapshot(room, { viewerId: 'A', full: true }), { hz: 30 }) });

for (const p of room.match.players) {
  p.hp = 0;
  p.alive = false;
  p.state = 'stun';
}
hub.tick(1000 / 30);
const resultRoom = hub.roomView(room, 'A');
const resultSnap = Object.assign(hub.snapshot(room, { viewerId: 'A', full: false }), { hz: 30 });
receive({ type: 'room', room: resultRoom });
receive({ type: 'snap', snap: resultSnap });
receive({ type: 'snap', snap: resultSnap });

ok(starts === 1, '結算快照重複抵達不會重開線上對局');
ok(ends === 1, '同一局只觸發一次結算 callback');

console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
if (fail) process.exit(1);
