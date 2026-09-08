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
  function connect(name, char) {
    const person = { id: 'p' + (++seq), name: name, char: char || 'yuan', roomId: null, role: null };
    const client = Net.createClient({
      now: now, name: name, char: char,
      send(msg) {
        const copy = JSON.parse(JSON.stringify(msg));
        later(() => proto.handle(person, copy));
      }
    });
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

  /** 推進 ms 毫秒（每 1/60 秒一格） */
  function advance(ms, onFrame) {
    const end = T + ms;
    while (T < end) {
      T += STEP_MS;
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
   * 要壓到 0 得在伺服器端做「按 ct 時間戳回溯套用輸入」，對這個遊戲不值得。 */
  ok(m.pred.avg < 0.15, '同一個對局時間下，預測跟伺服器幾乎一樣（平均 < 0.15 格）',
    '平均 ' + m.pred.avg.toFixed(4) + ' 格');
  /* 偶爾會有一次比較大的落差：客戶端以為踩到了、伺服器判定沒踩到（或反過來），
   * 這時候差的就是一段掉落距離。要看的是「多不多」跟「會不會硬歸位」，不是最大值。 */
  ok(m.pred.p95 < 0.5, '95% 的畫面誤差在半格以內', 'p95 = ' + m.pred.p95.toFixed(3) + ' 格');
  ok(m.pred.p99 < 1.3, '99% 的畫面誤差在一格多以內', 'p99 = ' + m.pred.p99.toFixed(3) + ' 格');
  ok(m.pred.big / m.samples < 0.015, '超過 1 格的落差不到 1.5%',
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
  const hpSame = cs.players.every(p => {
    const q = ss.players.find(x => x.id === p.id);
    return q && q.hp === p.hp && q.alive === p.alive;
  });
  ok(hpSame, '血量與生死狀態完全一致（不由客戶端決定）');
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
  const { w, a, b } = startedMatch({ lag: 80, jitter: 30, seed: 3 });
  const driveB = drive(b, 'hard', 'B');
  w.advance(4000, driveB);
  const foeId = b.state.me.id;
  let jumps = 0, samples = 0, prev = null;
  w.advance(4000, () => {
    driveB();
    const foe = a.match.players.find(p => p.id === foeId);
    if (!foe) return;
    if (prev != null) {
      samples++;
      /* 一格畫面（1/60 秒）最多走 6/60 = 0.1 格；抓明顯瞬移 */
      if (Math.abs(foe.x - prev) > 0.35) jumps++;
    }
    prev = foe.x;
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
console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n沒過的項目：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
