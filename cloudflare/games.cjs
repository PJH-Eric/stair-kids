module.exports = {
  'flip-match': { path: '/', maxPayload: 64 * 1024 },
  'guess-ab': { path: '/ws', maxPayload: 64 * 1024 },
  'angel-strategy': { path: '/ws', maxPayload: 4096 },
  'amaze-go': { path: '/ws', maxPayload: 4096 },
  'fruit-link': { path: '/socket.io/', maxPayload: 100000, socketIo: true },
  'draw-guess': { path: '/socket.io/', maxPayload: 200000, socketIo: true },
  'pool-duel': { path: '/ws', maxPayload: 64 * 1024 },
  'house-stack': { path: '/socket.io/', maxPayload: 100000, socketIo: true },
  'whack-a-mole': { path: '/socket.io/', maxPayload: 100000, socketIo: true },
  'stair-kids': { path: '/ws', maxPayload: 64 * 1024 },
  'maze-roll': { path: '/ws', maxPayload: 4096 },
  'snake-3d': { path: '/ws', maxPayload: 4000, entry: 'server/server.js' },
  'bumper-sumo': { path: '/socket.io/', maxPayload: 100000, socketIo: true },
  'bomb-squad': { path: '/ws', maxPayload: 4000 }
};
