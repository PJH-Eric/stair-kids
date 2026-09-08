/* ===== rng.js — 可注入種子的亂數 =====
 * 樓梯生成一律走這裡，同一個 seed 一定長出同一座樓梯，
 * 才能讓測試、AI 驗證與（M2 之後的）線上同步完全重現。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNG = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** xmur3：把字串或數字揉成 32 bit 種子 */
  function hashSeed(seed) {
    const str = String(seed);
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return (h >>> 0) || 1;
  }

  /** mulberry32：小、快、夠均勻 */
  function create(seed) {
    let a = hashSeed(seed);
    const rng = {
      /** [0,1) */
      next() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      /** [min,max] 的浮點數 */
      range(min, max) {
        return min + rng.next() * (max - min);
      },
      /** [min,max] 的整數 */
      int(min, max) {
        return min + Math.floor(rng.next() * (max - min + 1));
      },
      /** 機率 p 命中 */
      chance(p) {
        return rng.next() < p;
      },
      /** 從陣列挑一個 */
      pick(arr) {
        return arr[Math.floor(rng.next() * arr.length)];
      },
      /** 依權重挑一個：items 形如 [{ v, w }, ...] */
      weighted(items) {
        let total = 0;
        for (const it of items) total += it.w;
        if (total <= 0) return null;
        let roll = rng.next() * total;
        for (const it of items) {
          roll -= it.w;
          if (roll < 0) return it.v;
        }
        return items[items.length - 1].v;
      },
      /** 原地洗牌（Fisher-Yates） */
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(rng.next() * (i + 1));
          const t = arr[i];
          arr[i] = arr[j];
          arr[j] = t;
        }
        return arr;
      }
    };
    return rng;
  }

  /** 產一個新的隨機 seed（每一局都要換新的樓梯） */
  function newSeed() {
    return 'sk-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }

  return { create, hashSeed, newSeed };
});
