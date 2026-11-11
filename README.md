# Manhunt — Real-Time Outdoor Hide & Seek

A full-stack, mobile-first hide & seek game that runs entirely in mobile browsers (Safari iOS / Chrome Android) — no app install needed. A host creates a room, configures the match, and shares a 4-letter code; hunters hunt hiders in the real world, tracked live on a dark-themed GPS map.

## Tech stack

| Layer     | Tech                                                        |
| --------- | ----------------------------------------------------------- |
| Frontend  | Quasar (Vue 3 Composition API + Pinia), Leaflet dark tiles  |
| Backend   | Node.js, Express, Socket.io                                 |
| Database  | PostgreSQL (match replays, event log)                       |
| Geospatial | `@turf/turf` (distance / zone membership on the server)    |

## Project structure

```
manhunt/
├── backend/            # Express + Socket.io game server
│   ├── src/
│   │   ├── index.js    # HTTP + WebSocket wiring, serves the built SPA
│   │   ├── rooms.js    # Room registry & game engine (timers, zones, proximity)
│   │   ├── settings.js # Settings schema: defaults + clamping ranges
│   │   └── replay/     # Match replay module (decoupled, see below)
│   └── test/smoke.mjs  # End-to-end engine test over real sockets
└── frontend/           # Quasar SPA
    └── src/
        ├── components/ # GameMap.vue (Leaflet), SettingsPanel.vue (host config)
        ├── pages/      # IndexPage (home), CreatePage (host setup), RoomPage (game),
        │               # ReplaysPage (match list), ReplayPage (playback viewer)
        ├── services/   # socket, audio (Web Audio API), geo, wakeLock, settingsSchema,
        │               # api (replay REST), replay (timeline builder)
        └── stores/     # Pinia game store (socket wiring, beep loop, GPS)
```

## Running it

### Development (two terminals)

```bash
# Terminal 1 — game server on http://localhost:3000
cd backend && npm install && npm run dev

# Terminal 2 — Quasar dev server on http://localhost:9000
cd frontend && npm install && npm run dev
```

The Quasar dev server proxies `/socket.io` and `/api` (replays) to the game server, so the app talks to a single origin. Replays need a database: start one and point the backend at it. The backend runs on your host here, so the DB needs one host port — but bind it to loopback, so it is reachable only from your machine, not your network:

```bash
docker run -d --rm --name manhunt-db -e POSTGRES_USER=manhunt -e POSTGRES_PASSWORD=manhunt -e POSTGRES_DB=manhunt -p 127.0.0.1:5433:5432 postgres:17-alpine
DATABASE_URL=postgres://manhunt:manhunt@localhost:5433/manhunt npm run dev
```

Without `DATABASE_URL` the game server simply records nothing.

### Production

```bash
cd frontend && npm run build           # outputs frontend/dist/spa
cd backend && npm start                # serves the SPA *and* WebSockets on :3000
```

### Docker deployment (batterysync.de)

```bash
docker compose up -d --build
```

Single origin — everything runs behind nginx on port 4000:

| What                     | URL                                    |
| ------------------------ | -------------------------------------- |
| SPA (frontend)           | `https://batterysync.de:4000/`         |
| Game server API/sockets  | `https://batterysync.de:4000/backend/` |

The stack is three containers: nginx (frontend), the game server (backend) and
a PostgreSQL database that stores the match replays (data volume
`manhunt-pgdata` survives `docker compose down`). The backend waits for the
DB healthcheck (`depends_on: service_healthy`) and creates its schema on boot.

The database is fully isolated: it publishes no port and sits on a dedicated
`internal: true` Docker network (`manhunt_db-internal`) — Docker gives that
network no route to the outside world, so the DB is unreachable from the
host, the internet and every other container; only the backend can open a
connection to it. The only externally published port of the whole stack is
nginx's `4000`.

nginx (alpine) terminates TLS, serves the built SPA and proxies `/backend/` to
the game server container over the internal network — the backend is **not**
published to the host.

The TLS certificate pair comes from `/home/ubuntu/ssl/batterysync/` on the
host (mounted read-only to `/etc/manhunt/ssl` in the nginx container).
Expected file names — configurable via the `SSL_CERT` / `SSL_KEY` environment
variables in `docker-compose.yml`:

- `fullchain.pem` (certificate chain)
- `privkey.pem` (private key)

