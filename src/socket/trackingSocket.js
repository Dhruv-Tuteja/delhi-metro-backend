const sessionStore = require('../services/sessionStore');
const logger = require('../utils/logger');

/**
 * Determines the travel segment type based on speed and station proximity.
 * @param {number} speedKmh
 * @param {boolean} nearStation
 * @returns {'metro'|'walking'|'vehicle'}
 */
function classifySegment(speedKmh, nearStation) {
  if (nearStation) return 'metro';
  if (speedKmh < 8) return 'walking';
  if (speedKmh > 25) return 'vehicle';
  return 'walking';
}

/**
 * Registers all Socket.IO event handlers for real-time location tracking.
 *
 * SOLID:
 *   Single Responsibility: only handles WebSocket event wiring.
 *   Open/Closed: new event types can be added without modifying existing handlers.
 *   Dependency Inversion: receives io as parameter, not imported directly.
 *
 * Rooms:
 *   track:{trackingId}  — All viewers watching a specific journey
 *   phone:{trackingId}  — The Android device streaming location (private)
 *
 * @param {import('socket.io').Server} io
 */
function registerTrackingSocket(io) {
  io.on('connection', (socket) => {
    logger.debug(`Socket connected: ${socket.id}`);

    // ─────────────────────────────────────────────────────────────────────────
    // ANDROID APP: joins as the location sender for a session
    // ─────────────────────────────────────────────────────────────────────────
    socket.on('phone:join', ({ trackingId }) => {
      if (!trackingId) return;

      const session = sessionStore.get(trackingId);
      if (!session) {
        socket.emit('error', { code: 'SESSION_NOT_FOUND', message: 'No active session for this tracking ID' });
        return;
      }

      socket.join(`phone:${trackingId}`);
      socket.join(`track:${trackingId}`); // Phone also gets events (e.g. viewer count)
      socket.data.trackingId = trackingId;
      socket.data.role = 'phone';

      socket.emit('phone:joined', {
        trackingId,
        message: 'Connected to tracking server',
        sessionStartedAt: session.startedAt,
      });

      logger.info(`Phone joined session: ${trackingId}`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ANDROID APP: sends a GPS location update
    // ─────────────────────────────────────────────────────────────────────────
    socket.on('location:update', (payload) => {
      const { trackingId, lat, lng, timestamp, speedKmh = 0, accuracy = 0, segment: androidSegment } = payload;

      if (!trackingId || lat === undefined || lng === undefined) {
        logger.warn('Invalid location:update payload received');
        return;
      }

      const session = sessionStore.get(trackingId);
      if (!session || !session.isActive) return;

      // Trust Android's segment classification — it uses the state machine
      // which knows whether the user is currently in a confirmed metro leg.
      // Fall back to speed-based classification only if Android didn't send one.
      const segment = androidSegment || (speedKmh > 30 ? 'metro' : 'transit');

      const point = { lat, lng, timestamp: timestamp || Date.now(), segment, accuracy };

      // Store in buffer
      sessionStore.appendGpsPoint(trackingId, point);

      // Relay to all viewers in the room (excluding the sender)
      socket.to(`track:${trackingId}`).emit('location:update', {
        trackingId,
        lat,
        lng,
        timestamp: point.timestamp,
        segment,
        speedKmh,
        accuracy,
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ANDROID APP: notifies that a station was crossed
    // ─────────────────────────────────────────────────────────────────────────
    socket.on('station:visited', ({ trackingId, stationId, stationName, timestamp }) => {
      if (!trackingId || !stationId) return;

      sessionStore.markStationVisited(trackingId, stationId);

      // Get full visited list so viewers mark all stations up to this one
      // (handles manual jumps that skip intermediate stations)
      const session = sessionStore.get(trackingId);
      const allVisited = session ? session.visitedStationIds : [stationId];

      // Relay to all viewers
      io.to(`track:${trackingId}`).emit('station:visited', {
        trackingId,
        stationId,
        stationName,
        allVisitedStationIds: allVisited,
        timestamp: timestamp || Date.now(),
      });

      logger.debug(`Station visited: ${stationName} on ${trackingId}`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ANDROID APP: SOS was triggered
    // ─────────────────────────────────────────────────────────────────────────
    socket.on('sos:triggered', ({ trackingId, stationName, locationUrl }) => {
      if (!trackingId) return;

      sessionStore.markSosAlert(trackingId, stationName, locationUrl);

      io.to(`track:${trackingId}`).emit('sos:triggered', {
        trackingId,
        stationName,
        locationUrl,
        timestamp: Date.now(),
      });

      logger.warn(`SOS triggered for session: ${trackingId} at ${stationName}`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // WEBSITE VIEWER: joins to watch a live journey
    // ─────────────────────────────────────────────────────────────────────────
    socket.on('viewer:join', ({ trackingId }) => {
      if (!trackingId) return;

      const session = sessionStore.toPublicView(trackingId);
      if (!session) {
        socket.emit('error', { code: 'SESSION_NOT_FOUND', message: 'Journey not found or has ended' });
        return;
      }

      socket.join(`track:${trackingId}`);
      socket.data.trackingId = trackingId;
      socket.data.role = 'viewer';

      // If the phone is still connected, signal isn't actually lost —
      // clear stale signalLost flag before sending snapshot so viewer
      // doesn't see "connection lost" banner after their own net dropped
      const phoneRoom = io.sockets.adapter.rooms.get(`phone:${trackingId}`);
      if (phoneRoom && phoneRoom.size > 0) {
        sessionStore.setSignalLost(trackingId, false);
      }

      // Send full current state immediately so the map renders without waiting
      const freshSession = sessionStore.toPublicView(trackingId);
      socket.emit('session:snapshot', freshSession);

      // Broadcast updated viewer count to the phone
      const viewerCount = getViewerCount(io, trackingId);
      io.to(`phone:${trackingId}`).emit('viewers:count', { count: viewerCount });

      logger.info(`Viewer joined session: ${trackingId} (total viewers: ${viewerCount})`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // DISCONNECT: clean up rooms
    // ─────────────────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const { trackingId, role } = socket.data;

      if (trackingId && role === 'viewer') {
        const viewerCount = getViewerCount(io, trackingId);
        io.to(`phone:${trackingId}`).emit('viewers:count', { count: viewerCount });
      }

      // If phone disconnects, notify viewers the session may have ended
      if (trackingId && role === 'phone') {
        const session = sessionStore.get(trackingId);
        if (session && !session.isActive) {
          io.to(`track:${trackingId}`).emit('session:ended', { trackingId });
        }
      }

      logger.debug(`Socket disconnected: ${socket.id} (role: ${role || 'unknown'})`);
    });
  });
}

/**
 * Checks if coordinates are within ~200m of any station in the route.
 * @param {number} lat
 * @param {number} lng
 * @param {Array} stationRoute
 * @returns {boolean}
 */
function isNearAnyStation(lat, lng, stationRoute) {
  const THRESHOLD = 0.002; // ~200m in degrees
  return stationRoute.some(
    (s) => Math.abs(s.lat - lat) < THRESHOLD && Math.abs(s.lng - lng) < THRESHOLD
  );
}

/**
 * Returns the number of viewer sockets in a tracking room.
 * @param {import('socket.io').Server} io
 * @param {string} trackingId
 * @returns {number}
 */
function getViewerCount(io, trackingId) {
  const room = io.sockets.adapter.rooms.get(`track:${trackingId}`);
  if (!room) return 0;
  // Count only viewers (not the phone socket itself)
  let count = 0;
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data.role === 'viewer') count++;
  }
  return count;
}

module.exports = { registerTrackingSocket };
