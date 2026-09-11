/* ===== scripts/netcode-check.js — 線上同步驗收（可以指定延遲）=====
 *
 * 不開網路，直接把「伺服器（lib/rooms + match-loop + protocol）」跟
 * 「客戶端（public/js/net.js）」用一條假網路接起來，時鐘也是假的，
 * 所以同樣的一局在 0ms 與 80ms 延遲下都可以重播、可以量誤差。
 *
 * 執行：
 *   node scripts/netcode-check.js            （預設同時驗 0ms 與 80ms）
 *   node scripts/netcode-check.js --lag=80   （只驗 80ms，M2 驗收條件）
 *   node scripts/netcode-check.js --lag=200 --jitter=40 --loss=0.03
 */
'use strict';

const { createHub } = require('../lib/rooms.js');
const { createLoop } = require('../lib/match-loop.js');
const { createProtocol } = require('../lib/protocol.js');
const Net = require('../public/js/net.js');
const Rules = require('../public/js/rules.js');
const Ai = require('../public/js/ai.js');

const STEP_MS = Rules.STEP_MS;

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
function group(t) { console.log('\n' + t); }

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.indexOf('--' + name + '=') === 0);
  return hit ? Number(hit.split('=')[1]) : dflt;
};

/* ---------------------------------------------------------- */
/* 假網路：單向延遲 = lag/2，所以 rtt 就是 lag                   */
/* ---------------------------------------------------------- */

function createWorld(cfg) {
  cfg = cfg || {};
  const lag = cfg.lag || 0;
  const jitter = cfg.jitter || 0;
  const loss = cfg.loss || 0;
  const seedRng = mulberry(cfg.seed == null ? 12345 : cfg.seed);

  let T = 0;                       /* 假時鐘（毫秒） */
  const now = () => T;
  const queue = [];                /* { at, run } */

  function later(fn) {
    let d = lag / 2;
    if (jitter) d += (seedRng() - 0.5) * jitter;
    if (d < 0) d = 0;
    queue.push({ at: T + d, run: fn });
  }
  function maybeDrop() { return loss > 0 && seedRng() < loss; }

  /* --- 伺服器 --- */
  const clients = new Map();       /* personId → client */
  const io = {
    send(personId, msg) {
      const c = clients.get(personId);
      if (!c) return;
      if (msg.type !== 'snap' && msg.type !== 'hb' ? false : maybeDrop()) return;  /* 只讓快照／心跳會掉 */
      const copy = JSON.parse(JSON.stringify(msg));
      later(() => c.receive(copy));
    },
    lobbyIds() {
      const out = [];
      for (const [id, c] of clients) if (!c.state.room) out.push(id);
      return out;
    }
  };
  /* 樓梯 seed 固定下來，同一組參數每次跑出同一局，才有辦法比較不同延遲 */
  let matchNo = 0;
  const hub = createHub({ now: now, newSeed: () => 'netcheck-' + (cfg.seed == null ? 0 : cfg.seed) + '-' + (++matchNo) });
  const loop = createLoop(hub, io, { now: now });
  const proto = createProtocol(hub, loop, io);

  /* --- 客戶端 --- */
  let seq = 0;
  function connect(name, char, opt) {
    const person = { id: 'p' + (++seq), name: name, char: char || 'yuan', roomId: null, role: null };
    const client = Net.createClient(Object.assign({
      now: now, name: name, char: char,
      send(msg) {
        const copy = JSON.parse(JSON.stringify(msg));
        later(() => proto.handle(person, copy));
      }
    }, opt || {}));
    client.state.me.id = person.id;
    clients.set(person.id, client);
    client.person = person;
    client.hello();
    return client;
  }

  function disconnect(client) {
    clients.delete(client.person.id);
    hub.markDisconnected(client.person.id);
  }

  /**
   * 推進 ms 毫秒。預設每 1/60 秒一格（正常的畫面更新率），
   * frameMs 可以改成 8.33（144Hz）或 250（分頁被瀏覽器節流）來驗時間相關的機制。
   */
  function advance(ms, onFrame, frameMs) {
    const end = T + ms;
    const step = frameMs || STEP_MS;
    while (T < end) {
      T += step;
      /* 送達的封包 */
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].at <= T) { const it = queue.splice(i, 1)[0]; i--; it.run(); }
      }
      loop.frame(T);
      for (const c of clients.values()) c.frame(T, undefined);
      if (onFrame) onFrame(T);
    }
  }

  return { hub, loop, proto, io, connect, disconnect, advance, now: () => T, clients };
}

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** 幫兩個客戶端開一局（房主 A、對手 B），回傳世界 */
function startedMatch(cfg) {
  const w = createWorld(cfg);
  const a = w.connect('甲', 'yuan');
  const b = w.connect('乙', 'mimi');
  w.advance(400);
  a.actions.create('測試房', (cfg && cfg.difficulty) || 'normal');
  w.advance(400);
  b.actions.join(a.state.room.id, 'player');
  w.advance(400);
  a.actions.ready(true);
  b.actions.ready(true);
  w.advance(400);
  a.actions.start();
  w.advance(400);
  return { w, a, b };
}

/** 讓客戶端用 AI 的判斷來按方向鍵（照它自己看到的畫面判斷，不作弊） */
function drive(client, level, seed) {
  const brain = Ai.create(level, client.state.me.id, seed);
  return function () {
    const m = client.match;
    if (!m) return;
    client.setDir(brain.read(m, Rules.STEP).dir);
  };
}

/* ---------------------------------------------------------- */
group('連線、大廳、開房（走完整協定）');
{
  const w = createWorld({ lag: 80 });
  const a = w.connect('甲');
  w.advance(500);
  ok(a.state.server && a.state.me.id, '連上以後拿到 welcome 與自己的 id');
  ok(Array.isArray(a.state.rooms) && a.state.rooms.length === 0, '一開始大廳沒有房間');

  a.actions.create('甲的房', 'normal');
  w.advance(500);
  ok(a.state.room && a.state.room.isHost, '開房的人是房主');
  ok(a.state.room.youAre === 'player', '房主自己是玩家');

  const b = w.connect('乙');
  w.advance(500);
  ok(b.state.rooms.length === 1, '第二個人在大廳看得到這間房');
  ok(b.state.rooms[0].players === 1, '房間列表顯示 1 人');

  b.actions.join(a.state.room.id, 'player');
  w.advance(500);
  ok(b.state.room && b.state.room.youAre === 'player', '第二個人坐上席位');
  ok(a.state.room.members.length === 2, '房主也看到房間變成兩個人');

  const c = w.connect('丙');
  w.advance(300);
  c.actions.join(a.state.room.id, 'player');
  w.advance(500);
  ok(c.state.room.youAre === 'spectator', '席位滿了自動轉觀戰');

  a.actions.ready(true);
  w.advance(300);
  ok(!a.state.room.canStart, '只有一個人準備好還不能開始');
  b.actions.ready(true);
  w.advance(300);
  ok(a.state.room.canStart, '兩個人都準備好，房主可以開始');

  a.actions.start();
  w.advance(300);
  ok(a.match && b.match && c.match, '三個人（含觀戰）都收到完整快照、建好本地鏡像');
  ok(a.match.seed === b.match.seed, '兩邊的樓梯 seed 一樣');
  ok(a.match.steps.length > 0 && a.match.steps[0].id === b.match.steps[0].id,
    '兩邊算出同一座樓梯（不必靠網路傳整座）');
}

