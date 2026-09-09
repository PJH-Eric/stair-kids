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

function fakeContext() {
  const gradient = () => ({ addColorStop() {} });
  const target = {
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    measureText: () => ({ width: 0 })
  };
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

console.log('✓ 角色死亡後立即從畫面移除');
