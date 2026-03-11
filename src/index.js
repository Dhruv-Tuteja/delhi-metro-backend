require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { initializeFirebase } = require('./firebase/firebaseAdmin');
const { registerTrackingSocket } = require('./socket/trackingSocket');
const signalMonitor = require('./services/signalMonitor');
const sessionRoutes = require('./routes/sessionRoutes');
const bugReportRoutes = require('./routes/bugReportRoutes');
const { requireApiKey } = require('./middleware/apiKeyAuth');
const logger = require('./utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

initializeFirebase();

const app = express();
const server = http.createServer(app);

// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO
// ─────────────────────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:5173',
      /\.vercel\.app$/,   // Allow all Vercel preview URLs
    ],
    methods: ['GET', 'POST'],
  },
  pingTimeout: 30_000,
  pingInterval: 10_000,
  transports: ['websocket', 'polling'],
});

registerTrackingSocket(io);
signalMonitor.start(io);

// Make io accessible to route handlers (e.g. sessionRoutes needs it to emit session:ended)
app.set('io', io);

// ─────────────────────────────────────────────────────────────────────────────
// Express Middleware
// ─────────────────────────────────────────────────────────────────────────────

app.use(helmet());
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:5173',
      /\.vercel\.app$/,
    ],
  })
);
app.use(express.json({ limit: '2mb' })); // GPS path payloads can be large
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// Session start/end require Android API key; GET is public (website uses it)
app.use('/api/sessions', sessionRoutes);

// Bug reports are public (website form)
app.use('/api/bug-reports', bugReportRoutes);

// Health check — used by Railway to verify the server is up
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    env: process.env.NODE_ENV,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT) || 3001;
server.listen(PORT, () => {
  logger.info(`Delhi Metro Tracker backend running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  signalMonitor.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