/* ---------------------------------------------------------- */
group('邀請連結：確認暱稱後才加入');
{
  const w = createWorld({ lag: 0 });
  const host = w.connect('房主');
  w.advance(300);
  host.actions.create('邀請測試房', 'normal');
  w.advance(300);
  host.actions.invite();
  w.advance(300);
  const token = host.state.room && host.state.room.invite;
  const guest = w.connect('裝置上的舊暱稱');
  w.advance(300);
  guest.actions.useInvite(token, '被邀請的新暱稱');
  w.advance(300);
  const guestMember = guest.state.room && guest.state.room.members.find(m => m.id === guest.state.me.id);
  const hostMember = host.state.room && host.state.room.members.find(m => m.id === guest.state.me.id);
  ok(!!token, '房主可以產生邀請 token');
  ok(guestMember && guestMember.name === '被邀請的新暱稱', '邀請確認後以新暱稱加入房間');
  ok(hostMember && hostMember.name === '被邀請的新暱稱', '房內其他人即時看到邀請者的新暱稱');
}

/* ---------------------------------------------------------- */
group('客戶端只送輸入意圖（改前端也作弊不了）');
{
  const w = createWorld({ lag: 0 });
  const sent = [];
  const a = w.connect('甲');
  const realSend = a.state;
  const b = w.connect('乙');
  w.advance(300);
  a.actions.create('房', 'normal');
  w.advance(300);
  b.actions.join(a.state.room.id, 'player');
  w.advance(300);
  a.actions.ready(true); b.actions.ready(true);
  w.advance(300);
  a.actions.start();
  w.advance(300);

  /* 直接檢查協定：塞座標進來，伺服器要完全不理 */
  const room = [...w.hub.rooms.values()][0];
  const me = room.match.players.find(p => p.id === a.state.me.id);
  const beforeX = me.x;
  w.proto.handle(a.person, { type: 'input', seq: 999, dir: 0, x: 99, y: -50, hp: 99 });
  w.advance(100);
  ok(me.hp <= room.match.players[0].hpMax, '送 hp 過去不會被採用');
  ok(Math.abs(me.x - beforeX) < 3, '送座標過去不會被採用（位置只由伺服器算）');
}

/* ---------------------------------------------------------- */
/* 主戲：不同延遲下的預測校正誤差                                */
/* ---------------------------------------------------------- */

function measure(cfg, seconds) {
  const { w, a, b } = startedMatch(cfg);
  const driveA = drive(a, 'normal', 'A');
  const driveB = drive(b, 'hard', 'B');
  const room = [...w.hub.rooms.values()][0];

  /* 預測誤差要「拿同一個對局時間」來比：客戶端故意超前跑，
   * 直接拿雙方的當下比，量到的是超前量，不是誤差。 */
  const key = t => Math.round(t / Rules.STEP);
  const guess = new Map();          /* 對局時間 → 客戶端當時預測的位置 */
  let n = 0, sum = 0, max = 0;
  const errs = [];
  let camN = 0, camSum = 0, camMax = 0;
  let frames = 0;

  w.advance(seconds * 1000, () => {
    driveA(); driveB();
    frames++;
    if (!a.match || !room.match) return;
    const cp = a.match.players.find(p => p.id === a.state.me.id);
    if (cp) guess.set(key(a.match.time), { x: cp.x, y: cp.y, cam: a.match.cameraTop });

    const sk = key(room.match.time);
    const rec = guess.get(sk);
    if (rec) {
      const sp = room.match.players.find(p => p.id === a.state.me.id);
      if (sp) {
        const e = Math.hypot(rec.x - sp.x, rec.y - sp.y);
        sum += e; n++;
        errs.push(e);
        if (e > max) max = e;
      }
      const ce = Math.abs(rec.cam - room.match.cameraTop);
      camSum += ce; camN++;
      if (ce > camMax) camMax = ce;
      guess.delete(sk);
    }
    if (guess.size > 400) for (const k of guess.keys()) if (k < sk - 400) guess.delete(k);
  });

  return {
    w, a, b, room, frames, samples: n,
    pred: {
      avg: sum / Math.max(1, n), max: max,
      p95: errs.length ? errs.slice().sort((x, y) => x - y)[Math.floor(errs.length * 0.95)] : 0,
      p99: errs.length ? errs.slice().sort((x, y) => x - y)[Math.floor(errs.length * 0.99)] : 0,
      big: errs.filter(e => e > 1.0).length
    },
    cam: { avg: camSum / Math.max(1, camN), max: camMax },
    stats: a.stats()
  };
}

const onlyLag = arg('lag', null);
const jitter = arg('jitter', 0);
const loss = arg('loss', 0);
const lags = onlyLag == null ? [0, 80] : [onlyLag];

