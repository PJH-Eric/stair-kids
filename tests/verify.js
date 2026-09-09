/* ===== tests/verify.js — 規則核心單元測試 =====
 * 只測 rules.js / stairs.js / rng.js / themes，不需要瀏覽器。
 * 執行：npm test
 */
'use strict';

const Rules = require('../public/js/rules.js');
const Stairs = require('../public/js/stairs.js');
const RNG = require('../public/js/rng.js');
const Scenes = require('../public/js/themes/scenes.js');
const Characters = require('../public/js/themes/characters.js');
const Nicknames = require('../public/js/themes/nicknames.js');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}
function eq(a, b, name) { ok(a === b, name, '預期 ' + b + '，實際 ' + a); }
function near(a, b, tol, name) { ok(Math.abs(a - b) <= tol, name, '預期約 ' + b + '，實際 ' + a); }
function group(title) { console.log('\n' + title); }

const C = Rules.C;

/**
 * 測試沙盒：用手工指定的階梯取代程序生成，並停掉生成器，
 * 這樣每一條規則都能單獨驗證。
 */
function sandbox(opt) {
  opt = opt || {};
  const players = opt.players || [{ id: 'p1', name: 'A', char: 'yuan', kind: 'human' }];
  const s = Rules.createMatch({
    difficulty: opt.difficulty || 'normal',
    mode: opt.mode || (players.length > 1 ? 'versus' : 'solo'),
    players: players
  }, opt.seed || 'test');
  s.gen.depth = 1e9;                    /* 不再自動生成新階梯 */
  s.steps = (opt.steps || []).map((st, i) => Object.assign({
    id: 'T' + i, layer: i, kind: 'normal'
  }, st));
  s.phase = 'playing';
  s.countdown = 0;
  if (opt.cameraTop != null) s.cameraTop = opt.cameraTop;
  s.players.forEach((p, i) => {
    const init = (opt.at || [])[i];
    if (init) Object.assign(p, init);
    if (!s.steps.some(st => st.id === p.onStep)) p.onStep = null;
  });
  return s;
}

/** 跑 seconds 秒，回傳沿路收到的事件 */
function run(s, seconds, dirOf) {
  const steps = Math.round(seconds / C.STEP);
  const events = [];
  for (let i = 0; i < steps; i++) {
    const inputs = {};
    for (const p of s.players) inputs[p.id] = { dir: dirOf ? dirOf(i * C.STEP, p, s) : 0 };
    const r = Rules.stepMatch(s, inputs, Rules.STEP_MS);
    for (const e of r.events) events.push(e);
    if (s.phase === 'over') break;
  }
  return events;
}

const wide = (depth, x0, x1, extra) => Object.assign({ depth: depth, x0: x0, x1: x1, kind: 'normal' }, extra || {});

/* ---------------------------------------------------------- */
group('角色移動與物理');
{
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0, onStep: 'T0' }] });
  s.players[0].onStep = 'T0';
  run(s, 0.5, () => 1);
  near(s.players[0].x, 6 + 6 * 0.5, 0.05, '水平速度 6.0 格／秒，按住就是等速');
}
{
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0, onStep: 'T0' }] });
  s.players[0].onStep = 'T0';
  run(s, 3, () => 1);
  near(s.players[0].x, Stairs.C.FIELD_W - C.PLAYER_W / 2, 0.001,
    '撞到右牆就停住，不會繞回或穿出去');
}
{
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0, onStep: 'T0' }] });
  s.players[0].onStep = 'T0';
  run(s, 3, () => -1);
  near(s.players[0].x, C.PLAYER_W / 2, 0.001, '撞到左牆也停住');
}
{
  /* 從 0 落到 8 格：t = √(2·8/30) ≈ 0.73 秒（再深就會先摔出畫面了） */
  const s = sandbox({ steps: [wide(8, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0, vy: 0, onStep: null }] });
  run(s, 1.2);
  near(s.players[0].y, 8, 0.001, '重力 30 格／秒²，落到階梯上表面就停住');
  eq(s.players[0].onStep, 'T0', '落地後記住站在哪一階');
  eq(s.players[0].vy, 0, '落地後垂直速度歸零');
}
{
  /* 幼幼班不會摔死，可以放心一直掉下去量落速 */
  const s = sandbox({ difficulty: 'baby', steps: [], at: [{ x: 6, y: 0, vy: 0, onStep: null }] });
  run(s, 5);
  ok(s.players[0].vy <= C.MAX_FALL + 1e-9, '最大落速被限制在 18 格／秒（避免穿階）');
  near(s.players[0].vy, C.MAX_FALL, 0.001, '掉久了就維持在最大落速');
}
{
  /* 掃掠檢查：一步就跨過整階也要踩到 */
  const s = sandbox({ steps: [wide(0.2, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0, vy: C.MAX_FALL, onStep: null }] });
  Rules.stepMatch(s, { p1: { dir: 0 } }, Rules.STEP_MS);
  near(s.players[0].y, 0.2, 0.001, '高速落下用掃掠檢查，不會漏踩階梯');
}
{
  /* 上升中穿過階梯（經典手感） */
  const s = sandbox({ steps: [wide(0, 4, 8)], at: [{ x: 6, y: 5, vy: -9, onStep: null }] });
  run(s, 0.2);
  ok(s.players[0].y < 5, '上升時穿過階梯，不會被上面的階梯擋住');
}
{
  const s = sandbox({ steps: [wide(0, 5, 7)], at: [{ x: 6, y: 0, onStep: 'T0' }] });
  s.players[0].onStep = 'T0';
  run(s, 0.4, () => 1);
  eq(s.players[0].onStep, null, '走出階梯邊緣就會掉下去');
}

