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
    setupTitle: $('#setup-title'), setupHint: $('#setup-hint'), diffLabel: $('#diff-label'),
    vsAi: $('#btn-vs-ai'), start: $('#btn-start'),
    sideFoe: $('#side-foe'), hudFoeName: $('#hud-foe-name'), hudFoeLabel: $('#hud-foe-label'),
    hudFoeDepth: $('#hud-foe-depth'), hudFoeHp: $('#hud-foe-hp'),
    canvas: $('#canvas'), actors: $('#actors'), stage: $('#stage'),
    hudDepth: $('#hud-depth'), hudHp: $('#hud-hp'), hudHpRow: $('#hud-hp-row'),
    hudDiff: $('#hud-diff'), hudSpeed: $('#hud-speed'),
    hudWorld: $('#hud-world'), hudNext: $('#hud-next'),
    hudAvatar: $('#hud-avatar'), hudName: $('#hud-name'), hudWorldFill: $('#hud-world-fill'),
    liveSpikes: $('#live-spikes'), liveSprings: $('#live-springs'),
    liveFakes: $('#live-fakes'), liveCeil: $('#live-ceil'),
    hudNet: $('#hud-net'), hudBest: $('#hud-best'),
    hurtFlash: $('#overlay-hurt'),
    dmgPop: $('#dmg-pop'),
    countdown: $('#overlay-countdown'), countdownNum: $('#countdown-num'),
    milestone: $('#overlay-milestone'), milestoneText: $('#milestone-text'),
    rotateTip: $('#rotate-tip'), rotateClose: $('#rotate-close'),
    pads: $('#pads'), padLeft: $('#pad-left'), padRight: $('#pad-right'),
    pause: $('#overlay-pause'), pauseTitle: $('#pause-title'),
    resume: $('#btn-resume'), restart: $('#btn-restart'), goHome: $('#btn-home'),
    spectateTag: $('#spectate-tag'), sideChat: $('#side-chat'), toast: $('#toast'),
    ovResult: $('#ov-result'),
    resultTitle: $('#result-title'), resultHero: $('#result-hero'), resultNew: $('#result-new'),
    resultList: $('#result-list'), again: $('#btn-again'), changeDiff: $('#btn-change-diff'),
    resultHome: $('#btn-result-home'),
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

  /* 線上模式。伺服器位置一律問 config.js，這裡不硬編碼也不回退 localhost。 */
  const online = Online.create({
    serverUrl: (self.Config && Config.serverUrl) || null,
    /* 沒自己取名字就送空的，讓伺服器配一個可愛的隨機暱稱 ——
     * 不然兩個人都會叫「小玩家」，對手欄根本分不出誰是誰 */
    nameOf: () => (store.nickname || '').trim(),
    charOf: () => G.char,
    /* 畫面內插要在每個固定步之前存一份位置，線上跟單機走同一套 */
    beforeStep: st => snapshotPrev(st),
    onNotice: (text, kind) => toast(text, kind),
    onEnterRoom: () => { if (G.screen !== 'game') show('room'); },
    onMatchStart: info => startOnlineMatch(info),
    onMatchEnd: (result, meId) => finish(result, meId),
    onBackToLobby: () => {
      /* 兩種情況都走這裡：一局收掉了（回房間等下一局），或是離開／被踢（回大廳） */
      if (G.mode === 'online') { backFromOnlineMatch(); return; }
      if (G.screen === 'room' || G.screen === 'game') show('lobby');
    }
  });

  const G = {
    screen: 'home',
    match: null,
    raf: 0,
    last: 0,
    acc: 0,
    time: 0,                 /* 給動畫用的連續時間 */
    paused: false,
    mode: 'solo',                /* 'solo' 一個人玩｜'ai' 跟電腦對戰｜'online' 線上 */
    ai: null,                    /* 對戰時的 AI 控制器 */
    meId: 'p1',                  /* 哪一位是「我」（線上時是伺服器給的 id；觀戰時借用一號位） */
    spectating: false,
    menu: false,                 /* 線上模式的 Esc 選單（遊戲照跑，不暫停） */
    netInfo: '',
    difficulty: store.difficulty || 'normal',
    char: store.char || 'yuan',
    scene: Scenes.sceneFor(0),
    sceneFrom: null,
    sceneT: 1,
    milestoneTimer: 0,
    sinkBeep: 0,
    prev: { ready: false, cameraTop: 0, players: {} },
    healPulse: false
  };

  const charOf = id => Characters.byId(id);

  /* 「我」不一定是 players[0]：線上對戰的席位順序由伺服器決定，觀戰時根本沒有我。
   * 所有 HUD 與結算都走這兩個函式，才不會在線上模式顯示錯人的血量。 */
  const mePlayer = s => (s && s.players.find(p => p.id === G.meId)) || (s && s.players[0]) || null;
  const foePlayer = s => {
    const m = mePlayer(s);
    return (s && s.players.find(p => p !== m)) || null;
  };

  /* ================= 短提示 ================= */

  let toastTimer = 0;
  function toast(text, kind) {
    if (!els.toast || !text) return;
    els.toast.textContent = text;
    els.toast.classList.toggle('bad', kind === 'bad');
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

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

  const BACK_TO = { setup: 'home', online: 'home', help: 'home', lobby: 'online', room: 'lobby' };

  function show(name) {
    G.screen = name;
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    els.nav.hidden = !BACK_TO[name];
    if (BACK_TO[name]) els.back.dataset.go = BACK_TO[name];
    els.pads.classList.toggle('hidden', name !== 'game');
    if (name !== 'game' && els.ovResult) els.ovResult.hidden = true;
    syncPads();
    els.finishBtn.hidden = true;
    if (name === 'home') renderHomeRecords();
    if (name === 'setup') renderSetup();
    if (name === 'game') { view.resize(); updateRotateTip(); }
    if (name === 'lobby') {
      online.syncMe((store.nickname || '').trim(), G.char);
      online.connect();
      online.renderLobby();
    }
    if (name === 'room') online.renderRoom();
    if (name !== 'game') {
      if (els.spectateTag) els.spectateTag.hidden = true;
      if (els.sideChat) els.sideChat.hidden = true;
    }
  }

  function goto(name) {
    const leavingRoom = (G.screen === 'room' || (G.screen === 'game' && G.mode === 'online')) &&
      name !== 'room' && name !== 'game';
    if (G.screen === 'game' && name !== 'game') stopMatch();
    /* 從房間或對局裡走掉就是離開房間（對局中離開＝判輸，規劃書 §4.4） */
    if (leavingRoom) {
      const c = online.client();
      if (c) c.actions.leave();
    }
    /* 完全離開線上區域就把連線收掉，房間才不會一直掛著一個離線的人 */
    if (name !== 'lobby' && name !== 'room' && name !== 'game') online.disconnect();
    show(name);
  }

  const currentName = () =>
    (els.nickname.value || '').trim() || store.nickname || els.nickname.placeholder || '小玩家';

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

  /** 對戰不開放幼幼班：不會死就分不出勝負（規劃書 §0.2） */
  function diffChoices() {
    return G.mode === 'ai'
      ? Rules.DIFFICULTY_LIST.filter(id => Rules.DIFFICULTY[id].versus)
      : Rules.DIFFICULTY_LIST;
  }

  function renderSetup() {
    const vs = G.mode === 'ai';
    els.setupTitle.textContent = vs ? '跟電腦對戰' : '一個人玩';
    els.setupHint.textContent = vs
      ? '兩個人在同一座樓梯上，會互相推擠。倒數 3 秒後開始，你一死就結束這局。'
      : '選一隻小朋友，挑一個難度，就可以開始無限往下跑。';
    els.diffLabel.textContent = vs ? '難度（電腦對手用同一個難度）' : '難度';
    els.start.textContent = vs ? '開始對戰' : '開始下樓梯';
    /* 從一個人玩切到對戰時，如果原本選的是幼幼班就退回普通 */
    if (vs && !Rules.DIFFICULTY[G.difficulty].versus) G.difficulty = 'normal';

    els.nickname.value = store.nickname || '';
    els.nickname.placeholder = Nicknames.random();

    els.charPicker.innerHTML = Characters.CHARACTERS.map(c =>
      '<button class="char-opt" type="button" role="radio" data-char="' + c.id + '" aria-checked="' +
      (c.id === G.char) + '">' + Render.kidAvatarSvg(c, 56) + c.name + '</button>').join('');

    els.diffPicker.innerHTML = diffChoices().map(id => {
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
    /* 換了角色就同步給伺服器，房間卡片與名牌才會跟著換 */
    online.syncMe((store.nickname || '').trim(), G.char);
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
    const seed = RNG.newSeed();
    const vs = G.mode === 'ai';
    const players = [{ id: 'p1', name: name, char: G.char, kind: 'human' }];
    if (vs) {
      /* 電腦對手：難度跟玩家共用同一個（規劃書 §1.7），角色挑一隻跟你不一樣的 */
      const foeChar = Characters.CHARACTERS.find(c => c.id !== G.char) || Characters.CHARACTERS[0];
      /* 別跟玩家撞名 */
      let foeName = Nicknames.random();
      for (let i = 0; i < 12 && foeName === name; i++) foeName = Nicknames.random();
      players.push({
        id: 'ai1',
        name: foeName + '（' + Rules.DIFFICULTY[G.difficulty].name + '）',
        char: foeChar.id,
        kind: 'ai',
        aiLevel: G.difficulty
      });
    }
    G.match = Rules.createMatch({
      difficulty: G.difficulty,
      mode: vs ? 'versus' : 'solo',
      players: players
    }, seed);
    G.ai = vs ? Ai.create(G.difficulty, 'ai1', seed) : null;

    G.paused = false;
    G.acc = 0;
    G.last = 0;
    G.milestoneTimer = 0;
    G.prev = { ready: false, cameraTop: 0, players: {} };
    G.scene = Scenes.sceneFor(0);
    G.sceneFrom = null;
    G.sceneT = 1;
    view.clearActors();
    applyRenderOptions();
    sound.setScene(0);
    sound.setTempo(1);
    els.milestone.hidden = true;
    if (els.ovResult) els.ovResult.hidden = true;
    show('game');
    els.finishBtn.hidden = !G.match.diff.endless;
    updateHud(true);
    input.clear();
    loop(0);
  }

  /** 伺服器說開打了（自己上場或觀戰都走這裡） */
  function startOnlineMatch(info) {
    G.mode = 'online';
    G.spectating = !!info.spectating;
    const s = online.match;
    if (!s) return;
    /* 觀戰沒有「我」，借一號位當主視角，HUD 才有東西可以顯示 */
    G.meId = G.spectating ? (s.players[0] && s.players[0].id) : info.meId;
    G.match = s;
    G.difficulty = s.difficulty;
    G.paused = false;
    G.menu = false;
    G.acc = 0;
    G.last = 0;
    G.milestoneTimer = 0;
    G.prev = { ready: false, cameraTop: 0, players: {} };
    G.scene = Scenes.sceneFor(0);
    G.sceneFrom = null;
    G.sceneT = 1;
    view.clearActors();
    applyRenderOptions();
    sound.setScene(0);
    sound.setTempo(1);
    els.milestone.hidden = true;
    if (els.ovResult) els.ovResult.hidden = true;
    show('game');
    els.finishBtn.hidden = true;
    if (els.spectateTag) els.spectateTag.hidden = !G.spectating;
    if (els.sideChat) els.sideChat.hidden = false;
    /* 觀戰不給方向鍵（也不會送輸入意圖） */
    els.pads.classList.toggle('hidden', G.spectating);
    online.renderChat();
    updateHud(true);
    input.clear();
    loop(0);
  }

  /** 這一局收掉了（結算停留結束）→ 回房間等下一局 */
  function backFromOnlineMatch() {
    if (G.mode !== 'online') return;
    stopMatch();
    G.mode = 'solo';
    G.meId = 'p1';
    G.spectating = false;
    /* 房間還在就回房間等下一局；房間沒了（被踢、房主關掉）就回大廳 */
    show(online.room ? 'room' : 'lobby');
  }

  function stopMatch() {
    if (G.raf) cancelAnimationFrame(G.raf);
    G.raf = 0;
    G.match = null;
    G.ai = null;
    G.paused = false;
    els.pause.hidden = true;
    els.countdown.hidden = true;
    els.milestone.hidden = true;
    if (els.ovResult) els.ovResult.hidden = true;
    if (els.hurtFlash) els.hurtFlash.classList.remove('blink');
    if (els.spectateTag) els.spectateTag.hidden = true;
    if (els.sideChat) els.sideChat.hidden = true;
    G.menu = false;
    view.clearActors();
    input.clear();
  }

  /* ================= 遊戲迴圈（固定步長） ================= */

  function loop(now) {
    G.raf = requestAnimationFrame(loop);
    /* 線上模式的狀態物件由 net.js 保管：收到完整快照時它會重建一份，
     * 所以每一格都要重新問，不能抓著舊的。 */
    if (G.mode === 'online') G.match = online.match;
    const s = G.match;
    if (!s) return;
    if (!G.last) G.last = now;
    let dt = (now - G.last) / 1000;
    G.last = now;
    if (dt > 0.25) dt = 0.25;                 /* 切到別的分頁回來不要一次補一大段 */

    if (G.mode === 'online') {
      onlineFrame(s, now, dt);
      return;
    }

    if (!G.paused && s.phase !== 'over') {
      G.time += dt;
      G.acc += dt * 1000;
      let guard = 0;
      while (G.acc >= Rules.STEP_MS && guard++ < 12) {
        G.acc -= Rules.STEP_MS;
        /* 畫面內插用：推進之前先記下「上一格」的鏡頭與角色位置 */
        snapshotPrev(s);
        const cmd = input.read();
        const inputs = { p1: { dir: cmd.dir } };
        /* AI 跟真人走同一個管道，也在同一個固定步長裡決策 */
        if (G.ai) inputs.ai1 = G.ai.read(s, Rules.STEP);
        const r = Rules.stepMatch(s, inputs, Rules.STEP_MS);
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
    /* 用「上一格」與「這一格」之間的內插來畫，畫面才不會跟著 60Hz 的固定步長一格一格跳。
     * 規則核心完全不動，只是畫的時候取中間值。 */
    view.draw(interpolated(s), scene, charOf, G.time, G.paused ? 0 : dt);
    updateHud(false);
  }

  /**
   * 線上模式的一格。跟單機最大的差別：
   *   · 不自己推進規則核心 —— 交給 net.js（本地預測 ＋ 收到快照後回溯重演校正）
   *   · 不能暫停（伺服器不會停），所以沒有 G.paused 這條路
   *   · 觀戰不讀輸入，也不送輸入意圖
   */
  function onlineFrame(s, now, dt) {
    G.time += dt;
    const cmd = G.spectating ? { dir: 0 } : input.read();
    online.frame(now, cmd.dir);
    handleEvents(online.takeEvents());

    els.countdown.hidden = s.phase !== 'countdown';
    if (s.phase === 'countdown') els.countdownNum.textContent = Math.max(1, Math.ceil(s.countdown));

    if (G.milestoneTimer > 0) {
      G.milestoneTimer -= dt;
      if (G.milestoneTimer <= 0) els.milestone.hidden = true;
    }
    if (G.sceneT < 1) G.sceneT = Math.min(1, G.sceneT + dt / 0.8);

    const scene = blendScene(G.sceneFrom, G.scene, G.sceneT);
    /* 校正之後的視覺補正只加在自己身上，這樣回溯重演不會看到瞬移 */
    view.draw(interpolated(s, online.alpha(), online.visualOffset()), scene, charOf, G.time, dt);
    updateHud(false);
  }

  /* ---------- 畫面內插（讓滾動變柔順） ---------- */

  /**
   * 規則核心是固定 1/60 秒一步，但畫面可能是 60Hz、120Hz 或不穩定的間隔。
   * 直接畫「最後跑完那一步」的狀態，就會有些畫格重複、有些跳兩格 —— 看起來就是頓。
   * 所以每一步之前先存一份位置，畫的時候按照累積器的餘數插值。
   */
  function snapshotPrev(s) {
    G.prev.cameraTop = s.cameraTop;
    for (const p of s.players) {
      let e = G.prev.players[p.id];
      if (!e) { e = G.prev.players[p.id] = { x: p.x, y: p.y }; }
      e.x = p.x;
      e.y = p.y;
    }
    G.prev.ready = true;
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  /**
   * @param {number} [alpha] 這一格落在兩個固定步之間的哪裡；沒給就用單機的累積器
   * @param {{x:number,y:number}} [offset] 只加在「我」身上的視覺補正（線上校正用）
   */
  function interpolated(s, alpha, offset) {
    if (!G.prev.ready || G.paused || s.phase !== 'playing') return s;
    const t = Math.max(0, Math.min(1, alpha == null ? G.acc / Rules.STEP_MS : alpha));
    /* 用原型繼承做一層薄薄的「畫面用狀態」：只覆蓋位置，
     * 其他欄位（階梯、難度、狀態旗標）都直接讀原本的，階梯的動畫計時也還是寫回同一份物件。 */
    const view = Object.create(s);
    view.cameraTop = lerp(G.prev.cameraTop, s.cameraTop, t);
    view.players = s.players.map(p => {
      const e = G.prev.players[p.id];
      if (!e) return p;
      const shown = Object.create(p);
      shown.x = lerp(e.x, p.x, t);
      shown.y = lerp(e.y, p.y, t);
      if (offset && p.id === G.meId) { shown.x += offset.x; shown.y += offset.y; }
      return shown;
    });
    return view;
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
          break;
        }
        case 'hurt': {
          /* 震動、閃紅光、跳出來的數字都跟「這一下扣幾顆」成正比 ——
           * 傷害改成 1～5 隨機之後，玩家要能一眼分出「刮到一下」跟「踩慘了」。 */
          const amount = e.amount || 1;
          if (e.source === 'ceiling') {
            /* 天花板上面也是刺，被刺到的反饋要跟踩到刺階一樣明顯 */
            sound.play('warn');
            sound.play('spike');
          }
          view.kick(6 + amount * 2.5);
          flashHurt(amount >= 2);
          buzz(20 + amount * 18);
          popDamage(amount);
          break;
        }
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
        case 'heal': {
          sound.play('heal');
          /* 愛心排跳一下（updateHud 會重畫 innerHTML，所以要在下一格才加 class） */
          G.healPulse = true;
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

  /** 跳出「−N」告訴玩家這一下扣了幾顆愛心 */
  let dmgTimer = 0;
  function popDamage(n) {
    const el = els.dmgPop;
    if (!el) return;
    el.textContent = '−' + n;
    el.classList.toggle('big', n >= 3);
    el.hidden = false;
    /* 跟 flashHurt 一樣：先拿掉 class 強制重排，連續被扎才會每一下重新播 */
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    clearTimeout(dmgTimer);
    dmgTimer = setTimeout(() => { el.hidden = true; el.classList.remove('pop'); }, 700);
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
    const p = mePlayer(s);
    if (!p) return;
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
      if (G.healPulse) {
        const row = els.hudHp.querySelector('.hearts');
        if (row) { row.classList.remove('gain'); void row.offsetWidth; row.classList.add('gain'); }
      }
    }
    G.healPulse = false;
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
    /* 線上模式順便把延遲寫在同一行，連線變差看得出來 */
    if (G.mode === 'online') {
      const label = netLabel();
      if (label !== G.netInfo) { els.hudNet.textContent = label; G.netInfo = label; }
    }
    if (els.hudWorldFill) {
      const into = Math.max(0, Math.min(1, (p.best % Rules.C.MILESTONE) / Rules.C.MILESTONE));
      els.hudWorldFill.style.width = (into * 100).toFixed(1) + '%';
    }
    /* 對手（只給數字，不顯示領先／落後差距 —— 規劃書 §0.3） */
    const foe = foePlayer(s);
    if (foe) {
      els.hudFoeDepth.textContent = Math.floor(foe.best);
      if (force || foe.hp !== hudCache.foeHp || compact !== hudCache.compact) {
        els.hudFoeHp.innerHTML = SvgUI.hearts(foe.hp, foe.hpMax, compact);
        hudCache.foeHp = foe.hp;
      }
      if (force) els.hudFoeName.textContent = foe.name + (foe.alive ? '' : '（淘汰）');
      if (!foe.alive) els.hudFoeName.textContent = foe.name + '（淘汰）';
    }
    if (force) {
      els.sideFoe.hidden = !foe;
      /* 觀戰的人沒有「對手」，兩個都是別人 */
      if (els.hudFoeLabel) els.hudFoeLabel.textContent = G.spectating ? '另一位' : '對手';
      els.hudDiff.textContent = s.diff.name;
      els.hudNet.textContent = netLabel();
      const rec = store.records[s.difficulty];
      els.hudBest.textContent = rec && rec.depth ? '本機最深 ' + rec.depth + ' m' : '還沒有紀錄';
      els.hudHpRow.hidden = false;
      els.hudName.textContent = p.name;
      els.hudAvatar.innerHTML = Render.kidAvatarSvg(charOf(p.char), 50);
    }
  }

  function netLabel() {
    if (G.mode !== 'online') {
      return foePlayer(G.match) ? '跟電腦對戰' : '單機一人挑戰';
    }
    const st = online.stats();
    const ping = st && st.rtt ? '・延遲 ' + st.rtt + 'ms' : '';
    return (G.spectating ? '觀戰中' : '線上對戰') + ping;
  }

  /* ================= 結算 ================= */

  function fmtTime(sec) {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function finish(result, meId) {
    const online2 = G.mode === 'online';
    const watching = online2 && G.spectating;
    const me = result.players.find(p => p.id === (meId || G.meId)) || result.players[0];
    const foe = result.players.find(p => p !== me) || null;
    const win = foe ? result.winner === me.id : null;
    /* 觀戰不是自己的成績，不寫進本機紀錄 */
    const saved = watching
      ? { record: false, best: (store.records[result.difficulty] || { depth: 0 }) }
      : Store.record(store, {
        difficulty: result.difficulty,
        depth: me.depth,
        world: me.world,
        char: me.char,
        versus: foe ? { kind: online2 ? 'online' : 'ai', win: win } : null
      });
    if (!watching) store = Store.load();

    els.resultTitle.textContent = watching
      ? (result.draw ? '平手！' : (result.players.find(p => p.id === result.winner) || me).name + ' 贏了')
      : foe
      ? (result.draw ? '平手！' : win ? '你贏了！' : '你輸了')
      : result.endedBy === 'manual' ? '這局結束'
      : result.endedBy === 'fell' ? '摔下去了'
      : '沒血了';

    /* 對戰：勝方的大頭貼放大，下面各一行數據（規劃書 §7.6） */
    const line = (p, tag) =>
      '<div class="result-line' + (tag ? ' ' + tag : '') + '">' + p.name +
      ' 下到 <b>' + p.meters + ' m</b>　撐了 ' + fmtTime(p.survived) +
      (p.fell ? '（摔下去）' : p.alive ? '' : '（沒血了）') + '</div>';
    if (foe) {
      const champ = result.draw ? me : (win ? me : foe);
      const other = champ === me ? foe : me;
      els.resultHero.innerHTML =
        Render.kidFullSvg(charOf(champ.char), 118) +
        line(champ, 'champ') + line(other) +
        '<div class="result-line">' + Rules.DIFFICULTY[result.difficulty].name +
        '・最深到 ' + Scenes.sceneFor(me.world).name +
        (foe && foe.forfeit ? '　（' + foe.name + ' 斷線判輸）' : '') +
        (me.forfeit ? '　（你斷線判輸）' : '') + '</div>';
    } else {
      els.resultHero.innerHTML =
        Render.kidFullSvg(charOf(me.char), 132) +
        line(me) +
        '<div class="result-line">' + Rules.DIFFICULTY[result.difficulty].name +
        '・最深到 ' + Scenes.sceneFor(me.world).name + '</div>';
    }
    els.resultNew.hidden = !saved.record;
    if (saved.record || win) { sound.play('win'); view.burst('milestone', 6, 0, 0); }
    else if (foe) sound.play('dead');

    /* 線上模式沒有「再玩一次」與「換難度」—— 回房間讓房主開下一局 */
    els.again.hidden = !!online2;
    els.changeDiff.hidden = !!online2;
    els.resultHome.textContent = online2 ? '回房間' : '回首頁';
    els.resultHome.classList.toggle('primary', !!online2);

    /* 這局統計（一人挑戰自動省略「被推開」） */
    const rows = [
      ['踩到刺', me.stats.spikes + ' 次'],
      ['被天花板頂住', me.stats.ceilingSeconds.toFixed(1) + ' 秒'],
      ['踩到彈簧', me.stats.springs + ' 次'],
      ['踩破假階', me.stats.fakes + ' 次'],
      ['回復血量', me.stats.heals + ' 顆'],
      ['到達最深世界', Scenes.sceneFor(me.stats.deepestWorld).name],
      ['本機最深', saved.best.depth + ' m']
    ];
    if (result.mode === 'versus') rows.splice(4, 0, ['被推開', me.stats.pushes + ' 次']);
    if (foe) rows.push(['對手最深', foe.meters + ' m']);
    if (online2) {
      const st = online.stats();
      if (st) rows.push(['連線延遲', st.rtt + ' ms']);
    }
    if (watching) rows.unshift(['你的身分', '觀戰']);
    els.resultList.innerHTML = rows.map(r =>
      '<li><span>' + r[0] + '</span><b>' + r[1] + '</b></li>').join('');

    els.finishBtn.hidden = true;
    /* 不換路由：樓梯定格留在後面，結算蓋在上面（跟打地鼠一樣） */
    els.ovResult.hidden = false;
    els.pads.classList.add('hidden');
    input.clear();
    if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
    els.again.focus();
  }

  /* ================= 暫停選單（Esc；只有三顆） ================= */

  function togglePause(on) {
    const s = G.match;
    if (!s || s.phase === 'over' || G.screen !== 'game') return;
    if (settingsModal.isOpen) return;

    /* 線上對戰不能暫停：伺服器不會停，停下來只會被天花板追死。
     * 所以 Esc 只是打開一個選單，遊戲照跑，按鈕也換成「離開房間」。 */
    if (G.mode === 'online') {
      G.menu = on == null ? !G.menu : !!on;
      G.paused = false;
      els.pause.hidden = !G.menu;
      if (els.pauseTitle) els.pauseTitle.textContent = '選單（線上對戰不會暫停）';
      els.restart.hidden = true;
      els.goHome.textContent = '離開房間（算輸）';
      return;
    }
    if (els.pauseTitle) els.pauseTitle.textContent = '暫停中';
    els.restart.hidden = false;
    els.goHome.textContent = '回首頁';
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
      ['spike', '刺階', '踩到會扣愛心（依難度與玩到多深，一次 1～5 顆），之後有 0.6 秒無敵閃爍。'],
      ['fake', '假階', '踩到 0.25 秒後就崩掉，只能當短暫落腳點。']
    ];
    els.helpSteps.innerHTML = steps.map(s =>
      '<li>' + SvgUI.stepIcon(s[0]) + '<div><b>' + s[1] + '</b><span>' + s[2] + '</span></div></li>').join('');

    els.helpCeiling.innerHTML =
      '<figure>' + SvgUI.ceilingIcon(false) + '<figcaption>簡單／普通／困難：尖刺天花板，被頂住會持續扣血。</figcaption></figure>' +
      '<figure>' + SvgUI.ceilingIcon(true) + '<figcaption>幼幼班：軟綿綿的雲朵，被頂到只會被輕輕推回來，不扣血。</figcaption></figure>';

    els.helpDiff.innerHTML = Rules.DIFFICULTY_LIST.map(id => {
      const d = Rules.DIFFICULTY[id];
      /* 傷害是範圍，而且越往下玩越痛，所以淺處與深處都寫出來 */
      const near = Rules.spikeDamageRange(d, 0);
      const far = Rules.spikeDamageRange(d, Rules.C.SPIKE_DEEP_WORLDS);
      const hurt = d.ceilInterval == null
        ? '不會扣血'
        : d.hp + ' 顆愛心，被刺到一次扣 ' + near[0] + '～' + near[1] + ' 顆（' +
          (Rules.C.SPIKE_DEEP_WORLDS * Rules.C.MILESTONE) + ' m 之後 ' + far[0] + '～' + far[1] +
          ' 顆），被天花板頂住每 ' + d.ceilInterval + ' 秒扣一次';
      return '<li><b>' + d.name + '</b>：下捲每秒 ' + d.scrollBase + ' 格、每 ' + d.accelEvery +
        ' 秒加快 ' + Math.round(d.accelRate * 100) + '%（最多 ' + d.scrollCap + ' 倍）、' + hurt +
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
    /* 首頁的「一個人玩」與跟別人玩畫面的「一個人玩」都要切回單機模式 */
    if (btn.dataset.go === 'setup') G.mode = 'solo';
    if (btn.dataset.go === 'home') G.mode = 'solo';
    goto(btn.dataset.go);
  }));
  els.vsAi.addEventListener('click', () => {
    sound.unlock();
    sound.play('click');
    G.mode = 'ai';
    goto('setup');
  });
  els.start.addEventListener('click', () => { sound.unlock(); startMatch(); });
  els.again.addEventListener('click', () => { sound.unlock(); startMatch(); });
  els.changeDiff.addEventListener('click', () => goto('setup'));
  els.resultHome.addEventListener('click', () => {
    /* 線上模式這顆是「回房間」，不是回首頁（不能順手把房間關掉） */
    if (G.mode === 'online') { backFromOnlineMatch(); return; }
    goto('home');
  });
  els.resume.addEventListener('click', () => togglePause(false));
  els.restart.addEventListener('click', () => { togglePause(false); startMatch(); });
  els.goHome.addEventListener('click', () => {
    togglePause(false);
    /* 線上模式：離開房間（對局中離開＝判輸），回到大廳而不是首頁 */
    if (G.mode === 'online') { goto('lobby'); return; }
    goto('home');
  });
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
    /* 線上模式不能靠切分頁暫停（伺服器照跑），所以只有單機才自動暫停 */
    if (G.mode === 'online') return;
    if (document.hidden && G.match && G.match.phase !== 'over') togglePause(true);
  });

  /* 暱稱與角色改了就同步給伺服器（房間卡片、名牌、觀戰名單都要跟著換） */
  els.nickname.addEventListener('change', () => {
    store.nickname = (els.nickname.value || '').trim();
    Store.save(store);
    online.syncMe((store.nickname || '').trim(), G.char);
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

  /* 網址帶 ?invite=xxx（朋友貼給你的連結）→ 直接連線進那間房。
   * 有效性由伺服器驗，無效會回一句看得懂的話。 */
  if (online.takeInviteFromUrl()) {
    toast('用邀請連結加入房間…');
    show('lobby');
  }
})();