for (const lag of lags) {
  const label = lag + 'ms 延遲' + (jitter ? '、±' + jitter + 'ms 抖動' : '') + (loss ? '、' + Math.round(loss * 100) + '% 丟包' : '');
  group('預測與校正（' + label + '）');
  const m = measure({ lag: lag, jitter: jitter, loss: loss, seed: 7 }, 12);

  console.log('    量到：同一時間點的預測誤差 平均 ' + m.pred.avg.toFixed(4) + ' 格／最大 ' + m.pred.max.toFixed(3) +
    ' 格；鏡頭誤差 平均 ' + m.cam.avg.toFixed(5) + ' 格；本地超前 ' + m.stats.aheadMs + 'ms（目標 ' + m.a.state.leadMs + 'ms）；' +
    '校正 ' + m.stats.corrections + ' 次、重演平均 ' + m.stats.replayStepsAvg + ' 步；rtt 量到 ' + m.stats.rtt + 'ms');

  ok(m.samples > 300, '有取到足夠的比對樣本', m.samples + ' 格');
  /* 剩下的誤差來自「輸入生效的時間點」：伺服器是 30Hz tick 邊界才吃到新方向，
   * 客戶端是 60Hz 每一步就吃到，最多差半個 tick ＝ 0.2 格的走路距離。
   * 要壓到 0 得在伺服器端做「按 ct 時間戳回溯套用輸入」，對這個遊戲不值得。
   *
   * 門檻一律寫成「角色寬度的幾成」而不是固定格數 —— 玩家看得出來的是
   * 「偏了半個身體」還是「偏了一點點」，角色尺寸調整時這個標準才不會失效。 */
  const PW = Rules.C.PLAYER_W;
  ok(m.pred.avg < 0.12 * PW, '同一個對局時間下，預測跟伺服器幾乎一樣（平均 < 角色寬的 12%）',
    '平均 ' + m.pred.avg.toFixed(4) + ' 格＝角色寬的 ' + (m.pred.avg / PW * 100).toFixed(1) + '%');
  /* 偶爾會有一次比較大的落差：客戶端以為踩到了、伺服器判定沒踩到（或反過來），
   * 這時候差的就是一段掉落距離。要看的是「多不多」跟「會不會硬歸位」，不是最大值。 */
  ok(m.pred.p95 < 0.6 * PW, '95% 的畫面誤差不到半個身體寬',
    'p95 = ' + m.pred.p95.toFixed(3) + ' 格＝角色寬的 ' + (m.pred.p95 / PW * 100).toFixed(0) + '%');
  ok(m.pred.p99 < 1.2 * PW, '99% 的畫面誤差在一個身體寬左右',
    'p99 = ' + m.pred.p99.toFixed(3) + ' 格＝角色寬的 ' + (m.pred.p99 / PW * 100).toFixed(0) + '%');
  ok(m.pred.big / m.samples < 0.015, '超過 1 格的落差不到 1.5%（判定踩到／沒踩到不一致的那幾格）',
    m.pred.big + '/' + m.samples + ' 格；最大 ' + m.pred.max.toFixed(2) + ' 格');
  ok(m.cam.avg < 0.01, '鏡頭完全跟著伺服器（樓梯與天花板不會錯位）', '平均差 ' + m.cam.avg.toFixed(5) + ' 格');
  ok(m.stats.hardSnaps === 0, '不需要硬歸位（校正都在平滑範圍內）');
  ok(m.stats.snaps > 250, '12 秒內收到足夠的快照（30Hz）', m.stats.snaps + ' 份');
  ok(m.stats.errAvg < 0.15, '每次校正要搬動的距離很小（回溯重演有效）',
    '平均 ' + m.stats.errAvg.toFixed(4) + ' 格／最大 ' + m.stats.errMax.toFixed(3) + ' 格');

  /* 本地要超前「單向延遲 ＋ 一個 tick ＋ 邊際」；量到的數字還會加上這份快照本身的
   * 年紀（伺服器算完到送出最多一個 tick），所以上限放寬到再多三個 tick。 */
  const oneWay = lag / 2;
  ok(m.stats.aheadMs >= oneWay - 5 && m.stats.aheadMs <= oneWay + 4000 / m.w.loop.hz + 40,
    '本地模擬超前的量對得上延遲（單向 ' + Math.round(oneWay) + 'ms ＋ 緩衝）',
    '量到 ' + m.stats.aheadMs + 'ms');

  /* 樓梯與血量必須完全一致（這些是純權威資料，不允許有誤差） */
  /* 客戶端故意超前跑，所以它手上會多幾層還沒被伺服器算到的新樓梯；
   * 要驗的是「重疊的那一段完全一樣」，這才代表兩邊真的算出同一座樓梯。 */
  const cs = m.a.match, ss = m.room.match;
  const cMap = new Map(cs.steps.map(s => [s.id, s]));
  const lo = cs.steps[0].depth, hi = cs.steps[cs.steps.length - 1].depth;
  const shared = ss.steps.filter(s => s.depth >= lo && s.depth <= hi);
  const same = shared.every(s => {
    const c = cMap.get(s.id);
    return c && c.x0 === s.x0 && c.x1 === s.x1 && c.kind === s.kind && c.depth === s.depth;
  });
  ok(shared.length > 20 && same, '重疊範圍內的樓梯跟伺服器完全一樣（同一個 seed 各自算）',
    '比對了 ' + shared.length + ' 層');
  /* 生死一定要一致 —— 畫面靠它決定角色還在不在，不一致就會閃。 */
  const aliveSame = cs.players.every(p => {
    const q = ss.players.find(x => x.id === p.id);
    return q && q.alive === p.alive;
  });
  ok(aliveSame, '生死狀態完全一致（畫面才不會閃）');
  /* 血量會因為本地預測而暫時領先幾十毫秒（自己踩到刺馬上就扣，手感才對），
   * 所以不能要求每一格都相同。真正要驗的是「客戶端說了不算」：
   * 前端亂改血量，下一份快照就會把它蓋回伺服器的值。 */
  cs.players[0].hp = 99;
  m.w.advance(300);
  const nowHp = cs.players[0].hp;
  const srvHp = m.room.match.players[0].hp;
  /* 收到下一份快照就會被蓋回去。之後本地預測可能又先扣了一下（超前 100ms 左右），
   * 所以只能要求「亂改的值不見了、而且跟伺服器只差在預測的那一點」。 */
  ok(nowHp !== 99 && Math.abs(nowHp - srvHp) <= 2,
    '前端亂改血量會被下一份快照蓋回去（血量不由客戶端決定）',
    '99 → ' + nowHp + '（伺服器 ' + srvHp + '）');
  ok(cs.world === ss.world, '世界主題一致');
}

/* ---------------------------------------------------------- */
group('按下去就動（不等封包來回）');
{
  const { w, a } = startedMatch({ lag: 200 });
  /* 先把倒數跑完 */
  w.advance(4000);
  const me = () => a.match.players.find(p => p.id === a.state.me.id);
  const x0 = me().x;
  a.setDir(1);
  w.advance(100);                       /* 只過 100ms，封包還在路上（rtt 200ms） */
  /* 走路速度 6 格/秒 → 100ms 應該走 0.6 格；打了折還是要看得出來在走 */
  ok(me().x > x0 + 0.45, '按右邊 100ms 後本地就往右了（200ms 延遲也一樣）',
    '移動了 ' + (me().x - x0).toFixed(2) + ' 格');
}

/* ---------------------------------------------------------- */
group('對手的動作是平順的（內插，不是一格一格跳）');
{
  /* 對手有兩個位置（見 net.js 的 applyRemoteInterpolation）：
   *   viewX／viewY 是畫面用的，照快照時間軸內插 → 要平順
   *   x／y 是邏輯用的推測位置，推擠判定用 → 會被校正拉動，本來就不平順
   * 所以這裡量的是 viewX。 */
  const { w, a, b } = startedMatch({ lag: 80, jitter: 30, seed: 3 });
  const driveB = drive(b, 'hard', 'B');
  w.advance(4000, driveB);
  const foeId = b.state.me.id;
  let jumps = 0, samples = 0, prev = null;
  w.advance(4000, () => {
    driveB();
    const foe = a.match.players.find(p => p.id === foeId);
    if (!foe || foe.viewX == null) return;
    if (prev != null) {
      samples++;
      /* 一格畫面（1/60 秒）最多走 6/60 = 0.1 格；抓明顯瞬移 */
      if (Math.abs(foe.viewX - prev) > 0.35) jumps++;
    }
    prev = foe.viewX;
  });
  ok(samples > 200, '有取到足夠的樣本', samples + ' 格');
  ok(jumps / samples < 0.02, '對手幾乎不會瞬移（內插有效）',
    jumps + '/' + samples + ' 格超標');
}

/* ---------------------------------------------------------- */
group('斷線判輸與結算（走完整協定）');
{
  const { w, a, b } = startedMatch({ lag: 80 });
  const driveA = drive(a, 'hard', 'A');
  w.advance(4000, driveA);
  w.disconnect(b);
  w.advance(1000, driveA);
  const room = [...w.hub.rooms.values()][0];
  const pb = room.match.players.find(p => p.id === b.state.me.id);
  ok(pb && !pb.alive && pb.forfeit, '斷線的人立刻判輸');
  ok(room.phase === 'playing', '對手還活著，這局繼續（兩個人都死才結算）');
  ok(a.match.players.find(p => p.id === b.state.me.id).forfeit === true,
    '還在線上的人也看到對手判輸了');

  /* 讓剩下的人也結束：直接叫伺服器收局 */
  Rules.endMatch(room.match, 'dead');
  w.advance(500, driveA);
  ok(a.state.result, '剩下的人收到結算');
  ok(a.state.result.players.length === 2, '結算包含兩個人');
  ok(a.state.result.players.some(p => p.forfeit), '結算標明誰是斷線判輸');
  const winner = a.state.result.winner;
  ok(winner === a.state.me.id || a.state.result.draw, '沒斷線的人贏（或平手）');

  /* 結算停留結束 → 回房間 */
  w.advance(11000);
  ok(a.state.room && a.state.room.phase === 'lobby', '結算停留結束會自動回房間');
  ok(a.state.room.members.every(m => !m.ready), '回房間後準備狀態被清掉，要重新按');
}

