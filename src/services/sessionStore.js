/**
 * SessionStore — In-memory store for all active tracking sessions.
 *
 * SOLID: Single Responsibility — only manages session state.
 * All sessions are cleared on server restart (by design — trips re-register on app launch).
 *
 * Session shape:
 * {
 *   trackingId: string,         // Public share ID (e.g. "TRK-8492")
 *   tripId: string,             // Android Room DB trip ID
 *   userId: string,             // Firebase UID
 *   sourceStation: string,
 *   destinationStation: string,
 *   stationRoute: Array<{stationId, stationName, lat, lng, sequenceNumber, lineColor}>,
 *   visitedStationIds: string[],
 *   gpsBuffer: Array<{lat, lng, timestamp, segment}>,  // Live buffer, max 1000 points
 *   lastPingAt: number,         // Unix ms - used for signal loss detection
 *   startedAt: number,
 *   isActive: boolean,
 *   signalLost: boolean,
 *   hadSosAlert: boolean,
 * }
 */

const MAX_GPS_BUFFER = 1000;

class SessionStore {
  constructor() {
    /** @type {Map<string, object>} trackingId → session */
    this._sessions = new Map();
  }

  /**
   * Creates and stores a new session.
   * @param {object} sessionData
   * @returns {object} The created session
   */
  create(sessionData) {
    const session = {
      ...sessionData,
      gpsBuffer: [],
      visitedStationIds: sessionData.visitedStationIds || [],
      lastPingAt: Date.now(),
      startedAt: Date.now(),
      isActive: true,
      signalLost: false,
      hadSosAlert: false,
    };
    this._sessions.set(session.trackingId, session);
    return session;
  }

  /**
   * @param {string} trackingId
   * @returns {object|undefined}
   */
  get(trackingId) {
    return this._sessions.get(trackingId);
  }

  /**
   * Appends a GPS point to the session's buffer.
   * Enforces max buffer size by discarding oldest points.
   * @param {string} trackingId
   * @param {{ lat: number, lng: number, timestamp: number, segment: string }} point
   */
  appendGpsPoint(trackingId, point) {
    const session = this._sessions.get(trackingId);
    if (!session) return false;

    session.gpsBuffer.push(point);
    if (session.gpsBuffer.length > MAX_GPS_BUFFER) {
      session.gpsBuffer.shift(); // Remove oldest point
    }
    session.lastPingAt = Date.now();
    session.signalLost = false;
    return true;
  }

  /**
   * Marks a station as visited in the session.
   * @param {string} trackingId
   * @param {string} stationId
   */
  markStationVisited(trackingId, stationId) {
    const session = this._sessions.get(trackingId);
    if (!session) return false;
    if (!session.visitedStationIds.includes(stationId)) {
      session.visitedStationIds.push(stationId);
    }
    return true;
  }

  /**
   * Updates the signal lost state for a session.
   */
  setSignalLost(trackingId, isLost) {
    const session = this._sessions.get(trackingId);
    if (!session) return;
    session.signalLost = isLost;
  }

  /**
   * Marks SOS alert on session.
   */
  markSosAlert(trackingId) {
    const session = this._sessions.get(trackingId);
    if (!session) return;
    session.hadSosAlert = true;
  }

  /**
   * Ends a session (marks inactive, does NOT delete — allows brief replay of buffer).
   */
  end(trackingId) {
    const session = this._sessions.get(trackingId);
    if (!session) return null;
    session.isActive = false;
    session.endedAt = Date.now();
    return session;
  }

  /**
   * Hard deletes a session from memory.
   */
  delete(trackingId) {
    return this._sessions.delete(trackingId);
  }

  /**
   * Returns all active sessions (for signal monitoring).
   * @returns {object[]}
   */
  getAllActive() {
    return Array.from(this._sessions.values()).filter((s) => s.isActive);
  }

  /**
   * Returns a safe public view of a session (strips internal fields not needed by client).
   */
  toPublicView(trackingId) {
    const session = this._sessions.get(trackingId);
    if (!session) return null;

    return {
      trackingId: session.trackingId,
      sourceStation: session.sourceStation,
      destinationStation: session.destinationStation,
      stationRoute: session.stationRoute,
      visitedStationIds: session.visitedStationIds,
      gpsBuffer: session.gpsBuffer,
      startedAt: session.startedAt,
      endedAt: session.endedAt || null,
      isActive: session.isActive,
      signalLost: session.signalLost,
      hadSosAlert: session.hadSosAlert,
      lastPingAt: session.lastPingAt,
    };
  }
}

// Singleton — one store for the entire process lifetime
module.exports = new SessionStore();
