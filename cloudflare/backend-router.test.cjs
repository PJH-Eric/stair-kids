'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const { createBackendRouter } = require('./backend-router.js');

const cloudflare = { id: 'cloudflare', url: 'https://test.workers.dev' };
const render = { id: 'render', url: 'https://test.onrender.com' };

test('consults the preferred endpoint first in either direction', async () => {
  for (const [primary, standby] of [[cloudflare, render], [render, cloudflare]]) {
    const seen = [];
    const route = createBackendRouter({
      primary,
      standby,
      probe: async endpoint => { seen.push(endpoint.id); return true; }
    });
    assert.equal(await route.select(), primary.url);
    assert.deepEqual(seen, [primary.id]);
  }
});

test('simultaneous opens share one decision and the selected standby is sticky', async () => {
  const seen = [];
  const route = createBackendRouter({
    primary: render,
    standby: cloudflare,
    probe: async endpoint => { seen.push(endpoint.id); return endpoint === cloudflare; }
  });
  assert.deepEqual(await Promise.all([route.select(), route.select()]), [cloudflare.url, cloudflare.url]);
  assert.equal(await route.select(), cloudflare.url);
  assert.deepEqual(seen, ['render', 'cloudflare']);
  assert.equal(route.pinInvite(new URL('https://example.org/?room=ABCD')).search,
    '?room=ABCD&backend=cloudflare');
});

test('an invitation stays on its configured backend even if it differs from the preferred provider', async () => {
  const route = createBackendRouter({
    primary: cloudflare,
    standby: render,
    pin: 'render',
    probe: async () => assert.fail('Pinned invitations should use their assigned backend directly')
  });
  assert.equal(await route.select(), render.url);
});

test('a failed attempt can be retried without changing room routing', async () => {
  let available = false;
  const route = createBackendRouter({
    primary: cloudflare,
    standby: render,
    pin: 'unknown',
    probe: async endpoint => available && endpoint === render
  });
  assert.equal(await route.select(), null);
  available = true;
  assert.equal(await route.select(), render.url);
});

const routerSource = readFileSync(require.resolve('./backend-router.js'), 'utf8');
const siteSource = readFileSync(require.resolve('./site-backend.js'), 'utf8');
const pilotGames = [
  ['draw-guess', 'draw-guess-sg', '/socket.io/?EIO=4&transport=websocket'],
  ['guess-ab', 'guess-ab', '/ws'],
  ['bumper-sumo', 'bumper-sumo-83kf', '/socket.io/?EIO=4&transport=websocket'],
  ['amaze-go', 'amaze-go-server', '/ws'],
  ['stair-kids', 'stair-kids-sg', '/ws'],
  ['house-stack', 'house-stack-server', '/socket.io/?EIO=4&transport=websocket']
];

function virtualRouter() {
  let now = 0;
  const advance = ms => { now += ms; };
  const context = {
    module: { exports: {} }, Date: { now: () => now },
    performance: { now: () => now },
    setTimeout(resolve, ms) { advance(ms); resolve(); }
  };
  runInNewContext(routerSource, context);
  return { create: context.module.exports.createBackendRouter, advance, now: () => now };
}

function siteEndpoints(game, oracleOrigins = {}) {
  let endpoints;
  const window = {
    location: new URL(`https://pjh-eric.github.io/${game}/`),
    createBackendRouter(options) { endpoints = [...options.endpoints]; return {}; }
  };
  const source = siteSource.replace('/* ORACLE_PILOT_ORIGINS */ {}', () => JSON.stringify(oracleOrigins));
  runInNewContext(source, { window, URL, URLSearchParams, EventTarget });
  return endpoints;
}

test('水果連連看使用 Render 與 Cloudflare', () => {
  assert.deepEqual(siteEndpoints('fruit-link').map(endpoint => endpoint.id), ['render', 'cloudflare']);
});

