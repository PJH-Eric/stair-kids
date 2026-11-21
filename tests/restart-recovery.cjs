'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');

async function exercise(base, restart) {
  const sockets = [];
  function connect(url, resumeKey) {
    const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws');
    sockets.push(ws);
    const state = {};
    const send = data => ws.send(JSON.stringify(data));
    ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);
      state[msg.type] = msg;
      if (msg.type === 'hello') send({ type: 'hello', name: 'Recovery check', resumeKey });
    });
    return { state, send };
  }

  async function wait(get) {
    for (let i = 0; i < 280; i++) {
      const value = get();
      if (value) return value;
      await sleep(45);
    }
    assert.fail('等待公開房間或對局快照逾時');
  }

  try {
    const keys = [randomUUID(), randomUUID()];
    const [host, guest] = keys.map(key => connect(base, key));
    const welcomes = await Promise.all([host, guest].map(p => wait(() => p.state.welcome)));
    assert.ok(welcomes.every(w => w.resumeSupported));
    host.send({ type: 'create', difficulty: 'easy' });
    const { roomId } = await wait(() => host.state.joined);
    guest.send({ type: 'join', roomId, role: 'player' });
    await wait(() => guest.state.joined);
    for (const p of [host, guest]) p.send({ type: 'ready', ready: true });
    await wait(() => host.state.room?.room.canStart);
    host.send({ type: 'start' });
    const before = await wait(() => host.state.snap?.snap.matchPhase === 'playing' && host.state.snap.snap);
    guest.send({ type: 'input', seq: 1, dir: 1 });
    await wait(() => guest.state.snap?.snap.ackSeq === 1 && guest.state.snap.snap.tick > before.tick + 3);
    guest.send({ type: 'input', seq: 2, dir: 0 });
    await wait(() => guest.state.snap?.snap.ackSeq === 2);
    await sleep(300);
    const observed = guest.state.snap.snap;
    const after = await restart({ roomId });
    const a = connect(after, keys[0]);
    assert.equal((await wait(() => a.state.welcome)).personId, welcomes[0].personId);
    a.send({ type: 'join', roomId, role: 'player' });
    const restored = await wait(() => a.state.snap?.snap);
    assert.equal(a.state.joined.roomId, roomId);
    assert.equal(a.state.joined.role, 'player');
    assert.equal(a.state.room.room.hostId, welcomes[0].personId);
    assert.equal(a.state.room.room.recovering, true);
    assert.ok(restored.full && restored.seed && restored.steps.length > 0);
    assert.ok(restored.tick >= observed.tick - 8);
    await sleep(240);
    assert.equal(a.state.snap.snap.tick, restored.tick);
    const wrong = connect(after, welcomes[1].personId);
    assert.notEqual((await wait(() => wrong.state.welcome)).personId, welcomes[1].personId);
    wrong.send({ type: 'join', roomId, role: 'player' });
    await wait(() => wrong.state.error);
    const b = connect(after, keys[1]);
    assert.equal((await wait(() => b.state.welcome)).personId, welcomes[1].personId);
    b.send({ type: 'join', roomId, role: 'player' });
    assert.equal((await wait(() => b.state.joined)).role, 'player');
    await wait(() => a.state.room?.room.recovering === false && a.state.snap?.snap.tick > restored.tick);
    b.send({ type: 'leave' });
    a.send({ type: 'leave' });
    await wait(() => a.state.left);
    return { roomId, tick: restored.tick };
  } finally {
    for (const socket of sockets) socket.close();
  }
}

function start(file) {
  const child = spawn(process.execPath, ['-e', `
    const { server } = require('./server.js');
    server.listen(0, '127.0.0.1', () => process.stdout.write('PORT=' + server.address().port + '\\n'));
  `], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STAIR_ROOM_DB_PATH: file },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      const port = output.match(/PORT=(\d+)/)?.[1];
      if (port) resolve('http://127.0.0.1:' + port);
    });
    child.once('exit', code => reject(new Error('伺服器已停止：' + code)));
  });
  return { child, ready };
}

async function stop(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const done = once(child, 'exit');
  child.kill('SIGKILL');
  await done;
}

if (require.main === module) test('強制重啟保留房間、席位與樓梯對局快照', { timeout: 32000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stairs-restart-'));
  const file = path.join(dir, 'rooms.sqlite');
  let app = start(file);
  try {
    await exercise(await app.ready, async () => {
      await stop(app.child);
      app = start(file);
      return app.ready;
    });
  } finally {
    await stop(app.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

module.exports = { exercise };
