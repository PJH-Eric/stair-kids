'use strict';

const assert = require('node:assert/strict');
const { createHub, CONST } = require('../lib/rooms.js');
const { server, hub, loop, io, people } = require('../server.js');
const person = id => ({ id, name: id, char: 'yuan' });
let failures = 0;
async function check(name, run) {
  try { await run(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
}
async function until(check) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('連線或房間未完成清理');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function main() {
  await check('最後玩家離開後，觀眾不能保留房間與邀請', () => {
    const rooms = createHub();
    const { room } = rooms.createRoom(person('host'));
    rooms.join(room.id, person('spectator'), 'spectator');
    const invite = rooms.makeInvite(room.id, 'host');
    rooms.leave(room.id, 'host');
    assert.equal(rooms.rooms.has(room.id), false);
    assert.ok(rooms.resolveInvite(invite.token).error);
    assert.equal(room.inputs.size, 0);
    assert.equal(room.inputQ.size, 0);
  });
  await check('時間從零開始也會回收斷線空房，觀眾不能延長寬限', () => {
    let clock = 0;
    const rooms = createHub({ now: () => clock });
    const { room } = rooms.createRoom(person('host'));
    rooms.markDisconnected('host');
    assert.ok(rooms.rooms.has(room.id));
    clock = CONST.EMPTY_GRACE_MS - 1;
    rooms.join(room.id, person('spectator'), 'spectator');
    rooms.tick(1);
    assert.ok(rooms.rooms.has(room.id));
    clock = CONST.EMPTY_GRACE_MS;
    rooms.tick(1);
    assert.equal(rooms.rooms.has(room.id), false);
  });
  await check('失效的加入不取消空房回收；真人重新加入才取消', () => {
    let clock = 100;
    const rooms = createHub({ now: () => clock });
    const { room } = rooms.createRoom(person('host'));
    rooms.markDisconnected('host');
    const emptyAt = room.emptyAt;
    for (let i = 0; i < CONST.MAX_SPECTATORS; i++) rooms.join(room.id, person('spec' + i), 'spectator');
    assert.ok(rooms.join(room.id, person('overflow'), 'spectator').error);
    assert.equal(room.emptyAt, emptyAt);
    rooms.join(room.id, person('new-host'), 'player');
    clock += CONST.EMPTY_GRACE_MS + 1;
    rooms.tick(1);
    assert.ok(rooms.rooms.has(room.id));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  async function client() {
    const ws = new WebSocket('ws://127.0.0.1:' + server.address().port + '/ws');
    clients.push(ws);
    const messages = [];
    ws.addEventListener('message', event => messages.push(JSON.parse(event.data)));
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    await until(() => messages.some(message => message.type === 'hello'));
    return { ws, messages, id: messages.find(message => message.type === 'hello').personId };
  }
  await check('關房後通知觀眾並將連線移回大廳', async () => {
    const host = await client();
    const spectator = await client();
    const hostPerson = people.get(host.id).person;
    const specPerson = people.get(spectator.id).person;
    const { room } = hub.createRoom(hostPerson);
    hub.join(room.id, specPerson, 'spectator');
    hostPerson.roomId = room.id;
    specPerson.roomId = room.id;
    hub.leave(room.id, host.id);
    loop.frame(Date.now());
    loop.frame(Date.now() + 40);
    await until(() => spectator.messages.some(message => message.type === 'closed'));
    assert.equal(specPerson.roomId, null);
    assert.ok(io.lobbyIds().includes(spectator.id));
  });
  await check('無心跳的連線從在線名冊移除，正常大廳連線保留', async () => {
    const active = await client();
    const stale = await client();
    people.get(stale.id).socket.lastSeen = Date.now() - 20000;
    io.pingAll();
    await until(() => !people.has(stale.id));
    assert.ok(people.has(active.id));
    assert.equal(io.onlineCount(), people.size);
  });
  clients.forEach(client => client.close());
  await until(() => people.size === 0);
  loop.stop();
  server.close();
  process.exit(failures ? 1 : 0);
}
main().catch(error => { console.error(error); process.exit(1); });
