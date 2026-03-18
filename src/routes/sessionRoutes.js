const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const sessionService = require('../services/sessionService');
const sessionStore = require('../services/sessionStore');
const { requireApiKey } = require('../middleware/apiKeyAuth');
const logger = require('../utils/logger');

const router = express.Router();

// Rate limiters (in-memory; consider Redis for multi-instance deployments)
const sessionStartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { success: false, message: 'Too many session starts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const sessionEndLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { success: false, message: 'Too many session ends. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const sessionFetchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Validation middleware — returns 400 with error details if any rule fails.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

/**
 * POST /api/sessions/start
 * Called by Android app when a journey begins.
 * Returns a trackingId and share URL to include in the SMS.
 *
 * Body:
 *   tripId          string  (Android Room DB ID)
 *   userId          string  (Firebase UID)
 *   sourceStation   string
 *   destinationStation string
 *   stationRoute    Array<{ stationId, stationName, lat, lng, sequenceNumber, lineColor }>
 */
router.post(
  '/start',
  requireApiKey,
  sessionStartLimiter,
  [
    body('tripId').notEmpty().withMessage('tripId is required'),
    body('userId').notEmpty().withMessage('userId is required'),
    body('sourceStation').notEmpty().withMessage('sourceStation is required'),
    body('destinationStation').notEmpty().withMessage('destinationStation is required'),
    body('stationRoute').isArray().withMessage('stationRoute must be an array'),
  ],
  validate,
  async (req, res) => {
    try {
      const { tripId, userId, sourceStation, destinationStation, stationRoute } = req.body;

      const result = await sessionService.createSession({
        tripId,
        userId,
        sourceStation,
        destinationStation,
        stationRoute,
      });

      logger.info(`Session started via REST: ${result.trackingId}`);
      return res.status(201).json({
        success: true,
        trackingId: result.trackingId,
        shareUrl: result.shareUrl,
      });
    } catch (err) {
      logger.error('Failed to start session', err);
      const message = err?.message;
      if (message && message.includes('Maximum active sessions')) {
        return res.status(503).json({ success: false, message: 'Server is temporarily busy. Please try again later.' });
      }
      return res.status(500).json({ success: false, message: 'Failed to create tracking session' });
    }
  }
);

/**
 * POST /api/sessions/end
 * Called by Android app when a journey ends.
 * Accepts the full GPS path for Firestore persistence (enables trip replay).
 *
 * Body:
 *   trackingId  string
 *   gpsPath     Array<{ lat, lng, timestamp, segment }>  (optional — server uses buffer if absent)
 */
router.post(
  '/end',
  requireApiKey,
  sessionEndLimiter,
  [
    body('trackingId').notEmpty().withMessage('trackingId is required'),
    body('gpsPath').optional().isArray(),
  ],
  validate,
  async (req, res) => {
    try {
      const { trackingId, gpsPath = [] } = req.body;
      const io = req.app.get('io');

      const session = await sessionService.endSession(trackingId, gpsPath, io);
      if (!session) {
        return res.status(404).json({ success: false, message: 'Session not found' });
      }

      return res.json({ success: true, message: 'Journey ended successfully' });
    } catch (err) {
      logger.error('Failed to end session', err);
      return res.status(500).json({ success: false, message: 'Failed to end tracking session' });
    }
  }
);

/**
 * GET /api/sessions/:trackingId
 * Public endpoint — website fetches this before connecting via WebSocket.
 * Returns session metadata (no sensitive user data).
 */
router.get(
  '/:trackingId',
  sessionFetchLimiter,
  [param('trackingId').matches(/^TRK-[A-Z0-9]{6,12}$/).withMessage('Invalid tracking ID format')],
  validate,
  async (req, res) => {
    try {
      const { trackingId } = req.params;
      const session = await sessionService.getSession(trackingId);

      if (!session) {
        return res.status(404).json({ success: false, message: 'Journey not found' });
      }

      return res.json({ success: true, session });
    } catch (err) {
      logger.error('Failed to fetch session', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch session' });
    }
  }
);

/**
 * GET /api/sessions/:trackingId/status
 * Lightweight status check — is the session active?
 */
router.get('/:trackingId/status', sessionFetchLimiter, async (req, res) => {
  const session = sessionStore.get(req.params.trackingId);
  if (!session) {
    return res.json({ exists: false, isActive: false });
  }
  return res.json({
    exists: true,
    isActive: session.isActive,
    signalLost: session.signalLost,
    lastPingAt: session.lastPingAt,
  });
});

module.exports = router;

/**
 * GET /api/sessions/:trackingId/replay
 * Returns the full GPS path for a completed trip (for website replay feature).
 * Reads gpsPath from the trips Firestore collection using the tripId stored on the session.
 */
router.get('/:trackingId/replay', sessionFetchLimiter, async (req, res) => {
  try {
    const { trackingId } = req.params;
    if (!/^TRK-[A-Z0-9]{6,12}$/.test(trackingId)) {
      return res.status(400).json({ success: false, message: 'Invalid tracking ID format' });
    }

    const { getFirestore } = require('../firebase/firebaseAdmin');
    const db = getFirestore();

    // Get session to find tripId and stationRoute
    const sessionDoc = await db.collection('tracking_sessions').doc(trackingId).get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    const session = sessionDoc.data();

    // Get full GPS path from the trip document
    let gpsPath = [];
    if (session.tripId) {
      const tripDoc = await db.collection('trips').doc(session.tripId).get();
      if (tripDoc.exists) {
        gpsPath = tripDoc.data().gpsPath || [];
      }
    }

    return res.json({
      success: true,
      replay: {
        trackingId,
        sourceStation: session.sourceStation,
        destinationStation: session.destinationStation,
        stationRoute: session.stationRoute || [],
        visitedStationIds: session.visitedStationIds || [],
        gpsPath,
        startedAt: session.startedAt,
        endedAt: session.endedAt || null,
      },
    });
  } catch (err) {
    logger.error('Failed to fetch replay data', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch replay data' });
  }
});
