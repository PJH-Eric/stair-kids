/* ===== scripts/e2e-online.js — 用真的瀏覽器跑完整個線上流程 =====
 *
 * 這一支「不是」npm run verify 的一部分，也不算專案的依賴：
 * 它需要 Playwright，而這個專案的硬規則是零依賴（使用者雙擊 .bat 就能玩）。
 * 要跑的話另外裝：
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node server.js                      （另一個視窗）
 *   node scripts/e2e-online.js          （預設 http://localhost:3060）
 *   node scripts/e2e-online.js --url=https://xxx.onrender.com --shots=./screenshots
 *
 * 驗的是「三個瀏覽器同時連同一台伺服器」才看得出來的東西：
 * 開房、大廳列表、加入、席位滿了自動觀戰、準備好、開始、對戰、快速短語、
 * 邀請連結、搶位、踢人、結算、結算停留結束自動回房間、房間沒人自動關掉。
 */
'use strict';

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  console.error('這一支需要 Playwright（不是專案依賴，遊戲本身零依賴）：');
  console.error('  npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const BASE = String(arg('url', 'http://localhost:3060')).replace(/\/+$/, '');
const PAGE = BASE + '/index.html';
const SHOTS = arg('shots', '');
const EXE = arg('chromium', '');           /* 指定 Chromium 執行檔（CI 環境用） */

const wait = ms => new Promise(r => setTimeout(r, ms));

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

(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  const errs = [];

  async function open(label, viewport, url) {
    const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(label + ' pageerror: ' + e));
    page.on('console', m => { if (m.type() === 'error') errs.push(label + ' console: ' + m.text()); });
    await page.goto(url || PAGE);
    await wait(300);
    page.label = label;
    return page;
  }
  /* 用 JS 直接叫 click：側欄可以捲，Playwright 的 scrollIntoView 會把元素捲出可視區 */
  const tap = (p, sel) => p.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) throw new Error('找不到 ' + s);
    el.click();
  }, sel);
  const screen = p => p.evaluate(() => document.querySelector('.screen.active').id);
  const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png' }); };
  async function toLobby(p) {
    await tap(p, '[data-go="online"]'); await wait(200);
    await tap(p, '[data-go="lobby"]'); await wait(900);
  }

  /* ---------------------------------------------------------- */
  group('連線與開房');
  const A = await open('甲');
  await toLobby(A);
  ok((await A.textContent('#lobby-status')).indexOf('已連線') >= 0, '連得上伺服器',
    (await A.textContent('#lobby-status')).trim());
  await tap(A, '#btn-create'); await wait(800);
  ok(await screen(A) === 'screen-room', '開房之後進到房間畫面');
  ok(await A.$eval('#room-seats .seat', el => !!el), '席位卡畫出來了');

  group('大廳列表與加入');
  /* 整張房間卡都要可以點（手指按整張卡比按右邊那顆小按鈕容易），
   * 而且觸控裝置上每個可點的東西都要 ≥44px —— 平板是第一優先裝置。 */
  const B = await open('乙');
  await toLobby(B);
  const rooms = await B.$$eval('#lobby-list .room-item b', ns => ns.map(n => n.textContent));
  ok(rooms.length === 1, '第二個人在大廳看得到這間房', JSON.stringify(rooms));
  ok(await B.$eval('#lobby-list .room-item', el => el.hasAttribute('data-join')),
    '整張房間卡都可以點，不只右邊那顆按鈕');
  await tap(B, '#lobby-list .room-item'); await wait(900);
  ok(await screen(B) === 'screen-room', '點整張卡就能加入，並進到房間畫面');
  ok((await A.$$eval('#room-seats .seat', ns => ns.length)) === 2, '房主也看到變成兩個人');

  group('席位滿了自動觀戰（§0.3）');
  const C = await open('丙', { width: 1100, height: 800 });
  await toLobby(C);
  await tap(C, '#lobby-list [data-join]'); await wait(900);
  ok((await C.textContent('#room-hint')).indexOf('觀戰') >= 0, '第三個人自動變觀戰',
    (await C.textContent('#room-hint')).trim());
  const specs = await A.$$eval('#room-specs .spec span', ns => ns.map(n => n.textContent.trim()));
  ok(specs.length === 1, '房主看得到觀戰名單', JSON.stringify(specs));
  ok(await C.$eval('#btn-take-seat', el => el.hidden), '席位滿的時候搶不到位');
  await shot(A, '線上-房間有觀戰者');

  group('房主權限');
  await tap(A, '#room-diff [data-diff="hard"]'); await wait(700);
  ok((await B.$eval('#room-diff .diff-btn.on', el => el.textContent)) === '困難',
    '房主改難度，其他人立刻看到');
  ok(await B.$eval('#room-diff [data-diff="easy"]', el => el.disabled), '非房主改不了難度');
  await tap(A, '#room-diff [data-diff="normal"]'); await wait(500);

  group('邀請連結（可撤銷、與房間同生命）');
  await tap(A, '#btn-invite'); await wait(600);
  const invite = await A.inputValue('#invite-link');
  ok(/invite=[a-z0-9]{8,}/.test(invite), '產生得出邀請連結', invite);

  const D = await open('受邀者', { width: 1024, height: 768 }, invite);
  ok(await screen(D) === 'screen-lobby', '邀請連結先停在大廳，不會直接進房');
  ok(await D.$eval('#invite-join', el => !el.hidden), '大廳顯示邀請確認區');
  await D.fill('#invite-nickname', '邀請後的新暱稱');
  await tap(D, '#btn-invite-join'); await wait(900);
  ok(await screen(D) === 'screen-room', '確認暱稱後才加入邀請房間');
  ok(await D.$$eval('#room-seats .seat b', ns => ns.some(n => n.textContent.indexOf('邀請後的新暱稱') >= 0)),
    '邀請房間使用確認後的新暱稱');
  await tap(D, '#btn-leave-room'); await wait(700);

  group('準備好與開始');
  await tap(A, '#btn-ready'); await wait(400);
  ok(!(await A.$eval('#btn-start-online', el => !el.hidden && !el.disabled)),
    '只有一個人準備好，還不能開始');
  await tap(B, '#btn-ready'); await wait(500);
  ok(await A.$eval('#btn-start-online', el => !el.hidden && !el.disabled),
    '兩個人都準備好，房主可以開始');
  await shot(A, '線上-都準備好');
  await tap(A, '#btn-start-online'); await wait(1800);
  ok(await screen(A) === 'screen-game' && await screen(B) === 'screen-game', '兩個人一起進遊戲畫面');
  ok(await C.evaluate(() => !document.querySelector('#spectate-tag').hidden), '觀戰者看得到「觀戰中」標記');

  group('對局中');
  for (let i = 0; i < 5; i++) {
    await A.keyboard.down('ArrowRight'); await B.keyboard.down('ArrowLeft'); await wait(320);
    await A.keyboard.up('ArrowRight'); await B.keyboard.up('ArrowLeft');
    await A.keyboard.down('ArrowLeft'); await B.keyboard.down('ArrowRight'); await wait(320);
    await A.keyboard.up('ArrowLeft'); await B.keyboard.up('ArrowRight');
  }
  /* 驗的是「這局真的在跑」，不是特定深度 —— 所以看兩次取樣有沒有變深，
   * 固定門檻會被機器負載與鏡頭追人的時機影響（實測會抖到 3 m）。 */
  const depth1 = Number(await A.textContent('#hud-depth'));
  await wait(2500);
  const depth2 = Number(await A.textContent('#hud-depth'));
  ok(depth2 > depth1 && depth2 > 2, '真的在往下跑（深度持續增加）', depth1 + ' m → ' + depth2 + ' m');
  ok((await A.textContent('#hud-net')).indexOf('線上對戰') >= 0, '側欄標明是線上對戰並顯示延遲',
    (await A.textContent('#hud-net')).trim());
  await tap(A, '#game-chat-phrases [data-say]'); await wait(800);
  const heard = await B.$$eval('#game-chat-list li', ns => ns.map(n => n.textContent.trim()));
  ok(heard.some(t => t.indexOf('加油') >= 0), '對手收得到快速短語', JSON.stringify(heard.slice(-2)));
  await shot(A, '線上-對戰中');
  await shot(C, '線上-觀戰中');

  group('結算（兩個人都死才收，§4.4）');
  let ended = false;
  for (let i = 0; i < 70 && !ended; i++) {
    await wait(1000);
    ended = await A.evaluate(() => { const el = document.querySelector('#ov-result'); return el && !el.hidden; });
  }
  ok(ended, '兩個人都死了才出現結算');
  if (ended) {
    ok(await A.evaluate(() => document.querySelector('#btn-again').hidden), '線上結算沒有「再玩一次」');
    ok((await A.textContent('#btn-result-home')).trim() === '回房間', '按鈕是「回房間」不是「回首頁」');
    const rows = await A.$$eval('#result-list li', ns => ns.map(n => n.textContent.trim()));
    ok(rows.some(r => r.indexOf('連線延遲') >= 0), '這局統計有連線延遲');
    ok(rows.some(r => r.indexOf('被推開') >= 0), '這局統計有被推開（對戰才有）');
    await shot(A, '線上-結算');
    let back = false;
    for (let i = 0; i < 16 && !back; i++) {
      await wait(1000);
      back = (await screen(A)) === 'screen-room';
    }
    ok(back, '結算停留結束會自動回房間');
    ok((await A.$$eval('#room-seats .pill.ready', ns => ns.length)) === 0, '回房間後準備狀態被清掉');
    await shot(A, '線上-回到房間');
  }

  group('搶位與踢人（§0.3／§14.2）');
  await tap(B, '#btn-leave-room'); await wait(900);
  ok(await screen(B) === 'screen-lobby', '離開房間會回大廳');
  ok(!(await C.$eval('#btn-take-seat', el => el.hidden)), '席位空出來，觀戰者可以搶');
  await tap(C, '#btn-take-seat'); await wait(800);
  ok(await C.evaluate(() =>
    [...document.querySelectorAll('#room-seats .seat b')].some(n => n.textContent.indexOf('（你）') >= 0)),
    '搶到的人變成玩家');
  await tap(A, '#room-seats [data-kick]'); await wait(900);
  ok(await screen(C) === 'screen-lobby', '被房主請出去的人回到大廳');

  group('觸控裝置的點擊目標（平板優先）');
  {
    /* 開一個模擬觸控的分頁，量房間畫面上每一個可點的東西 */
    const T = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
    const tp = await T.newPage();
    await tp.goto(PAGE); await wait(300);
    await tp.evaluate(() => document.querySelector('[data-go="online"]').click()); await wait(200);
    await tp.evaluate(() => document.querySelector('[data-go="lobby"]').click()); await wait(900);
    await tp.evaluate(() => {
      const el = document.querySelector('#lobby-list [data-join]');
      if (el) el.click();
    });
    await wait(900);
    const small = await tp.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.screen.active button, .screen.active [role="radio"]')) {
        if (el.hidden || !el.offsetParent) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.height < 44 || r.width < 44)) {
          out.push((el.id || (el.textContent || '').trim().slice(0, 8)) +
            ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        }
      }
      return out;
    });
    ok(small.length === 0, '平板上房間畫面的每個按鍵都 ≥44px（手指按得到）',
      small.length ? small.join('｜') : '全部達標');
    await tp.close();
  }

  group('手機直向與平板');
  const P = await open('手機', { width: 390, height: 844 });
  await toLobby(P);
  await shot(P, '線上-手機大廳');
  ok(await P.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    '手機直向的大廳不會橫向溢出');
  await tap(P, '#lobby-list [data-join]'); await wait(1000);
  ok(await screen(P) === 'screen-room', '手機也進得了房間');
  await shot(P, '線上-手機房間');
  ok(await P.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    '手機直向的房間不會橫向溢出');

  group('伺服器統計與自動關房');
  const health = await A.evaluate(async () => (await fetch('/health')).json());
  ok(health.ok && health.hz === 30, '/health 回得出來，權威迴圈 30Hz');
  ok(health.rooms >= 1 && health.players >= 1, '/health 的人數是真的', JSON.stringify(
    { rooms: health.rooms, players: health.players, spectators: health.spectators }));
  for (const p of [A, P]) await p.evaluate(() => {
    const el = document.querySelector('#btn-leave-room');
    if (el) el.click();
  });
  await wait(1500);
  const left = await A.evaluate(async () => (await fetch('/api/rooms')).json());
  ok(left.rooms.length === 0, '沒人了房間就自己關掉（邀請連結一起失效）',
    left.rooms.length + ' 間');

  ok(errs.length === 0, '瀏覽器主控台沒有錯誤', errs.slice(0, 3).join(' ｜ ') || '乾淨');

  await browser.close();

  console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
  if (fail) {
    console.log('\n沒過的項目：');
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
})().catch(e => {
  console.error('\n測試本身出錯了：', e && e.message);
  console.error('（伺服器有開嗎？ node server.js）');
  process.exit(1);
});
