/**
 * Manhunt game server — Express + Socket.io.
 *
 * Dev:  `npm run dev` (port 3000). The Quasar dev server proxies
 *       `/socket.io` here, so the browser talks to a single origin.
 * Prod: this server also serves the built SPA from ../frontend/dist/sp.
 */
import express from 'express'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Server } from 'socket.io'

import { GameError, Room, createRoom, getRoom, rooms } from './rooms.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const DIST_DIR = path.resolve(__dirname, '../../frontend/dist/spa')

export function createApp() {
  const app = express()
  const httpServer = createServer(app)
  const io = new Server(httpServer)

  // ------------------------------------------------------------ socket api

  io.on('connection', (socket) => {
    /**
     * Every handler wraps `withRoom` which:
     *  - resolves the room (404-style error if unknown code)
     *  - resolves the acting player (except create/join)
     *  - converts GameError into a `room:error` emit + failed ack
     */
    const fail = (message, ack) => {
      socket.emit('room:error', { message })
      ack?.({ ok: false, error: message })
    }

    const ok = (ack, data = {}) => ack?.({ ok: true, ...data })

    const withRoom = (roomCode, socket_, fn, ack) => {
      try {
        const room = getRoom(roomCode)
        const player = room.assertMember(socket_)
        return fn(room, player)
      } catch (err) {
        fail(err instanceof GameError ? err.message : 'Something went wrong', ack)
        return null
      }
    }

    // -- room lifecycle -----------------------------------------------------

    socket.on('room:create', (payload = {}, ack) => {
      try {
        const hostName = String(payload.hostName || '').trim()
        if (!hostName) throw new GameError('A player name is required')
        const room = createRoom(io, {
          hostName,
          role: payload.role,
          zoneCenter: payload.zoneCenter,
          settings: payload.settings,
        })
        const host = room.players.get(room.hostId)
        room.bindSocket(host, socket)
        room.broadcastState()
        ok(ack, { roomState: room.serialize(), yourPlayerId: host.id })
      } catch (err) {
        fail(err instanceof GameError ? err.message : 'Could not create the room', ack)
      }
    })

    socket.on('room:join', (payload = {}, ack) => {
      try {
        const room = getRoom(payload.roomCode)
        const playerName = String(payload.playerName || '').trim()
        if (!playerName) throw new GameError('A player name is required')
        if (playerName.length > 24) throw new GameError('Name is too long (max 24 characters)')

        const byName = [...room.players.values()].find((p) => p.name.toLowerCase() === playerName.toLowerCase())
        if (byName && byName.connected) throw new GameError('That name is already taken in this room')

        let player
        if (byName) {
          // Reconnect / page refresh: reuse the existing player entry.
          player = room.reconnectPlayer(byName, socket, payload.role)
        } else {
          if (room.status !== 'lobby') throw new GameError('The game already started in this room')
          player = room.addPlayer(socket, { name: playerName, role: payload.role })
        }

        room.broadcastState()
        ok(ack, { roomState: room.serialize(), yourPlayerId: player.id })
      } catch (err) {
        fail(err instanceof GameError ? err.message : 'Could not join the room', ack)
      }
    })

    socket.on('room:update_settings', ({ roomCode, settings } = {}, ack) => {
      withRoom(roomCode, socket, (room, player) => {
        const next = room.updateSettings(player, settings || {})
        ok(ack, { settings: next })
      }, ack)
    })

    socket.on('player:set_role', ({ roomCode, role } = {}, ack) => {
      withRoom(roomCode, socket, (room, player) => {
        if (room.status !== 'lobby') throw new GameError('Role can only be changed in the lobby')
        player.role = role === 'hider' ? 'hider' : 'hunter'
        room.broadcastState()
        ok(ack)
      }, ack)
    })

    socket.on('room:leave', ({ roomCode } = {}, ack) => {
      withRoom(roomCode, socket, (room, player) => {
        socket.leave(room.code)
        socket.data.roomCode = null
        socket.data.playerId = null
        // In the lobby and after a game has ended there is nothing to
        // reconnect to — leaving removes the player from the list for
        // everyone. Mid-game (active) leaving keeps the entry reconnectable.
        if (room.status === 'lobby' || room.status === 'ended') {
          player.connected = false
          player.socketId = null
          room.removePlayer(player)
        } else {
          room.markDisconnected(socket.id)
        }
        ok(ack)
      }, ack)
    })

    // -- game flow ----------------------------------------------------------

    socket.on('game:start', ({ roomCode } = {}, ack) => {
      withRoom(roomCode, socket, (room, player) => {
        room.start(player)
        ok(ack)
      }, ack)
    })

    socket.on('game:reset', ({ roomCode } = {}, ack) => {
      withRoom(roomCode, socket, (room, player) => {
        room.resetToLobby(player)
        ok(ack)
      }, ack)
    })

    // -- live data ----------------------------------------------------------

    socket.on('player:location', (payload = {}) => {
      const roomCode = socket.data?.roomCode
      if (!roomCode) return
      try {
        const room = getRoom(roomCode)
        const player = room.players.get(socket.data?.playerId)
        if (player && player.connected) room.handleLocation(player, payload)
      } catch {
        // Unknown room mid-flight (e.g. deleted): ignore silently.
      }
    })

    socket.on('hider:captured', ({ roomCode, hiderId, hunterId } = {}, ack) => {
      withRoom(roomCode, socket, (room, player) => {
        room.captureHider(player, hiderId, hunterId)
        ok(ack)
      }, ack)
    })

    socket.on('disconnect', () => {
      const roomCode = socket.data?.roomCode
      if (!roomCode) return
      const room = rooms.get(roomCode)
      if (!room) return
      room.markDisconnected(socket.id)
    })
  })

  // ---------------------------------------------------------- static (prod)

  if (existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR))
    // SPA fallback (hash router, but keep deep paths working if mode changes).
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/socket.io')) return next()
      res.sendFile(path.join(DIST_DIR, 'index.html'))
    })
  }

  return { app, httpServer, io }
}

// Only auto-start when executed directly (`node src/index.js`), so the
// smoke test can import createApp() and boot it on a test port.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isMain) {
  const { httpServer } = createApp()
  httpServer.listen(PORT, () => {
    console.log(`[manhunt] game server listening on http://localhost:${PORT}`)
  })
}