/* ---------------------------------------------------------- */
group('聊天與觀戰（M3 會用到的通道先驗一下）');
{
  const { w, a, b } = startedMatch({ lag: 80 });
  a.actions.chat('一起加油！');
  w.advance(500);
  const line = b.state.room.chat.find(l => l.text === '一起加油！');
  ok(!!line && line.who === '甲', '對手收到聊天訊息，看得到是誰說的');
  const long = 'あ'.repeat(200);
  a.actions.chat(long);
  w.advance(500);
  const cut = b.state.room.chat[b.state.room.chat.length - 1];
  ok(cut.text.length <= 60, '太長的訊息會被截到 60 字');

  const c = w.connect('丙');
  w.advance(300);
  c.actions.join(a.state.room.id, 'spectator');
  w.advance(500);
  ok(c.match, '對局中進來觀戰，馬上拿到完整快照');
  ok(c.state.room.youAre === 'spectator', '身分是觀戰');
  ok(!!c.match.players.find(p => p.id === a.state.me.id), '觀戰者看得到兩個人');
}

/* ---------------------------------------------------------- */
group('心跳不能誤判（實測真的被誤判過）');
{
  /* 曾經發生的事：一局打完之後，還開著的分頁被判定斷線，整間房就被關掉了。
   * 原因是只認應用層的心跳訊息 —— 分頁被瀏覽器節流、或這一格畫得比較久，
   * JS 晚幾秒才回話就會被當成斷線。現在改成「收到任何訊息都算活著」。 */
  const w = createWorld({ lag: 40 });
  const a = w.connect('甲');
  w.advance(400);
  a.actions.create('心跳房', 'normal');
  w.advance(400);
  const room = [...w.hub.rooms.values()][0];
  const me = room.members.get(a.person.id);

  /* 攔掉 hb 的自動回覆，只讓它送別的訊息（模擬 JS 忙到來不及回心跳） */
  const realReceive = a.receive;
  a.receive = msg => { if (msg && msg.type === 'hb') return; realReceive(msg); };
  for (let i = 0; i < 6; i++) {
    w.proto.handle(a.person, { type: 'chat', text: '還在喔' });
    w.loop.heartbeatRound();
  }
  ok(me.connected, '完全沒回心跳、但一直有送別的訊息（聊天）→ 不會被判定斷線');
  ok(w.hub.rooms.has(room.id), '房間也不會被誤關');

  /* 對照組：真的什麼都不送就該判定斷線 */
  for (let i = 0; i < 4; i++) w.loop.heartbeatRound();
  ok(!me.connected, '完全沒有任何訊息才判定斷線');
}