for (const [game, renderName, websocketPath] of pilotGames) {
  test(`${game}: Oracle first, Render wake within 45 seconds, Cloudflare at 50 seconds`, async () => {
    const oracleUrl = `https://${game}.oracle.example`;
    const endpoints = siteEndpoints(game, { [game]: oracleUrl });
    assert.deepEqual(endpoints.map(endpoint => endpoint.url), [
      oracleUrl, `https://${renderName}.onrender.com`, `https://${game}-backup.eric-games.workers.dev`
    ]);
    assert.deepEqual(siteEndpoints(game).map(endpoint => endpoint.id), ['render', 'cloudflare']);
    for (const available of ['oracle', 'render', 'cloudflare']) {
      const clock = virtualRouter();
      const seen = [];
      const probes = [];
      const route = clock.create({ endpoints, probe: async endpoint => {
        seen.push([endpoint.id, clock.now()]);
        probes.push(endpoint);
        if (endpoint.id === available && (available !== 'render' || clock.now() >= 45000)) return true;
        clock.advance(endpoint.timeoutMs);
        return false;
      } });
      const url = endpoints.find(endpoint => endpoint.id === available).url;
      assert.deepEqual(await Promise.all([route.select(), route.select()]), [url, url]);
      assert.ok(probes.every(endpoint => endpoint.websocketPath === websocketPath));
      assert.ok(probes.filter(endpoint => endpoint.id === 'render').every(endpoint => endpoint.timeoutMs <= 3000));
      assert.deepEqual(seen[0], ['oracle', 0]);
      assert.equal(seen.at(-1)[0], available);
      if (available === 'oracle') assert.equal(seen.length, 1);
      if (available === 'render') assert.ok(seen.at(-1)[1] >= 45000 && seen.at(-1)[1] < 50000);
      if (available === 'cloudflare') assert.deepEqual(seen.at(-1), ['cloudflare', 50000]);
      assert.equal(route.pinInvite(new URL('https://game.example/?room=ABCD')).searchParams.get('backend'), available);
    }
  });
}

test('Bomb Squad keeps its Oracle and Cloudflare endpoints in the normal build', () => {
  assert.deepEqual(siteEndpoints('bomb-squad').map(endpoint => endpoint.id), ['oracle', 'cloudflare']);
});

test('a bookmarked room restores its backend after a refresh and is forgotten on leave', () => {
  const storage = new Map();
  let pin;
  const window = {
    location: new URL('https://pjh-eric.github.io/guess-ab/'),
    sessionStorage: {
      getItem: key => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    createBackendRouter(options) {
      pin = options.pin;
      return { pinInvite(url) { url.searchParams.set('backend', 'oracle'); return url; } };
    }
  };
  const source = siteSource.replace('/* ORACLE_PILOT_ORIGINS */ {}', '{"guess-ab":"https://guess-ab.oracle.example"}');
  const load = () => runInNewContext(source, { window, URL, URLSearchParams, EventTarget });
  load();
  window.GameBackend.rememberRoom();
  load();
  assert.equal(pin, 'oracle');
  window.location.search = '?backend=cloudflare';
  load();
  assert.equal(pin, 'cloudflare');
  window.GameBackend.forgetRoom();
  window.location.search = '';
  load();
  assert.equal(pin, undefined);
});

test('a confirmed suspension skips new Render attempts until expiry while preserving pinned rooms', async () => {
  const clock = virtualRouter();
  const suspended = { ...render, skipUntil: 1000 };
  const seen = [];
  const probe = async endpoint => { seen.push(endpoint.id); return true; };
  assert.equal(await clock.create({ endpoints: [suspended, cloudflare], probe }).select(), cloudflare.url);
  assert.deepEqual(seen, ['cloudflare']);
  clock.advance(1000);
  assert.equal(await clock.create({ endpoints: [suspended, cloudflare], probe }).select(), render.url);
  assert.deepEqual(seen, ['cloudflare', 'render']);
  const oracle = { id: 'oracle', url: 'https://pilot.oracle.example' };
  const pinned = clock.create({ endpoints: [render, cloudflare], pinOnly: [oracle], pin: 'oracle', probe });
  assert.equal(await pinned.select(), oracle.url);
  assert.deepEqual(seen, ['cloudflare', 'render']);
});
