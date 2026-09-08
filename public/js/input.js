/* ===== input.js — 鍵盤 ＋ 左右兩顆大觸控鍵 =====
 * 對外只吐 { dir: -1 | 0 | 1 }，和 AI 送進規則核心的格式完全一樣（規劃書 §7.2）。
 * 沒有跳鍵、沒有下壓鍵；橫向兩顆都在左下，直向左鍵左下、右鍵右下（版面差異在 CSS）。
 */
(function (root) {
  'use strict';

  function create() {
    const keys = new Set();
    const touch = { left: false, right: false };
    const pointers = new Map();       /* pointerId → 'left' | 'right' */
    let onUnlock = null;
    let onPause = null;
    let els = {};
    let vibrate = true;

    const LEFT_CODES = new Set(['ArrowLeft', 'KeyA']);
    const RIGHT_CODES = new Set(['ArrowRight', 'KeyD']);
    const ALIAS = {
      Left: 'ArrowLeft', Right: 'ArrowRight',
      a: 'KeyA', A: 'KeyA', d: 'KeyD', D: 'KeyD',
      Escape: 'Escape', Esc: 'Escape'
    };

    function codeOf(e) {
      const code = e.code;
      if (LEFT_CODES.has(code) || RIGHT_CODES.has(code) || code === 'Escape') return code;
      const alias = ALIAS[e.key];
      if (alias) return alias;
      return null;
    }

    /** 正在打字（暱稱欄、之後的聊天室）的時候，鍵盤不要被遊戲吃掉 */
    function typing(e) {
      const el = e.target;
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    }

    function keydown(e) {
      if (typing(e)) return;
      const code = codeOf(e);
      if (!code) return;
      if (code === 'Escape') { if (onPause) onPause(); e.preventDefault(); return; }
      keys.add(code);
      e.preventDefault();
      fireUnlock();
    }
    function keyup(e) {
      const code = codeOf(e);
      if (code) keys.delete(code);
    }
    function fireUnlock() { if (onUnlock) { const f = onUnlock; onUnlock = null; f(); } }

    function buzz() {
      if (!vibrate) return;
      try { if (root.navigator && root.navigator.vibrate) root.navigator.vibrate(12); } catch (e) { /* 忽略 */ }
    }

    /* ---------- 觸控：支援手指從一顆滑到另一顆，不用放開再按 ---------- */

    function sideAt(x, y) {
      for (const side of ['left', 'right']) {
        const el = els[side];
        if (!el) continue;
        const b = el.getBoundingClientRect();
        /* 判定範圍略放大，手指壓在邊緣也算按到 */
        const pad = 8;
        if (x >= b.left - pad && x <= b.right + pad && y >= b.top - pad && y <= b.bottom + pad) return side;
      }
      return null;
    }

    function refresh() {
      touch.left = false; touch.right = false;
      for (const side of pointers.values()) {
        if (side === 'left') touch.left = true;
        if (side === 'right') touch.right = true;
      }
      if (els.left) els.left.classList.toggle('pressed', touch.left);
      if (els.right) els.right.classList.toggle('pressed', touch.right);
    }

    function down(e) {
      const side = sideAt(e.clientX, e.clientY);
      if (!side) return;
      pointers.set(e.pointerId, side);
      refresh();
      buzz();
      fireUnlock();
      e.preventDefault();
    }
    function move(e) {
      if (!pointers.has(e.pointerId)) return;
      const side = sideAt(e.clientX, e.clientY);
      const before = pointers.get(e.pointerId);
      if (side) {
        if (side !== before) { pointers.set(e.pointerId, side); refresh(); buzz(); }
      } else if (before) {
        pointers.delete(e.pointerId);
        refresh();
      }
      e.preventDefault();
    }
    function up(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      refresh();
    }

    /* ---------- 對外 ---------- */

    function attach(opt) {
      els = opt || {};
      root.addEventListener('keydown', keydown);
      root.addEventListener('keyup', keyup);
      root.addEventListener('blur', () => { keys.clear(); pointers.clear(); refresh(); });
      const pad = els.pad || root.document.body;
      pad.addEventListener('pointerdown', down);
      root.addEventListener('pointermove', move, { passive: false });
      root.addEventListener('pointerup', up);
      root.addEventListener('pointercancel', up);
      /* 按鍵上不要跳出系統選單／選字 */
      for (const side of ['left', 'right']) {
        if (els[side]) els[side].addEventListener('contextmenu', e => e.preventDefault());
      }
    }

    /** 讀輸入：兩邊同時按住就以「最後按下的那一邊」為準，玩起來才不會卡住 */
    function read() {
      let dir = 0;
      let latest = null;
      for (const code of keys) {
        if (LEFT_CODES.has(code)) latest = -1;
        else if (RIGHT_CODES.has(code)) latest = 1;
      }
      if (latest) dir = latest;
      if (touch.left && !touch.right) dir = -1;
      else if (touch.right && !touch.left) dir = 1;
      else if (touch.left && touch.right) dir = dir || 0;
      return { dir: dir };
    }

    function clear() { keys.clear(); pointers.clear(); refresh(); }
    function onFirstGesture(fn) { onUnlock = fn; }
    function onEsc(fn) { onPause = fn; }
    function setVibrate(v) { vibrate = !!v; }

    return { attach, read, clear, onFirstGesture, onEsc, setVibrate };
  }

  root.Input = { create };
})(typeof self !== 'undefined' ? self : this);