/* ---------------------------------------------------------- */
group('角色朝向');
{
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0 }] });
  s.players[0].onStep = 'T0';
  eq(s.players[0].face, 0, '開局站著不動，面向前方（face 0）');
  run(s, 0.1, () => 1);
  eq(s.players[0].face, 1, '往右移動就面向右邊（face 1）');
  run(s, 0.1, () => -1);
  eq(s.players[0].face, -1, '往左移動就面向左邊（face -1）');
  run(s, 0.1, () => 0);
  eq(s.players[0].face, 0, '放開按鍵、停下來就回到面向前方');
}
{
  /* 在空中也要看得出朝向（前端會照 face 轉側臉） */
  const s = sandbox({ steps: [wide(30, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0, onStep: null }] });
  run(s, 0.5, () => -1);
  eq(s.players[0].state, 'fall', '這時候是在下墜');
  eq(s.players[0].face, -1, '下墜中往左也一樣面向左邊');
}

/* ---------------------------------------------------------- */
group('五種階梯');
{
  /* 輸送帶：往右 +1，逆走只剩 6 − 3 = 3 格／秒 */
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W, { kind: 'belt', belt: 1 })], at: [{ x: 6, y: 0 }] });
  s.players[0].onStep = 'T0';
  run(s, 0.5, () => -1);
  near(s.players[0].x, 6 - 3 * 0.5, 0.05, '輸送帶可以逆向走，但只剩 3.0 格／秒');
}
{
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W, { kind: 'belt', belt: 1 })], at: [{ x: 6, y: 0 }] });
  s.players[0].onStep = 'T0';
  run(s, 0.5, () => 0);
  near(s.players[0].x, 6 + 3 * 0.5, 0.05, '站著不動會被輸送帶帶動 3.0 格／秒');
}
{
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W, { kind: 'belt', belt: 1 })], at: [{ x: 4, y: 0 }] });
  s.players[0].onStep = 'T0';
  run(s, 0.5, () => 1);
  near(s.players[0].x, 4 + 9 * 0.5, 0.05, '順向走是 6 + 3 = 9.0 格／秒');
}
{
  /* 彈簧：向上初速 9 格／秒（讓玩家一步就踩到，才好量剛彈起的瞬間） */
  const s = sandbox({ steps: [wide(0.2, 0, Stairs.C.FIELD_W, { kind: 'spring' })], at: [{ x: 6, y: 0, vy: 12 }] });
  const r = Rules.stepMatch(s, { p1: { dir: 0 } }, Rules.STEP_MS);
  ok(r.events.some(e => e.type === 'spring'), '踩到彈簧會發出 spring 事件');
  near(s.players[0].vy, -C.SPRING_VY, 1e-9, '彈簧給向上初速 9 格／秒');
  eq(s.players[0].onStep, null, '彈簧不會讓玩家停在上面');
  eq(s.players[0].stats.springs, 1, '彈簧次數有記到「這局統計」');
}
{
  /* 彈簧的實際彈起高度 = v²/(2g) = 81/60 = 1.35 格 */
  const s = sandbox({ steps: [wide(2, 0, Stairs.C.FIELD_W, { kind: 'spring' })], at: [{ x: 6, y: 1.9, vy: 1 }] });
  let top = 99;
  for (let i = 0; i < 120; i++) {
    Rules.stepMatch(s, { p1: { dir: 0 } }, Rules.STEP_MS);
    top = Math.min(top, s.players[0].y);
  }
  near(2 - top, C.SPRING_VY * C.SPRING_VY / (2 * C.GRAVITY), 0.1, '彈起高度符合 v²/2g（1.35 格）');
}
{
  /* 刺階：扣 1～5 顆（依難度與深度隨機）＋ 0.6 秒無敵，不僵直 */
  const s = sandbox({ steps: [wide(1, 0, Stairs.C.FIELD_W, { kind: 'spike' })], at: [{ x: 6, y: 0, vy: 0 }] });
  const hp0 = s.players[0].hp;
  run(s, 0.3);
  const range = Rules.spikeDamageRange(Rules.DIFFICULTY.normal, 0);
  const lost = hp0 - s.players[0].hp;
  ok(lost >= range[0] && lost <= range[1],
    '踩到刺階扣的愛心落在這個難度的範圍內（普通淺處 ' + range[0] + '～' + range[1] + ' 顆）',
    '實際扣 ' + lost + ' 顆');
  eq(s.players[0].hurtAmount, lost, '扣了幾顆有記在 hurtAmount（畫面要顯示數字）');
  ok(s.players[0].invuln > 0, '踩刺後進入無敵閃爍');
  eq(s.players[0].stats.spikes, 1, '踩刺次數有記到「這局統計」');
  const before = s.players[0].hp;
  Rules.damage(s.players[0], 1, 'spike', []);
  eq(s.players[0].hp, before, '無敵期間不會再被同類（刺）傷害');
}
{
  const s = sandbox({ steps: [wide(1, 0, Stairs.C.FIELD_W, { kind: 'spike' })], at: [{ x: 6, y: 0, vy: 0 }] });
  run(s, 0.3);
  near(s.players[0].y, 1, 0.001, '踩刺之後照樣站在刺階上（不僵直、不彈開）');
  ok(s.players[0].state !== 'spike', '踩刺不改角色姿勢（受傷反饋只做畫面，不動角色）');
}
{
  /* 踩刺的畫面反饋：刺階閃白光 ＋ 記下傷害來源給前端播特效 */
  const s = sandbox({ steps: [wide(1, 0, Stairs.C.FIELD_W, { kind: 'spike' })], at: [{ x: 6, y: 0, vy: 0 }] });
  const ev = run(s, 0.3);
  ok(ev.some(e => e.type === 'spike'), '踩到刺會發出 spike 事件（前端播音效與白光）');
  ok(s.steps[0].flash > 0, '被踩到的刺階會被標記要閃白光');
  eq(s.players[0].hurtBy, 'spike', '傷害來源記成 spike（前端才知道要播哪一種受傷特效）');
  ok(s.players[0].hurtFlash > 0, '受傷閃光計時有啟動');
  /* 無敵期間再踩同一階不會再閃、也不會再扣 */
  s.steps[0].flash = 0;
  const hp = s.players[0].hp;
  s.players[0].y = 0.5; s.players[0].vy = 5; s.players[0].onStep = null;
  run(s, 0.2);
  eq(s.players[0].hp, hp, '無敵期間再踩同一個刺階不會再扣血');
  eq(s.steps[0].flash, 0, '無敵期間再踩也不會再閃白光（不會一直閃）');
}
{
  /* 假階：踩到 0.25 秒後崩解，只能當短暫落腳點 */
  const s = sandbox({ steps: [wide(0.2, 0, Stairs.C.FIELD_W, { kind: 'fake' })], at: [{ x: 6, y: 0, vy: 12 }] });
  const ev1 = run(s, 0.2);
  ok(ev1.some(e => e.type === 'fakeCrack'), '踩到假階會先裂開（發出 fakeCrack）');
  eq(s.players[0].onStep, 'T0', '假階踩上去先撐住 0.25 秒');
  eq(s.steps[0].broken, undefined, '0.25 秒還沒到就不會崩');
  const ev2 = run(s, 0.15);
  ok(ev2.some(e => e.type === 'fakeBreak'), '假階 0.25 秒後崩解');
  eq(s.steps[0].broken, true, '崩掉的假階被標記為 broken');
  eq(s.players[0].onStep, null, '假階崩掉後玩家開始往下掉');
  eq(s.players[0].stats.fakes, 1, '踩破假階次數有記到「這局統計」');
}
{
  const s = sandbox({ steps: [wide(1, 0, Stairs.C.FIELD_W, { kind: 'normal' })], at: [{ x: 6, y: 0, vy: 0 }] });
  const hp0 = s.players[0].hp;
  run(s, 1);
  eq(s.players[0].hp, hp0, '普通階完全沒有效果');
  near(s.players[0].y, 1, 0.001, '普通階站著不動');
}

