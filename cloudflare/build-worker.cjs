'use strict';

const fs = require('node:fs');
const path = require('node:path');
const games = require('./games.cjs');

const repoRoot = path.resolve(__dirname, '..');
const gameId = process.env.GAME_ID || path.basename(repoRoot);

if (!games[gameId]) throw new Error('No Cloudflare backend is configured for ' + gameId);

process.env.GAME_SOURCE_DIR = repoRoot;
process.env.GAME_NODE_MODULES = process.env.GAME_NODE_MODULES || path.join(__dirname, 'node_modules');

const { buildGame } = require('./build.cjs');

buildGame(gameId).then(code => {
  const outputFile = path.join(__dirname, 'dist', 'worker.mjs');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, code, 'utf8');
  process.stdout.write('Built Cloudflare backend for ' + gameId + '\n');
}).catch(error => {
  process.stderr.write((error.stack || error.message) + '\n');
  process.exitCode = 1;
});
