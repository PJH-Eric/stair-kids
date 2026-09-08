/* ===== themes/nicknames.js — 隨機可愛暱稱（形容詞 × 小動物） =====
 * 規劃書 §6／§14.3：進大廳不強迫打字，預設給一個隨機可愛名，對戰時可以自己改。
 * M0 單機只用來當預設玩家名；M3 線上會用同一份詞庫。
 */
(function (root) {
  'use strict';

  const ADJ = ['藍藍', '飛快', '勇敢', '愛睏', '圓圓', '亮亮', '胖胖', '跳跳',
    '香香', '呼呼', '軟軟', '閃閃', '溜溜', '甜甜', '毛毛', '咚咚'];
  const ANIMAL = ['小熊', '小兔', '小雞', '小貓', '小狗', '小企鵝', '小青蛙', '小熊貓',
    '小刺蝟', '小海豹', '小松鼠', '小恐龍'];

  /** 用亂數函式（預設 Math.random）組一個暱稱 */
  function random(rand) {
    const r = rand || Math.random;
    return ADJ[Math.floor(r() * ADJ.length)] + ANIMAL[Math.floor(r() * ANIMAL.length)];
  }

  const api = { ADJ, ANIMAL, random, COUNT: ADJ.length * ANIMAL.length };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Nicknames = api;
})(typeof self !== 'undefined' ? self : this);
