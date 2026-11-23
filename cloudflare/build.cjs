'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const games = require('./games.cjs');

const sourceRoot = path.resolve(process.env.GAME_SOURCE_ROOT || path.join(__dirname, '../..'));
const configuredGameRoot = process.env.GAME_SOURCE_DIR
  ? path.resolve(process.env.GAME_SOURCE_DIR)
  : null;
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const optionalModules = ['bufferutil', 'supports-color', 'utf-8-validate', 'uWebSockets.js'];

function replaceOnce(source, pattern, replacement) {
  const updated = source.replace(pattern, replacement);
  if (updated === source) throw new Error('Server entry changed around ' + pattern);
  return updated;
}

function gameFactory(id, game, serverFile) {
  let source = fs.readFileSync(serverFile, 'utf8');
  if (id === 'snake-3d') {
    source = replaceOnce(source, /import http from 'node:http';/, 'const http = runtime.http;');
    source = source.replace(/^import (\w+) from '(node:[^']+)';/gm, "const $1 = require('$2');");
    source = source.replace(/^import (\{[^}]+\}) from '(?:node:[^']+|\.\/lib\/[^']+)';/gm,
      (line, names) => names.includes('fileURLToPath') ? '' : "const " + names + " = require('./lib/rooms.js');");
    source = replaceOnce(source, /import \* as ws from '\.\/lib\/ws\.js';/, 'const ws = runtime.ws;');
    source = replaceOnce(source, /const HERE = path\.dirname\(fileURLToPath\(import\.meta\.url\)\);/, "const HERE = '/game';");
    source = replaceOnce(source, /if \(process\.argv\[1\][\s\S]*?export \{ createServer \};/,
      'module.exports = createServer();');
  } else {
    source = replaceOnce(source, /require\('http'\)/, 'runtime.http');
  }
  if (id === 'flip-match') {
    source = replaceOnce(source, /server\.on\('upgrade',[\s\S]*?\n\}\);/, '');
    source += '\nruntime.ws.attach(server, { onConnection: handleClient });\nmodule.exports = { server };\n';
  }
  if (['guess-ab', 'pool-duel', 'stair-kids', 'bomb-squad'].includes(id)) {
    source = replaceOnce(source, /require\('\.\/lib\/ws\.js'\)/, 'runtime.ws');
  }
  if (id === 'guess-ab' && source.includes('const roomStore =')) {
    source = replaceOnce(source, /const roomStore = process\.env\.GUESS_ROOM_DB_PATH[\s\S]+?\n  : null;/,
      'const roomStore = runtime.roomStore;');
  }
  if (['amaze-go', 'angel-strategy', 'maze-roll'].includes(id)) {
    source = replaceOnce(source, /require\('ws'\)/, 'runtime.ws');
  }
  if (id === 'amaze-go') {
    if (source.includes('const hub = new Hub();')) {
      source = replaceOnce(source, /const hub = new Hub\(\);/,
        'const hub = new Hub({ sweep: runtime.setInterval, clearSweep: runtime.clearInterval });');
    } else {
      source = replaceOnce(source, /const hub = new Hub\(\{ checkpoints \}\);/,
        'const hub = new Hub({ checkpoints, sweep: runtime.setInterval, clearSweep: runtime.clearInterval });');
    }
  }
  if (id === 'maze-roll') {
    source = replaceOnce(source, /const hub = new Hub\(\);/,
      'const hub = new Hub({ scheduleSweep: runtime.setInterval, clearSweep: runtime.clearInterval });');
  }
  if (['pool-duel', 'stair-kids'].includes(id)) {
    source = replaceOnce(source, /\nloop\.start\(\);/, '');
  }
  if (game.socketIo || id === 'angel-strategy') {
    source = replaceOnce(source, /require\('express'\)/, 'runtime.express');
  }
  if (game.socketIo) {
    source = replaceOnce(source, /require\('socket\.io'\)/, 'runtime.socketIo');
  }
  if (id === 'bomb-squad') {
    source = replaceOnce(source, /module\.exports = \{ createServer \};/, 'module.exports = createServer();');
  }
  if (['snake-3d', 'bomb-squad'].includes(id)) {
    source = replaceOnce(source, /old\.alive = false; try \{ old\.raw\.end\(\); \} catch \(e\) \{ \/\* 已斷 \*\/ \}(?: setTimeout\(\(\) => old\.raw\.destroy\(\), 2000\)\.unref\(\);)?/,
      'old.close();');
  }
  const roomsApi = source.includes('/api/rooms');
  return `exports.game = ${JSON.stringify({ ...game, id, roomsApi })};
exports.createGame = function (runtime) {
  'use strict';
  const module = { exports: {} };
  const { process, setInterval, clearInterval } = runtime;
  const __dirname = '/game';
  ${source}
  return module.exports;
};`;
}