/* ---------------------------------------------------------- */
group('回血（踩到非刺的地方）');
{
  const kinds = ['normal', 'belt', 'spring', 'fake'];
  for (const kind of kinds) {
    const extra = kind === 'belt' ? { kind: kind, belt: 1 } : { kind: kind };
    const s = sandbox({ steps: [wide(0.2, 0, Stairs.C.FIELD_W, extra)], at: [{ x: 6, y: 0, vy: 12 }] });
    s.players[0].hp = 5;
    const r = Rules.stepMatch(s, { p1: { dir: 0 } }, Rules.STEP_MS);
    eq(s.players[0].hp, 6, '踩到' + kind + '回復 1 顆愛心');
    ok(r.events.some(e => e.type === 'heal'), '踩到' + kind + '會發出 heal 事件（畫面播回血特效）');
  }
}
{
  const s = sandbox({ steps: [wide(0.2, 0, Stairs.C.FIELD_W, { kind: 'spike' })], at: [{ x: 6, y: 0, vy: 12 }] });
  s.players[0].hp = 9;
  const r = Rules.stepMatch(s, { p1: { dir: 0 } }, Rules.STEP_MS);
  ok(s.players[0].hp < 9, '踩到刺階會扣血');
  ok(!r.events.some(e => e.type === 'heal'), '踩到刺階只扣血，不會回血');
}
{
  const s = sandbox({ steps: [wide(0.2, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0, vy: 12 }] });
  const full = s.players[0].hp;
  const r = Rules.stepMatch(s, { p1: { dir: 0 } }, Rules.STEP_MS);
  eq(s.players[0].hp, full, '滿血時踩到階梯不會超過上限');
  ok(!r.events.some(e => e.type === 'heal'), '滿血就不發 heal 事件');
}
{
  const s = sandbox({ steps: [wide(0.2, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0, vy: 12 }] });
  s.players[0].hp = 3;
  run(s, 2);
  eq(s.players[0].hp, 4, '一直站在同一階上只回一次（回血是「踩到」的當下，不是站著就回）');
  eq(s.players[0].stats.heals, 1, '回血次數有記到「這局統計」');
}

/* ---------------------------------------------------------- */
group('鏡頭與保底下捲');
{
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0 }] });
  near(s.cameraTop, -C.CAMERA_LEAD, 1e-9, '開局鏡頭在「最深存活者 − ' + C.CAMERA_LEAD + ' 格」');
  const before = s.cameraTop;
  run(s, 1);
  ok(s.cameraTop > before, '鏡頭會隨時間往下捲');
  near(s.cameraTop - before, Rules.DIFFICULTY.normal.scrollBase, 0.05, '普通難度的保底下捲是 2.8 格／秒');
}
{
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0 }] });
  const top0 = s.cameraTop;
  s.players[0].vy = -30;                       /* 硬讓玩家往上衝 */
  run(s, 0.2);
  ok(s.cameraTop >= top0, '鏡頭永遠不回捲（彈再高也只是停住）');
}
{
  /* 保底下捲隨時間加快，並且有上限 */
  const d = Rules.DIFFICULTY.normal;
  near(Rules.scrollMultiplier(d, 0), 1, 1e-9, '開局速度倍率是 1.0');
  near(Rules.scrollMultiplier(d, 20), 1.12, 1e-9, '普通：每 20 秒 +12%');
  near(Rules.scrollMultiplier(d, 40), 1.12 * 1.12, 1e-9, '加速是複利疊上去');
  near(Rules.scrollMultiplier(d, 100000), d.scrollCap, 1e-9, '倍率不會超過難度上限');
  for (const id of Rules.DIFFICULTY_LIST) {
    const dd = Rules.DIFFICULTY[id];
    ok(Rules.scrollMultiplier(dd, 1e9) === dd.scrollCap, id + ' 的速度上限是 ' + dd.scrollCap + ' 倍');
  }
}
{
  /* 鏡頭跟最深的存活者（但追隨有速度上限，不會瞬間跳過去） */
  const s = sandbox({
    players: [{ id: 'p1', name: 'A', kind: 'human' }, { id: 'p2', name: 'B', kind: 'human' }],
    steps: [wide(0, 0, 4), wide(6, Stairs.C.FIELD_W - 4, Stairs.C.FIELD_W)],
    at: [{ x: 2, y: 0, onStep: 'T0' }, { x: 10, y: 6, onStep: 'T1' }]
  });
  s.players[0].onStep = 'T0'; s.players[1].onStep = 'T1';
  const start = s.cameraTop;
  run(s, 0.5);
  const floorOnly = start + Rules.DIFFICULTY.normal.scrollBase * 0.5;
  ok(s.cameraTop > floorOnly + 0.5, '鏡頭會主動追向最深的存活者（比只有保底下捲快）');
  const cap = Math.max(Rules.DIFFICULTY.normal.scrollBase, C.CAMERA_CATCHUP);
  ok(s.cameraTop <= start + cap * 0.5 + 1e-6,
    '但追隨有速度上限，不會瞬間跳到玩家身上（這是「掉出畫面外會摔死」成立的關鍵）');
}
{
  /* 幼幼班沒有追隨上限 → 永遠追得上 → 沉不出去 */
  eq(Rules.DIFFICULTY.baby.cameraCatchup, null, '幼幼班的鏡頭沒有追隨上限');
  eq(Rules.DIFFICULTY.baby.fallOut, false, '幼幼班不會摔死（照 §0.2 的鼓勵式不死）');
  ok(['easy', 'normal', 'hard'].every(id => Rules.DIFFICULTY[id].fallOut), '其他三段難度都會摔死');
}
{
  /* 倒數期間鏡頭不下捲 */
  const s = Rules.createMatch({ difficulty: 'normal', mode: 'solo', players: [{ id: 'p1' }] }, 'cd');
  const top = s.cameraTop;
  for (let i = 0; i < 60; i++) Rules.stepMatch(s, {}, Rules.STEP_MS);
  eq(s.cameraTop, top, '倒數期間鏡頭完全不動');
  eq(s.phase, 'countdown', '一人挑戰倒數 2 秒，1 秒時還在倒數');
  for (let i = 0; i < 70; i++) Rules.stepMatch(s, {}, Rules.STEP_MS);
  eq(s.phase, 'playing', '倒數結束就開始玩');
}

