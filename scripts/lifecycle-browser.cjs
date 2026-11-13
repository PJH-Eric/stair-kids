'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { server, hub, loop, people } = require('../server.js');

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const errors = [];
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.evaluate(() => document.querySelector('[data-go="online"]').click());
      await page.evaluate(() => document.querySelector('[data-go="lobby"]').click());
      await page.waitForFunction(() => document.getElementById('lobby-status').dataset.state === 'online');
      pages.push(page);
      if (i === 0) {
        await page.evaluate(() => document.getElementById('btn-create').click());
      } else {
        await page.waitForSelector('#lobby-list [data-join]');
        await page.evaluate(() => document.querySelector('#lobby-list [data-join]').click());
      }
      await page.waitForSelector('#screen-room.active');
    }
    const room = [...hub.rooms.values()][0];
    assert.equal(hub.specsOf(room).length, 1);
    const spectator = hub.specsOf(room)[0];
    for (const player of hub.seatsOf(room)) hub.leave(room.id, player.id);
    await pages[2].waitForSelector('#screen-lobby.active');
    assert.equal(people.get(spectator.id).person.roomId, null);
    assert.equal(hub.rooms.has(room.id), false);
    assert.deepEqual(errors, []);
    console.log('PASS 最後玩家離開後，觀眾收到關房通知並返回大廳，沒有瀏覽器錯誤');
  } finally {
    await browser.close();
    for (const { socket } of people.values()) socket.close(true);
    loop.stop(); server.close();
  }
  process.exit(0);
}
main().catch(error => { console.error(error); process.exit(1); });
