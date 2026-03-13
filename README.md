# Delhi Metro Tracker — Backend

Real-time WebSocket relay server for the Delhi Metro Tracker Android app. Manages live tracking sessions, streams GPS location to web viewers, monitors signal loss, and persists journey data to Firestore.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| HTTP Server | Express 4 |
| WebSockets | Socket.IO 4 |
| Database | Firebase Firestore (Admin SDK) |
| Auth | API key middleware (Android) |
| Logging | Winston |
| Process Manager | PM2 (production) |
| Tunnel | Cloudflare Tunnel |

---

## Architecture

```
Android App
    │
    ├── POST /api/sessions/start   → creates TRK-XXXXXX session
    ├── socket: phone:join         → joins tracking room
    ├── socket: location:update    → streams GPS points
    ├── socket: station:visited    → marks stations crossed
    ├── socket: sos:triggered      → emergency alert
    └── POST /api/sessions/end     → ends session, flushes GPS path to Firestore

Website Viewers
    │
    ├── socket: viewer:join        → receives full session snapshot
    ├── socket: location:update    → live GPS stream
    ├── socket: station:visited    → station crossing events
    ├── socket: sos:triggered      → SOS alert
    └── socket: session:ended      → journey completed
```

**Rooms:**
- `track:{trackingId}` — all viewers watching a journey
- `phone:{trackingId}` — private room for the Android device

**In-memory session store** holds the GPS buffer (max 1000 points), visited station list, SOS state, and signal status. On session end, the full GPS path is written to Firestore `trips/{tripId}`.

---

## Project Structure

```
src/
├── index.js                    # Express + Socket.IO server entry point
├── firebase/
│   └── firebaseAdmin.js        # Firebase Admin SDK init
├── middleware/
│   └── apiKeyAuth.js           # API key validation for Android requests
├── routes/
│   ├── sessionRoutes.js        # REST endpoints for session lifecycle
│   └── bugReportRoutes.js      # Help center bug report submissions
├── services/
│   ├── sessionService.js       # Business logic: create/end/get sessions
│   ├── sessionStore.js         # In-memory session state store
│   └── signalMonitor.js        # Background job: detects signal loss
├── socket/
│   └── trackingSocket.js       # All Socket.IO event handlers
└── utils/
    └── logger.js               # Winston logger config
```

---

## REST API

All Android-facing endpoints require the `x-api-key` header.

### `POST /api/sessions/start`
Called when a journey begins. Returns a `trackingId` and `shareUrl` to send via SMS.

**Request body:**
```json
{
  "tripId": "42",
  "userId": "firebase-uid",
  "sourceStation": "Dwarka Mor",
  "destinationStation": "Rajiv Chowk",
  "stationRoute": [
    { "stationId": "S001", "stationName": "Dwarka Mor", "lat": 28.61, "lng": 77.05, "sequenceNumber": 0, "lineColor": "#3d8ef8" }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "trackingId": "TRK-AB3X7K",
  "shareUrl": "https://delhi-metro-website.vercel.app/track/TRK-AB3X7K"
}
```

---

### `POST /api/sessions/end`
Called when the journey ends. Persists the full GPS path to Firestore.

**Request body:**
```json
{
  "trackingId": "TRK-AB3X7K",
  "gpsPath": [
    { "lat": 28.61, "lng": 77.05, "timestamp": 1700000000000, "segment": "metro" }
  ]
}
```

---

### `GET /api/sessions/:trackingId`
Public endpoint. Returns session metadata for the website before the WebSocket connects.

---

### `GET /api/sessions/:trackingId/status`
Lightweight heartbeat check — returns `isActive`, `signalLost`, `lastPingAt`.

---

### `POST /api/bug-reports`
Saves a help center submission to Firestore `bug_reports` collection. No auth required.

---

## Socket.IO Events

### Android → Server
| Event | Payload | Description |
|---|---|---|
| `phone:join` | `{ trackingId }` | Register as the location sender |
| `location:update` | `{ trackingId, lat, lng, speedKmh, accuracy, timestamp }` | Stream a GPS point |
| `station:visited` | `{ trackingId, stationId, stationName }` | Mark a station crossed |
| `sos:triggered` | `{ trackingId, stationName, locationUrl }` | Emergency alert |

### Server → Viewers
| Event | Payload | Description |
|---|---|---|
| `session:snapshot` | Full session state | Sent immediately on `viewer:join` |
| `location:update` | GPS point | Relayed from phone |
| `station:visited` | `{ stationId, allVisitedStationIds }` | Includes full visited list for manual jumps |
| `sos:triggered` | `{ stationName, locationUrl, timestamp }` | Emergency alert |
| `session:ended` | `{ trackingId }` | Journey completed |
| `signal_lost` | — | No GPS ping for 3+ minutes |
| `signal_restored` | — | GPS resumed |

---

## Environment Variables

Create a `.env` file in the backend root:

```env
PORT=3001
NODE_ENV=production

# Frontend URL for CORS
FRONTEND_URL=https://delhi-metro-website.vercel.app

# Android app authentication
API_SECRET_KEY=your-long-random-secret-key

# Firebase Admin SDK
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nXXXXX\n-----END PRIVATE KEY-----\n"
```

---

## Local Development

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev            # nodemon auto-restart
```

Server starts on `http://localhost:3001`. Test with:
```
GET http://localhost:3001/health
```

---

## Production Deployment (Windows Laptop + Cloudflare Tunnel)

### Start backend
```powershell
cd E:\path\to\backend
pm2 start src/index.js --name metro-backend
pm2 save
```

### Start Cloudflare Tunnel
```powershell
Start-ScheduledTask -TaskName "CloudflareTunnel"
```

### Check everything is live
```powershell
pm2 status
curl https://api.metrotracker.app/health
```

### Common PM2 commands
```powershell
pm2 logs metro-backend          # live logs
pm2 restart metro-backend       # restart after code changes
pm2 flush metro-backend         # clear logs
```

---

## Firestore Collections

| Collection | Document ID | Contents |
|---|---|---|
| `tracking_sessions` | `trackingId` | Session metadata, active status, visited stations |
| `trips` | `tripId` (Android Room ID) | Full `gpsPath` array written on trip end |
| `bug_reports` | auto-ID | Help center submissions |

---

## Signal Loss Detection

`signalMonitor.js` runs a background interval every 60 seconds. If a session has not received a GPS ping in 3 minutes it emits `signal_lost` to all viewers. When GPS resumes it emits `signal_restored`.
