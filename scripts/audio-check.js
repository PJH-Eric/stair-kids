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

/* ---------- 對手的事件不要在我這台機器上出聲音／震動（Eric 回報）----------
 * 症狀：對手踩到刺、回血、彈跳、快掉出去，我這邊照樣播音效，下沉甚至會震動 ——
 * 玩家什麼事都沒有卻聽到慘叫又感覺到震動，會以為是自己出事。
 * 這一組是看原始碼的結構驗的：handleEvents() 裡每一個「有 player 的事件」
 * 都必須先分辨是不是自己的（app.js 的 forMe → mine），不然就是又漏掉了一種。 */
{
  const appSrc = fs.readFileSync('public/js/app.js', 'utf8');
  const from = appSrc.indexOf('function handleEvents(');
  const body = from < 0 ? '' : appSrc.slice(from, appSrc.indexOf('\n  }\n', from));
  ok(!!body, '找得到 handleEvents()');
  const caseBlock = name => {
    const head = body.indexOf(`case '${name}':`);
    if (head < 0) return '';
    const next = body.indexOf("\n        case '", head + 1);
    return body.slice(head, next < 0 ? body.length : next);
  };
  /* rules.js 裡每一個帶 player 的事件（grep "events.push({ type:" 就是這幾個） */
  for (const name of ['land', 'spring', 'fakeCrack', 'spike', 'hurt', 'heal', 'sinking', 'fell', 'eliminated']) {
    const block = caseBlock(name);
    ok(block && /\bmine\b/.test(block), `「${name}」會先分辨是誰的事件`);
  }
  /* 反過來也要顧：沒有 player 的是場地事件，不分你我，不可以被一起關掉 */
  ok(!/\bmine\b/.test(caseBlock('countdown')), '倒數是場地事件，照樣要出聲');
  ok(!/\bmine\b/.test(caseBlock('fakeBreak')), '假階崩解是場地事件，照樣要畫');
  /* 震動只能是自己的事（對手下沉震我的手機是原本的 bug） */
  const buzzLines = body.split('\n').filter(line => /\bbuzz\(/.test(line));
  ok(buzzLines.length > 0, '還有震動反饋');
  const sinkBlock = caseBlock('sinking');
  ok(/if \(!mine\) break;[\s\S]*buzz\(/.test(sinkBlock), '對手快掉出去不會震動我的手機');
}

console.log('\n────────────────────────────');
console.log(`${pass} 項通過，${fail} 項失敗`);
if (fail) {
  console.error('\n失敗項目：\n- ' + failures.join('\n- '));
  process.exitCode = 1;
}
