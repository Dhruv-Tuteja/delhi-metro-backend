const sessionStore = require('./sessionStore');
const logger = require('../utils/logger');

const SIGNAL_LOSS_THRESHOLD_MS = parseInt(process.env.SIGNAL_LOSS_THRESHOLD_MS) || 120_000; // 2 minutes
const CHECK_INTERVAL_MS = 15_000; // Check every 15 seconds

/**
 * SignalMonitor — polls all active sessions and emits signal_lost / signal_restored
 * events via the Socket.IO server when a phone stops sending GPS updates.
 *
 * SOLID:
 *   Single Responsibility: only monitors signal health.
 *   Dependency Inversion: receives io (Socket.IO server) via start(), not hardcoded.
 */
class SignalMonitor {
  constructor() {
    this._timer = null;
    this._io = null;
  }

  /**
   * Starts the monitoring loop.
   * @param {import('socket.io').Server} io
   */
  start(io) {
    if (this._timer) return; // Already running
    this._io = io;
    this._timer = setInterval(() => this._check(), CHECK_INTERVAL_MS);
    logger.info(`SignalMonitor started (threshold: ${SIGNAL_LOSS_THRESHOLD_MS / 1000}s, interval: ${CHECK_INTERVAL_MS / 1000}s)`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      logger.info('SignalMonitor stopped');
    }
  }

  /** @private */
  _check() {
    const now = Date.now();
    const activeSessions = sessionStore.getAllActive();

    for (const session of activeSessions) {
      const timeSinceLastPing = now - session.lastPingAt;
      const wasSignalLost = session.signalLost;
      const isSignalLost = timeSinceLastPing > SIGNAL_LOSS_THRESHOLD_MS;

      if (isSignalLost && !wasSignalLost) {
        // Signal just dropped
        sessionStore.setSignalLost(session.trackingId, true);
        this._emit(session.trackingId, 'signal_lost', {
          trackingId: session.trackingId,
          lastSeenAt: session.lastPingAt,
          secondsSinceLastPing: Math.floor(timeSinceLastPing / 1000),
        });
        logger.warn(`Signal lost for session ${session.trackingId} (${Math.floor(timeSinceLastPing / 1000)}s ago)`);
      } else if (!isSignalLost && wasSignalLost) {
        // Signal restored
        sessionStore.setSignalLost(session.trackingId, false);
        this._emit(session.trackingId, 'signal_restored', {
          trackingId: session.trackingId,
          restoredAt: now,
        });
        logger.info(`Signal restored for session ${session.trackingId}`);
      }
    }
  }

  /**
   * Emits an event to all WebSocket clients watching a specific tracking room.
   * @private
   */
  _emit(trackingId, event, data) {
    if (!this._io) return;
    this._io.to(`track:${trackingId}`).emit(event, data);
  }
}

module.exports = new SignalMonitor();