/* ---------------------------------------------------------- */
group('對手在移動的時候不能有殘影（實測真的看到過）');
{
  /* 曾經發生的事：雙人對戰時，對手的角色一移動就有殘影。
   * 原因不在繪圖，而在「兩套時間軸被混在一起」：
   *   · 對手的位置是 net.js 依「快照時間軸」內插出來的，刻意畫在 100ms 前（RENDER_DELAY）
   *   · app.js 的畫面內插用的「上一格」卻是「本地預測時間軸」上、回溯重演之後的超前位置
   * 兩者差了大約 100ms ＋ 單向延遲，拿去 lerp 就會讓對手每一幀在
   * 「超前位置」與「延遲位置」之間來回跳 —— 眼睛看到的就是殘影。
   * 所以對手只能直接畫 net.js 算好的位置（app.js 那一層固定步長內插只給本地預測的自己）。
   *
   * 這一項量的是「對手在螢幕上的垂直位移有沒有反覆換方向、來回多大」。 */
  const prev = { cameraTop: 0, players: {}, ready: false };
  function snapshotPrev(s) {
    prev.cameraTop = s.cameraTop;
    for (const p of s.players) {
      let e = prev.players[p.id];
      if (!e) e = prev.players[p.id] = { x: p.x, y: p.y };
      e.x = p.x; e.y = p.y;
    }
    prev.ready = true;
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  const w = createWorld({ lag: 80, seed: 7 });
  const a = w.connect('甲', 'yuan', { beforeStep: snapshotPrev });
  const b = w.connect('乙', 'mimi');
  w.advance(400);
  a.actions.create('殘影房', 'normal');
  w.advance(400);
  b.actions.join(a.state.room.id, 'player');
  w.advance(400);
  a.actions.ready(true);
  b.actions.ready(true);
  w.advance(400);
  a.actions.start();
  w.advance(400);

  const meId = a.state.me.id;
  const brainA = Ai.create('normal', meId, 3);
  const brainB = Ai.create('hard', b.state.me.id, 9);
  /* mixed＝拿對手的「邏輯位置」（本地預測時間軸）去畫，也就是會有殘影的舊做法；
   * pure ＝拿 net.js 內插好的「畫面位置」viewY 來畫，也就是現在的做法。 */
  const track = { mixed: [], pure: [] };

  w.advance(6000, () => {
    if (a.match) a.setDir(brainA.read(a.match, Rules.STEP).dir);
    if (b.match) b.setDir(brainB.read(b.match, Rules.STEP).dir);
    const m = a.match;
    if (!m || m.phase !== 'playing' || !prev.ready) return;
    const opp = m.players.find(p => p.id !== meId);
    const e = opp && prev.players[opp.id];
    if (!e) return;
    const t = a.alpha();
    /* 螢幕上的位置＝世界座標減掉鏡頭（鏡頭是本地固定步長推的，照樣內插） */
    const cam = lerp(prev.cameraTop, m.cameraTop, t);
    if (opp.viewY == null) return;
    track.mixed.push(opp.y - opp.viewY);        /* 邏輯位置比畫面位置深多少 */
    track.pure.push(opp.viewY - cam);
  });

  const lagBehind = track.mixed.length
    ? track.mixed.reduce((s, v) => s + v, 0) / track.mixed.length : 0;

  /** 反覆換方向時的最大來回幅度（格）：越大越像殘影 */
  function wobble(list) {
    let max = 0;
    for (let i = 2; i < list.length; i++) {
      const d1 = list[i - 1] - list[i - 2];
      const d2 = list[i] - list[i - 1];
      if (d1 * d2 < 0) max = Math.max(max, Math.min(Math.abs(d1), Math.abs(d2)));
    }
    return max;
  }
  const pure = wobble(track.pure);
  ok(track.pure.length > 120, '對局有跑起來，量到足夠的畫格', track.pure.length + ' 幀');
  ok(pure < 0.2, '畫面位置（viewY）平順，對手不會來回跳', '來回 ' + pure.toFixed(3) + ' 格');
  /* 兩個位置要真的分開存在：畫面位置刻意落後（RENDER_DELAY ＋ 本地超前量），
   * 所以「邏輯位置」一定比它深。分不開就代表 app.js 又拿邏輯位置去畫了。 */
  ok(lagBehind > 0.2 && lagBehind < 4,
    '畫面位置確實落後邏輯位置（兩個位置沒有被混在一起）',
    '平均落後 ' + lagBehind.toFixed(3) + ' 格');
}

/* ---------------------------------------------------------- */
group('站到會消失的平面上：假階的引信不能自己燒快（實測會跳動）');
{
  /* 曾經發生的事：站到會消失的平面（假階）上，消失的那一刻人物跟平面會不正常跳動。
   * 原因是 apply() 只更新伺服器點名的那幾階：
   *   本地預測比伺服器超前 100ms 左右，會先踩上假階、先把 0.25 秒的引信點著；
   *   這時伺服器還沒踩到，dirty 清單裡當然沒有它，引信就不會被回捲；
   *   而回溯重演是「從快照時間點重跑到現在」，每收一份快照都把同一段時間再扣一次
   *   （平均 6.75 步／份 × 30 份／秒），引信等於四倍速在燒。
   * 假階因此比伺服器早碎，人先掉下去、下一份快照又被拉回階梯上，
   * 一來一回誤差量到 2.35 格。現在 dirty 當成完整真相，引信只會被扣一次。 */
  const w = createWorld({ lag: 80, seed: 11 });
  const a = w.connect('甲', 'yuan');
  const b = w.connect('乙', 'mimi');
  w.advance(400);
  a.actions.create('假階房', 'normal');
  w.advance(400);
  b.actions.join(a.state.room.id, 'player');
  w.advance(400);
  a.actions.ready(true);
  b.actions.ready(true);
  w.advance(400);
  a.actions.start();
  w.advance(400);

  const room = [...w.hub.rooms.values()][0];
  const driveA = drive(a, 'hard', 3);
  const driveB = drive(b, 'normal', 9);
  const srvBreak = new Map(), cliBreak = new Map();
  let camBack = 0, lastCam = null, lastMatch = null;

  w.advance(20000, () => {
    driveA();
    driveB();
    if (room.match) {
      for (const st of room.match.steps) {
        if (st.broken && !srvBreak.has(st.id)) srvBreak.set(st.id, room.match.time);
      }
    }
    const m = a.match;
    if (!m) return;
    for (const st of m.steps) {
      if (st.broken && !cliBreak.has(st.id)) cliBreak.set(st.id, m.time);
    }
    /* 收到完整快照時鏡像是新的物件，鏡頭要重新起算 */
    if (m !== lastMatch) { lastMatch = m; lastCam = null; }
    /* 快照把 cameraTop 四捨五入到小數第 4 位（rooms.js 的 toFixed(4)），
     * 所以容許那個量級的回退，真正要抓的是「看得出來」的回捲。 */
    if (lastCam != null && m.cameraTop < lastCam - 2e-4) {
      camBack = Math.min(camBack, m.cameraTop - lastCam);
    }
    lastCam = m.cameraTop;
  });

  let pairs = 0, worstGap = 0;
  for (const [id, t] of cliBreak) {
    if (!srvBreak.has(id)) continue;
    pairs++;
    worstGap = Math.max(worstGap, Math.abs(t - srvBreak.get(id)));
  }
  const st = a.stats();
  ok(pairs >= 1, '這一局真的有假階碎掉（有東西可以比）', pairs + ' 階');
  ok(worstGap <= 3 * STEP_MS / 1000 + 1e-6,
    '客戶端的假階跟伺服器同時碎（差 3 個 tick 以內）', '最大差 ' + worstGap.toFixed(3) + ' 秒');
  /* 修好之前最大誤差是 2.35 格（＝人被拉回上一階），平均 0.08。
   * 剩下的那一點是另一個來源：伺服器一個 tick（33ms）只用一個方向，
   * 客戶端卻是每 1/60 秒一步各用當下的方向，所以走到階梯邊緣時偶爾會
   * 一邊踩到、一邊踩空，差一整階。它會被視覺補正在 0.12 秒內滑掉
   * （smooth-check 量到的單幀位移都還在物理上限內），不是瞬移。 */
  ok(st.errMax < 2, '自己的位置不會被拉回上一階（誤差遠小於修好前的 2.35 格）',
    '最大 ' + st.errMax + ' 格、平均 ' + st.errAvg);
  ok(st.errAvg < 0.15, '平均誤差很小（畫面大部分時間完全對得上）', st.errAvg + ' 格');
  ok(st.hardSnaps === 0, '不需要硬歸位');
  ok(camBack === 0, '客戶端的鏡頭永遠不回捲（回捲就是整個畫面在跳）',
    camBack.toFixed(6) + ' 格');
}

/* ---------------------------------------------------------- */
group('左右移動與推擠：按著一邊不能被往回拉（實測會抖）');
{
  /* 曾經發生的事：
   *   （1）「往右移一格會被往左移動一點點」——
   *        伺服器一個 tick（33ms）只用一個方向、封包到了就整個 tick 都用新方向，
   *        跟本地預測換方向的那一步差最多一整個 tick。現在客戶端會告訴伺服器
   *        「這個方向從對局時間的哪一刻開始生效」（net.js 的 at），
   *        伺服器排隊到那一步才套用。
   *   （2）「推擠的時候會不正常閃爍抖動」——
   *        以前對手的位置被畫面內插（刻意延遲 100ms）直接蓋掉，本地預測的推擠
   *        因此是拿「快 180ms 前的對手」在算，跟伺服器的結果不同，每份快照都把
   *        我拉回去一次。現在對手分成 viewX（畫面用，延遲）與 x（邏輯用，推測），
   *        推擠算在推測位置上。
   * 這一項用「按著同一邊，畫面上卻往反方向移動」來量 —— 那就是手感上的回拉。 */
  const prevSnap = { players: {}, ready: false };
  function snapshotPrev(s) {
    for (const p of s.players) {
      let e = prevSnap.players[p.id];
      if (!e) e = prevSnap.players[p.id] = { x: p.x, y: p.y };
      e.x = p.x; e.y = p.y;
    }
    prevSnap.ready = true;
  }
  const lerp2 = (a, b, t) => a + (b - a) * t;
  const half = Rules.C.PLAYER_W / 2;

  function measure(lag, mode) {
    const w = createWorld({ lag: lag, seed: 4 });
    const a = w.connect('甲', 'yuan', { beforeStep: snapshotPrev });
    const b = w.connect('乙', 'mimi');
    w.advance(400);
    a.actions.create('推擠房', 'normal');
    w.advance(400);
    b.actions.join(a.state.room.id, 'player');
    w.advance(400);
    a.actions.ready(true);
    b.actions.ready(true);
    w.advance(400);
    a.actions.start();
    w.advance(400);
    const meId = a.state.me.id;
    const driveB = drive(b, 'normal', 9);
    w.advance(4000, driveB);                      /* 過倒數 */

    const rows = [];
    let dir = 1;
    w.advance(8000, T => {
      if (mode === 'wiggle') dir = Math.floor(T / 250) % 2 === 0 ? 1 : -1;
      a.setDir(dir);
      driveB();
      const m = a.match;
      if (!m || m.phase !== 'playing' || !prevSnap.ready) return;
      const me = m.players.find(p => p.id === meId);
      const e = prevSnap.players[meId];
      if (!me || !e) return;
      const off = a.visualOffset();
      rows.push({
        dir: dir,
        x: lerp2(e.x, me.x, a.alpha()) + off.x,
        /* 貼著牆的時候本來就不會再往前，不能算成回拉 */
        wall: me.x <= half + 1e-6 || me.x >= Rules.C.FIELD_W - half - 1e-6
      });
    });

    /* 「看得出來的回拉」門檻：0.05 格。畫面上一格約 32px，0.05 格 ≈ 1.6px，
     * 比這個小的反向連續看都看不出來，不算手感問題。 */
    const VISIBLE = 0.05;
    let visible = 0, moves = 0, worst = 0, total = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].wall || rows[i - 1].wall || rows[i].dir !== rows[i - 1].dir) continue;
      const d = rows[i].x - rows[i - 1].x;
      if (Math.abs(d) > 1e-9) moves++;
      const back = -d * rows[i].dir;
      if (back > 1e-6) {
        total += back;
        if (back > worst) worst = back;
        if (back > VISIBLE) visible++;
      }
    }
    return {
      moves: moves, visible: visible, rate: moves ? visible / moves : 0,
      worst: worst, total: total, errMax: a.stats().errMax, errAvg: a.stats().errAvg
    };
  }

  /* hold ＝ 一直按右，會一路推到對手身上（驗推擠）
   * wiggle ＝ 每 250ms 換邊（驗改方向的那一步對不對齊） */
  for (const [mode, label] of [['hold', '一直按同一邊（會推到對手）'], ['wiggle', '每 250ms 換邊']]) {
    const r = measure(80, mode);
    const detail = '單次最大回拉 ' + r.worst.toFixed(3) + ' 格、預測誤差 平均 ' +
      r.errAvg + '／最大 ' + r.errMax + ' 格';
    ok(r.moves > 60, label + '：取樣夠多', r.moves + ' 幀');
    /* 修好之前 hold 一直按右時：單次最大回拉 0.57 格、平均預測誤差 0.055 格、
     * 而且 39.7% 的畫格都在反向。注意「被對手推回來」是正常的遊戲行為，
     * 所以這裡不看反向次數，只看「有沒有被拉一大段」與「預測準不準」。 */
    ok(r.worst <= 0.15, label + '：不會被往回拉一大段（修好前 0.57 格）', detail);
    ok(r.errAvg < 0.04, label + '：預測平均誤差很小（修好前 hold 是 0.055 格）', detail);
    ok(r.errMax < 1.2, label + '：x 的預測誤差有上限（修好前是 1.55 格）', detail);
  }
}