The SSL certificate reader (`backend/src/ssl.js`) loads a pair if present and
falls back to plain HTTP without it — local dev needs no certificates. The SPA
bakes the socket base URL in at build time (`VITE_SOCKET_URL` build arg,
default `https://batterysync.de:4000/backend`); the client derives the
engine.io path from it (`/backend/socket.io`).

### Testing on real phones

Geolocation requires a secure context. `localhost` works on the desktop, but for real devices use one of:

- `cd frontend && npx quasar dev --https` (self-signed cert) with the backend reachable from the phone, or
- a tunnel (e.g. ngrok) in front of the production server.

### Engine tests

```bash
cd backend && npm test    # boots a server and plays a full match over real sockets
```

## Game settings (host controlled)

| Setting                  | Default | Range          |
| ------------------------ | ------- | -------------- |
| `gameDurationSeconds`    | 600     | 180 – 3600 s   |
| `initialZoneRadius`      | 500     | 50 – 2000 m    |
| `hidePhaseSeconds`       | 60      | 0 – 600 s      |
| `endgameEnabled`         | true    | on / off       |
| `endgameDurationSeconds` | 300     | 30 – 1200 s    |
| `endgameMinZoneRadius`   | 100     | 20 – 1000 m    |
| `endgameNoticeSeconds`   | 90      | 10 – 600 s     |
| `zoneShrinkInterval`     | 150     | 30 – 600 s     |
| `zoneShrinkPercent`      | 25      | 5 – 50 %       |
| `zoneShiftEnabled`       | true    | on / off       |
| `hiderRevealInterval`    | 60      | 10 – 300 s     |
| `proximityDistanceMeters`| 25      | 5 – 100 m      |
| `proximityBeepInterval`  | 30      | 5 – 60 s       |

All timers on the server derive from these settings — no hardcoded magic numbers.

## Core mechanics

