import { Server as SocketIo } from 'socket.io';
import { Server as EngineIo } from 'engine.io';

export class Server extends SocketIo {
  constructor(_http, options) {
    super({ serveClient: false });
    this.bind(new EngineIo({
      transports: ['websocket'],
      wsEngine: class { close() {} },
      pingInterval: options.pingInterval,
      pingTimeout: options.pingTimeout,
      maxHttpBufferSize: options.maxHttpBufferSize,
      perMessageDeflate: false
    }));
  }

  acceptWebSocket(connection, request) {
    const url = new URL(request.url);
    const address = request.headers.get('CF-Connecting-IP') || '';
    return this.engine.handshake('websocket', {
      url: url.pathname + url.search,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      _query: Object.fromEntries(url.searchParams),
      connection: { remoteAddress: address, encrypted: url.protocol === 'https:' },
      websocket: connection
    }, () => connection.close(1008));
  }
}