/* ---------------------------------------------------------- */
group('天花板');
{
  /* 扣血節奏：碰到就立刻扣一次，之後要等冷卻。直接測 applyCeiling，時間軸最乾淨。
   * 注意「一次扣幾顆」現在是 1～5 隨機（依難度與深度），所以這裡量的是「扣了幾次」。 */
  const applyCeiling = Rules.applyCeiling;
  const count = (id, seconds) => {
    const diff = Rules.DIFFICULTY[id];
    const st = { seed: 'ceil-test', world: 0, diff: diff };
    const p = { id: 'p1', y: 0, hp: 9999, hpMax: 9999, alive: true, invuln: 0, ceilCool: 0,
      pressed: false, ceilHits: 0, hurtFlash: 0, hurtBy: null, hurtAmount: 0,
      stats: { ceilingSeconds: 0 } };
    const out = [];
    const hits = [];
    const amounts = [];
    for (let i = 0; i < Math.round(seconds / C.STEP); i++) {
      p.ceilCool = Math.max(0, p.ceilCool - C.STEP);   /* stepMatch 每一步都會做這件事 */
      const before = p.y;
      const hp = p.hp;
      applyCeiling(st, p, p.y - C.PLAYER_H + 0.5, diff, C.STEP, out);
      p.y = before;                      /* 固定住位置，才量得到扣血節奏 */
      if (p.hp < hp) { hits.push(i * C.STEP); amounts.push(hp - p.hp); }
    }
    return { lost: 9999 - p.hp, sec: p.stats.ceilingSeconds, by: p.hurtBy,
      hits: hits, amounts: amounts };
  };
  const n = count('normal', 3.0);
  near(n.hits[0], 0, 1e-9, '碰到天花板的刺就「立刻」扣血，不用等滿一個間隔');
  eq(n.hits.length, 5, '普通：之後每 0.6 秒最多再扣一次（3 秒共 5 次）');
  near(n.hits[1] - n.hits[0], 0.6, 1e-6, '兩次扣血之間剛好隔一個冷卻');
  eq(n.by, 'ceiling', '被天花板扣血時傷害來源記成 ceiling');
  eq(count('easy', 3.0).hits.length, 3, '簡單：冷卻 1.2 秒（3 秒共 3 次）');
  eq(count('hard', 3.0).hits.length, 8, '困難：冷卻 0.4 秒（3 秒共 8 次）');
  eq(count('baby', 3.0).hits.length, 0, '幼幼班：軟綿綿的雲朵，被頂到完全不扣血');
  near(n.sec, 3.0, 0.05, '被頂住的秒數有記到「這局統計」');
}
{
  /* 在真的一局裡：碰到天花板那一下就要扣血（接觸是斷斷續續的，不能等累計） */
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0 }] });
  s.players[0].onStep = 'T0';
  s.cameraTop = -C.PLAYER_H + 0.5;
  const hp0 = s.players[0].hp;
  const ev = run(s, 0.05);
  const ceilRange = Rules.spikeDamageRange(Rules.DIFFICULTY.normal, 0);
  const ceilLost = hp0 - s.players[0].hp;
  ok(ceilLost >= ceilRange[0] && ceilLost <= ceilRange[1],
    '被天花板的刺頂到，當下就掉血（' + ceilRange[0] + '～' + ceilRange[1] + ' 顆）',
    '實際掉 ' + ceilLost + ' 顆');
  ok(ev.some(e => e.type === 'hurt' && e.source === 'ceiling'), '同時發出 ceiling 的 hurt 事件（前端閃紅光）');
}
{
  /* 被頂到會被推穿腳下的階梯往下掉（推力大於階梯） */
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0 }] });
  s.players[0].onStep = 'T0';
  s.cameraTop = -C.PLAYER_H + 0.5;
  const r = Rules.stepMatch(s, { p1: { dir: 0 } }, Rules.STEP_MS);
  eq(s.players[0].state, 'ceiling', '被頂到的當下狀態標成 ceiling（畫面會播警告與紅色閃爍）');
  eq(s.players[0].onStep, null, '被推穿之後就不站在那一階上了');
  ok(r.events.some(e => e.type === 'hurt' && e.source === 'ceiling'), '同時扣血');
  near(s.players[0].vy, C.CEIL_PUSH, 1e-6, '被頂到會拿到向下的初速（不會黏在天花板上）');
  run(s, 0.1);
  ok(s.players[0].y > 0.5, '下一刻真的往下掉了');
}
{
  /* 這是「下不去」的回歸測試。舊的 bug 是：位置每一格都被夾回 cameraTop+身高，
   * 玩家只能跟著鏡頭走，每踩一階掉血，完全沒有自主權。
   * 傷害改成 1～5 隨機之後「撐 12 秒」不再是合理的標準，
   * 所以這裡驗的是真正的重點：被推下去之後能不能離開天花板。 */
  const steps = [];
  for (let i = 0; i < 400; i++) steps.push(wide(i * 2.6, 2, 6));
  const s = sandbox({ steps: steps, at: [{ x: 4, y: 0, onStep: 'T0' }] });
  s.players[0].onStep = 'T0';
  s.players[0].hp = 9999;                 /* 這一項只看能不能脫離，不看血量 */
  s.players[0].hpMax = 9999;
  s.cameraTop = -C.PLAYER_H + 0.5;
  let freeFrames = 0, maxClear = 0;
  const ev = [];
  for (let i = 0; i < Math.round(3 / C.STEP); i++) {
    const r = Rules.stepMatch(s, { p1: { dir: 0 } }, Rules.STEP_MS);
    for (const e of r.events) ev.push(e);
    const p = s.players[0];
    if (!p.pressed) freeFrames++;
    const clear = (p.y - C.PLAYER_H) - s.cameraTop;   /* 頭頂離天花板多遠 */
    if (clear > maxClear) maxClear = clear;
  }
  eq(s.phase, 'playing', '被天花板頂到還活著（血量不設限的情況下）');
  ok(freeFrames > 30, '被推下去之後真的離開了天花板（' + freeFrames + ' 格沒被頂住）');
  ok(maxClear > 1.5, '頭頂跟天花板之間拉開過 1.5 格以上（' + maxClear.toFixed(2) + ' 格）');
  const hurts = ev.filter(e => e.type === 'hurt').length;
  const heals = ev.filter(e => e.type === 'heal').length;
  ok(hurts > 3, '過程中確實一直被扎（' + hurts + ' 次）');
  ok(heals > 0, '中間有踩到階梯回血（' + heals + ' 次）');
  const lostTotal = ev.filter(e => e.type === 'hurt').reduce((n, e) => n + e.amount, 0);
  ok(lostTotal > hurts,
    '每一次被扎扣 1～5 顆，總量比「一次一顆」多（' + hurts + ' 次共扣 ' + lostTotal + ' 顆）');
  ok(s.players[0].y > 7, '而且真的一路往下走（3 秒下降 ' + s.players[0].y.toFixed(0) + ' 格）');
}
{
  /* 彈簧在天花板正下方：原本會無限彈跳到死 */
  const s = sandbox({
    steps: [Object.assign(wide(2, 2, 6), { kind: 'spring' })],
    at: [{ x: 4, y: 2, onStep: 'T0' }]
  });
  s.players[0].onStep = 'T0';
  s.cameraTop = 2 - C.PLAYER_H + 0.4;
  const ev = run(s, 3);
  const springs = ev.filter(e => e.type === 'spring').length;
  ok(springs <= 1, '踩到彈簧撞到天花板不會無限彈（彈了 ' + springs + ' 次）');
  ok(s.players[0].y > 12 || s.players[0].fell, '會被天花板推著往下離開，不會卡在上面');
}
{
  /* 幼幼班同樣情境：不扣血、不會死 */
  const s = sandbox({ difficulty: 'baby', steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0 }] });
  s.players[0].onStep = 'T0';
  s.cameraTop = -C.PLAYER_H + 0.5;
  const hp0 = s.players[0].hp;
  run(s, 5.0);
  eq(s.players[0].hp, hp0, '幼幼班被雲朵頂到完全不扣血');
  eq(s.players[0].alive, true, '幼幼班不會死');
  eq(Rules.DIFFICULTY.baby.cloudCeiling, true, '幼幼班的天花板畫成雲朵，不畫尖刺');
}
{
  /* 天花板只會往下推，不會把玩家往上提 */
  const s = sandbox({ steps: [], at: [{ x: 6, y: 0, onStep: null }] });
  s.cameraTop = 5;
  const before = s.players[0].y;
  run(s, 0.02);
  ok(s.players[0].y > before, '被頂到是往下推，不是往上提');
  near(s.players[0].y - C.PLAYER_H, s.cameraTop, 0.001, '頭頂貼在天花板下緣');
}
{
  /* 刺階的 0.6 秒無敵不會蓋掉天花板的扣血（只擋「同類」傷害） */
  const p = { hp: 10, alive: true, invuln: 0.6, hurtFlash: 0, stats: {} };
  Rules.damage(p, 1, 'ceiling', []);
  eq(p.hp, 9, '踩刺的無敵不會擋掉天花板的扣血（傷害分兩類各自計時）');
}

