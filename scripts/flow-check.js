/* ===== scripts/flow-check.js — 線上完整流程驗收（把整個前端真的跑起來）=====
 *
 * 為什麼要這一支：
 *   「結算畫面殘留」「回到房間開不了下一局」這類 bug 都不在某一個函式裡，
 *   而在四層接起來的縫上 ——
 *     伺服器的房間階段（lib/rooms.js）× 快照（lib/match-loop.js）
 *     × 線上狀態機（public/js/online.js）× 畫面流程（public/js/app.js）
 *   單元測試量不到，只有整條走一遍才看得出來。
 *
 * 做法：scripts/fake-browser.js 在 Node 裡放一個最小的假瀏覽器（DOM、rAF、
 * setTimeout、WebSocket、localStorage、假時鐘），照 index.html 的順序把
 * public/js 全部載進同一個 context；另一端接的是真的 rooms + match-loop + protocol。
 * 對手用第二條真的協定連線（跟 netcode-check 一樣）。
 * 按鈕是真的用 click() 觸發，畫面狀態是真的從 DOM 讀出來的。
 *
 * 走的流程（使用者指定的那一串）：
 *   首頁 → 大廳 → 開房間 → 對手加入 → 兩人準備 → 開始 → 對戰 → 雙方死亡
 *   → 結算畫面（三顆按鈕）→ 再來一局 → 回到房間（按鈕跟原本開房間一樣）
 *   → 等對方準備好才能開始 → 第二局 → 結算 → 回到房間 → 第三局 → 回首頁
 *   → 斷線退回大廳
 *
 * 執行：node scripts/flow-check.js  或  npm run test:flow
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { boot } = require('./fake-browser.js');

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
const w = boot({ seed: 3 });
const el = w.el;
const screenNow = w.screenNow;
const theRoom = w.theRoom;
const foe = w.connectFoe();
const mySocket = () => w.sockets[w.sockets.length - 1];
const myId = () => {
  const p = w.socketPerson.get(mySocket());
  return p ? p.id : null;
};
const mySeat = () => {
  const r = theRoom();
  const id = myId();
  return r && id ? r.members.get(id) : null;
};

/* ---------------------------------------------------------- */
group('開場：首頁 → 大廳 → 開房間');
w.advance(200);
ok(screenNow() === 'home', '一開始在首頁', screenNow());

/* 左上角那一顆：首頁是「回遊戲大廳」（跳出這個遊戲），其他畫面是「返回」。
 * 兩顆共用同一個位置，一次只能有一顆 —— 從遊戲大廳開分頁進來的人少了它就回不去。 */
ok(el('lobby-home-link').hidden === false, '首頁看得到「回遊戲大廳」');
ok(el('btn-back').hidden === true, '首頁不會同時出現「返回」（同一個位置只放一顆）');
ok(el('screen-nav').hidden === false, '首頁的左上角導覽列是開著的');
{
  /* 網址與寫法要跟其他遊戲專案一致（都是指到 GitHub Pages 上的 game-lobby）。
   * 它是真的 <a>，不是 button ＋ location.href：長按要能複製、中鍵要能開新分頁。 */
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const tag = /<a[^>]*id="lobby-home-link"[^>]*>/.exec(html);
  ok(!!tag, '「回遊戲大廳」是一個 <a> 連結');
  ok(!!tag && /href="https:\/\/pjh-eric\.github\.io\/game-lobby\/"/.test(tag[0]),
    '指到遊戲大廳（跟其他遊戲專案同一個網址）');
  ok(!!tag && /aria-label="回遊戲大廳"/.test(tag[0]), '有給讀螢幕軟體的說明');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  ok(/\.nav-btn\[hidden\]\s*\{[^}]*display:\s*none/.test(css),
    '藏起來的時候真的不見（.lobby-home-link 有 display，會蓋掉 [hidden] 的預設值）');
}

