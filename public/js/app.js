/* ===== app.js — 畫面流程、遊戲迴圈、設定與本機紀錄 =====
 * 規則一律問 rules.js，這裡只負責「什麼時候問」與「畫出來」。
 */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  const els = {
    nav: $('#screen-nav'), back: $('#btn-back'),
    settingsBtn: $('#btn-settings'), finishBtn: $('#btn-finish'),
    homeArt: $('#home-art'), homeRecords: $('#home-records'),
    nickname: $('#in-nickname'), charPicker: $('#char-picker'),
    diffPicker: $('#diff-picker'), diffNote: $('#diff-note'),
    start: $('#btn-start'),
    canvas: $('#canvas'), actors: $('#actors'), stage: $('#stage'),
    hudDepth: $('#hud-depth'), hudHp: $('#hud-hp'), hudHpRow: $('#hud-hp-row'),
    hudDiff: $('#hud-diff'), hudSpeed: $('#hud-speed'),
    hudWorld: $('#hud-world'), hudNext: $('#hud-next'),
    hudAvatar: $('#hud-avatar'), hudName: $('#hud-name'), hudWorldFill: $('#hud-world-fill'),
    liveSpikes: $('#live-spikes'), liveSprings: $('#live-springs'),
    liveFakes: $('#live-fakes'), liveCeil: $('#live-ceil'),
    hudNet: $('#hud-net'), hudBest: $('#hud-best'),
    hurtFlash: $('#overlay-hurt'),
    countdown: $('#overlay-countdown'), countdownNum: $('#countdown-num'),
    milestone: $('#overlay-milestone'), milestoneText: $('#milestone-text'),
    rotateTip: $('#rotate-tip'), rotateClose: $('#rotate-close'),
    pads: $('#pads'), padLeft: $('#pad-left'), padRight: $('#pad-right'),
    pause: $('#overlay-pause'), resume: $('#btn-resume'), restart: $('#btn-restart'), goHome: $('#btn-home'),
    resultTitle: $('#result-title'), resultHero: $('#result-hero'), resultNew: $('#result-new'),
    resultList: $('#result-list'), again: $('#btn-again'), changeDiff: $('#btn-change-diff'),
    modal: $('#modal-settings'), modalClose: $('#btn-settings-close'), setMsg: $('#set-msg'),
    setBgm: $('#set-bgm'), setBgmVol: $('#set-bgm-vol'),
    setSfx: $('#set-sfx'), setSfxVol: $('#set-sfx-vol'),
    setVibrate: $('#set-vibrate'), setMotion: $('#set-motion'),
    setColor: $('#set-color'), setGuide: $('#set-guide'),
    setClear: $('#set-clear'), setReset: $('#set-reset'),
    helpSteps: $('#help-steps'), helpCeiling: $('#help-ceiling'), helpDiff: $('#help-diff')
  };

  let store = Store.load();
  const sound = Sound.create();
  const input = Input.create();
  const view = Render.create(els.canvas, els.actors);
  const settingsModal = SvgUI.modal(els.modal, els.settingsBtn);

  const G = {
    screen: 'home',
    match: null,
    raf: 0,
    last: 0,
    acc: 0,
    time: 0,                 /* 給動畫用的連續時間 */
    paused: false,
    difficulty: store.difficulty || 'normal',
    char: store.char || 'yuan',
    scene: Scenes.sceneFor(0),
    sceneFrom: null,
    sceneT: 1,
    milestoneTimer: 0,
    sinkBeep: 0
  };

  const charOf = id => Characters.byId(id);

  /* ================= 色彩：換世界的 0.8 秒漸變 ================= */

  function hex2rgb(h) {
    const s = String(h).replace('#', '');
    const v = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }
  function lerpColor(a, b, t) {
    if (typeof a !== 'string' || typeof b !== 'string' || a[0] !== '#' || b[0] !== '#') return b;
    const x = hex2rgb(a), y = hex2rgb(b);
    const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
    return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  }
  const PAIR_KEYS = ['sky', 'wood', 'belt', 'spring', 'spike', 'fake'];
  const SOLO_KEYS = ['far', 'mid', 'woodEdge'];

  /** 兩套主題之間的中間態；t=1 就是完全切到 b */
  function blendScene(a, b, t) {
    if (!a || t >= 1) return b;
    const out = Object.assign({}, b);
    for (const k of PAIR_KEYS) out[k] = b[k].map((c, i) => lerpColor(a[k][i], c, t));
    for (const k of SOLO_KEYS) out[k] = lerpColor(a[k], b[k], t);
    out.deco = t < 0.5 ? a.deco : b.deco;
    out.decoColors = t < 0.5 ? a.decoColors : b.decoColors;
    return out;
  }

  /* ================= 畫面切換 ================= */

  const BACK_TO = { setup: 'home', online: 'home', help: 'home', result: 'home' };

  function show(name) {
    G.screen = name;
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    els.nav.hidden = !BACK_TO[name];
    if (BACK_TO[name]) els.back.dataset.go = BACK_TO[name];
    els.pads.classList.toggle('hidden', name !== 'game');
    syncPads();
    els.finishBtn.hidden = true;
    if (name === 'home') renderHomeRecords();
    if (name === 'setup') renderSetup();
    if (name === 'game') { view.resize(); updateRotateTip(); }
  }

  function goto(name) {
    if (G.screen === 'game' && name !== 'game') stopMatch();
    show(name);
  }

  /* ================= 首頁 ================= */

  function renderHomeArt() {
    const picks = ['yuan', 'bobo', 'xing'].map(id =>
      '<svg viewBox="0 0 100 166" width="100" height="166" x="0" y="0">' +
      Render.buildKid(charOf(id), { id: 'home-' + id }) + '</svg>');
    els.homeArt.innerHTML = SvgUI.homeArt(picks);
  }

  function renderHomeRecords() {
    const lines = [];
    for (const id of Rules.DIFFICULTY_LIST) {
      const r = store.records[id];
      if (r && r.depth > 0) {
        lines.push('<span class="rec-line">' + Rules.DIFFICULTY[id].name + ' <b>' + r.depth + ' m</b></span>');
      }
    }
    const fav = Store.favoriteChar(store);
    const extra = [];
    if (store.bestWorld > 0) extra.push('去過 ' + Scenes.sceneFor(store.bestWorld).name);
    if (fav) extra.push('常用 ' + charOf(fav).name);
    els.homeRecords.innerHTML = lines.length
      ? '<div>最深紀錄：' + lines.join('') + '</div>' + (extra.length ? '<div>' + extra.join('・') + '</div>' : '')
      : '<div>還沒有紀錄，挑一個難度開始跑吧。</div>';
  }

  /* ================= 一個人玩：選角色與難度 ================= */

  const DIFF_NOTE = {
    baby: '很慢、不會出刺階與假階，被雲朵頂到也不扣血，20 顆愛心，想結束就按右上角「結束這局」。',
    easy: '慢慢加速，刺階與假階都比較少，12 顆愛心。',
    normal: '標準速度與比例，10 顆愛心。',
    hard: '一開始就很快，刺階與假階都多，只有 8 顆愛心。'
  };

  function renderSetup() {
    els.nickname.value = store.nickname || '';
    els.nickname.placeholder = Nicknames.random();

    els.charPicker.innerHTML = Characters.CHARACTERS.map(c =>
      '<button class="char-opt" type="button" role="radio" data-char="' + c.id + '" aria-checked="' +
      (c.id === G.char) + '">' + Render.kidAvatarSvg(c, 56) + c.name + '</button>').join('');

    els.diffPicker.innerHTML = Rules.DIFFICULTY_LIST.map(id => {
      const d = Rules.DIFFICULTY[id];
      const r = store.records[id];
      return '<button class="diff-opt" type="button" role="radio" data-diff="' + id + '" aria-checked="' +
        (id === G.difficulty) + '"><strong>' + d.name + '</strong><small>' +
        (d.ceilInterval == null ? '不會死' : d.hp + ' 顆愛心') +
        (r && r.depth ? '・最深 ' + r.depth + ' m' : '') + '</small></button>';
    }).join('');
    els.diffNote.textContent = DIFF_NOTE[G.difficulty] || '';
  }

  els.charPicker.addEventListener('click', e => {
    const btn = e.target.closest('[data-char]');
    if (!btn) return;
    G.char = btn.dataset.char;
    store.char = G.char; Store.save(store);
    sound.play('click');
    renderSetup();
  });
  els.diffPicker.addEventListener('click', e => {
    const btn = e.target.closest('[data-diff]');
    if (!btn) return;
    G.difficulty = btn.dataset.diff;
    store.difficulty = G.difficulty; Store.save(store);
    sound.play('click');
    renderSetup();
  });

  /* ================= 開始一局 ================= */

  function startMatch() {
    const name = (els.nickname.value || '').trim() || els.nickname.placeholder || '小玩家';
    store.nickname = name;
    store.char = G.char;
    store.difficulty = G.difficulty;
    Store.save(store);

    /* 每一局都換新的樓梯 seed（不做同座樓梯重打） */
    G.match = Rules.createMatch({
      difficulty: G.difficulty,
      mode: 'solo',
      players: [{ id: 'p1', name: name, char: G.char, kind: 'human' }]
    }, RNG.newSeed());

    G.paused = false;
    G.acc = 0;
    G.last = 0;
    G.milestoneTimer = 0;
    G.scene = Scenes.sceneFor(0);
    G.sceneFrom = null;
    G.sceneT = 1;
    view.clearActors();
    applyRenderOptions();
    sound.setScene(0);
    sound.setTempo(1);
    els.milestone.hidden = true;
    show('game');
    els.finishBtn.hidden = !G.match.diff.endless;
    updateHud(true);
    input.clear();
    loop(0);
  }

  function stopMatch() {
    if (G.raf) cancelAnimationFrame(G.raf);
    G.raf = 0;
    G.match = null;
    G.paused = false;
    els.pause.hidden = true;
    els.countdown.hidden = true;
    els.milestone.hidden = true;
    if (els.hurtFlash) els.hurtFlash.classList.remove('blink');
    view.clearActors();
    input.clear();
  }

  /* ================= 遊戲迴圈（固定步長） ================= */

  function loop(now) {
    G.raf = requestAnimationFrame(loop);
    const s = G.match;
    if (!s) return;
    if (!G.last) G.last = now;
    let dt = (now - G.last) / 1000;
    G.last = now;
    if (dt > 0.25) dt = 0.25;                 /* 切到別的分頁回來不要一次補一大段 */

    if (!G.paused && s.phase !== 'over') {
      G.time += dt;
      G.acc += dt * 1000;
      let guard = 0;
      while (G.acc >= Rules.STEP_MS && guard++ < 12) {
        G.acc -= Rules.STEP_MS;
        const cmd = input.read();
        const r = Rules.stepMatch(s, { p1: { dir: cmd.dir } }, Rules.STEP_MS);
        handleEvents(r.events);
        if (s.phase === 'over') break;
      }
      /* 還在往下沉就持續嗶，越接近掉出去嗶得越密 */
      const me = s.players[0];
      if (me && me.alive && me.sinking > 0) {
        G.sinkBeep -= dt;
        if (G.sinkBeep <= 0) {
          sound.play('sink');
          G.sinkBeep = Math.max(0.12, 0.42 - me.sinking * 0.05);
        }
      } else {
        G.sinkBeep = 0;
      }
      if (G.milestoneTimer > 0) {
        G.milestoneTimer -= dt;
        if (G.milestoneTimer <= 0) els.milestone.hidden = true;
      }
      if (G.sceneT < 1) {
        G.sceneT = Math.min(1, G.sceneT + dt / 0.8);   /* 0.8 秒漸變 */
      }
    }

    els.countdown.hidden = s.phase !== 'countdown';
    if (s.phase === 'countdown') els.countdownNum.textContent = Math.max(1, Math.ceil(s.countdown));

    const scene = blendScene(G.sceneFrom, G.scene, G.sceneT);
    view.draw(s, scene, charOf, G.time, G.paused ? 0 : dt);
    updateHud(false);
  }

  /* ================= 事件 → 音效、粒子、震動 ================= */

  function handleEvents(events) {
    const s = G.match;
    for (const e of events) {
      switch (e.type) {
        case 'countdown':
          sound.play('click');
          break;
        case 'start':
          els.countdown.hidden = true;
          break;
        case 'land':
          if (e.kind === 'normal' || e.kind === 'belt') sound.play('land');
          break;
        case 'spring': {
          sound.play('spring');
          const st = Rules.stepById(s, e.step);
          if (st) view.burst('spring', (st.x0 + st.x1) / 2, st.depth, s.cameraTop);
          break;
        }
        case 'fakeCrack':
          sound.play('fake');
          break;
        case 'fakeBreak':
          view.burst('fake', e.x, e.depth, s.cameraTop);
          break;
        case 'spike': {
          sound.play('spike');
          const st = Rules.stepById(s, e.step);
          const p = s.players.find(x => x.id === e.player);
          /* 粒子從刺階的接觸點往上噴，比從角色身上噴更看得懂發生了什麼 */
          if (p) view.burst('spike', p.x, st ? st.depth : p.y, s.cameraTop);
          view.kick(9);
          flashHurt(true);
          buzz(35);
          break;
        }
        case 'hurt':
          /* 踩刺已經有自己的一整套聲音與畫面（上面那個 case），這裡只處理天花板 */
          if (e.source === 'ceiling') {
            /* 天花板上面也是刺，被刺到的反饋要跟踩到刺階一樣明顯 */
            sound.play('warn');
            sound.play('spike');
            view.kick(8);
            flashHurt(true);
            buzz(35);
          }
          break;
        case 'milestone': {
          sound.play('milestone');
          els.milestoneText.textContent = e.meters + ' m！' + Scenes.sceneFor(e.world).name;
          els.milestone.hidden = false;
          G.milestoneTimer = 1.4;
          const p = s.players[0];
          view.burst('milestone', p.x, p.y, s.cameraTop);
          /* 換世界：0.8 秒漸變，樓梯不停、操作不中斷 */
          G.sceneFrom = blendScene(G.sceneFrom, G.scene, G.sceneT);
          G.scene = Scenes.sceneFor(e.world);
          G.sceneT = store.reduceMotion ? 1 : 0;
          sound.setScene(e.scene);
          break;
        }
        case 'sinking':
          sound.play('sink');
          buzz(15);
          break;
        case 'fell':
          sound.play('fell');
          view.kick(12);
          flashHurt(true);
          buzz(80);
          break;
        case 'eliminated':
          sound.play('dead');
          view.kick(10);
          buzz(60);
          break;
        case 'over':
          finish(e.result);
          break;
      }
    }
  }

  /** 受傷時畫面閃一圈紅光。減少動態時不關掉、只調弱（這是透明度不是位移） */
  let hurtTimer = 0;
  function flashHurt(strong) {
    const el = els.hurtFlash;
    if (!el) return;
    const peak = store.reduceMotion ? (strong ? 0.45 : 0.3) : (strong ? 1 : 0.75);
    el.style.setProperty('--peak', String(peak));
    /* 先拿掉 class 並強制重排，動畫才會從頭播 —— 連續被刺時每一下都要重新閃 */
    el.classList.remove('blink');
    void el.offsetWidth;
    el.classList.add('blink');
    clearTimeout(hurtTimer);
    hurtTimer = setTimeout(() => el.classList.remove('blink'), 560);
  }

  function buzz(ms) {
    if (!store.vibrate) return;
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* 忽略 */ }
  }

  /* ================= 資訊欄 ================= */

  let hudCache = { depth: -1, hp: -1, world: -1, speed: '', compact: null };

  /** 窄的薄狀態列擠不下一整排愛心（手機直向 10 顆就會被裁掉），改用「愛心＋數字」。
   * 平板直向有 800 多 px，照樣排一整排愛心比較好讀，所以要看寬度不是只看方向。 */
  function narrowHud() {
    try {
      return window.matchMedia('(orientation: portrait)').matches && window.innerWidth < 620;
    } catch (e) { return false; }
  }

  function updateHud(force) {
    const s = G.match;
    if (!s) return;
    const p = s.players[0];
    const meters = Math.floor(p.best);
    if (force || meters !== hudCache.depth) {
      els.hudDepth.textContent = meters;
      hudCache.depth = meters;
    }
    const compact = s.diff.hpAsNumber || narrowHud();
    if (force || p.hp !== hudCache.hp || compact !== hudCache.compact) {
      els.hudHp.innerHTML = SvgUI.hearts(p.hp, p.hpMax, compact);
      hudCache.hp = p.hp;
      hudCache.compact = compact;
    }
    const speed = '×' + s.scrollMul.toFixed(1);
    if (force || speed !== hudCache.speed) {
      els.hudSpeed.textContent = speed;
      hudCache.speed = speed;
      sound.setTempo(s.scrollMul);
    }
    if (force || s.world !== hudCache.world || compact !== hudCache.compactWorld) {
      const sc = Scenes.sceneFor(s.world);
      /* 直向只放世界名稱，「（第 N 層）」擠不下也不重要 */
      els.hudWorld.textContent = compact ? sc.name : sc.name + '（第 ' + (s.world + 1) + ' 層）';
      hudCache.world = s.world;
      hudCache.compactWorld = compact;
    }
    const nextAt = (s.world + 1) * Rules.C.MILESTONE;
    const left = Math.max(0, Math.ceil(nextAt - p.best));
    els.hudNext.textContent = '下一層還有 ' + left + ' m';
    if (els.liveSpikes) {
      els.liveSpikes.textContent = p.stats.spikes;
      els.liveSprings.textContent = p.stats.springs;
      els.liveFakes.textContent = p.stats.fakes;
      els.liveCeil.textContent = p.stats.ceilingSeconds.toFixed(1) + ' 秒';
    }
    if (els.hudWorldFill) {
      const into = Math.max(0, Math.min(1, (p.best % Rules.C.MILESTONE) / Rules.C.MILESTONE));
      els.hudWorldFill.style.width = (into * 100).toFixed(1) + '%';
    }
    if (force) {
      els.hudDiff.textContent = s.diff.name;
      els.hudNet.textContent = '單機一人挑戰';
      const rec = store.records[s.difficulty];
      els.hudBest.textContent = rec && rec.depth ? '本機最深 ' + rec.depth + ' m' : '還沒有紀錄';
      els.hudHpRow.hidden = false;
      els.hudName.textContent = p.name;
      els.hudAvatar.innerHTML = Render.kidAvatarSvg(charOf(p.char), 50);
    }
  }

  /* ================= 結算 ================= */

  function fmtTime(sec) {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function finish(result) {
    const me = result.players[0];
    const saved = Store.record(store, {
      difficulty: result.difficulty,
      depth: me.depth,
      world: me.world,
      char: me.char
    });
    store = Store.load();

    els.resultTitle.textContent =
      result.endedBy === 'manual' ? '這局結束'
      : result.endedBy === 'fell' ? '摔下去了'
      : '沒血了';
    els.resultHero.innerHTML =
      Render.kidFullSvg(charOf(me.char), 132) +
      '<div class="result-line">' + me.name + ' 下到 <b>' + me.meters + ' m</b>' +
      '　撐了 ' + fmtTime(me.survived) + '</div>' +
      '<div class="result-line">' + Rules.DIFFICULTY[result.difficulty].name +
      '・最深到 ' + Scenes.sceneFor(me.world).name + '</div>';
    els.resultNew.hidden = !saved.record;
    if (saved.record) { sound.play('win'); view.burst('milestone', 6, 0, 0); }

    /* 這局統計（一人挑戰自動省略「被推開」） */
    const rows = [
      ['踩到刺', me.stats.spikes + ' 次'],
      ['被天花板頂住', me.stats.ceilingSeconds.toFixed(1) + ' 秒'],
      ['踩到彈簧', me.stats.springs + ' 次'],
      ['踩破假階', me.stats.fakes + ' 次'],
      ['到達最深世界', Scenes.sceneFor(me.stats.deepestWorld).name],
      ['本機最深', saved.best.depth + ' m']
    ];
    if (result.mode === 'versus') rows.splice(4, 0, ['被推開', me.stats.pushes + ' 次']);
    els.resultList.innerHTML = rows.map(r =>
      '<li><span>' + r[0] + '</span><b>' + r[1] + '</b></li>').join('');

    els.finishBtn.hidden = true;
    show('result');
    if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
  }

  /* ================= 暫停選單（Esc；只有三顆） ================= */

  function togglePause(on) {
    const s = G.match;
    if (!s || s.phase === 'over' || G.screen !== 'game') return;
    if (settingsModal.isOpen) return;
    G.paused = on == null ? !G.paused : !!on;
    els.pause.hidden = !G.paused;
    if (G.paused) { input.clear(); els.resume.focus(); } else { G.last = 0; }
  }

  /* ================= 設定彈窗 ================= */

  function applyRenderOptions() {
    view.setOptions({
      reduceMotion: store.reduceMotion,
      colorAssist: store.colorAssist,
      depthGuide: store.depthGuide,
      /* 一律用 18 格。手機橫向原本會縮成 14 格放大角色，但摔死的判定線就在 18 格，
       * 看不到判定線就會死得莫名其妙，所以這裡不縮。 */
      viewH: Rules.C.VIEW_H
    });
  }

  /** 手機橫向：高度不足 → 縮短可見高度到 14 格並放大角色 */
  function shortStage() {
    return window.matchMedia('(orientation: landscape)').matches && window.innerHeight <= 480;
  }

  function syncSettingsUi() {
    els.setBgm.checked = store.bgm;
    els.setBgmVol.value = Math.round(store.bgmVol * 100);
    els.setSfx.checked = store.sfx;
    els.setSfxVol.value = Math.round(store.sfxVol * 100);
    els.setVibrate.checked = store.vibrate;
    els.setMotion.checked = store.reduceMotion;
    els.setColor.checked = store.colorAssist;
    els.setGuide.checked = store.depthGuide;
  }

  function pushSettings() {
    Store.save(store);
    sound.set('bgm', store.bgm);
    sound.set('bgmVol', store.bgmVol);
    sound.set('sfx', store.sfx);
    sound.set('sfxVol', store.sfxVol);
    input.setVibrate(store.vibrate);
    applyRenderOptions();
  }

  function bindSetting(el, key, isRange) {
    el.addEventListener('input', () => {
      store[key] = isRange ? Number(el.value) / 100 : el.checked;
      pushSettings();
      els.setMsg.textContent = '';
    });
  }
  bindSetting(els.setBgm, 'bgm');
  bindSetting(els.setBgmVol, 'bgmVol', true);
  bindSetting(els.setSfx, 'sfx');
  bindSetting(els.setSfxVol, 'sfxVol', true);
  bindSetting(els.setVibrate, 'vibrate');
  bindSetting(els.setMotion, 'reduceMotion');
  bindSetting(els.setColor, 'colorAssist');
  bindSetting(els.setGuide, 'depthGuide');

  els.settingsBtn.addEventListener('click', () => {
    sound.unlock();
    syncSettingsUi();
    els.setMsg.textContent = '';
    settingsModal.open(els.settingsBtn);
  });
  els.modalClose.addEventListener('click', () => settingsModal.close());
  els.modal.addEventListener('click', e => { if (e.target === els.modal) settingsModal.close(); });
  els.setClear.addEventListener('click', () => {
    store = Store.clearRecords(store);
    els.setMsg.textContent = '本機紀錄已清除。';
    renderHomeRecords();
    if (G.screen === 'setup') renderSetup();
  });
  els.setReset.addEventListener('click', () => {
    store = Store.resetSettings(store);
    syncSettingsUi();
    pushSettings();
    els.setMsg.textContent = '設定已恢復預設（紀錄保留）。';
  });

  /* ================= 怎麼玩：靜態圖文 ================= */

  function renderHelp() {
    const steps = [
      ['normal', '普通階', '站著不動，最安全的落腳點。'],
      ['belt', '輸送帶', '會把你帶著走（每秒 3 格）。可以逆著走，但只剩每秒 3 格，很慢。'],
      ['spring', '彈簧跳床', '踩到會往上彈一段，可以救命，也可能把你彈回天花板。'],
      ['spike', '刺階', '踩到扣 1 顆愛心，之後有 0.6 秒無敵閃爍。'],
      ['fake', '假階', '踩到 0.25 秒後就崩掉，只能當短暫落腳點。']
    ];
    els.helpSteps.innerHTML = steps.map(s =>
      '<li>' + SvgUI.stepIcon(s[0]) + '<div><b>' + s[1] + '</b><span>' + s[2] + '</span></div></li>').join('');

    els.helpCeiling.innerHTML =
      '<figure>' + SvgUI.ceilingIcon(false) + '<figcaption>簡單／普通／困難：尖刺天花板，被頂住會持續扣血。</figcaption></figure>' +
      '<figure>' + SvgUI.ceilingIcon(true) + '<figcaption>幼幼班：軟綿綿的雲朵，被頂到只會被輕輕推回來，不扣血。</figcaption></figure>';

    els.helpDiff.innerHTML = Rules.DIFFICULTY_LIST.map(id => {
      const d = Rules.DIFFICULTY[id];
      return '<li><b>' + d.name + '</b>：下捲每秒 ' + d.scrollBase + ' 格、每 ' + d.accelEvery +
        ' 秒加快 ' + Math.round(d.accelRate * 100) + '%（最多 ' + d.scrollCap + ' 倍）、' +
        (d.ceilInterval == null ? '不會扣血' : d.hp + ' 顆愛心，被頂每 ' + d.ceilInterval + ' 秒扣 1 顆') +
        '、刺階 ' + Math.round(d.spikeRate * 100) + '%、假階 ' + Math.round(d.fakeRate * 100) + '%。</li>';
    }).join('');
  }

  /* ================= 觸控能力 ================= */

  /** 有觸控就顯示左右兩顆大按鍵；純滑鼠桌機不顯示（只用鍵盤） */
  function hasTouch() {
    try {
      if (navigator.maxTouchPoints > 0) return true;
      if (window.matchMedia('(pointer: coarse)').matches) return true;
    } catch (e) { /* 忽略 */ }
    return 'ontouchstart' in window;
  }
  function syncPads() {
    els.pads.classList.toggle('no-touch', !hasTouch());
  }
  /* 有些裝置一開始回報得不準，真的碰到螢幕就立刻把按鍵放出來 */
  window.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') els.pads.classList.remove('no-touch');
  }, true);

  /* ================= 手機橫向提示 ================= */

  function updateRotateTip() {
    const show = shortStage() && !store.seenRotateTip;
    els.rotateTip.hidden = !show;
  }
  els.rotateClose.addEventListener('click', () => {
    store.seenRotateTip = true;
    Store.save(store);
    els.rotateTip.hidden = true;
  });

  /* ================= 綁事件 ================= */

  $$('[data-go]').forEach(btn => btn.addEventListener('click', () => {
    sound.unlock();
    sound.play('click');
    goto(btn.dataset.go);
  }));
  els.start.addEventListener('click', () => { sound.unlock(); startMatch(); });
  els.again.addEventListener('click', () => { sound.unlock(); startMatch(); });
  els.changeDiff.addEventListener('click', () => goto('setup'));
  els.resume.addEventListener('click', () => togglePause(false));
  els.restart.addEventListener('click', () => { togglePause(false); startMatch(); });
  els.goHome.addEventListener('click', () => { togglePause(false); goto('home'); });
  els.finishBtn.addEventListener('click', () => {
    if (!G.match || G.match.phase === 'over') return;
    finish(Rules.endMatch(G.match, 'manual'));
  });

  input.attach({ left: els.padLeft, right: els.padRight, pad: els.pads });
  input.onFirstGesture(() => sound.unlock());
  input.onEsc(() => togglePause());
  input.setVibrate(store.vibrate);
  els.padLeft.innerHTML = SvgUI.arrowIcon(-1);
  els.padRight.innerHTML = SvgUI.arrowIcon(1);
  els.settingsBtn.innerHTML = SvgUI.gearIcon();
  els.modalClose.innerHTML = SvgUI.closeIcon();

  window.addEventListener('resize', () => {
    applyRenderOptions();
    view.resize();
    updateRotateTip();
    syncPads();
    if (G.match) updateHud(true);
  });
  window.addEventListener('orientationchange', () => setTimeout(() => {
    applyRenderOptions(); view.resize(); updateRotateTip();
  }, 120));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && G.match && G.match.phase !== 'over') togglePause(true);
  });

  /* ================= 起手 ================= */

  renderHomeArt();
  renderHelp();
  syncPads();
  renderHomeRecords();
  syncSettingsUi();
  applyRenderOptions();
  input.setVibrate(store.vibrate);
  if (!store.char) { store.char = 'yuan'; }
  G.char = store.char;
  G.difficulty = store.difficulty || 'normal';
  show('home');
})();