- **Hiding phase** — when `hidePhaseSeconds` > 0, the match opens with a head start: hiders run to their spots while the main timer is paused (grey), no zone shrinking, no hider reveals and no proximity alerts happen. Both sides see an amber `Verstecken m:ss` countdown and a „VERSTECK DICH!“ banner; when it hits zero the main phase begins and the full `gameDurationSeconds` countdown starts.
- **Zone** — the server shrinks the safe zone by `zoneShrinkPercent` every `zoneShrinkInterval` seconds (floor: 20 m) and streams `game:tick` once per second. If the `zoneShiftEnabled` setting is on (default), every shrink tick also lets the zone **wander**: it jumps up to its full radius in a uniformly random direction (0 m minimum), then exposure is re-evaluated at the new spot. Rematches restore the pristine host-picked center.
- **Endgame** — when enabled (default), the match ends with a final phase instead of the time-up whistle: `endgameNoticeSeconds` (default 90) before the switch, the **coming endgame zone** is computed — one classic shrink-and-move, its random drift rolled at announcement time — and shown to **all** players as a second, **pulsating yellow circle** on the map. That window guarantees every hider at least `endgameNoticeSeconds` to reach the zone: from the announcement on, the classic shrink-and-move schedule is **suspended** (any shrink that would fall inside the window — or on the switch tick — is skipped) and the live zone stays put until the switch. The „Schrumpfen in“ chip keeps counting honestly: as soon as the *next* scheduled shrink would fall inside the window — i.e. already before the announcement — the `game:tick` payload reports `nextShrinkIn: null` and the chip is hidden. In that gap it is replaced by an **„Endgame-Zone in …“ chip** counting down the seconds until the notice window opens (`endgameNoticeIn`), which hands over to the „Endgame in m:ss“ chip when the preview appears; both stay hidden through the whole endgame. When the main timer hits zero, the switch applies exactly the announced zone, and every hider who failed to enter it is **out** (grey pin, own banner — no capturer). If that eliminates the last hiders, the match ends right away (hunters win), just like a reported capture of the final hider would. After the switch the normal match logic continues: being outside the zone only exposes a hider live, reveals and proximity alerts keep running. The twist: **hunters become invisible to hiders** for the whole endgame (hider maps get the hunter pins wiped; a rejoining hider is resynced without them), while hunters keep seeing hider snapshots. During the endgame the zone only shrinks — one step per second, sized to reach `endgameMinZoneRadius` exactly when the `endgameDurationSeconds` countdown — and thus the match — ends. Surviving hiders win; the HUD shows the countdown („Endgame in m:ss“ chip during the run-up, timer chip switches to the endgame clock) and both sides get an ENDGAME banner.
- **Visibility** — in the **lobby**, everyone sees everyone's live position. The host can also re-place the zone center directly on the map („Zone verschieben“ toggle, lobby only) — even long after the create screen; the tentative spot previews as a draggable ◎ marker and the zone circle follows it. Once the match starts, mapping edits are locked. Once the match starts: hiders always see hunters live **and each other** (team visibility: every hider's latest position streams to the hider role on every accepted fix); hunters receive hider snapshots every `hiderRevealInterval`. **Out-of-zone exception:** a hider outside the zone is streamed live to hunters (pulsing orange marker) until they re-enter — the pin then freezes at the last position the hunters watched, instead of rewinding to an older periodic reveal. Between periodic reveals, hidden hiders' pins stay frozen at their last revealed position — a live update for one exposed hider never carries the others' current fixes.
- **Reveal countdown & wave** — everyone sees when the next hider reveal is due (`Aufdecken in` / `Enttarnung in` chip, server-computed in `game:tick`). On each scheduled reveal the server emits `hiders:revealed` and every visible hider pin plays a wave animation — hunters see all snapshot pins wave, hiders see their own pin wave. Exposed (out-of-zone) pins wave continuously instead, and captured pins never wave.
- **Pins** — every map pin carries the player's initial (own dot included); captured hiders turn grey with a ✕ badge. A captured hider's own map keeps a static **dead pin where they were found** while their live position keeps tracking as a grey dot. The found spot is broadcast to the whole room the moment the capture is reported — hunters never see a stale pin waiting for the next reveal. All position pins are cleared when a game ends or the room resets.
- **Own position** — every player always sees their own location (blue dot + accuracy circle) on the map, regardless of fix quality. An exposed hider (outside the zone) sees their own dot and accuracy circle turn yellow with a continuous wave animation — and learns about the flip immediately, even when the zone moved past them while they stood still.
- **Smooth pin movement** — position updates glide instead of jumping: pins tween to each new fix (~0.7 s ease-out via `requestAnimationFrame`), with the own accuracy circle riding along in lockstep. Moves longer than 200 m snap instantly (manual location taps, fresh reveal snapshots) so pins never fly across the map.
- **Manual location (testing)** — optional, **off by default**: a small „Test-Werkzeuge“ panel on the map exposes a *Manueller Standort* toggle. When enabled, a GPS/Manuell switch appears; in Manual mode the GPS watch is stopped and tapping the map places you there (crosshair cursor), reporting the position like a normal quality GPS fix — so proximity beeps, live exposure and reveals can all be tested without walking around. The switch is per-device, survives page reloads, and can be flipped back off (or set back to GPS) at any time before/during a game.
- **Proximity alert** — on every accepted GPS fix the server evaluates `@turf/distance(hider, hunter)`. When a hunter comes within `proximityDistanceMeters`, the hider's client plays a 1000 Hz square-wave beep (400 ms, Web Audio API) immediately and repeats it every `proximityBeepInterval` seconds until the hunter leaves the radius.
- **Win conditions** — hunters win when every hider taps the report-capture button („Ich wurde gefunden — Fang melden“, then picking the hunter in the „Wer hat dich gefunden?“ dialog), fails to reach the announced endgame zone before the switch, or is caught during the endgame; hiders win when the (endgame) timer hits zero with at least one hider uncaught. With the endgame disabled, the match still ends at time-up exactly as before.
- **Seamless rejoin** — a dropped connection (network glitch, tunnel, mobile radio sleep) or a browser refresh never costs a player their session: the server keeps the player entry and re-binds the returning client to it — same player id, same role (a rejoining client sends no role, so a stale local one can never flip it), same captured/exposure state. Every successful join triggers a **resync**: the room state plus the position lists for the player's own role (hunters in the hiding phase still get nothing) and the current proximity state, so a hider mid-beep resumes instantly. When the game has already ended, the rejoined client gets the final winner/reason in room state instead of any position lists. The client auto-rejoins transparently whenever socket.io reconnects while a room is open; if the room is gone (empty-room cleanup, server restart), the app fails cleanly back to the home screen.

## Match replay

Every played match is recorded into PostgreSQL as an **event log** and can be watched afterwards.

