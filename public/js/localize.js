/* ===== localize.js — 把資料模組裡的中文名稱接上多語系（只在瀏覽器載入） =====
 * characters.js／scenes.js／rules.js／ai.js 同時給伺服器與測試用，裡面的 name 維持中文
 * （伺服器訊息與測試不變）。瀏覽器這邊把 name 換成「依目前語言查字典」的 getter，
 * 所以畫面上任何地方讀 .name 都會得到目前語言的名稱，語言切換後也會跟著變。
 */
(function (root) {
  'use strict';
  const I = root.I18N;
  if (!I) return;

  /** 在物件上放一個依語言取字典的 name（不能改寫的物件就略過） */
  function localName(obj, keyOf) {
    try {
      Object.defineProperty(obj, 'name', {
        enumerable: true, configurable: true,
        get() { return I.t(keyOf(obj)); }
      });
    } catch (e) { /* 凍結的物件：維持原樣 */ }
  }

  if (root.Characters) root.Characters.CHARACTERS.forEach(c => localName(c, o => 'char.' + o.id));
  if (root.Rules) Object.keys(root.Rules.DIFFICULTY).forEach(id => localName(root.Rules.DIFFICULTY[id], () => 'diff.' + id));
  if (root.Ai) Object.keys(root.Ai.LEVELS).forEach(id => localName(root.Ai.LEVELS[id], () => 'diff.' + id));
  if (root.Scenes) {
    root.Scenes.SCENES.forEach(s => localName(s, o => 'scene.' + o.id));
    const orig = root.Scenes.sceneFor;
    /* sceneFor 會複製一份場景物件，所以名稱要在複製出來之後再補上 */
    root.Scenes.sceneFor = function (world) {
      const sc = orig(world);
      const base = I.t('scene.' + sc.id);
      sc.name = sc.night ? I.t('scene.night', { name: base }) : base;
      return sc;
    };
  }
})(typeof self !== 'undefined' ? self : this);