/* ---------------------------------------------------------- */
group('推擠（對戰唯一的互動）');
{
  const a = { id: 'a', index: 0, x: 6.0, y: 5, alive: true };
  const b = { id: 'b', index: 1, x: 6.6, y: 5, alive: true };
  Rules.resolvePush(a, b);
  near(6.0 - a.x, b.x - 6.6, 1e-9, '推擠沿水平方向對稱，雙方各推開一半');
  near(b.x - a.x, C.PLAYER_W, 1e-6, '推開後剛好不重疊');
}
{
  const wall = C.PLAYER_W / 2;                                   /* 貼左牆時身體中心的 x */
  const a = { id: 'a', index: 0, x: wall, y: 5, alive: true };
  const b = { id: 'b', index: 1, x: wall + 0.5, y: 5, alive: true };
  Rules.resolvePush(a, b);
  near(a.x, wall, 1e-9, '對方貼牆時推的人自己被擋住（可以卡牆但不穿模）');
  near(b.x, wall + C.PLAYER_W, 1e-6, '被擋住的位移全部給另一邊，總之不重疊');
}
{
  const a = { id: 'a', index: 0, x: 6, y: 5, alive: true };
  const b = { id: 'b', index: 1, x: 6, y: 5 - C.PLAYER_H - 0.1, alive: true };
  eq(Rules.resolvePush(a, b), false, '垂直沒有交疊就不推（所以不會互踩頭、不會疊人）');
}
{
  const a = { id: 'a', index: 0, x: 6, y: 5, alive: true };
  const b = { id: 'b', index: 1, x: 6, y: 5.2, alive: true };
  Rules.resolvePush(a, b);
  ok(a.y === 5 && b.y === 5.2, '推擠只推水平，垂直方向完全不動');
  ok(Math.abs(b.x - a.x) >= C.PLAYER_W - 1e-6, '完全重疊時也會被推開（方向穩定，不看誰先動）');
}
{
  const s = sandbox({
    players: [{ id: 'p1', kind: 'human' }, { id: 'p2', kind: 'human' }],
    steps: [wide(0, 0, Stairs.C.FIELD_W)],
    at: [{ x: 6, y: 0 }, { x: 6.5, y: 0 }]
  });
  s.players.forEach(p => { p.onStep = 'T0'; });
  const hp = s.players.map(p => p.hp);
  run(s, 0.5);
  ok(s.players[0].hp === hp[0] && s.players[1].hp === hp[1], '推擠本身不扣血（傷害都由環境造成）');
  ok(s.players[0].stats.pushes >= 1, '被推開次數有記到「這局統計」');
}