async function buildGame(id) {
  const game = games[id];
  if (!game) throw new Error('Unknown game: ' + id);
  const esbuild = require(process.env.GAME_ESBUILD_MODULE || 'esbuild');
  const gameRoot = configuredGameRoot || path.join(sourceRoot, id);
  const serverFile = path.join(gameRoot, game.entry || 'server.js');
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'worker.mjs')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    minify: true,
    target: 'es2022',
    metafile: true,
    logLevel: 'silent',
    external: ['cloudflare:workers', ...optionalModules],
    nodePaths: process.env.GAME_NODE_MODULES ? [process.env.GAME_NODE_MODULES] : [],
    plugins: [{
      name: 'game-server',
      setup(build) {
        if (id === 'amaze-go') {
          // The online hub generates its boards from random specs. Campaign boards are browser assets.
          build.onResolve({ filter: /^\.\/levels-v1(?:-extra)?\.js$/ }, ({ importer }) =>
            importer === path.join(gameRoot, 'public', 'js', 'rules.js')
              ? { path: 'campaign', namespace: 'offline-levels' }
              : undefined);
          build.onLoad({ filter: /.*/, namespace: 'offline-levels' }, () => ({
            contents: 'module.exports = { boards: { toddler: [], easy: [], normal: [], hard: [], myth: [] } };',
            loader: 'js'
          }));
        }
        build.onResolve({ filter: /^game-server$/ }, () => ({ path: serverFile, namespace: 'game-server' }));
        build.onLoad({ filter: /.*/, namespace: 'game-server' }, () => ({
          contents: `import factory from 'game-factory';
export const game = factory.game;
export default factory.createGame;`,
          loader: 'js'
        }));
        build.onResolve({ filter: /^game-factory$/ }, () => ({ path: serverFile, namespace: 'game-factory' }));
        build.onLoad({ filter: /.*/, namespace: 'game-factory' }, () => ({
          contents: gameFactory(id, game, serverFile),
          loader: 'js',
          resolveDir: path.dirname(serverFile)
        }));
        build.onResolve({ filter: /^socket-io-adapter$/ }, () => game.socketIo
          ? { path: path.join(__dirname, 'socket-io.mjs'), namespace: 'socket-io-adapter' }
          : { path: 'empty', namespace: 'socket-io-adapter' });
        build.onLoad({ filter: /.*/, namespace: 'socket-io-adapter' }, () => ({
          contents: game.socketIo
            ? "import { Server } from './socket-io.mjs'; export default { Server };"
            : 'export default undefined;',
          loader: 'js',
          resolveDir: __dirname
        }));
        build.onResolve({ filter: /^socket-io-browser-client$/ }, () => ({
          path: 'client', namespace: 'socket-io-browser-client'
        }));
        build.onLoad({ filter: /.*/, namespace: 'socket-io-browser-client' }, () => {
          if (!game.socketIo) return { contents: 'export default null;', loader: 'js' };
          const socketIoRoot = path.join(path.dirname(require.resolve('socket.io')), '..');
          const client = fs.readFileSync(path.join(socketIoRoot, 'client-dist/socket.io.min.js'), 'utf8')
            .replace(/\/\/# sourceMappingURL=.*$/m, '');
          return { contents: 'export default ' + JSON.stringify(client) + ';', loader: 'js' };
        });
      }
    }]
  });
  const external = [...new Set(Object.values(result.metafile.outputs)
    .flatMap(output => output.imports)
    .filter(entry => entry.kind === 'require-call')
    .map(entry => entry.path))];
  const declarations = [];
  const keys = [];
  for (const name of external) {
    const builtin = name.replace(/^node:/, '');
    if (!builtins.has(builtin)) {
      if (!optionalModules.includes(name)) throw new Error('Unbundled dependency: ' + name);
      continue;
    }
    const symbol = 'nodeBuiltin' + declarations.length;
    declarations.push(`import * as ${symbol} from 'node:${builtin}';`);
    keys.push(`${JSON.stringify(name)}: ${symbol}.default ?? ${symbol}`);
  }
  declarations.push(`const builtinModules = {${keys.join(',')}};`);
  declarations.push(`const require = name => {
  if (Object.hasOwn(builtinModules, name)) return builtinModules[name];
  throw new Error('Optional module is unavailable: ' + name);
};`);
  return declarations.join('\n') + '\n' + result.outputFiles[0].text;
}

if (require.main === module) {
  buildGame(process.argv[2]).then(code => {
    if (process.argv[3]) fs.writeFileSync(process.argv[3], code, 'utf8');
    else process.stdout.write(code);
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildGame };
