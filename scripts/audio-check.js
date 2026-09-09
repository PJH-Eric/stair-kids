/* ===== scripts/audio-check.js — 音訊設定驗收 =====
 * 執行：node scripts/audio-check.js  或  npm run test:audio
 */
'use strict';

const fs = require('node:fs');
const vm = require('node:vm');

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

const contexts = [];
const timers = [];
class FakeGain {
  constructor() { this.gain = { value: 0 }; }
  connect() {}
}
class FakeAudioContext {
  constructor() {
    this.destination = {};
    this.currentTime = 0;
    this.gains = [];
    contexts.push(this);
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createOscillator() {
    return {
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}, start() {}, stop() {}
    };
  }
}

const sandbox = {
  self: null,
  AudioContext: FakeAudioContext,
  clearInterval: id => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
  setInterval: () => { const id = {}; timers.push(id); return id; },
  clearTimeout,
  setTimeout,
  Math
};
sandbox.self = sandbox;
vm.runInNewContext(fs.readFileSync('public/js/audio.js', 'utf8'), sandbox, {
  filename: 'public/js/audio.js'
});

console.log('\n音訊設定');
const sound = sandbox.Sound.create({ bgm: false, bgmVol: 0.35, sfx: false, sfxVol: 0.6 });
sound.unlock();
const [, sfx, bgm] = contexts[0].gains;
eq(sfx.gain.value, 0, '首次解鎖時套用關閉的音效設定');
eq(bgm.gain.value, 0, '首次解鎖時套用關閉的背景音樂設定');
eq(timers.length, 0, '背景音樂關閉時不會啟動排程');

sound.set('bgm', true);
sound.set('sfx', true);
eq(bgm.gain.value, 0.35, '即時開啟背景音樂會恢復音量');
eq(sfx.gain.value, 0.6, '即時開啟音效會恢復音量');
eq(timers.length, 1, '即時開啟背景音樂會啟動排程');

sound.set('bgm', false);
sound.set('sfx', false);
eq(bgm.gain.value, 0, '即時關閉背景音樂會靜音');
eq(sfx.gain.value, 0, '即時關閉音效會靜音');
eq(timers.length, 0, '即時關閉背景音樂會停止排程');

console.log('\n────────────────────────────');
console.log(`${pass} 項通過，${fail} 項失敗`);
if (fail) {
  console.error('\n失敗項目：\n- ' + failures.join('\n- '));
  process.exitCode = 1;
}
