'use strict';

const { createHmac, randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { deserialize, serialize } = require('node:v8');
const RNG = require('../public/js/rng.js');

function openCheckpoints(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, checkpoint BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS identity (slot INTEGER PRIMARY KEY, salt BLOB NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO identity VALUES (1, ?)').run(randomBytes(32));
  const { salt } = db.prepare('SELECT salt FROM identity WHERE slot = 1').get();
  const list = db.prepare('SELECT checkpoint FROM rooms');
  const save = db.prepare('INSERT INTO rooms VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET checkpoint = excluded.checkpoint');
  const remove = db.prepare('DELETE FROM rooms WHERE id = ?');

  return {
    identity(key) { return 'p' + createHmac('sha256', salt).update(key).digest('hex').slice(0, 24); },
    load() {
      return list.all().map(({ checkpoint }) => {
        const { format, room, rngState, savedAt } = deserialize(checkpoint);
        if (format !== 1) throw new Error('不支援的房間快照版本');
        if (room.match) room.match.gen.rng = RNG.create(room.seed, rngState);
        return { room, savedAt };
      });
    },
    write(room, savedAt) {
      let match = null;
      let rngState;
      if (room.match) {
        const { rng, ...gen } = room.match.gen;
        match = { ...room.match, gen };
        rngState = rng.checkpoint();
      }
      save.run(room.id, serialize({ format: 1, room: { ...room, match }, rngState, savedAt }));
    },
    remove(id) { remove.run(id); }
  };
}

module.exports = { openCheckpoints };