/* ---------------------------------------------------------- */
group('深度、里程碑與世界');
{
  const s = sandbox({ steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0 }] });
  s.players[0].onStep = 'T0';
  s.players[0].y = 100.5;
  s.players[0].best = 100.5;
  const ev = run(s, 0.05);
  const m = ev.find(e => e.type === 'milestone');
  ok(!!m, '每 100 公尺跳一次慶祝提示');
  eq(m && m.meters, 100, '里程碑的公尺數是 100 的倍數');
  eq(s.world, 1, '同時換到下一層世界');
  near(s.worldFade, 0.8, 0.05, '換世界是 0.8 秒漸變（不打斷操作）');
}
{
  eq(Scenes.COUNT, 6, '六套世界主題');
  eq(Scenes.sceneFor(0).name, '幼稚園', '0～100 m 是幼稚園');
  eq(Scenes.sceneFor(2).name, '海邊', '200～300 m 是海邊');
  eq(Scenes.sceneFor(5).name, '太空站', '500 m 以上是太空站');
  eq(Scenes.sceneFor(6).night, true, '六套用完循環並套用夜間配色');
  eq(Rules.worldSceneIndex(7), 1, '第 7 層對回第 2 套主題');
  eq(Rules.worldIsNight(6), true, '第 7 層開始是夜間變體');
}
{
  const s = sandbox({ steps: [wide(8, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0, onStep: null }] });
  run(s, 1.2);
  near(s.players[0].best, 8, 0.001, '分數就是最深深度（1 格 = 1 公尺）');
  s.players[0].y = 3;
  run(s, 0.05);
  near(s.players[0].best, 8, 0.001, '分數只增不減');
}

/* ---------------------------------------------------------- */
group('四段難度參數（規劃書 §1.7）');
{
  const table = {
    baby:   { scrollBase: 1.2, accelEvery: 30, accelRate: 0.05, scrollCap: 1.5, hp: 20, ceilInterval: null, spikeRate: 0.00, fakeRate: 0.00 },
    easy:   { scrollBase: 1.8, accelEvery: 22, accelRate: 0.08, scrollCap: 1.8, hp: 14, ceilInterval: 1.2, spikeRate: 0.06, fakeRate: 0.06 },
    normal: { scrollBase: 2.8, accelEvery: 20, accelRate: 0.12, scrollCap: 2.2, hp: 10, ceilInterval: 0.6, spikeRate: 0.15, fakeRate: 0.14 },
    hard:   { scrollBase: 3.6, accelEvery: 18, accelRate: 0.15, scrollCap: 2.6, hp: 9, ceilInterval: 0.4, spikeRate: 0.24, fakeRate: 0.20 }
  };
  eq(Rules.DIFFICULTY_LIST.join(','), 'baby,easy,normal,hard', '四段難度：幼幼班／簡單／普通／困難');
  for (const id in table) {
    const want = table[id], got = Rules.DIFFICULTY[id];
    let same = true;
    for (const k in want) if (got[k] !== want[k]) same = false;
    ok(same, id + '（' + got.name + '）的參數與規劃書一致',
      same ? '' : JSON.stringify({ want: want, got: got }));
  }
  eq(Rules.DIFFICULTY.baby.hpAsNumber, true, '幼幼班 20 顆愛心改用「愛心＋數字」顯示');
  eq(Rules.DIFFICULTY.baby.endless, true, '幼幼班沒有終點，靠「結束這局」收局');
  eq(Rules.DIFFICULTY.baby.versus, false, '幼幼班不開放對戰');
  ok(['easy', 'normal', 'hard'].every(id => Rules.DIFFICULTY[id].versus), '對戰只有簡單／普通／困難');
  ok(Rules.DIFFICULTY.baby.scrollBase < Rules.DIFFICULTY.easy.scrollBase &&
     Rules.DIFFICULTY.easy.scrollBase < Rules.DIFFICULTY.normal.scrollBase &&
     Rules.DIFFICULTY.normal.scrollBase < Rules.DIFFICULTY.hard.scrollBase, '四段的下捲速度單調遞增');
}

