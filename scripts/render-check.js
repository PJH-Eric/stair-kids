/* ===== scripts/render-check.js — 角色死亡後的畫面清理驗收 =====
 * 執行：node scripts/render-check.js  或  npm run test:render
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Characters = require('../public/js/themes/characters.js');
const Rules = require('../public/js/rules.js');
const Scenes = require('../public/js/themes/scenes.js');

class FakeElement {
  constructor(tagName, parent) {
    this.tagName = tagName;
    this.parentNode = parent || null;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  querySelector() {
    return new FakeElement('g', this);
  }
}

function fakeContext(scaleCalls) {
  const gradient = () => ({ addColorStop() {} });
  const target = {
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    measureText: () => ({ width: 0 })
  };
  if (scaleCalls) target.scale = (x, y) => scaleCalls.push([x, y]);
  return new Proxy(target, {
    get(obj, name) {
      if (name in obj) return obj[name];
      return () => {};
    },
    set(obj, name, value) {
      obj[name] = value;
      return true;
    }
  });
}

function loadRender() {
  const document = {
    createElementNS: (_namespace, tagName) => new FakeElement(tagName)
  };
  const context = vm.createContext({
    console,
    document,
    devicePixelRatio: 1,
    Rules,
    self: null
  });
  context.self = context;
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/render.js'), 'utf8'), context);
  return context.Render;
}

function stateWith(alive) {
  return {
    cameraTop: 0,
    diff: { cloudCeiling: false },
    steps: [],
    players: [{
      id: 'A', name: '甲', char: 'yuan', kind: 'human',
      x: 6, y: 3, alive, state: alive ? 'idle' : 'stun',
      face: 0, invuln: 0, sinking: 0
    }]
  };
}

const canvas = {
  width: 360,
  height: 540,
  getContext: () => fakeContext(),
  getBoundingClientRect: () => ({ width: 360, height: 540 })
};
const actorSvg = new FakeElement('svg');
const render = loadRender().create(canvas, actorSvg);
const scene = Scenes.sceneFor(0);
const charOf = Characters.byId;

const appSource = fs.readFileSync(require.resolve('../public/js/app.js'), 'utf8');
const finishStart = appSource.indexOf('  function finish(result, meId) {');
const finishEnd = appSource.indexOf('  /* ================= 暫停選單', finishStart);
assert.ok(finishStart >= 0 && finishEnd > finishStart, '找到結算流程');
assert.match(appSource.slice(finishStart, finishEnd), /view\.clearActors\(\)/,
  '結算時會清除畫面上的角色');
const interpStart = appSource.indexOf('  function interpolated(s, alpha, offset) {');
const interpEnd = appSource.indexOf('  /* ================= 事件', interpStart);
assert.ok(interpStart >= 0 && interpEnd > interpStart, '找到畫面內插');
const interpSection = appSource.slice(interpStart, interpEnd);
assert.match(interpSection, /if \(localOnly && p\.id !== predictedId\) \{/,
  '線上模式只對本地預測的角色做固定步長內插（對手的位置交給 net.js，混兩套時間軸會有殘影）');
assert.match(interpSection, /shown\.x = p\.viewX;[\s\S]*shown\.y = p\.viewY;/,
  '對手畫在 net.js 內插好的 viewX／viewY 上（p.x／p.y 是留給推擠判定的推測位置）');
const onlineFrameStart = appSource.indexOf('  function onlineFrame(s, now, dt) {');
const onlineFrameEnd = appSource.indexOf('  /* ---------- 畫面內插', onlineFrameStart);
assert.ok(onlineFrameStart >= 0 && onlineFrameEnd > onlineFrameStart, '找到線上畫面流程');
assert.match(appSource.slice(onlineFrameStart, onlineFrameEnd),
  /handleEvents\(online\.takeEvents\(\)\);[\s\S]*if \(!G\.raf \|\| G\.screen !== 'game'\) return;/,
  '結算後不會讓同一個線上畫格把角色重新畫回來');

render.draw(stateWith(true), scene, charOf, 0, 0);
assert.equal(actorSvg.children.length, 1, '存活玩家會被畫出來');

render.draw(stateWith(false), scene, charOf, 0, 0);
assert.equal(actorSvg.children.length, 0, '死亡玩家會在下一幀立即從畫面移除');

const stacked = stateWith(true);
stacked.players.push(Object.assign({}, stacked.players[0], {
  id: 'B', name: '乙', y: stacked.players[0].y - Rules.C.PLAYER_H, onPlayer: 'A'
}));
render.draw(stacked, scene, charOf, 0, 0);
const lowerName = actorSvg.children[0].children[1];
const upperName = actorSvg.children[1].children[1];
assert.ok(Number(lowerName.attributes.get('y')) > render.view.scale * Rules.C.PLAYER_H,
  '托著別人時暱稱移到腳下，不遮住上面玩家');
assert.equal(upperName.attributes.get('y'), '-6', '上面玩家的暱稱仍在頭頂');
stacked.players[1].onPlayer = null;
render.draw(stacked, scene, charOf, 0, 0);
assert.equal(lowerName.attributes.get('y'), '-6', '解除支撐後暱稱回到頭頂');

console.log('✓ 角色死亡後立即從畫面移除');
console.log('✓ 疊人暱稱避開上面玩家並在分開後復原');

const tallCanvas = {
  getContext: () => fakeContext(),
  getBoundingClientRect: () => ({ width: 390, height: 684 })
};
const tallActors = new FakeElement('svg');
const tallRender = loadRender().create(tallCanvas, tallActors);
tallRender.setOptions({ viewH: 24, fitHeight: true });
assert.ok(tallRender.view.h < 684, '直向延展使用原場景座標高度');
assert.ok((tallRender.view.h - tallRender.view.voidTop) / tallRender.view.h < 0.06,
  '填滿操作區上方時，深淵仍小於場景的 6%');
assert.equal(tallActors.attributes.get('preserveAspectRatio'), 'none',
  '角色與 Canvas 同步延展，保持落點對齊');
tallRender.setOptions({ fitHeight: false });
assert.equal(tallRender.view.h, 684, '離開直向模式後恢復一般場景高度');
assert.equal(tallActors.attributes.get('preserveAspectRatio'), 'xMidYMid meet');
console.log('✓ 直向填滿操作區上方，同步角色座標並保留深淵比例');

// 各裝置等比縮小，SVG 本地腳底 y=160 仍對齊規則中的腳底。
for (const [device, width, height, viewH, fitHeight] of [
  ['手機直向', 390, 684, 24, true],
  ['手機橫向', 676, 390, 16, false],
  ['平板直向', 768, 790, 18, true],
  ['平板橫向', 1024, 768, 16, false],
  ['桌機', 1156, 900, 16, false]
]) {
  const deviceCanvas = {
    getContext: () => fakeContext(),
    getBoundingClientRect: () => ({ width, height })
  };
  const deviceActors = new FakeElement('svg');
  const deviceRender = loadRender().create(deviceCanvas, deviceActors);
  deviceRender.setOptions({ viewH, fitHeight });
  deviceRender.draw(stateWith(true), scene, charOf, 0, 0);
  for (const reduceMotion of [false, true]) {
    deviceRender.setOptions({ reduceMotion });
    for (const status of [{}, { flipIn: Rules.C.FLIP_DELAY / 2 }, { flipLeft: Rules.C.FLIP_RECOVER * 0.8 }, { flipLeft: 0.1 }]) {
      const flipState = stateWith(true);
      flipState.steps = [Object.assign({ id: 'flip', kind: 'flip', depth: 4, x0: 3, x1: 8 }, status)];
      const before = JSON.stringify(flipState.steps);
      deviceRender.draw(flipState, scene, charOf, 0, 1 / 60);
      assert.equal(JSON.stringify(flipState.steps), before, device + '：繪圖不改變翻轉計時');
    }
  }
  const actor = deviceActors.children[0];
  const k = Number(actor.children[0].attributes.get('transform').match(/scale\(([^)]+)\)/)[1]);
  const y = Number(actor.attributes.get('transform').match(/translate\([^,]+,([^)]+)\)/)[1]);
  const scale = deviceRender.view.scale;
  assert.ok(Math.abs(k / (scale * 1.25 / 100) - 0.95) < 0.001,
    device + '：角色繪圖縮小 5%');
  const expectedFeet = deviceRender.view.offY + 3 * scale;
  assert.ok(Math.abs(y + 160 * k - expectedFeet) < 0.07,
    device + '：縮小後腳底仍對齊階梯');
}
console.log('✓ 手機、平板直橫向與桌機的角色縮放及腳底座標');

const flipScales = [];
const flipCanvas = {
  getContext: () => fakeContext(flipScales),
  getBoundingClientRect: () => ({ width: 390, height: 684 })
};
const flipRender = loadRender().create(flipCanvas, new FakeElement('svg'));
for (const flipLeft of [Rules.C.FLIP_RECOVER - 0.18, Rules.C.FLIP_RECOVER / 2]) {
  flipScales.length = 0;
  const state = stateWith(true);
  state.steps = [{ id: 'flip', kind: 'flip', depth: 4, x0: 3, x1: 8, flipLeft }];
  flipRender.draw(state, scene, charOf, 0, 0);
  assert.ok(flipScales.some(([x, y]) => x === 1 && Math.abs(y + 1) < 1e-8),
    '0.18 秒內翻到背面，冷卻中保持背面');
}
flipRender.setOptions({ reduceMotion: true });
flipScales.length = 0;
const reducedFlipState = stateWith(true);
reducedFlipState.steps = [{ id: 'flip', kind: 'flip', depth: 4, x0: 3, x1: 8, flipLeft: Rules.C.FLIP_RECOVER / 2 }];
flipRender.draw(reducedFlipState, scene, charOf, 0, 0);
assert.ok(!flipScales.some(([, y]) => y < 0), '減少動態模式不旋轉翻板');
console.log('✓ 翻轉階快速翻面、背面停留與減少動態模式');