/* ---------------------------------------------------------- */
group('沒按方向鍵的時候不能自己滑（跟單機比）');
{
  /* 曾經發生的事：線上的左右移動「會滑」。
   * 原因不是速度算錯，而是視覺補正的抹除時機：每次校正都會把誤差抹在 0.12 秒裡，
   * 抹掉補正等於讓角色自己走幾像素 —— 在移動中完全看不見（混在速度裡），
   * 但站著不動時就是「沒按方向鍵卻自己滑一下」。實測 200ms 延遲時有 10.6% 的
   * 沒按畫格在滑（單機是 0%）。
   * 現在補正分成兩個軸各自衰減：水平的要等「有在左右移動」才抹，
   * 垂直的要等「有在空中」才抹（見 net.js 的 IDLE_SMOOTH_RATE）。 */
  const IDEAL = Rules.C.MOVE_SPEED / 60;
  const lerp3 = (a, b, t) => a + (b - a) * t;

  /** 一段取樣裡「沒按卻在移動」的比例與最大幅度 */
  function slideStats(rows) {
    let noInput = 0, moved = 0, worst = 0;
    const speeds = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i], q = rows[i - 1];
      if (!r.ok || !q.ok) continue;
      if (r.dir === 0 && q.dir === 0) {
        noInput++;
        const d = Math.abs(r.x - q.x);
        if (d > 0.02) { moved++; if (d > worst) worst = d; }
      } else if (r.dir !== 0 && r.dir === q.dir) {
        speeds.push((r.x - q.x) * r.dir);
      }
    }
    const mean = speeds.length ? speeds.reduce((s, v) => s + v, 0) / speeds.length : 0;
    const sd = speeds.length
      ? Math.sqrt(speeds.reduce((s, v) => s + (v - mean) * (v - mean), 0) / speeds.length) : 0;
    return { noInput: noInput, rate: noInput ? moved / noInput : 0, worst: worst, sd: sd };
  }

  /** 只在「不會被別的力量推動」的畫格採樣：活著、不在輸送帶上、沒貼牆、沒被推 */
  function usable(s, me, foe) {
    const onStep = me.onStep ? s.steps.find(x => x.id === me.onStep) : null;
    const half = Rules.C.PLAYER_W / 2;
    return me.alive && !(onStep && onStep.kind === 'belt') &&
      me.x > half + 1e-6 && me.x < Rules.C.FIELD_W - half - 1e-6 &&
      !(foe && foe.alive && Math.abs(foe.x - me.x) < Rules.C.PLAYER_W + 0.4 &&
        Math.abs(foe.y - me.y) < Rules.C.PLAYER_H);
  }

  /* --- 單機基準（沒有網路，這就是「順」的定義） --- */
  const base = (() => {
    const prev = { players: {}, ready: false };
    const snap = s => {
      for (const p of s.players) {
        let e = prev.players[p.id];
        if (!e) e = prev.players[p.id] = { x: p.x, y: p.y };
        e.x = p.x; e.y = p.y;
      }
      prev.ready = true;
    };
    const s = Rules.createMatch({
      difficulty: 'normal', mode: 'versus',
      players: [
        { id: 'p1', name: '甲', char: 'yuan', kind: 'human' },
        { id: 'p2', name: '乙', char: 'mimi', kind: 'ai' }
      ]
    }, 'slide-solo');
    const b1 = Ai.create('normal', 'p1', 3), b2 = Ai.create('normal', 'p2', 9);
    let acc = 0;
    const rows = [];
    for (let f = 0; f < 60 * 40 && s.phase !== 'over'; f++) {
      acc += 1000 / 60;
      let dir = 0;
      while (acc >= STEP_MS) {
        acc -= STEP_MS;
        snap(s);
        dir = b1.read(s, Rules.STEP).dir;
        Rules.stepMatch(s, { p1: { dir: dir }, p2: { dir: b2.read(s, Rules.STEP).dir } }, STEP_MS);
        if (s.phase === 'over') break;
      }
      if (!prev.ready || s.phase !== 'playing') continue;
      const me = s.players[0], foe = s.players[1];
      rows.push({
        dir: dir, x: lerp3(prev.players.p1.x, me.x, acc / STEP_MS), ok: usable(s, me, foe)
      });
    }
    return slideStats(rows);
  })();
  ok(base.noInput > 200, '單機基準取樣夠多', base.noInput + ' 個沒按的畫格');
  ok(base.rate === 0, '單機完全不會自己滑（這是基準）',
    (base.rate * 100).toFixed(1) + '%、每幀速度標準差 ' + base.sd.toFixed(4));

  /* --- 線上 --- */
  for (const lag of [80, 200]) {
    const prev = { players: {}, ready: false };
    const snap = s => {
      for (const p of s.players) {
        let e = prev.players[p.id];
        if (!e) e = prev.players[p.id] = { x: p.x, y: p.y };
        e.x = p.x; e.y = p.y;
      }
      prev.ready = true;
    };
    const w = createWorld({ lag: lag, seed: 8 });
    const a = w.connect('甲', 'yuan', { beforeStep: snap });
    const b = w.connect('乙', 'mimi');
    w.advance(400);
    a.actions.create('滑動房', 'normal');
    w.advance(400);
    b.actions.join(a.state.room.id, 'player');
    w.advance(400);
    a.actions.ready(true);
    b.actions.ready(true);
    w.advance(400);
    a.actions.start();
    w.advance(400);
    const meId = a.state.me.id;
    const brainA = Ai.create('normal', meId, 3);
    const driveB = drive(b, 'normal', 9);
    const rows = [];
    w.advance(40000, () => {
      /* advance() 是「先跑完這一格，再叫 onFrame」，所以要先記下這一格實際用的
       * 方向（也就是上一格決定的 st.dir），才不會把方向的標籤錯開一格 ——
       * 錯開的話「剛放手那一格」會被算成沒按，量出來的滑動全是假的。 */
      const dirUsed = a.state.dir;
      const m = a.match;
      if (m && m.phase === 'playing' && prev.ready) {
        const me = m.players.find(p => p.id === meId);
        const foe = m.players.find(p => p.id !== meId);
        const e = prev.players[meId];
        if (me && e) {
          rows.push({
            dir: dirUsed,
            x: lerp3(e.x, me.x, a.alpha()) + a.visualOffset().x,
            ok: usable(m, me, foe)
          });
        }
      }
      if (m) a.setDir(brainA.read(m, Rules.STEP).dir);
      driveB();
    });
    const s = slideStats(rows);
    const detail = '沒按卻在移動 ' + (s.rate * 100).toFixed(1) + '%（' + s.noInput +
      ' 幀）、單幀最大 ' + s.worst.toFixed(4) + ' 格、速度標準差 ' + s.sd.toFixed(4);
    ok(s.noInput > 200, lag + 'ms：取樣夠多', s.noInput + ' 個沒按的畫格');
    /* 修好之前：80ms 是 2.5%（最大 0.05 格）、200ms 是 10.6%（最大 0.10 格） */
    ok(s.rate <= 0.005, lag + 'ms：沒按方向鍵時不會自己滑（修好前 80ms 2.5%、200ms 10.6%）', detail);
    ok(s.worst <= 0.02, lag + 'ms：連一點點都不該滑（走一格畫格是 0.1 格）', detail);
    ok(s.sd <= 0.02, lag + 'ms：按著的時候速度穩定（每幀 0.1 格）', detail);
  }
}

