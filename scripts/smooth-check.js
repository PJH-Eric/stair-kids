/* ===== scripts/smooth-check.js — 線上對戰的畫面順暢度驗收 =====
 *
 * 驗的是「時間相關的機制（interval）在畫面上呈現得正不正常、順不順」：
 *   · 畫面更新率：60Hz、144Hz、30Hz，以及分頁被瀏覽器節流（一次跳 250ms）
 *   · 伺服器的權威迴圈：正常 30Hz，以及 setInterval 被拖慢（100ms 才跑一次）
 *   · 網路：0ms／80ms／200ms＋40ms 抖動
 *
 * 量的不是「規則對不對」，而是「眼睛看到什麼」：直接從假 DOM 讀角色圖層每一格
 * 真正被寫進去的 transform，也就是角色在螢幕上的位置。像素再用角色自己的
 * scale(k) 換回「格」（k = view.scale × PLAYER_W ÷ 100），所以門檻可以直接用
 * 規則核心的速度上限來算，換視窗大小、換難度都不用改測試。
 *
 * 三個指標：
 *   單幀最大位移   一格畫面移動多少；超過「落速＋鏡頭追速」就是瞬移
 *   來回幅度       連續兩幀反向的較小邊；這就是抖動／殘影的大小
 *   大幅來回比例   反向幅度 > 0.15 格的畫格佔比；殘影會讓它爆到六成以上
 *                  （彈簧彈起來也會反向，但那是一局幾次，不會變成比例）
 *
 * 執行：node scripts/smooth-check.js  或  npm run test:smooth
 */
'use strict';

const { boot } = require('./fake-browser.js');
const Rules = require('../public/js/rules.js');

const C = Rules.C;
/* 畫面上一個角色一秒最多能移動幾格：自己的速度上限 ＋ 鏡頭的追隨上限。
 * 掉到最快是 MAX_FALL、彈簧往上是 SPRING_VY，鏡頭最快是 CAMERA_CATCHUP。 */
const MAX_SPEED = Math.max(C.MAX_FALL, C.SPRING_VY) + C.CAMERA_CATCHUP;
const WOBBLE_BIG = 0.15;           /* 「看得出來的抖動」從幾格算起 */

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
/* 從假 DOM 讀角色圖層真正被寫進去的螢幕座標                     */
/* ---------------------------------------------------------- */
function readActors(w) {
  const layer = w.el('actors');
  const out = [];
  for (const g of layer.children) {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.attributes.get('transform') || '');
    if (!m) continue;
    const label = g.children.find(c => c.classes && c.classes.has('actor-name'));
    /* 角色的 inner 是 scale(view.scale × PLAYER_W ÷ 100)，用它把像素換回「格」 */
    const inner = g.children.find(c => c.classes && c.classes.has('actor-kid'));
    const sm = inner ? /scale\(([\d.]+)\)/.exec(inner.attributes.get('transform') || '') : null;
    out.push({
      name: label ? String(label.textContent) : '',
      x: Number(m[1]),
      y: Number(m[2]),
      scale: sm ? Number(sm[1]) * 100 / C.PLAYER_W : 0
    });
  }
  return out;
}

/** 開一局：進大廳 → 開房 → 對手進來 → 兩邊準備 → 開始 */
function startMatch(w, opt) {
  const el = w.el;
  const foe = w.connectFoe();
  const goLobby = w.dom.dataGo.find(b => b.dataset.go === 'lobby');
  goLobby.click();
  if (!w.until(() => el('lobby-status').textContent === '已連線', 6000, opt)) return null;
  el('btn-create').click();
  if (!w.until(() => w.screenNow() === 'room', 6000, opt)) return null;
  foe.say({ type: 'hello', name: '小乙', char: 'mimi' });
  w.advance(200, opt);
  foe.say({ type: 'join', roomId: w.theRoom().id, role: 'player' });
  if (!w.until(() => w.hub.connectedSeats(w.theRoom()).length === 2, 6000, opt)) return null;
  el('btn-ready').click();
  foe.say({ type: 'ready', ready: true });
  if (!w.until(() => el('btn-start-online').disabled === false, 6000, opt)) return null;
  el('btn-start-online').click();
  if (!w.until(() => w.screenNow() === 'game', 6000, opt)) return null;
  return foe;
}

/** 我在伺服器上的名字（角色名牌上就是這個） */
function myName(w) {
  const room = w.theRoom();
  const p = w.socketPerson.get(w.sockets[w.sockets.length - 1]);
  const seat = room && p ? room.members.get(p.id) : null;
  return seat ? seat.name : '';
}