/* ---------------------------------------------------------- */
group('勝負判定（規劃書 §1.6）');
{
  /* 一人挑戰：血歸零就結束（連續踩刺把血耗完） */
  const steps = [];
  for (let i = 0; i < 40; i++) steps.push(wide(i * 2.2, 0, Stairs.C.FIELD_W, { kind: i % 2 ? 'spike' : 'normal' }));
  const s = sandbox({ steps: steps, at: [{ x: 6, y: 0, onStep: 'T0' }] });
  s.players[0].onStep = 'T0';
  run(s, 30, () => 1);
  eq(s.phase, 'over', '一人挑戰血歸零就結束');
  eq(s.result.endedBy, 'dead', '結算標明是被打死的');
  eq(s.result.players[0].hp, 0, '結算帶著血歸零的狀態');
  eq(s.result.players[0].fell, false, '不是摔死的');
  ok(s.result.players[0].survived > 0, '結算帶著存活時間');
  ok(s.result.players[0].stats.spikes > 0, '結算帶著「這局統計」');
}
{
  /* 一人挑戰：連續踩空掉出畫面下緣 → 摔死 */
  const s = sandbox({ steps: [], at: [{ x: 6, y: 0, onStep: null }] });
  const ev = run(s, 5);
  eq(s.phase, 'over', '連續踩空掉出畫面下緣就結束這局');
  eq(s.result.endedBy, 'fell', '結算標明是摔下去的');
  eq(s.result.players[0].fell, true, '這位玩家是摔死的');
  ok(ev.some(e => e.type === 'sinking'), '快掉出去之前會先發出 sinking 警示（畫面下緣會亮紅帶）');
  ok(ev.some(e => e.type === 'fell'), '掉出去時發出 fell 事件');
  ok(ev.some(e => e.type === 'eliminated'), '摔死一樣算淘汰');
  ok(s.players[0].y > 12 && s.players[0].y < 22,
    '大約掉 16 格（5～6 層）沒踩到東西就會摔死（實際 ' + s.players[0].y.toFixed(1) + ' 格）');
}
{
  /* 幼幼班怎麼掉都不會摔死 */
  const s = sandbox({ difficulty: 'baby', steps: [], at: [{ x: 6, y: 0, onStep: null }] });
  run(s, 10);
  eq(s.phase, 'playing', '幼幼班連續踩空 10 秒也不會結束');
  eq(s.players[0].alive, true, '幼幼班不會摔死');
  near(s.players[0].y - s.cameraTop, C.CAMERA_LEAD, 0.2, '幼幼班的鏡頭永遠追得上，玩家沉不出畫面');
}
{
  /* 幼幼班：手動結束這局 */
  const s = sandbox({ difficulty: 'baby', steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 6, y: 0 }] });
  s.players[0].onStep = 'T0';
  run(s, 6);
  eq(s.phase, 'playing', '幼幼班沒有終點，不會自己結束');
  const r = Rules.endMatch(s, 'manual');
  eq(s.phase, 'over', '按「結束這局」才收局');
  eq(r.endedBy, 'manual', '結算標明是手動結束');
  ok(r.players[0].meters >= 0, '手動結束也有成績');
}
{
  /* 單機對電腦：玩家一死就結束，不必等電腦死 */
  const s = sandbox({
    mode: 'versus',
    players: [{ id: 'p1', kind: 'human' }, { id: 'ai1', kind: 'ai', aiLevel: 'normal' }],
    steps: [wide(0, 0, Stairs.C.FIELD_W)],
    at: [{ x: 3, y: 0 }, { x: 9, y: 0 }]
  });
  s.players.forEach(p => { p.onStep = 'T0'; });
  s.players[1].best = 5;
  s.players[0].hp = 1;
  Rules.damage(s.players[0], 1, 'spike', []);
  run(s, 0.05);
  eq(s.phase, 'over', '對電腦時玩家一死就結束');
  eq(s.result.winner, 'ai1', '用雙方當下深度比較，電腦比較深就是電腦贏');
  eq(s.players[1].alive, true, '電腦還活著也照樣結算');
}
{
  /* 線上 1v1：兩個人都死了才結算 */
  const s = sandbox({
    mode: 'versus',
    players: [{ id: 'p1', kind: 'human' }, { id: 'p2', kind: 'human' }],
    steps: [wide(0, 0, Stairs.C.FIELD_W)],
    at: [{ x: 3, y: 0 }, { x: 9, y: 0 }]
  });
  s.players.forEach(p => { p.onStep = 'T0'; });
  s.players[0].hp = 1;
  Rules.damage(s.players[0], 1, 'spike', []);
  run(s, 0.05);
  eq(s.phase, 'playing', '線上一個人死不會結束對局');
  s.players[1].best = 3;
  s.players[1].hp = 1;
  Rules.damage(s.players[1], 1, 'spike', []);
  run(s, 0.05);
  eq(s.phase, 'over', '兩個人都死了才結算');
  eq(s.result.winner, 'p2', '比最終深度較深者勝（先死的人也可能贏）');
}
{
  /* 深度相同 → 比存活時間；都相同 → 平手 */
  const mk = (bestA, bestB, tA, tB) => {
    const s = sandbox({
      mode: 'versus',
      players: [{ id: 'p1', kind: 'human' }, { id: 'p2', kind: 'human' }],
      steps: [wide(0, 0, Stairs.C.FIELD_W)], at: [{ x: 3, y: 0 }, { x: 9, y: 0 }]
    });
    s.players[0].best = bestA; s.players[1].best = bestB;
    s.players[0].aliveTime = tA; s.players[1].aliveTime = tB;
    s.players.forEach(p => { p.alive = false; p.hp = 0; });
    return Rules.checkResult(s);
  };
  eq(mk(10, 10, 8, 5).winner, 'p1', '深度相同時比存活時間較長者勝');
  eq(mk(10, 10, 5, 5).draw, true, '深度與存活時間都相同判平手');
  eq(mk(10, 10, 5, 5).winner, null, '平手沒有勝方');
}

