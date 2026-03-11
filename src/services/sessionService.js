const { customAlphabet } = require('nanoid');
const sessionStore = require('./sessionStore');
const { getFirestore } = require('../firebase/firebaseAdmin');
const logger = require('../utils/logger');

// Human-friendly alphabet — no 0/O, I/l confusion
const generateId = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

/**
 * SessionService — business logic for session lifecycle.
 *
 * SOLID: Single Responsibility — creates/ends sessions, delegates storage to sessionStore.
 *        Open/Closed — new session types can extend without modifying this class.
 */
class SessionService {
  /**
   * Creates a new tracking session from an Android trip start event.
   *
   * @param {object} params
   * @param {string} params.tripId - Android Room DB trip ID
   * @param {string} params.userId - Firebase UID
   * @param {string} params.sourceStation
   * @param {string} params.destinationStation
   * @param {Array}  params.stationRoute - Full ordered station list for the route
   * @returns {{ trackingId: string, shareUrl: string }}
   */
  async createSession({
    tripId,
    userId,
    sourceStation,
    destinationStation,
    stationRoute,
  }) {
    // Ensure no duplicate active session for same tripId
    const existing = this._findByTripId(tripId);
    if (existing) {
      logger.warn(`Session already exists for tripId ${tripId}, returning existing`);
      const shareUrl = this._buildShareUrl(existing.trackingId);
      return { trackingId: existing.trackingId, shareUrl };
    }

    const trackingId = `TRK-${generateId()}`;

    sessionStore.create({
      trackingId,
      tripId: String(tripId),
      userId,
      sourceStation,
      destinationStation,
      stationRoute: stationRoute || [],
    });

    // Write session metadata to Firestore so it survives server restarts
    // (lightweight — no GPS data here)
    try {
      await getFirestore().collection('tracking_sessions').doc(trackingId).set({
        trackingId,
        tripId: String(tripId),
        userId,
        sourceStation,
        destinationStation,
        startedAt: Date.now(),
        isActive: true,
      });
    } catch (err) {
      // Non-fatal — in-memory session still works
      logger.error('Failed to persist session to Firestore', err);
    }

    const shareUrl = this._buildShareUrl(trackingId);
    logger.info(`Session created: ${trackingId} for trip ${tripId}`);
    return { trackingId, shareUrl };
  }

  /**
   * Ends a tracking session and persists the full GPS path to Firestore.
   *
   * @param {string} trackingId
   * @param {Array}  gpsPath - Complete GPS breadcrumb array from Android
   * @returns {object|null} Ended session or null if not found
   */
  async endSession(trackingId, gpsPath = [], io = null) {
    const session = sessionStore.end(trackingId);
    if (!session) {
      logger.warn(`Attempted to end non-existent session: ${trackingId}`);
      return null;
    }

    // Notify all viewers immediately so they don't need to refresh
    if (io) {
      io.to(`track:${trackingId}`).emit('session:ended', { trackingId });
    }

    // Merge Android's GPS path with any buffer we accumulated server-side
    const mergedPath = gpsPath.length > 0 ? gpsPath : session.gpsBuffer;

    // Persist GPS path and mark session complete in Firestore
    try {
      const db = getFirestore();
      const batch = db.batch();

      const sessionRef = db.collection('tracking_sessions').doc(trackingId);
      batch.update(sessionRef, {
        isActive: false,
        endedAt: session.endedAt,
        visitedStationIds: session.visitedStationIds,
      });

      // Store GPS path on the trip document so replay works
      if (session.tripId && mergedPath.length > 0) {
        const tripRef = db.collection('trips').doc(session.tripId);
        batch.set(
          tripRef,
          { gpsPath: mergedPath, trackingId },
          { merge: true }
        );
      }

      await batch.commit();
      logger.info(`Session ended and GPS path (${mergedPath.length} points) saved: ${trackingId}`);
    } catch (err) {
      logger.error('Failed to persist session end to Firestore', err);
    }

    return session;
  }

  /**
   * Retrieves session state — checks memory first, then Firestore.
   * @param {string} trackingId
   */
  async getSession(trackingId) {
    // Hot path: in-memory
    const inMemory = sessionStore.toPublicView(trackingId);
    if (inMemory) return inMemory;

    // Cold path: Firestore (server restarted or session expired from memory)
    try {
      const doc = await getFirestore()
        .collection('tracking_sessions')
        .doc(trackingId)
        .get();

      if (!doc.exists) return null;
      return { ...doc.data(), gpsBuffer: [], stationRoute: [] };
    } catch (err) {
      logger.error('Failed to fetch session from Firestore', err);
      return null;
    }
  }

  /** @private */
  _findByTripId(tripId) {
    const all = sessionStore.getAllActive();
    return all.find((s) => s.tripId === String(tripId)) || null;
  }

  /** @private */
  _buildShareUrl(trackingId) {
    const base = process.env.FRONTEND_URL || 'https://your-app.vercel.app';
    return `${base}/track/${trackingId}`;
  }
}

module.exports = new SessionService();
