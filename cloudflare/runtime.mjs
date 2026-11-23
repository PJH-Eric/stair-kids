import { EventEmitter } from 'node:events';

export const allowedOrigin = 'https://pjh-eric.github.io';

function connectSocket(socket, maxPayload) {
  const connection = new EventEmitter();
  const encoder = new TextEncoder();
  connection.data = {};
  connection.lastSeen = Date.now();
  Object.defineProperties(connection, {
    alive: { get: () => socket.readyState === WebSocket.OPEN },
    readyState: { get: () => socket.readyState }
  });
  connection.send = (message, callback) => {
    if (!connection.alive) {
      callback?.(new Error('Socket closed'));
      return;
    }
    try {
      socket.send(message);
      if (callback) queueMicrotask(() => callback());
    } catch (error) {
      if (callback) queueMicrotask(() => callback(error));
    }
  };
  connection.sendText = connection.send;
  connection.sendJSON = message => connection.send(JSON.stringify(message));
  connection.close = code => {
    if (connection.alive) socket.close(typeof code === 'number' ? code : 1000);
  };
  connection.terminate = connection.close;
  connection.ping = () => {
    // The Workers API does not expose WebSocket control frames.
    // Clients with application-level heartbeats still get those from the game.
    connection.emit('pong');
  };
  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    if (encoder.encode(data).byteLength > maxPayload) {
      connection.close(1009);
      return;
    }
    connection.lastSeen = Date.now();
    connection.emit('message', data, false);
  });
  const close = () => {
    socket.removeEventListener('error', close);
    socket.removeEventListener('close', close);
    connection.emit('close');
  };
  socket.addEventListener('close', close);
  socket.addEventListener('error', close);
  return connection;
}

function createHttpServer(handler) {
  const server = new EventEmitter();
  server.on('request', handler);
  // The standalone Flip Match entry starts listening as soon as it loads.
  server.listen = () => server;
  return server;
}

function express() {
  const routes = new Map();
  const app = (request, response) => {
    const route = routes.get(new URL(request.url, 'https://worker.invalid').pathname);
    if (route) return route(request, response);
    response.writeHead(404);
    response.end();
  };
  app.get = (path, handler) => routes.set(path, handler);
  app.disable = () => {};
  app.use = () => {};
  return app;
}
express.static = () => {};

export function createRuntime(game, socketIo) {
  let onConnection;
  let clientCount = 0;
  const timers = new Set();
  const runtime = {
    http: { createServer: createHttpServer },
    express,
    socketIo,
    process: {
      env: { GAME_ALLOWED_ORIGIN: allowedOrigin, ALLOW_ORIGIN: allowedOrigin },
      uptime: () => (Date.now() - startedAt) / 1000,
      on() {}
    },
    setInterval(callback, delay) {
      const timer = { callback, delay, handle: undefined, unref() {} };
      timers.add(timer);
      if (clientCount) timer.handle = setInterval(callback, delay);
      return timer;
    },
    clearInterval(timer) {
      clearInterval(timer?.handle);
      timers.delete(timer);
    },
    ws: {
      attach(_server, options) {
        onConnection = options.onConnection;
      },
      WebSocketServer: class extends EventEmitter {
        clients = new Set();

        constructor() {
          super();
          onConnection = connection => {
            this.clients.add(connection);
            connection.once('close', () => this.clients.delete(connection));
            this.emit('connection', connection);
          };
        }
      }
    },
    open(socket, request, gameServer) {
      const connection = connectSocket(socket, game.maxPayload);
      if (clientCount++ === 0) {
        for (const timer of timers) timer.handle = setInterval(timer.callback, timer.delay);
        gameServer.loop?.start();
      }
      connection.once('close', () => {
        // Let the game's own disconnect listener update seats and broadcast first.
        queueMicrotask(() => {
          if (--clientCount) return;
          for (const timer of timers) {
            clearInterval(timer.handle);
            timer.handle = undefined;
          }
          gameServer.loop?.stop();
        });
      });
      if (game.socketIo) return gameServer.io.acceptWebSocket(connection, request);
      onConnection(connection);
    }
  };
  const startedAt = Date.now();
  return runtime;
}

export function handleHttp(request, server) {
  const url = new URL(request.url);
  return new Promise(resolve => {
    let status = 200;
    const headers = new Headers({
      'Access-Control-Allow-Origin': allowedOrigin,
      'Cache-Control': 'no-store'
    });
    const response = {
      setHeader(name, value) { headers.set(name, value); },
      writeHead(code, extra) {
        status = code;
        for (const [name, value] of Object.entries(extra || {})) headers.set(name, value);
        return response;
      },
      json(body) {
        headers.set('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(body));
      },
      end(body) { resolve(new Response(body, { status, headers })); }
    };
    server.emit('request', {
      url: url.pathname + url.search,
      method: request.method,
      headers: Object.fromEntries(request.headers)
    }, response);
  });
}
