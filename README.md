# Manhunt — Real-Time Outdoor Hide & Seek

A full-stack, mobile-first hide & seek game that runs entirely in mobile browsers (Safari iOS / Chrome Android) — no app install needed. A host creates a room, configures the match, and shares a 4-letter code; hunters hunt hiders in the real world, tracked live on a dark-themed GPS map.

## Tech stack

| Layer     | Tech                                                        |
| --------- | ----------------------------------------------------------- |
| Frontend  | Quasar (Vue 3 Composition API + Pinia), Leaflet dark tiles  |
| Backend   | Node.js, Express, Socket.io                                 |
| Geospatial | `@turf/turf` (distance / zone membership on the server)    |

## Project structure

```
manhunt/
├── backend/            # Express + Socket.io game server
│   ├── src/
│   │   ├── index.js    # HTTP + WebSocket wiring, serves the built SPA
│   │   ├── rooms.js    # Room registry & game engine (timers, zones, proximity)
│   │   └── settings.js # Settings schema: defaults + clamping ranges
│   └── test/smoke.mjs  # End-to-end engine test over real sockets
└── frontend/           # Quasar SPA
    └── src/
        ├── components/ # GameMap.vue (Leaflet), SettingsPanel.vue (host config)
        ├── pages/      # IndexPage (home), CreatePage (host setup), RoomPage (game)
        ├── services/   # socket, audio (Web Audio API), geo, wakeLock, settingsSchema
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

The Quasar dev server proxies `/socket.io` to the game server, so the app talks to a single origin.

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
- **Visibility** — in the **lobby**, everyone sees everyone's live position. The host can also re-place the zone center directly on the map („Zone verschieben“ toggle, lobby only) — even long after the create screen; the tentative spot previews as a draggable ◎ marker and the zone circle follows it. Once the match starts, mapping edits are locked. Once the match starts: hiders always see hunters live **and each other** (team visibility: every hider's latest position streams to the hider role on every accepted fix); hunters receive hider snapshots every `hiderRevealInterval`. **Out-of-zone exception:** a hider outside the zone is streamed live to hunters (pulsing orange marker) until they re-enter — the pin then freezes at the last position the hunters watched, instead of rewinding to an older periodic reveal. Between periodic reveals, hidden hiders' pins stay frozen at their last revealed position — a live update for one exposed hider never carries the others' current fixes.
- **Reveal countdown & wave** — everyone sees when the next hider reveal is due (`Aufdecken in` / `Enttarnung in` chip, server-computed in `game:tick`). On each scheduled reveal the server emits `hiders:revealed` and every visible hider pin plays a wave animation — hunters see all snapshot pins wave, hiders see their own pin wave. Exposed (out-of-zone) pins wave continuously instead, and captured pins never wave.
- **Pins** — every map pin carries the player's initial (own dot included); captured hiders turn grey with a ✕ badge. A captured hider's own map keeps a static **dead pin where they were found** while their live position keeps tracking as a grey dot. The found spot is broadcast to the whole room the moment the capture is reported — hunters never see a stale pin waiting for the next reveal. All position pins are cleared when a game ends or the room resets.
- **Own position** — every player always sees their own location (blue dot + accuracy circle) on the map, regardless of fix quality. An exposed hider (outside the zone) sees their own dot and accuracy circle turn yellow with a continuous wave animation — and learns about the flip immediately, even when the zone moved past them while they stood still.
- **Smooth pin movement** — position updates glide instead of jumping: pins tween to each new fix (~0.7 s ease-out via `requestAnimationFrame`), with the own accuracy circle riding along in lockstep. Moves longer than 200 m snap instantly (manual location taps, fresh reveal snapshots) so pins never fly across the map.
- **Manual location (testing)** — optional, **off by default**: a small „Test-Werkzeuge“ panel on the map exposes a *Manueller Standort* toggle. When enabled, a GPS/Manuell switch appears; in Manual mode the GPS watch is stopped and tapping the map places you there (crosshair cursor), reporting the position like a normal quality GPS fix — so proximity beeps, live exposure and reveals can all be tested without walking around. The switch is per-device, survives page reloads, and can be flipped back off (or set back to GPS) at any time before/during a game.
- **Proximity alert** — on every accepted GPS fix the server evaluates `@turf/distance(hider, hunter)`. When a hunter comes within `proximityDistanceMeters`, the hider's client plays a 1000 Hz square-wave beep (400 ms, Web Audio API) immediately and repeats it every `proximityBeepInterval` seconds until the hunter leaves the radius.
- **Win conditions** — hunters win when every hider taps the report-capture button („Ich wurde gefunden — Fang melden“, then picking the hunter in the „Wer hat dich gefunden?“ dialog); hiders win when the timer hits zero with at least one hider uncaught.
- **Seamless rejoin** — a dropped connection (network glitch, tunnel, mobile radio sleep) or a browser refresh never costs a player their session: the server keeps the player entry and re-binds the returning client to it — same player id, same role (a rejoining client sends no role, so a stale local one can never flip it), same captured/exposure state. Every successful join triggers a **resync**: the room state plus the position lists for the player's own role (hunters in the hiding phase still get nothing) and the current proximity state, so a hider mid-beep resumes instantly. When the game has already ended, the rejoined client gets the final winner/reason in room state instead of any position lists. The client auto-rejoins transparently whenever socket.io reconnects while a room is open; if the room is gone (empty-room cleanup, server restart), the app fails cleanly back to the home screen.

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

Mutating events acknowledge with `{ ok, ... }`; errors also arrive as `room:error`. Room state broadcasts never contain player coordinates — positions travel only over the `map:*_positions` events, so a hunter cannot extract hider locations from room state.
