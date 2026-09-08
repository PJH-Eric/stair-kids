/* ===== storage.js — 本機設定與紀錄（只存在這台裝置，不上傳、不做伺服器排行榜） =====
 * 規劃書 §13。
 */
(function (root) {
  'use strict';
  const KEY = 'stair-kids';

  const DEFAULTS = {
    /* 上次用的暱稱與角色，下次自動帶入 */
    nickname: '',
    char: 'yuan',
    difficulty: 'normal',
    /* 設定彈窗（規劃書 §7.5） */
    bgm: true,
    bgmVol: 0.35,
    sfx: true,
    sfxVol: 0.6,
    vibrate: true,
    reduceMotion: false,
    colorAssist: false,
    depthGuide: false,
    seenHelp: false,
    seenRotateTip: false,
    /* 紀錄 */
    records: {},          /* { [難度]: { depth, world, date } } */
    bestWorld: 0,         /* 到達過的最深世界 */
    charUse: {},          /* 各角色使用次數 → 算出常用角色 */
    versus: { ai: { win: 0, lose: 0 }, online: { win: 0, lose: 0 } },
    plays: 0
  };

  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    const data = Object.assign({}, DEFAULTS, raw || {});
    data.records = Object.assign({}, (raw && raw.records) || {});
    data.charUse = Object.assign({}, (raw && raw.charUse) || {});
    data.versus = {
      ai: Object.assign({ win: 0, lose: 0 }, (raw && raw.versus && raw.versus.ai) || {}),
      online: Object.assign({ win: 0, lose: 0 }, (raw && raw.versus && raw.versus.online) || {})
    };
    return data;
  }

  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 無痕模式等等，忽略 */ }
  }

  /** 清除本機紀錄（設定彈窗那顆），設定本身保留 */
  function clearRecords(data) {
    data.records = {};
    data.bestWorld = 0;
    data.charUse = {};
    data.versus = { ai: { win: 0, lose: 0 }, online: { win: 0, lose: 0 } };
    data.plays = 0;
    save(data);
    return data;
  }

  /** 恢復預設（設定全部回到出廠值，紀錄不動） */
  function resetSettings(data) {
    const keep = {
      records: data.records, bestWorld: data.bestWorld, charUse: data.charUse,
      versus: data.versus, plays: data.plays, nickname: data.nickname, char: data.char
    };
    const next = Object.assign({}, DEFAULTS, keep);
    save(next);
    return next;
  }

  /**
   * 一局結束後記一筆。
   * @returns {{ record: boolean, best: object }} record 為 true 代表破了本機記錄
   */
  function record(data, info) {
    const diff = info.difficulty;
    const meters = Math.floor(info.depth || 0);
    const world = info.world || 0;
    const prev = data.records[diff] || { depth: 0, world: 0, date: '' };
    const isRecord = meters > prev.depth;
    data.records[diff] = {
      depth: Math.max(prev.depth, meters),
      world: Math.max(prev.world, world),
      date: isRecord ? new Date().toISOString().slice(0, 10) : prev.date
    };
    data.bestWorld = Math.max(data.bestWorld || 0, world);
    if (info.char) data.charUse[info.char] = (data.charUse[info.char] || 0) + 1;
    data.plays = (data.plays || 0) + 1;
    if (info.versus && info.versus.kind) {
      const bucket = data.versus[info.versus.kind];
      if (bucket) { if (info.versus.win) bucket.win++; else bucket.lose++; }
    }
    save(data);
    return { record: isRecord, best: data.records[diff] };
  }

  /** 最常用的角色 id（沒紀錄就回 null） */
  function favoriteChar(data) {
    let best = null, n = 0;
    for (const id in data.charUse) if (data.charUse[id] > n) { n = data.charUse[id]; best = id; }
    return best;
  }

  root.Store = { load, save, record, clearRecords, resetSettings, favoriteChar, DEFAULTS, KEY };
})(typeof self !== 'undefined' ? self : this);
