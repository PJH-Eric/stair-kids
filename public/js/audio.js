/* ===== audio.js — 木琴童謠風 BGM ＋ 音效（WebAudio 合成，不依賴外部音檔） =====
 * 規劃書 §8：同一段主旋律在每個世界換樂器變奏，速度倍率越高節拍越快。
 * 首次使用者手勢後才解鎖播放，符合瀏覽器規定。BGM／音效音量獨立。
 * 之後要換成指定資產時，只要替換 SFX／MELODY 這兩份資料就好。
 */
(function (root) {
  'use strict';

  /* 主旋律（同一段，六個世界只換樂器與音色）：C 大調的童謠句法 */
  const MELODY = [
    523, 587, 659, 784, 659, 587, 523, 587,
    659, 784, 880, 784, 659, 587, 523, 0
  ];
  const BASS = [131, 0, 165, 0, 196, 0, 165, 0, 131, 0, 175, 0, 196, 0, 131, 0];

  /* 六套世界的樂器變奏（規劃書 §8） */
  const INSTRUMENTS = [
    { id: 'xylophone', name: '木琴', wave: 'triangle', decay: 0.28, gain: 0.20, octave: 1, wash: 0 },
    { id: 'harmonica', name: '口琴', wave: 'sawtooth', decay: 0.46, gain: 0.11, octave: 1, wash: 0, vibrato: 6 },
    { id: 'glockenspiel', name: '鋼片琴', wave: 'sine', decay: 0.55, gain: 0.17, octave: 2, wash: 0.05 },
    { id: 'recorder', name: '木笛', wave: 'sine', decay: 0.40, gain: 0.16, octave: 1, attack: 0.05 },
    { id: 'chime', name: '鐘琴', wave: 'triangle', decay: 0.85, gain: 0.15, octave: 2 },
    { id: 'synth', name: '電子音', wave: 'square', decay: 0.22, gain: 0.09, octave: 1 }
  ];

  function create() {
    let ctx = null;
    let master = null, sfxGain = null, bgmGain = null;
    let unlocked = false;
    let timer = null, cursor = 0;
    let scene = 0;            /* 目前世界對應的樂器索引 */
    let tempoMul = 1;         /* 速度倍率越高，節拍越快 */
    const settings = { bgm: true, sfx: true, bgmVol: 0.35, sfxVol: 0.6 };

    function unlock() {
      if (unlocked) return;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      try { ctx = new AC(); } catch (e) { return; }
      master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
      sfxGain = ctx.createGain(); sfxGain.gain.value = settings.sfx ? settings.sfxVol : 0; sfxGain.connect(master);
      bgmGain = ctx.createGain(); bgmGain.gain.value = settings.bgm ? settings.bgmVol : 0; bgmGain.connect(master);
      unlocked = true;
      if (settings.bgm) startBgm();
    }

    function tone(freq, dur, wave, gainVal, slideTo, dest, opt) {
      if (!unlocked || !freq) return;
      opt = opt || {};
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = wave || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
      const attack = opt.attack || 0.012;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainVal || 0.3), t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(dest || sfxGain);
      if (opt.vibrato) {
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = opt.vibrato; lg.gain.value = freq * 0.012;
        lfo.connect(lg); lg.connect(osc.frequency);
        lfo.start(); lfo.stop(t0 + dur + 0.02);
      }
      osc.start(); osc.stop(t0 + dur + 0.03);
    }

    function noise(dur, cut, gainVal, dest) {
      if (!unlocked) return;
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = cut || 1200;
      const g = ctx.createGain(); g.gain.value = gainVal || 0.3;
      src.connect(filt); filt.connect(g); g.connect(dest || sfxGain);
      src.start();
    }

    /* 音效清單（規劃書 §8） */
    const SFX = {
      step: () => noise(0.05, 700, 0.10),                                        /* 腳步 */
      land: () => { noise(0.09, 520, 0.18); tone(180, 0.10, 'sine', 0.16, 120); },/* 落地 */
      spring: () => tone(320, 0.22, 'sine', 0.34, 900),                          /* 彈簧「啵」 */
      fake: () => { noise(0.2, 2400, 0.26); tone(520, 0.14, 'square', 0.10, 200); }, /* 假階碎裂 */
      /* 踩刺「唉呦」：金屬刺聲 ＋ 小朋友的短促叫聲 ＋ 一點撞擊噪音，三層疊起來才夠痛 */
      spike: () => {
        noise(0.07, 5200, 0.30);
        tone(1180, 0.07, 'square', 0.26, 620);
        tone(880, 0.20, 'triangle', 0.30, 430);
        setTimeout(() => tone(560, 0.20, 'triangle', 0.22, 300), 80);
        tone(190, 0.26, 'sine', 0.24, 90);
      },
      soft: () => tone(420, 0.16, 'sine', 0.22, 620),                            /* 幼幼班雲朵「啵」 */
      warn: () => { tone(880, 0.09, 'square', 0.16); setTimeout(() => tone(660, 0.09, 'square', 0.14), 90); },
      hurt: () => tone(240, 0.30, 'sawtooth', 0.22, 110),
      milestone: () => [0, 90, 180, 300].forEach((d, i) =>
        setTimeout(() => tone([659, 784, 988, 1319][i], 0.30, 'triangle', 0.26), d)),
      dead: () => [0, 130, 260].forEach((d, i) =>
        setTimeout(() => tone([392, 330, 262][i], 0.34, 'sine', 0.26), d)),
      win: () => [0, 90, 180, 300, 430].forEach((d, i) =>
        setTimeout(() => tone([523, 659, 784, 1047, 1319][i], 0.30, 'triangle', 0.26), d)),
      click: () => tone(660, 0.07, 'triangle', 0.18)
    };

    function play(name) {
      if (!unlocked || !settings.sfx) return;
      const fn = SFX[name];
      if (fn) fn();
    }

    /* ---------- BGM ---------- */

    function beat() {
      if (!settings.bgm || !unlocked) return;
      const inst = INSTRUMENTS[scene % INSTRUMENTS.length];
      const i = cursor % MELODY.length;
      const f = MELODY[i] * (inst.octave || 1);
      if (f) tone(f, inst.decay, inst.wave, inst.gain, null, bgmGain, { attack: inst.attack, vibrato: inst.vibrato });
      const b = BASS[i];
      if (b) tone(b, inst.decay * 1.4, 'sine', inst.gain * 0.6, null, bgmGain);
      if (inst.wash && i % 8 === 0) noise(0.7, 900, inst.wash, bgmGain);   /* 海邊的浪聲 */
      cursor++;
    }

    function schedule() {
      if (timer) clearInterval(timer);
      const ms = Math.max(150, Math.round(420 / tempoMul));
      timer = setInterval(beat, ms);
    }

    function startBgm() {
      if (!unlocked) return;
      schedule();
    }
    function stopBgm() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    /** 換世界：換樂器，順著過場切過去（旋律不重頭來） */
    function setScene(index) {
      scene = ((index % INSTRUMENTS.length) + INSTRUMENTS.length) % INSTRUMENTS.length;
    }
    /** 速度倍率越高，節拍跟著加快 */
    function setTempo(mul) {
      const next = Math.max(0.6, Math.min(2.6, mul || 1));
      if (Math.abs(next - tempoMul) < 0.05) return;
      tempoMul = next;
      if (timer) schedule();
    }

    function set(key, value) {
      settings[key] = value;
      if (!unlocked) return;
      if (key === 'bgm' || key === 'bgmVol') bgmGain.gain.value = settings.bgm ? settings.bgmVol : 0;
      if (key === 'sfx' || key === 'sfxVol') sfxGain.gain.value = settings.sfx ? settings.sfxVol : 0;
      if (key === 'bgm') { if (value) startBgm(); else stopBgm(); }
    }

    return {
      unlock, play, set, setScene, setTempo, startBgm, stopBgm,
      settings, INSTRUMENTS,
      get unlocked() { return unlocked; }
    };
  }

  root.Sound = { create, MELODY, INSTRUMENTS };
})(typeof self !== 'undefined' ? self : this);
