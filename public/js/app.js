/* ===== app.js — 畫面流程、遊戲迴圈、設定與本機紀錄 =====
 * 規則一律問 rules.js，這裡只負責「什麼時候問」與「畫出來」。
 */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  const els = {
    nav: $('#screen-nav'), back: $('#btn-back'), leaveRoom: $('#btn-leave-room'),
    settingsBtn: $('#btn-settings'), finishBtn: $('#btn-finish'),
    homeArt: $('#home-art'), homeRecords: $('#home-records'),
    nickname: $('#in-nickname'), charPicker: $('#char-picker'),
    diffPicker: $('#diff-picker'), diffNote: $('#diff-note'),
    setupTitle: $('#setup-title'), setupHint: $('#setup-hint'), diffLabel: $('#diff-label'),
    vsAi: $('#btn-vs-ai'), start: $('#btn-start'),
    sideFoe: $('#side-foe'), hudFoeName: $('#hud-foe-name'), hudFoeLabel: $('#hud-foe-label'),
    hudFoeDepth: $('#hud-foe-depth'), hudFoeHp: $('#hud-foe-hp'),
    canvas: $('#canvas'), actors: $('#actors'), stage: $('#stage'),
    wrap: document.querySelector('.game-wrap'), side: $('#side'),
    wrap: $('.game-wrap'), side: $('#side'),
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
    countdownTip: $('#countdown-tip'),
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
    setBgmNum: $('#set-bgm-num'), setSfxNum: $('#set-sfx-num'),
    homeOnline: $('#home-online'),
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
    onNameChange: name => {
      store.nickname = name;
      Store.save(store);
      els.nickname.value = name;
    },
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

  /** 這個事件是不是發生在「我」身上。
   * 震動、紅光、跳出來的 −N、手機震動都是第一人稱的痛感反饋，只有本人該收到；
   * 對手被扎照樣有聲音與噴出來的粒子，看得到發生什麼事，畫面不會替別人痛一次。
   * 觀戰時 G.meId 會借用一號位（見 enterOnlineMatch），但觀戰者並沒有在玩，
   * 所以一律不算自己 —— 旁觀者的畫面不該被別人的傷害震到。 */
  const isMine = e => !G.spectating && e.player === G.meId;
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

  /** 右上角的「結束這局」有沒有出現：直向的狀態列要靠這個讓開右邊 */
  function markFinishBtn() {
    document.body.classList.toggle('has-finish', !els.finishBtn.hidden);
  }

  function show(name) {
    G.screen = name;
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    /* 左上角是全站統一的「退出」位置：選單畫面是返回上一層，
     * 房間與遊戲中則是離開這間房／這一局。原本遊戲畫面完全沒有這顆，
     * 只能按 Esc，觸控裝置根本沒有 Esc 可以按。 */
    els.nav.hidden = !BACK_TO[name] && name !== 'game';
    if (BACK_TO[name]) els.back.dataset.go = BACK_TO[name];
    els.back.textContent = (name === 'game' || name === 'room') ? '← 離開房間' : '← 返回';
    document.body.classList.toggle('in-game', name === 'game');
    els.pads.classList.toggle('hidden', name !== 'game');
    if (name !== 'game' && els.ovResult) els.ovResult.hidden = true;
    syncPads();
    els.finishBtn.hidden = true;
    markFinishBtn();
    if (name === 'home') { renderHomeRecords(); refreshPresence(); }
    if (name === 'setup') renderSetup();
    /* 進遊戲畫面才量得到真正的尺寸（隱藏中的 section 量出來是 0），所以在這裡重新收邊 */
    if (name === 'game') { applyRenderOptions(); updateRotateTip(); }
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

  /**
   * 首頁「跟別人玩」上的線上人數。
   * 只是加分資訊，所以失敗一律安靜收掉（沒設 server、伺服器在睡、離線都算正常）。
   */
  function refreshPresence() {
    const badge = els.homeOnline;
    if (!badge) return;
    const base = (self.Config && Config.serverUrl) || '';
    if (!base) { badge.hidden = true; return; }
    let done = false;
    const give = () => { if (!done) { done = true; badge.hidden = true; } };
    setTimeout(give, 4000);                      /* 伺服器在睡就不要一直等 */
    fetch(base + '/api/presence', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (done) return;
        done = true;
        const n = d && Number(d.online) || 0;
        badge.hidden = n <= 0;
        badge.textContent = '線上 ' + n + ' 人';
      })
      .catch(give);
  }

  /* ================= 首頁 ================= */

  function renderHomeArt() {
    const picks = ['yuan', 'bobo', 'xing'].map(id =>
      '<svg viewBox="0 0 100 166" width="100" height="166" x="0" y="0">' +
      Render.buildKid(charOf(id), { id: 'home-' + id }) + '</svg>');
    els.homeArt.innerHTML = SvgUI.homeArt(picks);
  }

  function renderHomeRecords() {
    const chips = [];
    for (const id of Rules.DIFFICULTY_LIST) {
      const r = store.records[id];
      if (r && r.depth > 0) {
        chips.push('<span class="rec-chip">' + Rules.DIFFICULTY[id].name +
          '<b>' + r.depth + ' m</b></span>');
      }
    }
    if (store.bestWorld > 0) {
      chips.push('<span class="rec-chip soft">去過<b>' + Scenes.sceneFor(store.bestWorld).name + '</b></span>');
    }
    const fav = Store.favoriteChar(store);
    if (fav) chips.push('<span class="rec-chip soft">常用<b>' + charOf(fav).name + '</b></span>');
    const vs = store.versus || {};
    const on = vs.online || { win: 0, lose: 0 };
    if (on.win + on.lose > 0) {
      chips.push('<span class="rec-chip soft">線上<b>' + on.win + ' 勝 ' + on.lose + ' 敗</b></span>');
    }
    els.homeRecords.innerHTML = chips.length
      ? chips.join('')
      : '<span class="rec-chip soft">還沒有紀錄，挑一個難度開始跑吧</span>';
  }

  /* ================= 一個人玩：選角色與難度 ================= */

  /** 難度說明一律從規則核心算出來 —— 寫死的數字改了規則就會騙人（之前真的騙了） */
  function diffNote(id) {
    const d = Rules.DIFFICULTY[id];
    if (!d) return '';
    if (d.ceilInterval == null) {
      return '很慢、不會出刺階與假階，被雲朵頂到也不扣血，' + d.hp +
        ' 顆愛心，想結束就按右上角「結束這局」。';
    }
    const near = Rules.spikeDamageRange(d, 0);
    const far = Rules.spikeDamageRange(d, Rules.C.SPIKE_DEEP_WORLDS);
    const deep = Rules.C.SPIKE_DEEP_WORLDS * Rules.C.MILESTONE;
    return d.hp + ' 顆愛心；被刺到一次扣 ' + near[0] + '～' + near[1] + ' 顆，' +
      deep + ' m 之後變成 ' + far[0] + '～' + far[1] + ' 顆。' +
      '下捲每秒 ' + d.scrollBase + ' 格，每 ' + d.accelEvery + ' 秒加快 ' +
      Math.round(d.accelRate * 100) + '%（最多 ' + d.scrollCap + ' 倍）。' +
      '刺階 ' + Math.round(d.spikeRate * 100) + '%、假階 ' + Math.round(d.fakeRate * 100) + '%。';
  }

  /** 難度卡上的兩行數字：三段的差別要用眼睛就看得出來 */
  function diffCardLines(id) {
    const d = Rules.DIFFICULTY[id];
    if (d.ceilInterval == null) {
      return ['<small>' + d.hp + ' 顆愛心</small>',
        '<small>速度 ' + d.scrollBase + ' 格/秒</small>',
        '<small class="diff-hurt">不會死，沒有刺</small>'];
    }
    const near = Rules.spikeDamageRange(d, 0);
    /* 一行放一件事，卡片才不會在窄一點的螢幕上把「格/秒」折成兩行 */
    return ['<small>' + d.hp + ' 顆愛心</small>',
      '<small>速度 ' + d.scrollBase + ' 格/秒</small>',
      '<small class="diff-hurt">刺一次 −' + (near[0] === near[1] ? near[0] : near[0] + '～' + near[1]) + ' 顆</small>'];
  }

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
        (id === G.difficulty) + '"><strong>' + d.name + '</strong>' +
        diffCardLines(id).join('') +
        '<em>' + (r && r.depth ? '你最深 ' + r.depth + ' m' : '還沒玩過') + '</em></button>';
    }).join('');
    els.diffNote.textContent = diffNote(G.difficulty);
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

  /** 第一次玩才在倒數時提示操作方式（玩過一次就記住，不再出現） */
  function armFirstTimeTip() {
    if (!els.countdownTip) return;
    const first = !store.seenHelp;
    els.countdownTip.hidden = !first;
    if (!first) return;
    els.countdownTip.textContent = wantsPads()
      ? '用下面兩顆按鍵左右移動，沒有跳'
      : '用 ← → 左右移動，沒有跳';
    store.seenHelp = true;
    Store.save(store);
  }

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
    armFirstTimeTip();
    show('game');
    els.finishBtn.hidden = !G.match.diff.endless;
    markFinishBtn();
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
    armFirstTimeTip();
    show('game');
    els.finishBtn.hidden = true;
    markFinishBtn();
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
    /* 結算 callback 會在事件處理中取消動畫並清掉角色；不要讓同一幀在清除後又畫回最後一幀。 */
    if (!G.raf || G.screen !== 'game') return;

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
          const hpTarget = syncHpHud(e.player, e.hp);
          if (e.source === 'ceiling') {
            /* 天花板上面也是刺，被刺到的反饋要跟踩到刺階一樣明顯 */
            sound.play('warn');
            sound.play('spike');
          }
          if (hpTarget === 'foe') pulseFoeHp();
          if (!isMine(e)) break;
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
          syncHpHud(e.player, e.hp);
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
          if (!isMine(e)) break;
          view.kick(12);
          flashHurt(true);
          buzz(80);
          break;
        case 'eliminated':
          sound.play('dead');
          if (!isMine(e)) break;
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
  let foeHpTimer = 0;
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

  /** 受傷事件抵達時先同步血量，對手的愛心不必等下一次狀態輪詢才變化。 */
  function syncHpHud(playerId, hp) {
    const s = G.match;
    if (!s || hp == null) return null;
    const p = s.players.find(x => x.id === playerId);
    if (!p) return null;
    const compact = s.diff.hpAsNumber || narrowHud();
    if (p.id === G.meId) {
      els.hudHp.innerHTML = SvgUI.hearts(hp, p.hpMax, compact);
      els.hudHp.setAttribute('aria-label', '血量 ' + hp + '/' + p.hpMax);
      return 'me';
    }
    const foe = foePlayer(s);
    if (!foe || foe.id !== p.id) return null;
    els.hudFoeHp.innerHTML = SvgUI.hearts(hp, p.hpMax, compact);
    els.hudFoeHp.setAttribute('aria-label', '血量 ' + hp + '/' + p.hpMax);
    return 'foe';
  }

  /** 對手受傷時讓血量欄短暫提示，避免只看到角色姿勢卻誤以為沒有扣血。 */
  function pulseFoeHp() {
    const el = els.hudFoeHp;
    if (!el) return;
    el.classList.remove('foe-hit');
    void el.offsetWidth;
    el.classList.add('foe-hit');
    clearTimeout(foeHpTimer);
    foeHpTimer = setTimeout(() => el.classList.remove('foe-hit'), 450);
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

  let hudCache = { depth: -1, hp: -1, foeHp: -1, foeId: null, world: -1, speed: '', compact: null };

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
      els.hudHp.setAttribute('aria-label', '血量 ' + p.hp + '/' + p.hpMax);
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
      if (force || foe.id !== hudCache.foeId || foe.hp !== hudCache.foeHp || compact !== hudCache.compact) {
        els.hudFoeHp.innerHTML = SvgUI.hearts(foe.hp, foe.hpMax, compact);
        els.hudFoeHp.setAttribute('aria-label', '血量 ' + foe.hp + '/' + foe.hpMax);
        hudCache.foeHp = foe.hp;
        hudCache.foeId = foe.id;
      }
      if (force) els.hudFoeName.textContent = foe.name + (foe.alive ? '' : '（淘汰）');
      if (!foe.alive) els.hudFoeName.textContent = foe.name + '（淘汰）';
    } else {
      hudCache.foeHp = -1;
      hudCache.foeId = null;
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
    if (!saved.record && !watching && saved.best && saved.best.depth > me.meters) {
      /* 沒破紀錄就講差多少 —— 比只說「沒破」有動力得多 */
      els.resultNew.hidden = false;
      els.resultNew.textContent = '離你的紀錄還差 ' + (saved.best.depth - me.meters) + ' m';
      els.resultNew.classList.add('near');
    } else {
      els.resultNew.textContent = '破紀錄了！';
      els.resultNew.classList.remove('near');
    }
    if (saved.record || win) { sound.play('win'); view.burst('milestone', Rules.C.FIELD_W / 2, 0, 0); }
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
    markFinishBtn();
    /* 側欄的「本機最深」要跟著更新，不然會停在這局開始前的值 */
    if (els.hudBest) {
      const rec = store.records[result.difficulty];
      els.hudBest.textContent = rec && rec.depth ? '本機最深 ' + rec.depth + ' m' : '還沒有紀錄';
    }
    /* 結算會立刻停止動畫，沒有下一幀可讓渲染器依 alive 清理，所以先清掉畫面角色。 */
    view.clearActors();
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

  /**
   * 寬螢幕上把整組面板收到「場地 ＋ 兩條窄牆」的寬度。
   *
   * 為什麼要這樣做：場地的像素寬度是被視窗高度綁死的（要放得下可見高度 ＋ 天花板），
   * 舞台再寬也只是把多出來的空間畫成牆。收邊之後可玩區域佔面板的比例才拉得上來。
   * 不會來回震盪：收到的寬度一定 ≥ 場地寬度，所以 scale 仍然由高度決定。
   */
  const sideWidth = () => (els.side ? els.side.getBoundingClientRect().width : 0);

  function fitStage() {
    if (!els.wrap) return;
    const st = view.view;
    const box = els.canvas.getBoundingClientRect();
    /* 直向與窄螢幕不收（那些情況是寬度吃緊，場地本來就已經佔滿）；
     * 遊戲畫面還沒顯示的時候量不到尺寸，這時候一定要把上限清掉 ——
     * 否則會用「隱藏時量到的 0」算出一個超窄的上限，等畫面顯示出來就塌掉。 */
    const measurable = st && st.wantStageW && box.width >= 240 && box.height >= 240;
    if (!measurable) {
      els.wrap.style.maxWidth = '';
      els.stage.style.maxHeight = '';
      return;
    }
    /* 橫向寬螢幕：收掉多出來的寬度（那些只會變成兩片牆） */
    const wide = window.innerWidth >= 1100 && window.innerWidth > window.innerHeight * 0.9;
    if (wide) {
      els.wrap.style.maxWidth = Math.round(sideWidth() + st.wantStageW) + 'px';
    } else {
      els.wrap.style.maxWidth = '';
    }
    /* 橫向的方向鍵要避開左邊的資訊欄（不然會蓋在「本機最深」那些字上面）。
     * 資訊欄的寬度會隨斷點變，所以量出來丟給 CSS 用，不要在 CSS 裡抄一份。 */
    document.documentElement.style.setProperty('--side-w', Math.round(sideWidth()) + 'px');
    /* 視窗比可玩區域高很多（直向）：收掉多出來的高度，
     * 不然死亡線以下會露出一大片深淵，等於半個螢幕是死的。空出來的地方剛好放方向鍵。
     * 只在有觸控按鍵的裝置上收 —— 桌機沒有按鍵可以放，收掉只會在下面留一條空白，
     * 那還不如讓深淵把畫面填滿（深淵本來就是「掉下去就沒了」的視覺提示）。 */
    if (wantsPads() && box.height > st.wantStageH + 8) {
      els.stage.style.maxHeight = st.wantStageH + 'px';
    } else {
      els.stage.style.maxHeight = '';
    }
  }

  function applyRenderOptions() {
    view.setOptions({
      reduceMotion: store.reduceMotion,
      colorAssist: store.colorAssist,
      depthGuide: store.depthGuide,
      /* 一律用 18 格。手機橫向原本會縮成 14 格放大角色，但摔死的判定線就在 18 格，
       * 看不到判定線就會死得莫名其妙，所以這裡不縮。 */
      viewH: Rules.C.VIEW_H
    });
    /* 先量一次拿到「場地要多寬」，收邊，再量一次（收邊之後舞台變窄了）。
     * 兩次就會收斂：收到的寬度一定 ≥ 場地寬度，所以 scale 仍然由高度決定。 */
    view.resize();
    fitStage();
    view.resize();
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
    syncVolNums();
    disarmClear();
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

  let clearArmed = false;
  let clearTimer = 0;
  function disarmClear() {
    clearArmed = false;
    clearTimeout(clearTimer);
    if (!els.setClear) return;
    els.setClear.textContent = '清除本機紀錄';
    els.setClear.classList.remove('danger-armed');
  }

  /** 音量的百分比要看得到，不然拉了不知道拉到哪 */
  function syncVolNums() {
    if (els.setBgmNum) els.setBgmNum.textContent = Math.round((store.bgmVol || 0) * 100) + '%';
    if (els.setSfxNum) els.setSfxNum.textContent = Math.round((store.sfxVol || 0) * 100) + '%';
  }

  function bindSetting(el, key, isRange) {
    el.addEventListener('input', () => {
      store[key] = isRange ? Number(el.value) / 100 : el.checked;
      pushSettings();
      syncVolNums();
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
    /* 清紀錄是不可逆的，所以第一下只是「舉手」，要再按一次才真的清 */
    if (!clearArmed) {
      clearArmed = true;
      els.setClear.textContent = '再按一次就真的清除';
      els.setClear.classList.add('danger-armed');
      els.setMsg.textContent = '紀錄清掉就回不來了，確定的話再按一次。';
      clearTimeout(clearTimer);
      clearTimer = setTimeout(disarmClear, 5000);
      return;
    }
    disarmClear();
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

  /**
   * 要不要顯示左右兩顆大按鍵。
   *
   * 判斷依據是「主要指向裝置是不是滑鼠」，不是「這台機器支不支援觸控」——
   * 觸控筆電、觸控螢幕的桌機 maxTouchPoints 都 > 0，但那些人是用鍵盤玩的，
   * 跳出兩顆大按鍵只是擋住畫面（Eric：「桌機不需要方向鍵」）。
   * 真的用手指點下去的時候（下面那個 pointerdown）才把按鍵放出來。
   */
  let padsForced = false;
  function wantsPads() {
    if (padsForced) return true;
    try {
      /* any-hover: hover ＝這台機器上有一個「可以停留」的指標，也就是有滑鼠或觸控板。
       * 桌機、觸控筆電都會命中；平板與手機不會。這是判斷「有沒有滑鼠」最直接的問法，
       * 比 pointer: fine 可靠（觸控筆電的主要指標有時候會回報成 coarse）。 */
      if (window.matchMedia('(any-hover: hover)').matches) return false;
      if (window.matchMedia('(pointer: fine)').matches) return false;
      if (navigator.maxTouchPoints > 0) return true;
      if (window.matchMedia('(pointer: coarse)').matches) return true;
    } catch (e) { /* 忽略 */ }
    return 'ontouchstart' in window;
  }
  function syncPads() {
    els.pads.classList.toggle('no-touch', !wantsPads());
  }
  /* 真的用手指碰螢幕了：把按鍵放出來，並重新排版（空間要讓給按鍵） */
  window.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || padsForced) return;
    padsForced = true;
    els.pads.classList.remove('no-touch');
    applyRenderOptions();
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
  /* 左上角的「離開」。這顆原本沒有任何 listener —— index.html 上沒有 data-go，
   * 而 $('[data-go]') 是綁事件時就抓好的快照陣列，屬性是後來才由 show() 補的，
   * 所以每一個畫面上的返回鈕其實都按不動。 */
  els.back.addEventListener('click', () => {
    sound.unlock();
    sound.play('click');
    /* 遊戲中不直接跳走：開選單讓玩家確認 —— 線上是「離開房間（算輸）」，
     * 單機是先暫停再回首頁，誤觸不會直接毀掉正在跑的一局。 */
    if (G.screen === 'game') { togglePause(true); return; }
    /* 房間畫面轉呼叫現成的「離開房間」，它會通知伺服器把位子放掉；
     * 自己另寫一套 goto('lobby') 會留下幽靈佔位。 */
    if (G.screen === 'room' && els.leaveRoom) { els.leaveRoom.click(); return; }
    const to = els.back.dataset.go;
    if (!to) return;
    if (to === 'home' || to === 'setup') G.mode = 'solo';
    goto(to);
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

  /* 結算畫面上 Enter／空白鍵＝主要按鈕（桌機想連玩的時候不用去找滑鼠）。
   * 只在結算開著、而且焦點不在輸入框裡的時候才接手。 */
  window.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!els.ovResult || els.ovResult.hidden) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    e.preventDefault();
    (G.mode === 'online' ? els.resultHome : els.again).click();
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

  /* 設定頁的暱稱改了就同步給伺服器（房間卡片、名牌、觀戰名單都要跟著換） */
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

  /* 網址帶 ?invite=xxx（朋友貼給你的連結）→ 先到大廳確認暱稱，再加入那間房。
   * token 有效性由伺服器驗，無效會回一句看得懂的話。 */
  if (online.takeInviteFromUrl()) {
    toast('收到房間邀請，先確認暱稱再加入。');
    show('lobby');
  }
})();