- **Recording** — a self-contained module (`backend/src/replay/`) that is fully **decoupled from the game logic**: `rooms.js` has no knowledge of it. The composition root (`index.js`) hands rooms a wrapped `io` whose broadcasts are mirrored into the log, and forwards accepted GPS fixes. Match lifecycle is detected from the stream itself: the first `room:state_changed` with status "active" opens a match, `game:over` seals it. A match is saved with its **id** (uuid), **lobby code**, **date** (start/end), result, plus snapshots of the settings and the roster.
- **What is logged** — everything the game emits, verbatim: every room broadcast (`game:tick` with zone/preview/countdowns, `room:state_changed` with the full state, reveal events, `game:over`, …), every socket-scoped emission (per-hider proximity alerts, role-filtered `map:hider_positions`/`map:hunter_positions` lists, …) and the inbound `player:location` fixes of every player (the replay is "all-seeing": it shows where everyone actually was, not what each role could see). Nothing is filtered by usefulness — events no viewer consumes today stay in the log for future analysis. Each event carries a gapless per-match sequence number and a timestamp. Socket-scoped events that reach several sockets in identical copies (role fan-out) are collapsed into one row until their payload changes.
- **Robustness by contract** — the replay must never break a game: writes are buffered in memory, flushed in ordered batches every second and retried when the database is down; a match that dies silently (server restart) is sealed after 15 quiet minutes. Without `DATABASE_URL` set, the module is a pure passthrough and the game server behaves exactly as before.
- **REST API** — `GET /api/matches` (list, newest first) and `GET /api/matches/:id` (match + full event stream). In the Docker deployment reachable under `/backend/api/...`. Always mounted — without a database the endpoints answer `503` with a clear message instead of failing silently.
- **Viewer** — the home screen's „Replays ansehen“ opens the match list (code, date, duration, result, player/action counts); tapping a match plays it back on the dark Leaflet map: zone circle, pulsating endgame preview, every player's true position with optional track lines, a timeline slider (0 – match length), play/pause and 1×–60× speeds. Pins **glide** smoothly between fixes while playing (jumps on scrubbing and teleports). Event highlights: a hider's **discovery** (reveal/capture) and a hider **outside the zone** (orange pin) pulse with a ring animation — while paused the pulse runs as long as the condition holds (for inspecting the exact second), during playback it lasts 3 real seconds from the event second.

## GPS accuracy policy

Fixes are graded by reported accuracy and used accordingly:

| Grade              | Accuracy     | Used for                                                        |
| ------------------ | ------------ | --------------------------------------------------------------- |
| Junk               | > 100 m      | Dropped entirely (client and server)                            |
| Degraded           | 25 – 100 m   | Map display only — no proximity alerts, no exposure changes     |
| Quality            | ≤ 25 m       | Drives proximity alerts and out-of-zone exposure                |

The player's own marker and accuracy circle are always updated, even with degraded fixes — you should never lose sight of yourself because of a weak GPS moment (the HUD chip shows `±X m` and turns amber while accuracy is degraded).

## Browser API usage

- **Screen Wake Lock** — requested for the whole room session (lobby, hiding phase and match), re-acquired on `visibilitychange` and whenever the browser revokes it, with a retry loop while it is denied (e.g. battery saver). On browsers without Wake Lock support (iOS < 18.4) the map shows a "screen may turn off" hint — there is no web API fallback there; set *Auto-Lock → Never* as a workaround.
- **Geolocation** — `watchPosition` with `{ enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }`; accuracy policy as above (enforced on client *and* server).
- **Web Audio** — the `AudioContext` is created/resumed on the first user gesture (Create/Join buttons) to satisfy mobile autoplay policies.

## WebSocket API

Client → server: `room:create`, `room:update_settings`, `room:set_zone_center`, `room:join`, `player:set_role`, `room:leave`, `game:start`, `game:reset`, `player:location`, `hider:captured`

Server → client: `room:state_changed`, `game:tick`, `map:hunter_positions`, `map:hider_positions`, `hiders:revealed`, `player:proximity_alert`, `game:over`, `room:error`

Mutating events acknowledge with `{ ok, ... }`; errors also arrive as `room:error`. Room state broadcasts never contain player coordinates — positions travel only over the `map:*_positions` events, so a hunter cannot extract hider locations from room state. `game:tick` carries the phase (`hiding` | `main` | `endgame`), the announced `endgameZone` (`{ lat, lng, radius }`, present for everyone while the endgame is upcoming) and `endgameRemaining` (seconds left in the endgame).