/* ---------------------------------------------------------- */
group('設定：開關、音量條、關掉聲音就停用音量');
{
  el('btn-settings').click();
  w.advance(50);
  ok(el('modal-settings').hidden === false, '右上角的齒輪打得開設定');
  {
    /* 假瀏覽器只照 index.html 的屬性建節點，不解析文字，所以字面從原始碼看 */
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    ok(/id="set-done"[^>]*>完成</.test(html), '底下有一顆明確的「完成」（原本只有右上角那顆小叉叉）');
  }
  /* 音量條在聲音關掉時要停用並變灰 —— 原本還拖得動，拖了卻完全沒反應 */
  el('set-bgm').checked = false;
  el('set-bgm').dispatch('input');
  w.advance(20);
  ok(el('set-bgm-vol').disabled === true, '關掉背景音樂，音量條跟著停用');
  el('set-bgm').checked = true;
  el('set-bgm').dispatch('input');
  w.advance(20);
  ok(el('set-bgm-vol').disabled === false, '開回來就能拖了');
  /* 拉音量要即時看得到百分比 */
  el('set-sfx-vol').value = '40';
  el('set-sfx-vol').dispatch('input');
  w.advance(20);
  ok(el('set-sfx-num').textContent === '40%', '拉音量，旁邊的百分比跟著變', el('set-sfx-num').textContent);
  el('set-done').click();
  w.advance(50);
  ok(el('modal-settings').hidden === true, '按「完成」就關起來');
}

/* ---------------------------------------------------------- */
group('首頁 → 大廳 → 開房間');
const goLobby = w.dom.dataGo.find(b => b.dataset.go === 'lobby');
ok(!!goLobby, '首頁有「跟別人玩」的入口');
goLobby.click();
ok(w.until(() => screenNow() === 'lobby' && el('lobby-status').textContent === '已連線', 3000),
  '進大廳並連上伺服器', el('lobby-status').textContent);
ok(el('lobby-home-link').hidden === true, '離開首頁就換回「返回」，不會兩顆疊在一起');
ok(el('btn-back').hidden === false, '大廳看得到「返回」');

el('btn-create').click();
ok(w.until(() => screenNow() === 'room', 3000), '開房間之後進到房間畫面', screenNow());
ok(!!theRoom(), '伺服器真的開了一間房');
ok(el('btn-ready').hidden === false, '房間裡看得到「我準備好了」');
ok(el('btn-start-online').hidden === false && el('btn-start-online').disabled === true,
  '房主看得到「開始」，但還不能按（人不夠）');

/* ---------------------------------------------------------- */
group('對手加入 → 兩人準備 → 開始');
foe.say({ type: 'hello', name: '小乙', char: 'mimi' });
w.advance(100);
foe.say({ type: 'join', roomId: theRoom().id, role: 'player' });
ok(w.until(() => w.hub.connectedSeats(theRoom()).length === 2, 3000), '對手坐上第二個位子');

el('btn-ready').click();
ok(w.until(() => mySeat() && mySeat().ready, 2000), '我按了「我準備好了」');
ok(el('btn-start-online').disabled === true, '只有我準備好，還不能開始');
foe.say({ type: 'ready', ready: true });
ok(w.until(() => el('btn-start-online').disabled === false, 3000), '兩個人都準備好，開始鈕亮了');

el('btn-start-online').click();
ok(w.until(() => screenNow() === 'game', 3000), '開打之後切到遊戲畫面', screenNow());
ok(el('ov-result').hidden === true, '剛開打不會有結算畫面殘留');
ok(w.until(() => el('actors').children.length === 2, 5000), '畫面上有兩個小朋友',
  el('actors').children.length + ' 個');

/* ---------------------------------------------------------- */
group('對戰 → 雙方死亡 → 結算');
/* 兩個人都不動：被天花板一路往下推，最後掉出畫面下緣摔死（真的走規則核心） */
ok(w.until(() => el('ov-result').hidden === false, 120000), '兩個人都死了之後跑出結算畫面');
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
ok(w.until(() => screenNow() === 'room', 3000), '按「再來一局」馬上回到房間', screenNow());
ok(el('ov-result').hidden === true, '結算畫面收掉了，沒有殘留');
foe.say({ type: 'result-done' });
ok(w.until(() => theRoom().phase === 'lobby', 12000), '兩邊都看完結算，房間回到大廳階段',
  theRoom().phase);
ok(w.until(() => mySeat() && mySeat().ready, 3000), '「再來一局」幫我自動按好準備');
ok(el('btn-ready').hidden === false && el('btn-start-online').hidden === false,
  '房間的按鈕跟原本開房間一樣（準備、開始都在）');
