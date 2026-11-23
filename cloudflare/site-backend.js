(function (window, oraclePilotOrigins) {
  'use strict';

  if (window.location.origin !== 'https://pjh-eric.github.io') return;
  const game = window.location.pathname.split('/')[1];
  const query = new URLSearchParams(window.location.search);
  // Explicit test URLs remain direct connections.
  if (query.has('server')) return;

  const settings = {
    'flip-match': ['flip-match-sg', '/'],
    'guess-ab': ['guess-ab', '/ws'],
    'angel-strategy': ['angel-strategy-server', '/ws'],
    'amaze-go': ['amaze-go-server', '/ws'],
    'fruit-link': ['fruit-link-sg', '/socket.io/'],
    'draw-guess': ['draw-guess-sg', '/socket.io/'],
    'pool-duel': ['pool-duel', '/ws'],
    'house-stack': ['house-stack-server', '/socket.io/'],
    'whack-a-mole': ['whack-a-mole-sg', '/socket.io/'],
    'stair-kids': ['stair-kids-sg', '/ws'],
    'maze-roll': ['maze-roll-server', '/ws'],
    'snake-3d': ['snake-3d-server', '/ws'],
    'bumper-sumo': ['bumper-sumo-83kf', '/socket.io/'],
    'bomb-squad': [null, '/ws'],
    'curling-duel': ['ice-duel-server', '/', 'curling-duel']
  };

  const config = settings[game];
  if (!config) return;
  const [renderName, path, workerName = game + '-backup'] = config;
  const websocketPath = path === '/socket.io/' ? path + '?EIO=4&transport=websocket' : path;
  const cloudflare = {
    id: 'cloudflare', url: 'https://' + workerName + '.eric-games.workers.dev',
    websocketPath, timeoutMs: 5000
  };
  // The Render service for Bomb Squad needs a confirmed endpoint.
  const origin = renderName ? {
    id: 'render', url: 'https://' + renderName + '.onrender.com',
    websocketPath, timeoutMs: 12000
  } : {
    id: 'oracle', url: 'https://bomb-squad.duckdns.org',
    websocketPath, timeoutMs: 8000
  };
  const oracleUrl = oraclePilotOrigins[game];
  let endpoints = [origin, cloudflare];
  if (oracleUrl) {
    const oracle = { id: 'oracle', url: oracleUrl, websocketPath, timeoutMs: 5000 };
    const render = { ...origin, timeoutMs: 3000, wakeTimeoutMs: 45000 };
    endpoints = [oracle, render, cloudflare];
  }
  const roomBackendKey = 'game-backend-room:' + game;
  let roomBackend;
  try { roomBackend = window.sessionStorage.getItem(roomBackendKey); } catch { /* storage may be unavailable */ }
  const route = window.createBackendRouter({ endpoints, pin: query.get('backend') || roomBackend });
  const hosts = new Set(endpoints.map(endpoint => new URL(endpoint.url).host));
  const NativeSocket = window.WebSocket;

  function manages(address) {
    if (!address) return false;
    try { return hosts.has(new URL(address).host); } catch { return false; }
  }

  class RoutedSocket extends EventTarget {
    connecting = true;
    socket = null;

    constructor(address) {
      super();
      this.url = address;
      void this.open(address);
    }

    get readyState() {
      return this.socket?.readyState ?? (this.connecting ? NativeSocket.CONNECTING : NativeSocket.CLOSED);
    }

    notify(event) {
      this.dispatchEvent(event);
      this['on' + event.type]?.call(this, event);
    }

    async open(address) {
      try {
        const selected = await route.select();
        if (!this.connecting) return;
        if (!selected) throw new Error('No available game backend');
        const url = new URL(address);
        url.host = new URL(selected).host;
        this.socket = new NativeSocket(url);
        this.url = url.href;
        this.socket.addEventListener('open', () => this.notify(new Event('open')));
        this.socket.addEventListener('message', event => this.notify(new MessageEvent('message', { data: event.data })));
        this.socket.addEventListener('error', () => this.notify(new Event('error')));
        this.socket.addEventListener('close', event => this.notify(new CloseEvent('close', {
          code: event.code, reason: event.reason, wasClean: event.wasClean
        })));
      } catch {
        this.connecting = false;
        this.notify(new Event('error'));
        this.notify(new CloseEvent('close', { code: 1006 }));
      }
    }

    send(data) { this.socket.send(data); }

    close(code, reason) {
      if (this.socket) this.socket.close(code, reason);
      else this.connecting = false;
    }
  }

  window.GameBackend = {
    canRoute: manages,
    async select(address) {
      if (!manages(address)) return address;
      const selected = await route.select();
      if (!selected) throw new Error('No available game backend');
      return selected;
    },
    createSocket(address) {
      return manages(address) ? new RoutedSocket(address) : new NativeSocket(address);
    },
    pinInvite(address) {
      return route.pinInvite(new URL(address, window.location.href)).toString();
    },
    rememberRoom() {
      const backend = route.pinInvite(new URL(window.location.origin)).searchParams.get('backend');
      if (backend) {
        try { window.sessionStorage.setItem(roomBackendKey, backend); } catch { /* storage may be unavailable */ }
      }
    },
    forgetRoom() {
      try { window.sessionStorage.removeItem(roomBackendKey); } catch { /* storage may be unavailable */ }
    }
  };
})(window, /* ORACLE_PILOT_ORIGINS */ {});