/** 每一格畫面記一次角色位置 */
function sample(w, ms, opt) {
  const frames = [];
  w.advance(ms, Object.assign({}, opt, {
    onFrame: () => frames.push(readActors(w))
  }));
  return frames;
}

const median = list => {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * 一位角色的順暢度指標（單位：格）。
 * 只看畫面上連續存在的區段，中間消失（死掉）就切斷，不會把「消失」算成位移。
 */
function smoothness(frames, name) {
  const deltas = [];
  let last = null;
  for (const actors of frames) {
    const a = actors.find(x => x.name === name);
    if (!a || !a.scale) { last = null; continue; }
    const y = a.y / a.scale;                    /* 像素 → 格 */
    if (last != null) deltas.push(y - last);
    last = y;
  }
  const abs = deltas.map(Math.abs).filter(v => v > 1e-9);
  let max = 0;
  for (const d of abs) if (d > max) max = d;
  let wobble = 0, bigWobbles = 0;
  for (let i = 1; i < deltas.length; i++) {
    if (deltas[i] * deltas[i - 1] >= 0) continue;
    const amp = Math.min(Math.abs(deltas[i]), Math.abs(deltas[i - 1]));
    if (amp > wobble) wobble = amp;
    if (amp > WOBBLE_BIG) bigWobbles++;
  }
  return {
    n: deltas.length,
    med: median(abs),
    max: max,
    wobble: wobble,
    bigRate: deltas.length ? bigWobbles / deltas.length : 0
  };
}

const line = s => '中位數 ' + s.med.toFixed(3) + '、最大 ' + s.max.toFixed(3) +
  '、來回 ' + s.wobble.toFixed(3) + ' 格、大幅來回 ' + (s.bigRate * 100).toFixed(1) + '%';

/** 一格畫面最多可以移動幾格（物理上限，再放 20% 的餘裕） */
const moveBound = frameMs => MAX_SPEED * (frameMs / 1000) * 1.2 + 0.05;

/** 檢查一位角色（自己或對手） */
function checkActor(who, s, frameMs) {
  const bound = moveBound(frameMs);
  ok(s.n > 30, who + '：取樣夠多', s.n + ' 幀');
  ok(s.med > 0, who + '：畫面上真的在動（不是定格）', line(s));
  ok(s.max <= bound, who + '：不會瞬移（單幀位移在物理上限內）',
    line(s) + '，上限 ' + bound.toFixed(3));
  ok(s.wobble <= bound, who + '：沒有一次大到不合理的來回', line(s));
  /* 殘影的本體：修好之前有六成以上的畫格都在來回跳 */
  ok(s.bigRate <= 0.06, who + '：不會一直來回跳（殘影）', line(s));
}

/* ---------------------------------------------------------- */
/* 情境                                                        */
/* ---------------------------------------------------------- */
const CASES = [
  { name: '60Hz 畫面、區網（0ms）', lag: 0, frameMs: 1000 / 60 },
  { name: '60Hz 畫面、80ms 延遲', lag: 80, frameMs: 1000 / 60 },
  { name: '144Hz 畫面、80ms 延遲', lag: 80, frameMs: 1000 / 144 },
  { name: '30Hz 畫面（弱機）、80ms 延遲', lag: 80, frameMs: 1000 / 30 },
  { name: '60Hz 畫面、200ms 延遲＋40ms 抖動', lag: 200, jitter: 40, frameMs: 1000 / 60 },
  { name: '伺服器迴圈被拖慢成 100ms 一次', lag: 80, frameMs: 1000 / 60, serverTickMs: 100 }
];

for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  group('畫面順暢度：' + c.name);
  const opt = { frameMs: c.frameMs, serverTickMs: c.serverTickMs };
  const w = boot({
    lag: c.lag, jitter: c.jitter, seed: 11 + i,
    frameMs: c.frameMs, serverTickMs: c.serverTickMs
  });
  const foe = startMatch(w, opt);
  ok(!!foe, '開得起來，而且進到遊戲畫面', w.screenNow());
  if (!foe) continue;
  const mine = myName(w);

  ok(w.until(() => readActors(w).length === 2, 6000, opt), '兩個角色都畫出來了',
    readActors(w).length + ' 個');

  /* 倒數是 interval 驅動的 UI：3 → 2 → 1 → 收掉 */
  const seen = new Set();
  w.advance(3500, Object.assign({}, opt, {
    onFrame: () => {
      if (!w.el('overlay-countdown').hidden) seen.add(String(w.el('countdown-num').textContent));
    }
  }));
  ok(seen.has('3') && seen.has('2') && seen.has('1'), '倒數 3、2、1 都顯示過',
    [...seen].join('／'));
  ok(w.el('overlay-countdown').hidden === true, '開打之後倒數收掉了');

  /* 正式對戰中取樣 */
  const frames = sample(w, 6000, opt);
  checkActor('自己', smoothness(frames, mine), c.frameMs);
  checkActor('對手', smoothness(frames, '小乙'), c.frameMs);
}

