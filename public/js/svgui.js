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
  function arrowIcon(dir) {
    const flip = dir < 0 ? ' transform="scale(-1,1) translate(-48,0)"' : '';
    return '<svg viewBox="0 0 48 48" aria-hidden="true"' + flip + '>' +
      '<path d="M14 10 34 24 14 38z" fill="currentColor"/>' +
      '<path d="M14 10 34 24 14 38z" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2" stroke-linejoin="round"/>' +
      '</svg>';
  }

  function gearIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5Zm8.4 3.5a8.4 8.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a8.2 8.2 0 0 0-2-1.2L15.6 3h-3.9l-.4 2.6a8.2 8.2 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a8.4 8.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a8.2 8.2 0 0 0 2 1.2l.4 2.6h3.9l.4-2.6a8.2 8.2 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.06-.4.1-.8.1-1.2Z"/></svg>';
  }
  function closeIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>';
  }
  function flagIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M8 4h11l-2.4 4L19 12H8z" fill="currentColor"/></svg>';
  }

  /* ---------- 五種階梯的小圖示（教學頁、色彩輔助說明用） ---------- */

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
    /* kids：已經算好的 SVG 字串陣列（由 app.js 用 Render.buildKid 產生） */
    const stairs = [
      { x: 12, y: 118, w: 96 },
      { x: 84, y: 150, w: 84 },
      { x: 150, y: 182, w: 78 },
      { x: 214, y: 212, w: 74 }
    ].map(s =>
      '<rect x="' + s.x + '" y="' + s.y + '" width="' + s.w + '" height="14" rx="5" fill="#D89B57"/>' +
      '<rect x="' + (s.x + 3) + '" y="' + (s.y + 2) + '" width="' + (s.w - 6) + '" height="4" rx="2" fill="rgba(255,255,255,.5)"/>'
    ).join('');
    return '<svg viewBox="0 0 320 240" class="home-art-svg" aria-label="小朋友站在樓梯口往下看">' +
      '<defs><linearGradient id="ha-sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#FFF6E0"/><stop offset="100%" stop-color="#FFD9B0"/></linearGradient></defs>' +
      '<rect width="320" height="240" rx="18" fill="url(#ha-sky)"/>' +
      '<circle cx="266" cy="42" r="26" fill="#FFE9A8" opacity=".9"/>' +
      stairs +
      '<g transform="translate(28,10) scale(0.62)">' + (kids[0] || '') + '</g>' +
      '<g transform="translate(104,50) scale(0.5)">' + (kids[1] || '') + '</g>' +
      '<g transform="translate(176,88) scale(0.42)">' + (kids[2] || '') + '</g>' +
      '</svg>';
  }

  root.SvgUI = {
    hearts, heartSvg, arrowIcon, gearIcon, closeIcon, flagIcon,
    stepIcon, ceilingIcon, modal, homeArt
  };
})(typeof self !== 'undefined' ? self : this);
