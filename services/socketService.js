const jwt = require('jsonwebtoken');
let io = null;

const init = (server, options = {}) => {
  const { Server } = require('socket.io');
  io = new Server(server, {
    cors: {
      origin: (process.env.CORS_ORIGINS && process.env.CORS_ORIGINS.split(',')) || '*',
      credentials: true
    },
    ...options
  });

  // Authenticate sockets using JWT token provided in handshake.auth.token
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Authentication error'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { id: payload.id || payload._id, companyId: payload.companyId };
      return next();
    } catch (err) {
      return next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    try {
      const uid = socket.user && socket.user.id;
      if (uid) {
        const room = `user_${uid}`;
        socket.join(room);
      }

      socket.on('disconnect', () => {
        // clean up if needed
      });
    } catch (err) {
      // ignore
    }
  });

  console.log('Socket.io initialized');
};

const emitToUser = (userId, event, payload) => {
  if (!io) return;
  try {
    const room = `user_${userId}`;
    io.to(room).emit(event, payload);
  } catch (err) {
    console.error('Failed to emit socket event', err);
  }
};

const getIo = () => io;

module.exports = { init, emitToUser, getIo };
