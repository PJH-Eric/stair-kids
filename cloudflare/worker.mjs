import { DurableObject } from 'cloudflare:workers';
import createGame, { game } from 'game-server';
import { allowedOrigin, createRuntime, handleHttp } from './runtime.mjs';
import socketIo from 'socket-io-adapter';
import browserClient from 'socket-io-browser-client';

const headers = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store'
};

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    const socketPath = url.pathname === game.path || (game.path === '/' && url.pathname === '/ws');
    const origin = request.headers.get('Origin');

    if (browserClient && url.pathname === '/socket.io/socket.io.js' && request.method === 'GET' && !upgrade) {
      return new Response(browserClient, {
        headers: {
          ...headers,
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }
    if (upgrade) {
      if (!socketPath) return new Response('Not found', { status: 404, headers });
      if (origin && origin !== allowedOrigin) return new Response('Forbidden', { status: 403 });
      if (game.socketIo && (url.searchParams.get('EIO') !== '4' ||
          url.searchParams.get('transport') !== 'websocket' || url.searchParams.has('sid'))) {
        return new Response('Expected an Engine.IO 4 WebSocket handshake', { status: 400, headers });
      }
    } else {
      if (url.pathname !== '/health' && (!game.roomsApi || url.pathname !== '/api/rooms')) {
        return new Response('Not found', { status: 404, headers });
      }
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });
    }

    return env.LOBBY.getByName(game.id, { locationHint: 'apac' }).fetch(request);
  }
};

function createRoomStore(storage) {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS guess_ab_rooms (id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL)');
  return {
    load() { return sql.exec('SELECT checkpoint FROM guess_ab_rooms').toArray().map(row => JSON.parse(row.checkpoint)); },
    write(changes) {
      storage.transactionSync(() => {
        for (const [id, checkpoint] of changes) {
          if (checkpoint) {
            sql.exec('INSERT INTO guess_ab_rooms VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET checkpoint = excluded.checkpoint',
              id, JSON.stringify(checkpoint));
          } else {
            sql.exec('DELETE FROM guess_ab_rooms WHERE id = ?', id);
          }
        }
      });
    }
  };
}

export class GameLobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runtime = createRuntime(game, socketIo);
    if (game.id === 'guess-ab') {
      this.runtime.roomStore = createRoomStore(ctx.storage);
      this.runtime.process.exit = () => ctx.abort('Guess AB room checkpoint failed');
    }
    this.server = createGame(this.runtime);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      await this.runtime.open(server, request, this.server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (game.id === 'flip-match') return Response.json({ ok: true, service: game.id }, { headers });
    return handleHttp(request, this.server.server);
  }
}
