/* ===== records.js — 對局紀錄、統計與成就（只存本機，不連後端） =====
 * 參考 bumper-sumo／house-stack 的紀錄系統。
 * 計入：單機、跟電腦、線上對戰的最終結果；觀戰、中途離開（手動結束的單機除外）不計。
 * 去重：matchId 記在 seen，重送不會重複累計。
 * 保存：localStorage「stair-kids:v1:records」，近期明細保留 50 局。
 */
(function (root) {
  'use strict';
  var KEY = 'stair-kids:v1:records';
  var GAME = 'stair-kids';
  var KEEP = 50, KEEP_IDS = 1000;

  /* 成就：kind total＝累計值、single＝單局最高值；metric 對應下方計算 */
  var ACH = [
    { id: 'first_run', icon: 'flag', target: 1, kind: 'total', metric: 'games' },
    { id: 'games_20', icon: 'run', target: 20, kind: 'total', metric: 'games' },
    { id: 'depth_50', icon: 'down', target: 50, kind: 'single', metric: 'meters' },
    { id: 'depth_100', icon: 'down', target: 100, kind: 'single', metric: 'meters' },
    { id: 'depth_300', icon: 'down', target: 300, kind: 'single', metric: 'meters' },
    { id: 'depth_500', icon: 'star', target: 500, kind: 'single', metric: 'meters' },
    { id: 'all_worlds', icon: 'globe', target: 5, kind: 'single', metric: 'world' },
    { id: 'clean_100', icon: 'shield', target: 1, kind: 'single', metric: 'cleanRun' },
    { id: 'spring_20', icon: 'spring', target: 20, kind: 'total', metric: 'springs' },
    { id: 'heal_10', icon: 'heart', target: 10, kind: 'total', metric: 'heals' },
    { id: 'ai_win', icon: 'crown', target: 1, kind: 'total', metric: 'aiWins' },
    { id: 'online_win', icon: 'globe', target: 1, kind: 'total', metric: 'onlineWins' }
  ];

  var memory = null, saveOk = true;

  function newId() {
    try { if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID(); } catch (e) { /* 舊瀏覽器 */ }
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function blank() {
    return { schemaVersion: 1, gameId: GAME, profileId: newId(), matches: [], seen: [], stats: {}, ach: {} };
  }
  function migrate(d) {
    if (!d.profileId) d.profileId = newId();
    ['matches', 'seen'].forEach(function (k) { if (!Array.isArray(d[k])) d[k] = []; });
    ['stats', 'ach'].forEach(function (k) { if (!d[k] || typeof d[k] !== 'object') d[k] = {}; });
    return d;
  }
  function load() {
    if (memory) return memory;
    var raw = null, d = null;
    try { raw = root.localStorage.getItem(KEY); } catch (e) { saveOk = false; }
    if (raw) {
      try { d = JSON.parse(raw); } catch (e) { d = null; }
      if (!d || typeof d !== 'object' || d.gameId !== GAME) {
        try { root.localStorage.setItem(KEY + ':corrupt:' + Date.now(), raw); } catch (e2) { /* 存不下就算了 */ }
        d = null;
      }
    }
    memory = migrate(d || blank());
    return memory;
  }
  function persist() {
    try { root.localStorage.setItem(KEY, JSON.stringify(memory)); saveOk = true; } catch (e) { saveOk = false; }
    return saveOk;
  }
  function newTotals() {
    return { games: 0, wins: 0, meters: 0, springs: 0, heals: 0, spikes: 0, aiWins: 0, onlineWins: 0, playSec: 0 };
  }

  /**
   * 記一局。row：{ matchId, mode:'solo'|'ai'|'online', difficulty, meters, world, survived, win(null=單機), spikes, springs, heals, fakes }
   * 回傳 { recorded, duplicate, unlocked:[id], saved }
   */
  function record(row) {
    var d = load();
    if (!row || !row.matchId) return { recorded: false, unlocked: [] };
    if (d.seen.indexOf(row.matchId) >= 0) return { recorded: false, duplicate: true, unlocked: [], saved: saveOk };
    var meters = Math.max(0, Math.floor(row.meters || 0));
    var entry = {
      matchId: row.matchId, mode: row.mode, difficulty: row.difficulty || null, meters: meters,
      world: row.world | 0, survived: Math.round(row.survived || 0), win: row.win == null ? null : !!row.win,
      spikes: row.spikes | 0, springs: row.springs | 0, heals: row.heals | 0, at: new Date().toISOString()
    };
    d.matches.unshift(entry);
    if (d.matches.length > KEEP) d.matches.length = KEEP;
    d.seen.push(row.matchId);
    if (d.seen.length > KEEP_IDS) d.seen.splice(0, d.seen.length - KEEP_IDS);

    var tot = d.stats.all || (d.stats.all = newTotals());
    tot.games++; tot.meters += meters; tot.springs += entry.springs; tot.heals += entry.heals;
    tot.spikes += entry.spikes; tot.playSec += entry.survived;
    if (entry.win === true) {
      tot.wins++;
      if (row.mode === 'ai') tot.aiWins++;
      if (row.mode === 'online') tot.onlineWins++;
    }
    var bk = d.stats[row.mode] || (d.stats[row.mode] = { games: 0, wins: 0, best: 0 });
    bk.games++; if (entry.win === true) bk.wins++; bk.best = Math.max(bk.best, meters);

    var single = {
      meters: meters, world: entry.world,
      cleanRun: meters >= 100 && entry.spikes === 0 ? 1 : 0
    };
    var unlocked = [];
    ACH.forEach(function (a) {
      var cur = d.ach[a.id] || (d.ach[a.id] = { progress: 0, unlockedAt: null });
      if (cur.unlockedAt) return;
      var v = a.kind === 'total' ? tot[a.metric] : Math.max(cur.progress, single[a.metric] || 0);
      cur.progress = Math.min(a.target, v);
      if (v >= a.target) { cur.unlockedAt = new Date().toISOString(); unlocked.push(a.id); }
    });
    return { recorded: true, duplicate: false, unlocked: unlocked, saved: persist() };
  }

  function clearAll() {
    var pid = load().profileId;
    memory = blank(); memory.profileId = pid;
    try { root.localStorage.removeItem(KEY); } catch (e) { /* 被擋 */ }
    persist();
  }

  if (root.addEventListener) root.addEventListener('storage', function (e) { if (e.key === KEY) memory = null; });

  var api = {
    ACH: ACH, KEEP: KEEP, KEY: KEY, newTotals: newTotals,
    data: load, record: record, clearAll: clearAll, saveOk: function () { return saveOk; },
    _reset: function () { memory = null; }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StairRecords = api;
})(typeof window !== 'undefined' ? window : globalThis);
