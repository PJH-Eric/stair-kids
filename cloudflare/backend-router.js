(function (root, factory) {
  const createBackendRouter = factory();
  if (typeof module === 'object' && module.exports) module.exports = { createBackendRouter };
  else root.createBackendRouter = createBackendRouter;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function socketProbe(endpoint) {
    return new Promise(resolve => {
      let socket;
      let timer;
      let settled = false;

      function finish(available) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket && socket.readyState < 2) socket.close();
        resolve(available);
      }

      try {
        const url = new URL(endpoint.websocketPath, endpoint.url + '/');
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(url);
        socket.addEventListener('open', () => finish(true), { once: true });
        socket.addEventListener('error', () => finish(false), { once: true });
        socket.addEventListener('close', () => finish(false), { once: true });
        timer = setTimeout(() => finish(false), endpoint.timeoutMs);
      } catch {
        finish(false);
      }
    });
  }

  async function tryProbe(probe, endpoint) {
    try {
      return await probe(endpoint);
    } catch {
      return false;
    }
  }

  async function checkEndpoint(probe, endpoint) {
    if (!endpoint.wakeTimeoutMs) return tryProbe(probe, endpoint);

    const deadline = performance.now() + endpoint.wakeTimeoutMs;
    let remaining = deadline - performance.now();
    while (remaining > 0) {
      const timeoutMs = Math.min(endpoint.timeoutMs, remaining);
      if (await tryProbe(probe, { ...endpoint, timeoutMs })) return true;
      remaining = deadline - performance.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(3000, remaining)));
      remaining = deadline - performance.now();
    }
    return false;
  }

  function createBackendRouter({ primary, standby, endpoints = [primary, standby], pinOnly = [], pin, probe = socketProbe }) {
    const candidates = endpoints.filter(Boolean);
    const pinned = [...candidates, ...pinOnly].find(endpoint => endpoint.id === pin);
    let selected = pinned;
    let pending;

    async function choose() {
      for (const endpoint of candidates) {
        if (endpoint.skipUntil > Date.now()) continue;
        if (await checkEndpoint(probe, endpoint)) {
          selected = endpoint;
          return selected.url;
        }
      }
      return null;
    }

    return {
      get url() {
        return (selected || candidates[0])?.url ?? null;
      },
      select() {
        if (selected) return Promise.resolve(selected.url);
        pending ??= choose().finally(() => { pending = undefined; });
        return pending;
      },
      pinInvite(url) {
        if (selected) url.searchParams.set('backend', selected.id);
        return url;
      }
    };
  }

  return createBackendRouter;
});