/* ---------------------------------------------------------- */
group('分頁被節流之後回來：畫面要接得回去，不能亂跳');
{
  /* 手機切出去接電話、桌機切到別的分頁，requestAnimationFrame 會被壓到
   * 幾百毫秒才跑一次。回來的時候客戶端要一次補很多步，這裡驗它補完之後
   * 畫面能不能馬上回到順的狀態（而不是瞬移、抖動或直接卡住）。 */
  const opt = { frameMs: 1000 / 60 };
  const w = boot({ lag: 80, seed: 77, frameMs: 1000 / 60 });
  const foe = startMatch(w, opt);
  ok(!!foe, '開得起來');
  const mine = myName(w);
  w.advance(4000, opt);                                  /* 過倒數 */

  const before = smoothness(sample(w, 2000, opt), mine);
  const during = sample(w, 2000, { frameMs: 250, serverTickMs: opt.serverTickMs });
  const after = smoothness(sample(w, 2000, opt), mine);

  ok(during.length >= 6, '節流期間畫面還是有在更新', during.length + ' 幀');
  ok(w.screenNow() === 'game', '節流之後還在遊戲畫面', w.screenNow());
  ok(after.med > 0, '回來之後畫面繼續動', line(after));
  ok(after.max <= moveBound(1000 / 60), '回來之後不會瞬移', line(after));
  ok(after.bigRate <= 0.06, '回來之後不會一直抖', line(after));
  ok(Math.abs(after.med - before.med) <= before.med * 0.8 + 0.02,
    '回來之後的移動速度跟節流前差不多（沒有被時間差扯著跑）',
    before.med.toFixed(3) + ' → ' + after.med.toFixed(3) + ' 格');
}

/* ---------------------------------------------------------- */
/** 水平方向的順暢度（單位：格）。back ＝ 逆著按鍵方向移動的最大一步 */
function horizontal(frames, name, dir) {
  const deltas = [];
  let last = null;
  for (const actors of frames) {
    const a = actors.find(x => x.name === name);
    if (!a || !a.scale) { last = null; continue; }
    const x = a.x / a.scale;
    if (last != null) deltas.push(x - last);
    last = x;
  }
  let max = 0, back = 0, backFrames = 0;
  for (const d of deltas) {
    if (Math.abs(d) > max) max = Math.abs(d);
    const b = -d * dir;
    if (b > 0) { if (b > back) back = b; if (b > 0.05) backFrames++; }
  }
  const abs = deltas.map(Math.abs).filter(v => v > 1e-9);
  return { n: deltas.length, med: median(abs), max: max, back: back, backFrames: backFrames };
}

/** 按住某個方向鍵幾毫秒，回傳這段時間的每一格畫面 */
function holdKey(w, code, ms, opt) {
  w.win.dispatch('keydown', { code: code });
  const frames = sample(w, ms, opt);
  w.win.dispatch('keyup', { code: code });
  return frames;
}