/* ---------------------------------------------------------- */
group('自己被刺到的反饋要即時（不等伺服器）');
{
  /* 曾經發生的事：線上對戰被刺到，閃光、震動、火花都慢半拍 ——
   * 因為那些反饋是等伺服器的快照回來才播的，比「畫面上踩到刺的那一刻」
   * 晚了一個單向延遲 ＋ 一個 tick。
   * 現在自己的反饋改成本地預測就先播（net.js 的 emitPredicted），
   * 伺服器那份到了再用「事件步號」一對一對消，所以不會播兩次。
   * 傷害數字是 seed 雜湊算的（rules.js 的 rollSpikeDamage），兩邊一定一樣。 */
  function measureFeedback(lag) {
    const w = createWorld({ lag: lag, seed: 17 });
    const a = w.connect('甲', 'yuan');
    const b = w.connect('乙', 'mimi');
    w.advance(400);
    a.actions.create('挨刺房', 'hard');
    w.advance(400);
    b.actions.join(a.state.room.id, 'player');
    w.advance(400);
    a.actions.ready(true);
    b.actions.ready(true);
    w.advance(400);
    a.actions.start();
    w.advance(400);
    const room = [...w.hub.rooms.values()][0];
    const meId = a.state.me.id;
    const driveA = drive(a, 'easy', 5);          /* 弱一點的 AI 才踩得到刺 */
    const driveB = drive(b, 'normal', 9);
    const srv = [];
    const cli = [];
    let lastPending = null;
    w.advance(30000, T => {
      driveA();
      driveB();
      /* 伺服器是 30Hz，pending 每個 tick 換一份新的陣列；不比對就會重複計算 */
      if (room.pending && room.pending !== lastPending) {
        lastPending = room.pending;
        for (const e of room.pending) {
          if ((e.type === 'hurt' || e.type === 'spike') && e.player === meId) {
            srv.push({ at: T, type: e.type, amount: e.amount, step: e.at });
          }
        }
      }
      for (const e of a.takeEvents()) {
        if ((e.type === 'hurt' || e.type === 'spike') && e.player === meId) {
          cli.push({ at: T, type: e.type, amount: e.amount, step: e.at });
        }
      }
    });
    let paired = 0, missing = 0, sum = 0, worstAmount = 0;
    for (const s of srv) {
      const hit = cli.find(c => c.step === s.step && c.type === s.type && !c.used);
      if (!hit) { missing++; continue; }
      hit.used = true;
      paired++;
      sum += hit.at - s.at;                      /* 負數 ＝ 比伺服器更早播 */
      if (s.type === 'hurt' && hit.amount !== s.amount) worstAmount++;
    }
    return {
      srv: srv.length, cli: cli.length, paired: paired, missing: missing,
      extra: cli.filter(c => !c.used).length,
      lead: paired ? sum / paired : 0, amountBad: worstAmount
    };
  }

  for (const lag of [0, 80, 200]) {
    const r = measureFeedback(lag);
    const detail = '伺服器 ' + r.srv + ' 次、客戶端 ' + r.cli + ' 次、提前 ' +
      (-r.lead).toFixed(0) + 'ms、預測錯 ' + r.extra + ' 次';
    ok(r.srv >= 5, lag + 'ms：這一局真的被刺到幾次', r.srv + ' 次');
    ok(r.missing === 0, lag + 'ms：伺服器算出來的每一次都有播到（沒有被對消吃掉）', detail);
    ok(r.lead < -20, lag + 'ms：反饋比伺服器算出來更早（修好前是晚 40～60ms）', detail);
    ok(r.extra <= Math.max(1, Math.ceil(r.srv * 0.25)),
      lag + 'ms：預測錯而多播的次數很少', detail);
    ok(r.amountBad === 0, lag + 'ms：預測的傷害數字跟伺服器一模一樣', detail);
  }
}

/* ---------------------------------------------------------- */
group('結算停留的十秒內不能一直重播死掉那一下');
{
  /* 曾經發生的事：room.pending 是「上一個 tick 發生的事」，結算階段不再推進對局，
   * 所以它會停在最後那一份（含最後一次受傷、淘汰）—— 而快照每個 tick 都帶著它，
   * 客戶端就在結算的十秒內以 30Hz 重播死掉那一下的音效、震動與粒子（實測 50 次以上）。 */
  const { w, a, b } = startedMatch({ lag: 40, seed: 23 });
  const room = [...w.hub.rooms.values()][0];
  w.advance(4000);
  for (const p of room.match.players) { p.hp = 0; p.alive = false; p.state = 'stun'; }
  w.advance(300);
  ok(room.phase === 'result', '兩個人都死了 → 結算階段', room.phase);
  a.takeEvents();                                /* 把結算那一刻的事件收掉 */
  let repeats = 0;
  w.advance(3000, () => {
    for (const e of a.takeEvents()) {
      if (e.type === 'hurt' || e.type === 'spike' || e.type === 'eliminated') repeats++;
    }
  });
  ok(repeats === 0, '結算停留期間不會再收到受傷／淘汰事件', repeats + ' 次');
}