ok(el('btn-start-online').disabled === true, '對方還沒準備好，開始鈕還是不能按');
foe.say({ type: 'ready', ready: true });
ok(w.until(() => el('btn-start-online').disabled === false, 3000), '對方準備好之後才可以開始');

el('btn-start-online').click();
ok(w.until(() => screenNow() === 'game' && el('ov-result').hidden === true, 3000),
  '第二局正常開打，沒有上一局的結算殘留', screenNow());
ok(w.until(() => el('actors').children.length === 2, 5000), '第二局也有兩個小朋友');

/* ---------------------------------------------------------- */
group('第二局結算 → 回到房間 → 第三局');
ok(w.until(() => el('ov-result').hidden === false, 120000), '第二局也跑得出結算');
el('btn-change-diff').click();
ok(w.until(() => screenNow() === 'room', 3000), '按「回到房間」回到房間', screenNow());
ok(el('ov-result').hidden === true, '結算收掉了');
foe.say({ type: 'result-done' });
ok(w.until(() => theRoom().phase === 'lobby', 12000), '房間回到大廳階段');
ok(mySeat() && mySeat().ready === false,
  '「回到房間」不會自動幫我準備（跟「再來一局」不一樣）');
el('btn-ready').click();
foe.say({ type: 'ready', ready: true });
ok(w.until(() => el('btn-start-online').disabled === false, 3000), '兩個人準備好，可以開第三局');
el('btn-start-online').click();
ok(w.until(() => screenNow() === 'game', 3000), '第三局開打');

/* ---------------------------------------------------------- */
group('結算 → 回首頁：座位要放掉、連線要收掉');
ok(w.until(() => el('ov-result').hidden === false, 120000), '第三局跑得出結算');
const leavingId = myId();
el('btn-result-home').click();
w.advance(500);
ok(screenNow() === 'home', '回到首頁', screenNow());
ok(el('ov-result').hidden === true, '首頁不會殘留結算畫面');
ok(el('lobby-home-link').hidden === false && el('btn-back').hidden === true,
  '打完一局回到首頁，左上角也換回「回遊戲大廳」');
ok(mySocket().readyState === 3, '離開線上區域會把連線收掉');
const room1 = theRoom();
ok(!room1 || !room1.members.has(leavingId) || !room1.members.get(leavingId).connected,
  '伺服器那邊的座位放掉了');

/* ---------------------------------------------------------- */
group('連線斷掉：不要留在一間按什麼都沒反應的幽靈房間，但要自己連回去');
/* 斷線的當下一定要先離開房間畫面（重連拿到的是新身分，舊的房間物件已經死了），
 * 以前只有「對局中」才通知，坐在房間裡斷線的人會停在一間死掉的房間畫面上。
 * 但停在大廳也不對：手機切到別的 App（切去貼邀請連結）一定會斷線，
 * 對使用者來說那就是「房間自己關掉了」。伺服器現在會把等人的房間留 60 秒
 * （rooms.js 的 EMPTY_GRACE_MS），客戶端重連之後要自己走回同一間房。 */
goLobby.click();
ok(w.until(() => screenNow() === 'lobby' && mySocket().readyState === 1, 5000), '重新連上大廳');
el('btn-create').click();
ok(w.until(() => screenNow() === 'room', 3000), '又開了一間房', screenNow());
/* theRoom() 是「第一間房」，這時候對手還待在第一局那間，所以要問「我在哪一間」 */
const roomOf = id => [...w.hub.rooms.values()].find(r => r.members.has(id));
const roomBefore = roomOf(myId());
mySocket().close();
ok(el('toast').textContent.indexOf('連線斷了') === 0, '斷線當下有講原因',
  el('toast').textContent);
ok(w.until(() => screenNow() === 'room' && mySocket().readyState === 1, 5000),
  '重連之後自己走回同一間房（不是留在大廳，也不是卡在幽靈房間）', screenNow());
const roomBack = roomOf(myId());
ok(roomBefore && roomBack && roomBack.id === roomBefore.id, '回到的是同一間房',
  roomBefore && roomBack ? roomBefore.id + ' → ' + roomBack.id : '找不到房間');
ok(roomBack && roomBack.hostId === myId(), '而且還是房主，開得了下一局');
ok(roomBack && [...roomBack.members.values()].length === 1,
  '斷線前的舊席位有收掉，房間裡只有回來的這一個人');

/* ---------------------------------------------------------- */
console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n沒過的項目：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
