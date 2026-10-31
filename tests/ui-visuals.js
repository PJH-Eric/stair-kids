/* 視覺元件測試：首頁主視覺、房間卡片圖示、空席插畫、結算表情與徽章 */
'use strict';
const assert = require('node:assert/strict');
const { SvgUI } = require('../public/js/svgui.js');
const { Render } = require('../public/js/render.js');
const Characters = require('../public/js/themes/characters.js');
const Scenes = require('../public/js/themes/scenes.js');

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

const kid = Characters.byId ? Characters.byId('yuan') : Characters.CHARACTERS[0];

ok('首頁主視覺包含天花板刺、五種階梯與三位角色', () => {
  const svg = SvgUI.homeArt(['<g id="k0"/>', '<g id="k1"/>', '<g id="k2"/>']);
  for (const id of ['ha-wood', 'ha-belt', 'ha-spring', 'ha-spikebase', 'ha-metal']) assert.ok(svg.includes(id), id);
  assert.ok(svg.includes('stroke-dasharray'), '假階虛線');
  for (const id of ['k0', 'k1', 'k2']) assert.ok(svg.includes('id="' + id + '"'), id);
  assert.equal((svg.match(/<svg/g) || []).length, 1);
});

ok('房間卡片三種狀態圖示不同', () => {
  const a = SvgUI.roomStateIcon('waiting'), b = SvgUI.roomStateIcon('playing'), c = SvgUI.roomStateIcon('full');
  assert.notEqual(a, b); assert.notEqual(b, c); assert.notEqual(a, c);
});

ok('翻轉階具有獨立的轉軸與迴轉圖示', () => {
  const flip = SvgUI.stepIcon('flip');
  assert.notEqual(flip, SvgUI.stepIcon('fake'));
  assert.ok(flip.includes('<circle'));
  assert.ok(flip.includes('a8 8'));
});

ok('空席插畫使用該席位的玩家色', () => {
  assert.ok(SvgUI.emptySeatArt('#4F86D6').includes('#4F86D6'));
  assert.ok(SvgUI.emptySeatArt('#F2545B').includes('#F2545B'));
});

ok('結算徽章與皇冠可輸出，皇冠有替代文字', () => {
  assert.ok(SvgUI.medalIcon(30).includes('<svg'));
  assert.ok(/aria-label="[^"]+"/.test(SvgUI.crownIcon(30)));
});

ok('角色三種表情彼此不同且不影響預設表情', () => {
  const base = Render.kidFullSvg(kid, 120, null);
  const happy = Render.kidFullSvg(kid, 120, null, 'happy');
  const sad = Render.kidFullSvg(kid, 120, null, 'sad');
  const dizzy = Render.kidFullSvg(kid, 120, null, 'dizzy');
  assert.ok(!base.includes('k-mood'));
  for (const s of [happy, sad, dizzy]) assert.ok(s.includes('k-mood'));
  assert.equal(new Set([happy, sad, dizzy]).size, 3);
  assert.ok(Render.kidAvatarSvg(kid, 60, '#4F86D6', 'sad').includes('k-mood'));
});

ok('六個世界都有階梯材質需要的欄位', () => {
  for (const sc of Scenes.SCENES) {
    assert.ok(sc.id && sc.decoColors.length >= 4, sc.id);
  }
});

console.log('\n' + pass + ' 項通過，0 項失敗');
