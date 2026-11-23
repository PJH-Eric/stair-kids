'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const path = require('node:path');
const { io } = require('socket.io-client');
const WebSocket = require('ws');
const games = require('./games.cjs');

const origin = 'https://pjh-eric.github.io';
const suffix = process.env.WORKER_SUBDOMAIN || 'eric-games.workers.dev';
const sourceRoot = path.resolve(process.env.GAME_SOURCE_ROOT || path.join(__dirname, '../..'));

async function find(messages, predicate) {
  const deadline = Date.now() + 15000;
  do {
    const match = messages.find(predicate);
    if (match) return match;
    await pause(20);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + predicate.toString());
}

function openRaw(url, clients) {
  const ws = new WebSocket(url, { origin, handshakeTimeout: 10000 });
  clients.push(() => ws.close());
  const messages = [];
  const type = message => message.t ?? message.type;
  const send = message => ws.send(JSON.stringify(message));
  ws.on('message', payload => {
    const message = JSON.parse(payload.toString());
    if (type(message) === 'hb') send({ type: 'hb' });
    else messages.push(message);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    opened,
    send,
    wait(name, predicate = () => true) {
      return find(messages, message => type(message) === name && predicate(message));
    }
  };
}

async function rawFlow(id, base, clients) {
  const a = openRaw(base.replace('https:', 'wss:') + games[id].path, clients);
  const b = openRaw(base.replace('https:', 'wss:') + games[id].path, clients);
  await Promise.all([a.opened, b.opened]);
  if (id === 'maze-roll') {
    a.send({ t: 'hello', name: 'Worker test' });
    await a.wait('hi');
    a.send({ t: 'create', name: 'Worker test' });
    await a.wait('room');
    a.send({ t: 'leave' });
    return 'WebSocket hello and room creation';
  }
  if (['stair-kids', 'snake-3d', 'bomb-squad'].includes(id)) {
    a.send({ type: 'hello', name: 'Worker test', clientId: randomUUID(), key: randomUUID() });
    await a.wait('welcome');
    a.send({ type: 'create', name: 'Worker test' });
    await a.wait('joined');
    a.send({ type: 'leave' });
    return 'WebSocket hello and room creation';
  }
  if (id === 'flip-match') {
    await Promise.all([a.wait('welcome'), b.wait('welcome')]);
    a.send({ t: 'create', size: 4 });
    const room = await a.wait('joined');
    b.send({ t: 'join', id: room.id });
    await b.wait('joined');
    b.send({ t: 'ready', v: true });
    await a.wait('room', message => message.room?.players?.[1]?.ready);
    a.send({ t: 'start' });
    await b.wait('start');
    a.send({ t: 'leave' });
    b.send({ t: 'leave' });
    return 'two players started a match';
  }
  if (id === 'angel-strategy') {
    for (const player of [a, b]) player.send({ t: 'hello', pid: randomUUID(), name: 'Worker test' });
    await Promise.all([a.wait('hello'), b.wait('hello')]);
    a.send({ t: 'room:create', name: 'Worker test' });
    const { room } = await a.wait('room');
    b.send({ t: 'room:join', id: room.id });
    await b.wait('joined');
    a.send({ t: 'room:start' });
    await b.wait('round');
    a.send({ t: 'room:leave' });
    b.send({ t: 'room:leave' });
    return 'two players reached the first round';
  }
  if (id === 'amaze-go') {
    await Promise.all([a.wait('welcome'), b.wait('welcome')]);
    a.send({ t: 'create', diff: 'easy' });
    const room = await a.wait('room');
    b.send({ t: 'join', room: room.id, want: 'player' });
    await b.wait('room', message => message.id === room.id);
    a.send({ t: 'start' });
    const game = await b.wait('game');
    const rules = require(path.join(sourceRoot, id, 'public/js/rules.js'));
    const arrow = rules.freeArrows(game.state)[0];
    assert.notEqual(arrow, undefined, 'There is a legal arrow on the generated board');
    await pause(Math.max(0, game.startAt - game.serverNow) + 100);
    a.send({ t: 'tap', id: arrow });
    await b.wait('move', message => message.ok && message.id === arrow);
    a.send({ t: 'leave' });
    b.send({ t: 'leave' });
    return 'board generated and legal move synchronized';
  }

  for (const player of [a, b]) player.send({ type: 'hello', name: 'Worker test', clientId: randomUUID() });
  await Promise.all([a.wait('welcome'), b.wait('welcome')]);
  if (id === 'guess-ab') {
    a.send({ type: 'create', mode: 'duel', settings: { tier: 0, cs: 'pack-fruit', turnSec: 30 } });
    const { room } = await a.wait('room');
    b.send({ type: 'join', roomId: room.id, token: room.invite.token, want: 'player' });
    await b.wait('room', message => message.room.you.role === 'player');
    b.send({ type: 'ready', value: true });
    await a.wait('room', message => message.room.seats[1]?.ready);
    a.send({ type: 'start' });
    const { room: setup } = await b.wait('room', message => message.room.status === 'setup');
    const secret = setup.game.players[1].myDefault;
    a.send({ type: 'secret', code: [0, 1, 2, 3] });
    b.send({ type: 'secret', code: secret });
    const { room: playing } = await b.wait('room', message => message.room.status === 'playing');
    await pause(Math.max(0, playing.game.startedAt - playing.serverNow) + 200);
    const first = playing.game.first;
    [a, b][first].send({ type: 'guess', code: first === 0 ? secret : [0, 1, 2, 3] });
    await a.wait('room', message => message.room.status === 'playing' && message.room.game.turn === 1 - first);
    [a, b][1 - first].send({ type: 'guess', code: first === 0 ? [0, 1, 2, 3] : secret });
    await a.wait('room', message => message.room.status === 'finished');
    a.send({ type: 'leave' });
    b.send({ type: 'leave' });
    return 'two players completed a duel';
  }

  a.send({ type: 'create', name: 'Worker test', kind: 'eight' });
  const room = await a.wait('joined');
  b.send({ type: 'join', roomId: room.roomId });
  await b.wait('joined');
  a.send({ type: 'ready', ready: true });
  b.send({ type: 'ready', ready: true });
  await a.wait('room', message => message.room.members.filter(member => member.ready).length === 2);
  a.send({ type: 'start' });
  const { game } = await b.wait('game');
  const ai = require(path.join(sourceRoot, id, 'public/js/ai.js'));
  const rng = require(path.join(sourceRoot, id, 'public/js/rng.js'));
  const rules = require(path.join(sourceRoot, id, 'public/js/rules.js'));
  const physics = require(path.join(sourceRoot, id, 'public/js/physics.js'));
  const { shot } = ai.chooseShot(game.state, 'normal', rng.create('worker-verification'));
  [a, b][game.state.turn].send({ type: 'shot', shot });
  const settle = await b.wait('settle');
  const world = rules.prepareWorld(game.state, shot);
  physics.applyShot(world, shot);
  assert.equal(settle.hash, physics.runToRest(world).hash);
  a.send({ type: 'leave' });
  b.send({ type: 'leave' });
  return 'authoritative shot settled and broadcast';
}

async function socketIoFlow(id, base, clients) {
  const response = await fetch(base + '/socket.io/socket.io.js', { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /javascript/);
  assert.match(await response.text(), /Socket\.IO v4\./);
  async function open() {
    const socket = io(base, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 10000,
      extraHeaders: { Origin: origin }
    });
    clients.push(() => socket.disconnect());
    const messages = [];
    for (const event of ['room:sync', 'room:events', 'room:stroke']) {
      socket.on(event, data => messages.push({ event, data }));
    }
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const request = (event, data) => socket.timeout(10000).emitWithAck(event, data);
    if (id !== 'house-stack') {
      const hello = await request('hello', { clientId: randomUUID(), key: randomUUID(), name: 'Worker test' });
      assert.ok(hello.ok, JSON.stringify(hello));
    }
    return {
      request,
      send: (event, data) => socket.emit(event, data),
      wait: (event, predicate) => find(messages, message => message.event === event && predicate(message.data))
    };
  }
  if (['house-stack', 'whack-a-mole', 'bumper-sumo'].includes(id)) {
    const client = await open();
    const created = await client.request('room:create', { name: 'Worker test', roomName: 'Worker test' });
    assert.ok(created.ok, JSON.stringify(created));
    client.send('room:leave', {});
    return 'Socket.IO acknowledgements and room creation';
  }

  const [a, b] = await Promise.all([open(), open()]);
  const created = await a.request('room:create', { roomName: 'Worker test', level: 'easy' });
  assert.ok(created.ok, JSON.stringify(created));
  const joined = await b.request('room:join', { code: created.code });
  assert.ok(joined.ok, JSON.stringify(joined));
  a.send('room:ready', { ready: true });
  b.send('room:ready', { ready: true });
  const roomOf = view => id === 'draw-guess' ? view.room : view;
  await a.wait('room:sync', view => roomOf(view).members.filter(member => member.ready).length >= 2);
  a.send('room:start', {});
  const { data: view } = await b.wait('room:sync', view => roomOf(view).phase === 'playing');
  assert.equal(roomOf(view).code, created.code);
  a.send('room:leave', {});
  b.send('room:leave', {});
  return 'Socket.IO acknowledgements, room join and match start';
}

async function verify(id) {
  const base = 'https://' + id + '-backup.' + suffix;
  const response = await fetch(base + '/health', { headers: { Origin: origin }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal((await response.json()).ok, true);
  const clients = [];
  try {
    const result = await (games[id].socketIo ? socketIoFlow : rawFlow)(id, base, clients);
    console.log(id + ': ' + result);
  } finally {
    clients.forEach(close => close());
  }
}

const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(games);
Promise.allSettled(selected.map(verify)).then(results => {
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(selected[index] + ': ' + result.reason.stack);
      process.exitCode = 1;
    }
  });
});