/* ---------------------------------------------------------- */
group('樓梯生成（規劃書 §3）');
{
  const a = Stairs.makeStairs('same-seed', 'normal', 0, 300);
  const b = Stairs.makeStairs('same-seed', 'normal', 0, 300);
  eq(JSON.stringify(a), JSON.stringify(b), '同一個 seed 長出完全一樣的樓梯');
  const c = Stairs.makeStairs('other-seed', 'normal', 0, 300);
  ok(JSON.stringify(a) !== JSON.stringify(c), '不同 seed 長出不一樣的樓梯');
}
{
  const gen = Stairs.createGen('twostep', 'normal');
  let two = 0, tooFar = 0, tooNear = 0;
  while (gen.layer < 4000) {
    const l = Stairs.nextLayer(gen);
    if (l.length < 2) continue;
    two++;
    const sep = Stairs.spanGap(l[0].x0, l[0].x1, l[1].x0, l[1].x1);
    if (sep > Stairs.C.TWO_STEP_MAX_SEP + 1e-9) tooFar++;
    if (sep < Stairs.C.TWO_STEP_MIN_GAP - 1e-9) tooNear++;
  }
  ok(two > 100, '偶爾會出現同一層兩階（4000 層裡有 ' + two + ' 層）');
  eq(tooNear, 0, '同層兩階之間至少留 0.9 格（不會看起來像一整片）');
  eq(tooFar, 0, '同層兩階不會隔太遠（下一層才找得到兩邊都走得到的落點）');
}
{
  const first = Stairs.makeStairs('spawn', 'normal', 0, 20)[0];
  eq(first.depth, 0, '第 0 層在深度 0');
  eq(first.spawn, true, '第 0 層是出生平台');
  near(first.x1 - first.x0, Stairs.C.SPAWN_WIDTH, 1e-9,
    '出生平台寬 ' + Stairs.C.SPAWN_WIDTH + ' 格（唯一的例外層，兩側各留得下一條過得去的縫）');
  near((first.x0 + first.x1) / 2, Stairs.C.FIELD_W / 2, 1e-9, '出生平台在場地正中間');
}
{
  const s = Stairs.makeStairs('babyseed', 'baby', 0, 2000);
  ok(!s.some(st => st.kind === 'spike'), '幼幼班完全不出現刺階');
  ok(!s.some(st => st.kind === 'fake'), '幼幼班完全不出現假階');
}
{
  const gen = Stairs.createGen('reach', 'hard');
  const layers = [];
  while (gen.layer < 400) layers.push(Stairs.nextLayer(gen));
  let bad = 0;
  for (let i = 1; i < layers.length; i++) {
    const gap = layers[i][0].depth - layers[i - 1][0].depth;
    const span = Stairs.reachSpan(gap);
    for (const st of layers[i]) {
      /* 上一層「每一階」都要走得到，站在哪一階都不會遇到死路 */
      const worst = Math.max(...layers[i - 1].map(p => Stairs.spanGap(st.x0, st.x1, p.x0, p.x1)));
      if (worst > span + 1e-6) bad++;
    }
  }
  eq(bad, 0, '從上一層的每一階都在「走路來得及」的距離內（可達性保證）');
}
{
  const gen = Stairs.createGen('rate', 'normal');
  const layers = [];
  while (gen.layer < 3000) layers.push(Stairs.nextLayer(gen));
  let inField = true, spanOk = true;
  for (const l of layers) for (const st of l) {
    if (st.x0 < -1e-9 || st.x1 > Stairs.C.FIELD_W + 1e-9) inField = false;
    const w = st.x1 - st.x0;
    if (!st.spawn && !st.wide && (w < Stairs.C.WIDTH_MIN - 1e-9 || w > Stairs.C.WIDTH_MAX + 1e-9)) spanOk = false;
  }
  ok(inField, '階梯不會超出場地寬 ' + Stairs.C.FIELD_W + ' 格');
  ok(spanOk, '一般階梯寬度落在 2.5～4.0 格');
  let gapOk = true;
  for (let i = 1; i < layers.length; i++) {
    const g = layers[i][0].depth - layers[i - 1][0].depth;
    if (g < Stairs.C.GAP_MIN - 1e-9 || g > Stairs.C.GAP_MAX + 1e-9) gapOk = false;
  }
  ok(gapOk, '層間垂直間距落在 2.0～3.0 格');
}

/* ---------------------------------------------------------- */
group('資產與詞庫');
{
  eq(Characters.CHARACTERS.length, 8, '8 隻小朋友角色');
  const ids = new Set(Characters.CHARACTERS.map(c => c.id));
  eq(ids.size, 8, '角色 id 沒有重複');
  ok(Characters.CHARACTERS.every(c => c.hair && c.top && c.skin && c.shirt && c.pants && c.shoe),
    '每一隻都有頭髮、衣服、褲子與鞋子的配色（不是圓球加臉）');
  ok(Nicknames.COUNT >= 100, '隨機暱稱詞庫互乘有 ' + Nicknames.COUNT + ' 種組合');
  ok(/[一-鿿]/.test(Nicknames.random()), '隨機暱稱是中文的「形容詞＋小動物」');
}

/* ---------------------------------------------------------- */
group('可重現性（線上同步與測試的前提）');
{
  const play = () => {
    const s = Rules.createMatch({
      difficulty: 'normal', mode: 'solo',
      players: [{ id: 'p1', name: 'A', char: 'yuan', kind: 'human' }]
    }, 'fixed-seed');
    for (let i = 0; i < 3600; i++) {
      Rules.stepMatch(s, { p1: { dir: i % 90 < 45 ? 1 : -1 } }, Rules.STEP_MS);
      if (s.phase === 'over') break;
    }
    const p = s.players[0];
    return JSON.stringify({
      x: p.x.toFixed(6), y: p.y.toFixed(6), hp: p.hp, best: p.best.toFixed(6),
      world: s.world, camera: s.cameraTop.toFixed(6), stats: p.stats
    });
  };
  eq(play(), play(), '同樣的 seed 與同樣的輸入，跑出完全一樣的結果');
}
{
  const r1 = RNG.create('abc'), r2 = RNG.create('abc');
  eq(r1.next(), r2.next(), '同一個種子的亂數序列一致');
}

/* ---------------------------------------------------------- */
console.log('\n────────────────────────────');
console.log(pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n失敗項目：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