group('按著方向鍵走：畫面上要順順地走，不會被往回拉');
{
  /* 使用者回報「往右移一格會被往左移動一點點」。成因有兩個（都已修）：
   *   · 伺服器一個 tick 只用一個方向，換方向的那一步跟本地預測差最多一整個 tick
   *   · 推擠是拿「延遲 180ms 的對手」在算，跟伺服器結果不同
   * 這裡直接發真的 keydown，量角色在螢幕上有沒有逆著按鍵方向倒退。 */
  const opt = { frameMs: 1000 / 60 };
  const w = boot({ lag: 80, seed: 41, frameMs: 1000 / 60 });
  const foe = startMatch(w, opt);
  ok(!!foe, '開得起來');
  const mine = myName(w);
  w.advance(4000, opt);                                  /* 過倒數 */

  const at = readActors(w);
  const meNow = at.find(a => a.name === mine);
  const foeNow = at.find(a => a.name === '小乙');
  ok(!!meNow && !!foeNow, '兩個角色都在畫面上');
  /* 先往「離對手遠」的方向走，驗單純的移動；再往對手身上走，驗推擠 */
  const awayDir = meNow && foeNow ? (meNow.x >= foeNow.x ? 1 : -1) : 1;
  const key = d => (d > 0 ? 'ArrowRight' : 'ArrowLeft');
  /* 一格畫面最多能走多少：水平速度 ＋ 輸送帶帶動速度 */
  const walkBound = (C.MOVE_SPEED + C.BELT_SPEED) * (1 / 60) * 1.2 + 0.02;

  const away = horizontal(holdKey(w, key(awayDir), 1000, opt), mine, awayDir);
  ok(away.n > 40, '走開這段取樣夠多', away.n + ' 幀');
  ok(away.med > 0, '真的有在走（按鍵有反應）',
    '中位數 ' + away.med.toFixed(3) + ' 格／幀');
  ok(away.max <= walkBound, '走的時候不會瞬移',
    '最大 ' + away.max.toFixed(3) + '，上限 ' + walkBound.toFixed(3));
  ok(away.back <= 0.05, '按著一邊走，畫面上不會往回退',
    '最大回退 ' + away.back.toFixed(4) + ' 格');
  ok(away.backFrames === 0, '完全沒有看得出來的回退', away.backFrames + ' 幀');

  /* 推到對手身上：被推回來是正常的，但不能一直閃、也不能被拉一大段。
   * 同時記下伺服器判定的距離，才分得出「真的擠在一起」與「只是從旁邊掉過去」。 */
  const pushFrames = [];
  const srvGaps = [];
  const pushDirs = [];
  const myPerson = w.socketPerson.get(w.sockets[w.sockets.length - 1]);
  /* 每一格都往對手所在的方向按（對手會跑，固定按一邊常常追不到），
   * 這樣才保證真的擠在一起、量得到重疊。 */
  let held = null;
  w.advance(2500, Object.assign({}, opt, {
    onFrame: () => {
      const actors = readActors(w);
      const me2 = actors.find(x => x.name === mine);
      const foe2 = actors.find(x => x.name === '小乙');
      let dirNow = 0;
      if (me2 && foe2) {
        dirNow = me2.x >= foe2.x ? -1 : 1;
        const want = key(dirNow);
        if (held !== want) {
          if (held) w.win.dispatch('keyup', { code: held });
          w.win.dispatch('keydown', { code: want });
          held = want;
        }
      }
      pushFrames.push(actors);
      pushDirs.push(dirNow);
      const m = w.theRoom() && w.theRoom().match;
      const sm = m && m.players.find(p => p.id === myPerson.id);
      const sf = m && m.players.find(p => p.id !== myPerson.id);
      srvGaps.push(sm && sf ? { dx: Math.abs(sm.x - sf.x), dy: Math.abs(sm.y - sf.y) } : null);
    }
  }));
  if (held) w.win.dispatch('keyup', { code: held });

  /* 推擠時的位移與回退（方向每一格都可能不同，所以自己算） */
  let pushMax = 0, pushBack = 0, pushN = 0, missing = 0;
  for (let i = 1; i < pushFrames.length; i++) {
    if (pushFrames[i].length !== 2) missing++;
    const p = pushFrames[i - 1].find(a => a.name === mine);
    const q = pushFrames[i].find(a => a.name === mine);
    if (!p || !q || !q.scale || pushDirs[i] === 0 || pushDirs[i] !== pushDirs[i - 1]) continue;
    pushN++;
    const d = (q.x - p.x) / q.scale;
    if (Math.abs(d) > pushMax) pushMax = Math.abs(d);
    const back = -d * pushDirs[i];
    if (back > pushBack) pushBack = back;
  }
  ok(pushN > 80, '推擠這段取樣夠多', pushN + ' 幀');
  ok(missing === 0, '推擠的時候兩個角色都一直在畫面上（不會閃掉）',
    missing + ' 幀少了角色');
  ok(pushMax <= walkBound + 0.15, '推擠的時候不會瞬移',
    '最大 ' + pushMax.toFixed(3) + ' 格');
  ok(pushBack <= 0.15, '推擠的時候不會被拉一大段回去（修好前 0.57 格）',
    '最大回退 ' + pushBack.toFixed(4) + ' 格');

  /* 放開按鍵之後不能再滑（剛推完最容易抓到：那時候通常還有校正在補）。校正的視覺補正如果在「站著不動」的時候抹掉，
   * 角色就會自己走幾像素 —— 那就是使用者說的「滑動」（見 net.js 的 IDLE_SMOOTH_RATE）。 */
  const idleFrames = sample(w, 400, opt);
  const idle = horizontal(idleFrames, mine, awayDir);
  let idleMove = 0;
  for (let i = 1; i < idleFrames.length; i++) {
    const p = idleFrames[i - 1].find(a => a.name === mine);
    const q = idleFrames[i].find(a => a.name === mine);
    if (!p || !q || !q.scale) continue;
    idleMove += Math.abs(q.x - p.x) / q.scale;
  }
  ok(idle.n > 15, '放手後這段取樣夠多', idle.n + ' 幀');
  ok(idleMove <= 0.05, '放開按鍵之後就停住，不會再滑（修好前會滑 0.13 格）',
    '400ms 內總共移動 ' + idleMove.toFixed(4) + ' 格');

  /* 推擠時畫面上不能重疊。伺服器上的間距永遠 >= 身寬（resolvePush 會分開），
   * 但對手刻意畫在 100ms 前，所以「剛好貼著」在畫面上會疊進去半個身體
   * （實測 0.65 格 ＝ 身寬的 52%）。net.js 的 contactWeight 就是在修這個。
   * 判斷「真的擠在一起」要用伺服器的距離：畫面上的高度差是延遲後的值，
   * 一個人從另一個人身邊掉過去時，物理上早就錯開了，那不算推擠。 */
  let sideBySide = 0, sideWorst = 0, touchFrames = 0, worstOverlap = 0, overlapFrames = 0;
  for (let i = 0; i < pushFrames.length; i++) {
    const actors = pushFrames[i];
    const srv = srvGaps[i];
    const m = actors.find(a => a.name === mine);
    const f = actors.find(a => a.name === '小乙');
    if (!m || !f || !m.scale || !srv) continue;
    /* 伺服器判定「高度有交疊、而且貼在一起」＝ 真的在推擠 */
    if (srv.dy >= C.PLAYER_H || srv.dx > C.PLAYER_W + 0.05) continue;
    touchFrames++;
    const over = C.PLAYER_W - Math.abs(m.x - f.x) / m.scale;
    if (over > 0.02) { overlapFrames++; if (over > worstOverlap) worstOverlap = over; }
    /* 「肩並肩硬推」：畫面上的高度差也很小。這是使用者說的那個情況，重疊要是 0。
     * 另一種是「從對方旁邊掉下去」：對手的垂直位置是延遲值、本地預測又超前，
     * 兩邊對高度的看法差到一個身高，那幾幀還會殘留一點重疊（見 net.js 的註解）。 */
    if (Math.abs(m.y - f.y) / m.scale < C.PLAYER_H * 0.5) {
      sideBySide++;
      if (over > sideWorst) sideWorst = over;
    }
  }
  ok(touchFrames > 20, '真的有在推擠（伺服器判定兩人貼在一起）', touchFrames + ' 幀');
  ok(sideBySide > 10, '其中有肩並肩硬推的畫格', sideBySide + ' 幀');
  ok(sideWorst <= 0.05, '肩並肩硬推的時候完全不重疊（修好前疊進去 0.65 格）',
    '最大 ' + sideWorst.toFixed(3) + ' 格');
  ok(worstOverlap <= 0.35, '從旁邊掉過去那幾幀也只剩一點點（修好前 0.65 格）',
    overlapFrames + '／' + touchFrames + ' 幀，最大 ' + worstOverlap.toFixed(3) +
    ' 格（身寬 ' + C.PLAYER_W + ' 格）');
}

/* ---------------------------------------------------------- */
group('結算畫面只會出現一次（不會閃）');
{
  const opt = { frameMs: 1000 / 60 };
  const w = boot({ lag: 80, seed: 5, frameMs: 1000 / 60 });
  const foe = startMatch(w, opt);
  ok(!!foe, '開得起來');
  let flips = 0;
  let last = w.el('ov-result').hidden;
  const done = w.until(() => {
    const now = w.el('ov-result').hidden;
    if (now !== last) { flips++; last = now; }
    return now === false;
  }, 120000, opt);
  ok(done, '兩個人都死了之後跑出結算');
  w.advance(2000, opt);
  ok(flips === 1, '結算只被打開一次（沒有先關再開的閃動）', flips + ' 次');
  ok(w.el('ov-result').hidden === false, '結算會停在畫面上，不會自己閃掉');
  ok(w.el('actors').children.length === 0, '結算時沒有殘留的角色');
}

/* ---------------------------------------------------------- */
console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n沒過的項目：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