/* ---------------------------------------------------------- */
group('時間相關的機制：30Hz 迴圈、掉幀、量延遲、結算停留、輸入節流');
{
  /* 1. 伺服器的 30Hz 累加器：對局時間要跟真實時間一致 */
  const { w, a, b } = startedMatch({ lag: 40, seed: 5 });
  const room = [...w.hub.rooms.values()][0];
  const driveA = drive(a, 'normal', 1), driveB = drive(b, 'normal', 2);
  const tick = () => { driveA(); driveB(); };
  w.advance(4000, tick);                       /* 過倒數 */
  const t0 = room.match.time, wall0 = w.now();
  w.advance(5000, tick);
  const drift = Math.abs((room.match.time - t0) - (w.now() - wall0) / 1000);
  ok(drift < 0.05, '30Hz 權威迴圈：對局時間跟真實時間一致', '差 ' + drift.toFixed(4) + ' 秒');

  /* 2. 量延遲：PING_MS 是 1.5 秒一次，跑幾秒就該量得出來 */
  /* 假網路的單向延遲是 lag/2，再加上「一格才處理一次封包」的量化（16.7ms／跳），
   * 所以量出來會比設定的 40ms 多一點，但不能少、也不能多一倍。 */
  const rtt = a.stats().rtt;
  ok(rtt >= 40 && rtt <= 40 + 2 * STEP_MS + 10, '延遲量得出來（PING_MS 的機制有在跑）',
    rtt + 'ms vs 設定 40ms');

  /* 3. 本地超前量：應該約等於單向延遲 ＋ 一個 tick（太小＝預測沒在超前，按鍵會鈍） */
  const ahead = a.stats().aheadMs;
  ok(ahead > 1000 / 30 && ahead < 250, '本地模擬確實在超前跑（按鍵才不會鈍）',
    ahead + 'ms，至少要一個 tick（33ms）');

  /* 4. 分頁被節流：一次跳 250ms 的畫格，補完之後不能亂掉 */
  const before = a.stats().hardSnaps;
  w.advance(2000, tick, 250);
  w.advance(2000, tick);
  ok(a.stats().hardSnaps === before, '分頁節流回來不需要硬歸位');
  ok(Math.abs(a.match.time - room.match.time) < 0.5,
    '節流回來之後客戶端與伺服器的時間還是對得上',
    '差 ' + (a.match.time - room.match.time).toFixed(3) + ' 秒');
  ok(room.phase === 'playing' || room.phase === 'result', '這一局沒有因為節流而壞掉',
    room.phase);
}

{
  /* 5. 結算停留：沒人回報看完就要等滿 10 秒（RESULT_MS） */
  const { w, a, b } = startedMatch({ lag: 40, seed: 9 });
  const room = [...w.hub.rooms.values()][0];
  w.advance(4000);
  for (const p of room.match.players) { p.hp = 0; p.alive = false; p.state = 'stun'; }
  w.advance(200);
  ok(room.phase === 'result', '兩個人都死了 → 結算階段', room.phase);
  const startedAt = w.now();
  w.advance(9000);
  ok(room.phase === 'result', '9 秒還在結算停留（結算不會被提早收掉）', room.phase);
  w.advance(1500);
  ok(room.phase === 'lobby', '10 秒之後自動回房間', room.phase);
  const waited = (w.now() - startedAt) / 1000;
  ok(waited >= 9.5 && waited <= 11, '停留時間就是設定的 10 秒', waited.toFixed(1) + ' 秒');
}

{
  /* 6. 兩邊都按了「再來一局／回到房間」就不用等滿 10 秒 */
  const { w, a, b } = startedMatch({ lag: 40, seed: 21 });
  const room = [...w.hub.rooms.values()][0];
  w.advance(4000);
  for (const p of room.match.players) { p.hp = 0; p.alive = false; p.state = 'stun'; }
  w.advance(200);
  ok(room.phase === 'result', '進到結算階段');
  a.actions.resultDone();
  w.advance(300);
  ok(room.phase === 'result', '只有一邊看完，還是要等（對方還在看結算）', room.phase);
  b.actions.resultDone();
  w.advance(300);
  ok(room.phase === 'lobby', '兩邊都看完就馬上回房間', room.phase);
}

{
  /* 7. 輸入節流（INPUT_MIN_MS = 33ms）只擋「方向沒變」的重送，
   *    真的改方向一定要送得出去 —— 不然按了會沒反應。 */
  const { w, a, b } = startedMatch({ lag: 40, seed: 33 });
  const room = [...w.hub.rooms.values()][0];
  w.advance(4000);
  const meId = a.state.me.id;
  const dirOnServer = () => {
    const it = room.inputs.get(meId);
    return it ? it.dir : 0;
  };
  let allArrived = true;
  for (const dir of [1, -1, 1, 0, -1, 1]) {
    a.setDir(dir);
    w.advance(120);
    if (dirOnServer() !== dir) allArrived = false;
  }
  ok(allArrived, '連續改方向，每一次都送到伺服器（節流不會吃掉按鍵）');
}

/* ---------------------------------------------------------- */
group('可見高度走完整協定（手機直向的人要看得更深）');
{
  /* 直向的手機會回報「我想看 22 格」（app.js 的 wantViewH），
   * 伺服器開局時把全房統一成一個值，再隨完整快照發回來 ——
   * 鏡像少了這個值就會用預設的 16 格重建，畫面下緣跟伺服器的判定線就對不上了。 */
  const w = createWorld({ lag: 80 });
  const a = w.connect('甲', 'yuan', { viewH: 22 });     /* 手機直向 */
  const b = w.connect('乙', 'mimi');                    /* 沒回報 */
  w.advance(400);
  a.actions.create('直向房', 'normal');
  w.advance(400);
  b.actions.join(a.state.room.id, 'player');
  w.advance(400);
  a.actions.ready(true); b.actions.ready(true);
  w.advance(400);
  a.actions.start();
  w.advance(600);
  const room = [...w.hub.rooms.values()][0];
  ok(room.match.viewH === 22, 'hello 帶上去的 22 格有被伺服器收下');
  ok(a.match && a.match.viewH === 22, '房主的鏡像用同一個死亡線重建');
  ok(b.match && b.match.viewH === 22, '對手的鏡像也是同一個（兩邊同一套規則）');

  /* 轉向：還在大廳可以改，開局之後就不准動了 */
  b.actions.setViewH(24);
  w.advance(400);
  ok(room.match.viewH === 22, '對局中回報新的比例，不會動到正在打的這一局');
  ok(room.members.get(b.person.id).viewH === 24, '但有記下來，下一局才算數');
}
{
  /* 前端亂給不能變成規則漏洞：把死亡線丟到天邊就等於永遠摔不死 */
  const w = createWorld({ lag: 0 });
  const a = w.connect('甲', 'yuan', { viewH: 9999 });
  w.advance(400);
  a.actions.create('作弊房', 'normal');
  w.advance(400);
  ok(a.state.room && w.hub.rooms.size === 1, '房間開起來了');
  const room = [...w.hub.rooms.values()][0];
  ok(room.members.get(a.person.id).viewH === Rules.C.VIEW_H_MAX,
    '超大的值被收到上限 ' + Rules.C.VIEW_H_MAX + ' 格（不能靠改前端把死亡線推到天邊）');
}

/* ---------------------------------------------------------- */
console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n沒過的項目：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
