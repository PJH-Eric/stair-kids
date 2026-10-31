/* ===== svgui.js — 立體按鈕與共用 UI（全手繪 SVG，沒有 emoji 文字美術） =====
 * 規劃書 §7.2／§7.5。愛心血量、方向鍵圖示、設定齒輪、首頁主視覺、Modal 焦點鎖定。
 */
(function (root) {
  'use strict';

  /* ---------- 愛心血量 ---------- */

  const HEART_PATH = 'M12 21.3 3.9 13.2A5.6 5.6 0 0 1 12 5.6a5.6 5.6 0 0 1 8.1 7.6z';

  function heartSvg(full, size) {
    const s = size || 18;
    return '<svg class="heart' + (full ? '' : ' broken') + '" viewBox="0 0 24 24" width="' + s +
      '" height="' + s + '" aria-hidden="true">' +
      (full
        ? '<defs><linearGradient id="hg" x1="0" y1="0" x2="0.4" y2="1">' +
          '<stop offset="0" stop-color="#FF8FA8"/><stop offset="100%" stop-color="#D6314F"/>' +
          '</linearGradient></defs><path d="' + HEART_PATH + '" fill="url(#hg)"/>' +
          '<path d="M8.5 9.4a2.6 2.6 0 0 1 2.6-1.8" stroke="#fff" stroke-width="1.4" fill="none" opacity=".8" stroke-linecap="round"/>'
        : '<path d="' + HEART_PATH + '" fill="none" stroke="#B9A7A7" stroke-width="2" stroke-dasharray="3 2"/>') +
      '</svg>';
  }

  /**
   * 一排愛心。幼幼班 20 顆排太長，改成「愛心＋數字」。
   * @param {boolean} asNumber true 就用愛心＋數字
   */
  function hearts(hp, hpMax, asNumber) {
    if (asNumber) {
      return '<span class="hearts number">' + heartSvg(true, 20) +
        '<b>×' + hp + '</b><i>/' + hpMax + '</i></span>';
    }
    let out = '<span class="hearts">';
    for (let i = 0; i < hpMax; i++) out += heartSvg(i < hp, 18);
    return out + '</span>';
  }

  /* ---------- 圖示 ---------- */

  /** 觸控方向鍵的箭頭（立體感靠 CSS 的漸層與陰影，圖示只負責明確的方向） */
  /**
   * 方向鍵的箭頭。
   *
   * 原本左鍵是在 <svg> 根元素上掛 transform="scale(-1,1) translate(-48,0)" 來鏡像，
   * 但根元素的 transform 是在 CSS 像素空間生效，translate(-48,0) 等於把整個
   * 圖示往右推 48 個 CSS 像素 —— 實測左鍵的箭頭左邊留白 105px、右邊只有 9px，
   * 完全沒對稱（Eric：「方向鍵的箭頭沒有對稱置中」）。
   * 現在改成直接給兩條互為鏡像的路徑，一個 transform 都不用。
   *
   * 兩條路徑的外框都是 x 14～34、y 10～38，也就是在 48×48 的畫布上正中央，
   * 而且互為鏡像 —— 左右鍵的留白完全一樣（實測各 56.5px）。
   */
  function arrowIcon(dir) {
    const d = dir < 0 ? 'M34 10 14 24 34 38z' : 'M14 10 34 24 14 38z';
    return '<svg viewBox="0 0 48 48" aria-hidden="true">' +
      '<path d="' + d + '" fill="currentColor"/>' +
      '<path d="' + d + '" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2" stroke-linejoin="round"/>' +
      '</svg>';
  }

  function gearIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5Zm8.4 3.5a8.4 8.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a8.2 8.2 0 0 0-2-1.2L15.6 3h-3.9l-.4 2.6a8.2 8.2 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a8.4 8.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a8.2 8.2 0 0 0 2 1.2l.4 2.6h3.9l.4-2.6a8.2 8.2 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.06-.4.1-.8.1-1.2Z"/></svg>';
  }
  function closeIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>';
  }
  /**
   * 設定頁分組的小圖示。四組：聲音、手感、看得清楚、這台裝置上的資料。
   * 一律線稿（stroke）＋ currentColor，跟齒輪／叉叉同一套語言，不用 emoji ——
   * emoji 在每台裝置長得都不一樣，而且會跟著系統字體縮放跑掉。
   */
  function settingIcon(kind) {
    const wrap = inner =>
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    if (kind === 'sound') return wrap('<path d="M5 9.5h3l4.5-3.5v12L8 14.5H5z"/><path d="M16.5 9a4 4 0 0 1 0 6"/><path d="M19 6.5a7.5 7.5 0 0 1 0 11"/>');
    if (kind === 'feel') return wrap('<path d="M12 4.5v15"/><path d="M7.5 8v8M16.5 8v8"/><path d="M3.5 10.5v3M20.5 10.5v3"/>');
    if (kind === 'see') return wrap('<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>');
    return wrap('<path d="M4.5 6.5c0-1.7 3.4-3 7.5-3s7.5 1.3 7.5 3-3.4 3-7.5 3-7.5-1.3-7.5-3Z"/><path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>');
  }

  function flagIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M8 4h11l-2.4 4L19 12H8z" fill="currentColor"/></svg>';
  }

  /* ---------- 六種階梯的小圖示（教學頁、色彩輔助說明用） ---------- */

  function stepIcon(kind, w, h) {
    w = w || 96; h = h || 34;
    const box = '0 0 96 34';
    let inner = '';
    if (kind === 'normal') {
      inner = '<rect x="4" y="12" width="88" height="16" rx="4" fill="#D89B57"/>' +
        '<rect x="7" y="14" width="82" height="4" rx="2" fill="rgba(255,255,255,.45)"/>' +
        '<path d="M12 22h72M12 26h72" stroke="#8C5320" stroke-width="1.4"/>';
    } else if (kind === 'belt') {
      inner = '<rect x="4" y="12" width="88" height="16" rx="8" fill="#6B8AA8"/>' +
        '<g fill="none" stroke="#fff" stroke-width="2">' +
        '<circle cx="20" cy="20" r="5"/><circle cx="48" cy="20" r="5"/><circle cx="76" cy="20" r="5"/>' +
        '<path d="M20 20l4 3M48 20l4 3M76 20l4 3"/></g>' +
        '<path d="M40 6h10l6 4-6 4h-10z" fill="#33526E"/>';
    } else if (kind === 'spring') {
      inner = '<path d="M28 30q10-6 20 0t20-6" stroke="#C74F70" stroke-width="3" fill="none"/>' +
        '<path d="M28 24q10-6 20 0t20-6" stroke="#C74F70" stroke-width="3" fill="none"/>' +
        '<rect x="20" y="10" width="56" height="10" rx="5" fill="#F27C9B"/>' +
        '<rect x="24" y="12" width="48" height="3" rx="1.5" fill="rgba(255,255,255,.6)"/>';
    } else if (kind === 'flip') {
      inner = '<rect x="4" y="12" width="88" height="16" rx="4" fill="#9874C6" stroke="#493064" stroke-width="2"/>' +
        '<circle cx="12" cy="20" r="3" fill="#F8E8B5"/><circle cx="84" cy="20" r="3" fill="#F8E8B5"/>' +
        '<path d="M55 16a8 8 0 1 0 0 8M51 12l5 4-6 3" fill="none" stroke="#fff" stroke-width="2"/>';
    } else if (kind === 'spike') {
      inner = '<rect x="4" y="14" width="88" height="14" rx="4" fill="#D6413B"/>' +
        '<path d="M8 14l6-10 6 10zM22 14l6-10 6 10zM36 14l6-10 6 10zM50 14l6-10 6 10zM64 14l6-10 6 10zM78 14l6-10 6 10z" fill="#FFF0EC"/>';
    } else {
      inner = '<rect x="4" y="12" width="88" height="16" rx="5" fill="#F6F1E6" stroke="#B8AE9B" stroke-width="2" stroke-dasharray="5 4"/>' +
        '<path d="M26 13l4 7-3 7M50 13l4 7-3 7M74 13l4 7-3 7" stroke="#9A9080" stroke-width="1.8" fill="none"/>';
    }
    return '<svg class="step-icon" viewBox="' + box + '" width="' + w + '" height="' + h + '" aria-hidden="true">' + inner + '</svg>';
  }

  /** 天花板圖示：一般難度是尖刺，幼幼班是雲朵 */
  function ceilingIcon(cloud, w) {
    w = w || 120;
    if (cloud) {
      return '<svg viewBox="0 0 120 40" width="' + w + '" height="' + (w / 3) + '" aria-hidden="true">' +
        '<path d="M0 0h120v16q-8 0-8 0 0 8-9 8t-9-8q0 9-10 9t-10-9q0 10-11 10t-11-10q0 9-10 9t-10-9q0 8-9 8t-9-8q0 0-14 0z" fill="#fff"/>' +
        '<g fill="#fff">' +
        '<circle cx="16" cy="16" r="9"/><circle cx="37" cy="17" r="11"/><circle cx="60" cy="16" r="12"/>' +
        '<circle cx="83" cy="17" r="11"/><circle cx="104" cy="16" r="9"/></g>' +
        '<g fill="#DCE8F2" opacity=".85">' +
        '<ellipse cx="37" cy="24" rx="7" ry="3"/><ellipse cx="60" cy="25" rx="8" ry="3"/><ellipse cx="83" cy="24" rx="7" ry="3"/></g>' +
        '</svg>';
    }
    return '<svg viewBox="0 0 120 40" width="' + w + '" height="' + (w / 3) + '" aria-hidden="true">' +
      '<rect x="0" y="0" width="120" height="14" fill="#B32C28"/>' +
      '<path d="M2 14l8 16 8-16zM22 14l8 16 8-16zM42 14l8 16 8-16zM62 14l8 16 8-16zM82 14l8 16 8-16zM102 14l8 16 8-16z" fill="#FFF0EC"/></svg>';
  }

  /* ---------- Modal：遮罩、焦點鎖定、Esc 關閉 ---------- */

  function modal(el, opener) {
    let lastFocus = opener || null;
    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    function items() {
      return [...el.querySelectorAll(FOCUSABLE)].filter(n => !n.disabled && n.offsetParent !== null);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const list = items();
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function open(from) {
      lastFocus = from || lastFocus || document.activeElement;
      el.hidden = false;
      el.classList.add('open');
      document.addEventListener('keydown', onKey, true);
      const list = items();
      if (list.length) list[0].focus();
    }
    function close() {
      el.classList.remove('open');
      el.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    return { open, close, get isOpen() { return !el.hidden; } };
  }

  /* ---------- 首頁大主視覺：小朋友站在樓梯口往下看 ---------- */

  function homeArt(kids) {
    /* kids：已經算好的 SVG 字串陣列（由 app.js 用 Render.buildKid 產生）。
     * 場景：天花板刺在上、五種階梯一路往右下走（木頭／輸送帶／彈簧／假階／刺），
     * 三個小朋友站在不同階上，兩位用玩家色外框（藍／紅）暗示對戰。 */
    const wood = (x, y, w) =>
      '<rect x="' + x + '" y="' + (y + 6) + '" width="' + w + '" height="15" rx="4" fill="#9B5F2B"/>' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="14" rx="5" fill="url(#ha-wood)"/>' +
      '<rect x="' + (x + 4) + '" y="' + (y + 2) + '" width="' + (w - 8) + '" height="3" rx="1.5" fill="rgba(255,255,255,.55)"/>' +
      '<path d="M' + (x + 8) + ' ' + (y + 8.5) + 'h' + (w - 16) + 'M' + (x + 8) + ' ' + (y + 11.5) + 'h' + (w - 26) +
        '" stroke="#8C5320" stroke-opacity=".45" stroke-width="1.2" stroke-linecap="round"/>';
    const belt = (x, y, w) => {
      let arrows = '';
      for (let ax = x + 14; ax < x + w - 10; ax += 16) {
        arrows += '<path d="M' + ax + ' ' + (y + 4) + 'l6 4-6 4z" fill="#12293A" stroke="#fff" stroke-width="1"/>';
      }
      return '<rect x="' + x + '" y="' + (y + 6) + '" width="' + w + '" height="15" rx="7" fill="#3F5F7F"/>' +
        '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="14" rx="7" fill="url(#ha-belt)"/>' +
        '<circle cx="' + (x + 7) + '" cy="' + (y + 7) + '" r="4" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="1.6"/>' +
        '<circle cx="' + (x + w - 7) + '" cy="' + (y + 7) + '" r="4" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="1.6"/>' +
        arrows;
    };
    const spring = (x, y, w) =>
      '<path d="M' + (x + w / 2 - 12) + ' ' + (y + 12) + 'q12 5 24 0m-24 5q12 5 24 0m-24 5q12 5 24 0" fill="none" stroke="#C74F70" stroke-width="3" stroke-linecap="round"/>' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="11" rx="5.5" fill="url(#ha-spring)"/>' +
      '<rect x="' + (x + 5) + '" y="' + (y + 2) + '" width="' + (w - 10) + '" height="2.6" rx="1.3" fill="rgba(255,255,255,.6)"/>';
    const fake = (x, y, w) =>
      '<rect x="' + x + '" y="' + (y + 5) + '" width="' + w + '" height="13" rx="5" fill="#C9BBA4"/>' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="13" rx="5" fill="#FBF6EE" stroke="#78705F" stroke-width="1.6" stroke-dasharray="5 4"/>' +
      '<path d="M' + (x + w * .3) + ' ' + (y + 1) + 'l5 6-4 5M' + (x + w * .66) + ' ' + (y + 1) + 'l-4 6 5 5" fill="none" stroke="#5A5046" stroke-opacity=".6" stroke-width="1.4"/>';
    const spikes = (x, y, w, up) => {
      let t = '';
      const n = Math.max(2, Math.round(w / 12));
      const cw = w / n;
      for (let i = 0; i < n; i++) {
        const sx = x + i * cw;
        t += up
          ? '<path d="M' + sx + ' ' + y + 'l' + (cw / 2) + ' -16 ' + (cw / 2) + ' 16z" fill="url(#ha-metal)" stroke="#5A0B0A" stroke-width="1.2" stroke-linejoin="round"/>'
          : '<path d="M' + sx + ' ' + y + 'l' + (cw / 2) + ' 16 ' + (cw / 2) + ' -16z" fill="url(#ha-metal)" stroke="#5A0B0A" stroke-width="1.2" stroke-linejoin="round"/>';
      }
      return t;
    };
    const spikeStep = (x, y, w) =>
      spikes(x + 3, y + 3, w - 6, true) +
      '<rect x="' + x + '" y="' + (y + 3) + '" width="' + w + '" height="14" rx="4" fill="url(#ha-spikebase)"/>';

    const kid = (i, x, y, s, ring) => kids[i]
      ? '<g transform="translate(' + x + ',' + (y - 157 * s) + ') scale(' + s + ')">' + kids[i] + '</g>' +
        (ring ? '<ellipse cx="' + (x + 50 * s) + '" cy="' + (y + 1) + '" rx="' + (30 * s) + '" ry="' + (6 * s) + '" fill="none" stroke="' + ring + '" stroke-width="3"/>' : '')
      : '';

    return '<svg viewBox="0 0 360 290" class="home-art-svg" role="img" aria-label="' +
      (root.I18N ? root.I18N.t('home.art') : '小朋友站在樓梯口往下看') + '">' +
      '<defs>' +
      '<linearGradient id="ha-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF6E0"/><stop offset="55%" stop-color="#FFE2C0"/><stop offset="100%" stop-color="#FFC995"/></linearGradient>' +
      '<linearGradient id="ha-wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F0B56A"/><stop offset="100%" stop-color="#C98543"/></linearGradient>' +
      '<linearGradient id="ha-belt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#A9BFD8"/><stop offset="100%" stop-color="#6A88AA"/></linearGradient>' +
      '<linearGradient id="ha-spring" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF9BB4"/><stop offset="100%" stop-color="#E0587C"/></linearGradient>' +
      '<linearGradient id="ha-spikebase" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C73A34"/><stop offset="100%" stop-color="#5E0F0D"/></linearGradient>' +
      '<linearGradient id="ha-metal" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6E605C"/><stop offset=".35" stop-color="#EEE6E2"/><stop offset=".6" stop-color="#B9AAA4"/><stop offset="1" stop-color="#4E4340"/></linearGradient>' +
      '<linearGradient id="ha-well" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFB98A" stop-opacity="0"/><stop offset="1" stop-color="#8A4B2A" stop-opacity=".38"/></linearGradient>' +
      '<clipPath id="ha-clip"><rect width="360" height="290" rx="22"/></clipPath>' +
      '</defs>' +
      '<g clip-path="url(#ha-clip)">' +
        '<rect width="360" height="290" fill="url(#ha-sky)"/>' +
        '<circle cx="300" cy="64" r="30" fill="#FFE9A8" opacity=".95"/><circle cx="300" cy="64" r="44" fill="#FFE9A8" opacity=".35"/>' +
        '<g fill="#fff" opacity=".85"><ellipse cx="70" cy="78" rx="30" ry="9"/><ellipse cx="88" cy="70" rx="20" ry="10"/>' +
          '<ellipse cx="248" cy="118" rx="26" ry="8"/><ellipse cx="262" cy="111" rx="16" ry="8"/></g>' +
        '<rect y="150" width="360" height="140" fill="url(#ha-well)"/>' +
        /* 兩側井壁的縱向接縫，帶出「一口往下的井」 */
        '<path d="M14 0v290M346 0v290" stroke="#B9763D" stroke-opacity=".18" stroke-width="8"/>' +
        /* 天花板：整局唯一在追的東西，首頁先讓它露個臉 */
        '<rect width="360" height="12" fill="url(#ha-spikebase)"/>' +
        spikes(0, 12, 360, false) +
        wood(18, 150, 118) +
        belt(104, 176, 104) +
        spring(190, 204, 82) +
        fake(252, 226, 78) +
        spikeStep(286, 258, 62) +
        kid(0, 28, 150, 0.62, null) +
        kid(1, 124, 176, 0.5, '#4F86D6') +
        kid(2, 224, 204, 0.46, '#F2545B') +
        /* 深度牌：呼應「往下比深度」 */
        '<g transform="translate(262,142)"><rect width="78" height="26" rx="13" fill="#fff" stroke="#E5C9A8" stroke-width="2"/>' +
          '<path d="M16 8v10m-5-4l5 5 5-5" fill="none" stroke="#C9662A" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
          '<text x="27" y="18" font-size="13" font-weight="800" fill="#A85129" font-family="system-ui,sans-serif">100 m</text></g>' +
      '</g>' +
      '</svg>';
  }

  /** 破紀錄徽章：金色圓章加緞帶 */
  function medalIcon(size) {
    size = size || 26;
    return '<svg class="medal" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      '<path d="M9 2h6l3 9h-6z" fill="#E0405F"/><path d="M23 2h-6l-3 9h6z" fill="#4F86D6"/>' +
      '<circle cx="16" cy="20" r="10" fill="#FFD44D" stroke="#D99A1E" stroke-width="2"/>' +
      '<path d="M16 13.5l2 4.2 4.6.6-3.4 3.2.9 4.6-4.1-2.3-4.1 2.3.9-4.6-3.4-3.2 4.6-.6z" fill="#FFF3B0" stroke="#D99A1E" stroke-width="1" stroke-linejoin="round"/></svg>';
  }

  /** 勝利皇冠 */
  function crownIcon(size) {
    size = size || 28;
    return '<svg class="crown" viewBox="0 0 32 24" width="' + size + '" height="' + Math.round(size * 0.75) + '" role="img" aria-label="' +
      (root.I18N ? root.I18N.t('res.crownAria') : '勝利') + '">' +
      '<path d="M3 20L1.5 6l7 6L16 2l7.5 10 7-6L29 20z" fill="#FFD44D" stroke="#D99A1E" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle cx="16" cy="14" r="2.2" fill="#E0405F"/><circle cx="8" cy="15" r="1.5" fill="#4F86D6"/><circle cx="24" cy="15" r="1.5" fill="#4F86D6"/></svg>';
  }

  /** 大廳房間卡片左側的狀態圖示：waiting 空位等人、playing 往下跑、full 兩席都坐滿 */
  function roomStateIcon(kind) {
    const head = '<svg viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">';
    if (kind === 'playing') {
      return head + '<path d="M5 12h14v6H5zM15 20h14v6H15zM25 28h12v6H25z" fill="#E0405F"/>' +
        '<path d="M5 12h14v2H5zM15 20h14v2H15zM25 28h12v2H25z" fill="#fff" opacity=".45"/>' +
        '<path d="M9 22l5 4-5 4z" fill="#A3364A"/></svg>';
    }
    if (kind === 'full') {
      return head + '<circle cx="13" cy="15" r="6" fill="#4F86D6"/><path d="M3 34c0-7 4-10 10-10s10 3 10 10z" fill="#4F86D6"/>' +
        '<circle cx="28" cy="15" r="6" fill="#F2545B"/><path d="M18 34c0-7 4-10 10-10s10 3 10 10z" fill="#F2545B"/></svg>';
    }
    return head + '<circle cx="14" cy="15" r="6" fill="#4F86D6"/><path d="M4 34c0-7 4-10 10-10s10 3 10 10z" fill="#4F86D6"/>' +
      '<circle cx="30" cy="17" r="7" fill="none" stroke="#2F7A44" stroke-width="2.4" stroke-dasharray="3.5 3"/>' +
      '<path d="M30 13.5v7M26.5 17h7" stroke="#2F7A44" stroke-width="2.4" stroke-linecap="round"/></svg>';
  }

  function eyeIcon(size) {
    size = size || 14;
    return '<svg class="eye" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      '<path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="12" r="3.4" fill="currentColor"/></svg>';
  }

  /** 空席插畫：虛線小朋友剪影＋閃爍的「＋」，用該席位的玩家色 */
  function emptySeatArt(color, size) {
    size = size || 56;
    return '<svg class="seat-empty-art" viewBox="0 0 56 56" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      '<circle cx="28" cy="28" r="26" fill="' + color + '" opacity=".1"/>' +
      '<g fill="none" stroke="' + color + '" stroke-width="2.4" stroke-dasharray="4 3.4" stroke-linecap="round">' +
        '<circle cx="28" cy="22" r="9"/><path d="M11 50c0-11 7-16 17-16s17 5 17 16"/></g>' +
      '<g class="seat-plus"><circle cx="44" cy="12" r="8" fill="' + color + '"/>' +
        '<path d="M44 8v8M40 12h8" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></g></svg>';
  }

  /** 準備完成的勾勾徽章 */
  function readyCheck(size) {
    size = size || 18;
    return '<svg class="ready-check" viewBox="0 0 20 20" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="9" fill="#38a85a"/><path d="M5.5 10.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  root.SvgUI = {
    emptySeatArt, readyCheck, roomStateIcon, eyeIcon, medalIcon, crownIcon,
    hearts, heartSvg, arrowIcon, gearIcon, closeIcon, flagIcon, settingIcon,
    stepIcon, ceilingIcon, modal, homeArt
  };
})(typeof self !== 'undefined' ? self : this);
