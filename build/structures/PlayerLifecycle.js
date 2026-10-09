const { AqualinkEvents } = require('./AqualinkEvents')
const { reportSuppressedError } = require('./Reporting')

const FRESH_REJOIN_DELAYS = Object.freeze({
  4006: 1000,
  4014: 3000,
  4022: 5000
})
// After the voice deadline the node is asked first; then up to this many
// fresh joins, plus one re-send when the node never got the voice update.
const DEADLINE_REJOINS = 2
// How long after a re-send the node is asked again: it answers quickly.
const DEADLINE_RECHECK_MS = 5000

class PlayerLifecycle {
  constructor(player, deps) {
    this.player = player
    this._functions = deps._functions
    this.PLAYER_STATE = deps.PLAYER_STATE
    this.VOICE_TRACE_INTERVAL = deps.VOICE_TRACE_INTERVAL
    this.PLAYER_UPDATE_SILENCE_THRESHOLD = deps.PLAYER_UPDATE_SILENCE_THRESHOLD
    this.VOICE_DOWN_THRESHOLD = deps.VOICE_DOWN_THRESHOLD
    this.VOICE_ABANDON_MULTIPLIER = deps.VOICE_ABANDON_MULTIPLIER
    this.VOICE_FORCE_DESTROY_MS = deps.VOICE_FORCE_DESTROY_MS
    this.RECONNECT_MAX = deps.RECONNECT_MAX
    this.MUTE_TOGGLE_DELAY = deps.MUTE_TOGGLE_DELAY
    this.SEEK_DELAY = deps.SEEK_DELAY
    this.PAUSE_DELAY = deps.PAUSE_DELAY
    this.RETRY_BACKOFF_BASE = deps.RETRY_BACKOFF_BASE
    this.RETRY_BACKOFF_MAX = deps.RETRY_BACKOFF_MAX

    this._deadlineTimer = null
    this._deadlineSeq = 0
    this._deadlineRejoins = 0
    this._deadlineResent = false
  }

  handlePlayerUpdate(packet) {
    const player = this.player
    if (player.destroyed || !packet?.state) return
    const s = packet.state
    player._lastPlayerUpdateAt = Date.now()
    const wasConnected = player.connected
    player.position = this._functions.isNum(s.position) ? s.position : 0
    player.connected = !!s.connected
    player.ping = this._functions.isNum(s.ping) ? s.ping : 0
    player.timestamp = this._functions.isNum(s.time) ? s.time : Date.now()

    if (player.destroyed) return

    if (!player.connected) {
      if (wasConnected || !player._voiceDownSince) {
        if (player.aqua?.debugTrace) {
          player.aqua._trace('player.voice.down', {
            guildId: player.guildId,
            reconnecting: !!player._reconnecting,
            recovering: !!player._voiceRecovering
          })
        }
      }
      if (
        !player._voiceDownSince &&
        !player._reconnecting &&
        !player._voiceRecovering
      ) {
        player._voiceDownSince = Date.now()
        const recoveryToken = player._claimVoiceRecovery('player_update_resume')
        player._createTimer(() => {
          if (
            !player._isVoiceRecoveryActive(recoveryToken) ||
            player.connected ||
            player.destroyed ||
            player._reconnecting ||
            player._voiceRecovering ||
            player.nodes?.info?.isNodelink ||
            !player.voiceChannel
          )
            return
          player.connection.attemptResume()
        }, 1000)
      }
    } else {
      this.clearVoiceDeadline(true)
      player._voiceDownSince = 0
      player.reconnectionRetries = 0
      player.state = this.PLAYER_STATE.READY
      player._clearVoiceRecovery(undefined, 'connected')
      player._voiceRecovering = false

      if (player._reconnecting && !player._isActivelyReconnecting) {
        player._reconnecting = false
      }
      if (player._resuming) {
        player._resuming = false
      }

      const now = Date.now()
      if (
        !wasConnected ||
        now - player._lastVoiceUpTraceAt >= this.VOICE_TRACE_INTERVAL
      ) {
        player._lastVoiceUpTraceAt = now
        if (player.aqua?.debugTrace) {
          player.aqua._trace('player.voice.up', {
            guildId: player.guildId,
            ping: player.ping
          })
        }
      }
      this.flushDeferredPlay()
    }

    player.aqua.emit(AqualinkEvents.PlayerUpdate, player, packet)
  }

  async voiceWatchdog() {
    const player = this.player
    if (player.destroyed || !player.connection) return

    const now = Date.now()
    const silentPlayer =
      player.playing &&
      !player.paused &&
      !!player.voiceChannel &&
      !player._reconnecting &&
      !player._voiceRecovering &&
      now - (player._lastPlayerUpdateAt || 0) >=
        this.PLAYER_UPDATE_SILENCE_THRESHOLD

    if (silentPlayer) {
      const silenceMs = now - (player._lastPlayerUpdateAt || now)
      if (!player._voiceDownSince)
        player._voiceDownSince = now - this.VOICE_DOWN_THRESHOLD - 1
      player._lastPlayerUpdateAt = now
      player.connected = false
      if (player.aqua?.debugTrace) {
        player.aqua._trace('player.voice.silence', {
          guildId: player.guildId,
          silenceMs,
          playing: !!player.playing,
          paused: !!player.paused
        })
      }
    }

    if (player._voiceDownSince && !player.connected) {
      const downFor = Date.now() - player._voiceDownSince
      if (
        downFor > this.VOICE_FORCE_DESTROY_MS &&
        player.reconnectionRetries >= this.RECONNECT_MAX
      ) {
        if (player.aqua?.debugTrace) {
          player.aqua._trace('player.forceDestroy', {
            guildId: player.guildId
          })
        }
        player.destroy()
        return
      }
    }

    if (!player._shouldAttemptVoiceRecovery()) return

    const hasVoiceData =
      player.connection?.sessionId &&
      player.connection?.endpoint &&
      player.connection?.token
    if (!hasVoiceData) {
      const downFor = Date.now() - player._voiceDownSince
      if (downFor > this.VOICE_DOWN_THRESHOLD * this.VOICE_ABANDON_MULTIPLIER) {
        const recoveryToken = player._claimVoiceRecovery(
          'watchdog_voice_refresh'
        )
        if (player._isVoiceRecoveryActive(recoveryToken))
          player.connection?._requestVoiceState?.()
        if (player._isVoiceRecoveryActive(recoveryToken))
          player.connection?.resendVoiceUpdate(true)
        player.reconnectionRetries = Math.min(
          player.reconnectionRetries + 1,
          30
        )
        if (
          downFor > this.VOICE_FORCE_DESTROY_MS &&
          player.reconnectionRetries >= this.RECONNECT_MAX * 2
        ) {
          player.destroy()
        }
      }
      return
    }

    const recoveryToken = player._claimVoiceRecovery('watchdog_resume')
    player._voiceRecovering = true
    try {
      if (!player._isVoiceRecoveryActive(recoveryToken)) return
      if (await player.connection.attemptResume()) {
        player.reconnectionRetries = player._voiceDownSince = 0
        player._clearVoiceRecovery(recoveryToken, 'resumed')
        return
      }
      if (!player._isVoiceRecoveryActive(recoveryToken)) return
      const originalMute = player.mute
      player.send({
        guild_id: player.guildId,
        channel_id: player.voiceChannel,
        self_deaf: player.deaf,
        self_mute: !originalMute
      })
      await player._delay(this.MUTE_TOGGLE_DELAY)
      if (!player.destroyed && player._isVoiceRecoveryActive(recoveryToken)) {
        player.send({
          guild_id: player.guildId,
          channel_id: player.voiceChannel,
          self_deaf: player.deaf,
          self_mute: originalMute
        })
      }
      if (player._isVoiceRecoveryActive(recoveryToken))
        player.connection.resendVoiceUpdate()
      player.reconnectionRetries++
    } catch (error) {
      player.reconnectionRetries++
      reportSuppressedError(player, 'player.voiceWatchdog', error, {
        guildId: player.guildId
      })
      if (player.reconnectionRetries >= this.RECONNECT_MAX) {
        if (player._isVoiceRecoveryActive(recoveryToken))
          player.connection?._requestVoiceState?.()
        if (player._isVoiceRecoveryActive(recoveryToken))
          player.connection?.resendVoiceUpdate(true)
        player.reconnectionRetries = this.RECONNECT_MAX - 2
      }
    } finally {
      if (player._isVoiceRecoveryActive(recoveryToken)) {
        player._voiceRecovering = false
      }
    }
  }

  async attemptVoiceResume(abortSignal) {
    const player = this.player
    if (!player.connection?.sessionId)
      throw new Error(`No session (guild=${player.guildId})`)
    if (abortSignal?.aborted) throw new Error('Resume aborted by signal')
    if (!(await player.connection.attemptResume()))
      throw new Error(
        `Resume failed (guild=${player.guildId}, endpoint=${player.connection.endpoint || 'none'})`
      )
  }

  async freshVoiceRejoin(code, payload) {
    const player = this.player
    const voiceChannel = this._functions.toId(player.voiceChannel)
    if (!voiceChannel) {
      player.aqua?.emit?.(AqualinkEvents.SocketClosed, player, payload)
      return
    }

    const recoveryToken = player._claimVoiceRecovery(
      `socket_closed_fresh_${code}`
    )
    player.connected = false
    player._voiceDownSince = player._voiceDownSince || Date.now()
    player._reconnecting = true
    player._isActivelyReconnecting = true

    if (player.aqua?.debugTrace) {
      player.aqua._trace('player.socketClosed.freshRejoin', {
        guildId: player.guildId,
        code,
        delay: FRESH_REJOIN_DELAYS[code]
      })
    }

    player.aqua?.emit?.(AqualinkEvents.PlayerReconnect, player, {
      code,
      fresh: true,
      resuming: false
    })

    try {
      await player._delay(FRESH_REJOIN_DELAYS[code])
      if (!player._isVoiceRecoveryActive(recoveryToken) || player.destroyed) {
        if (player.connected && !player.destroyed) {
          player._reconnecting = false
          player._isActivelyReconnecting = false
        }
        return
      }

      if (!this.rejoinVoice(voiceChannel)) {
        throw new Error(
          `Unable to prepare fresh voice join (guild=${player.guildId})`
        )
      }
      // The join armed the voice deadline, which takes it from here.
      player._isActivelyReconnecting = false
    } catch (error) {
      player._reconnecting = false
      player._isActivelyReconnecting = false
      player._clearVoiceRecovery(recoveryToken, 'fresh_rejoin_failed')
      reportSuppressedError(player, 'player.socketClosed.freshRejoin', error, {
        code,
        guildId: player.guildId
      })
      player.aqua?.emit?.(AqualinkEvents.SocketClosed, player, payload)
    }
  }

  // Drops the voice credentials and joins the channel again, so Discord
  // hands out new ones. _reconnecting stays set until the player connects:
  // the node closes the replaced voice connection (NodeLink with a 4014),
  // and taking that for a new failure would wipe the new credentials.
  rejoinVoice(voiceChannel) {
    const player = this.player
    if (!voiceChannel || !player.connection?._prepareFreshVoiceJoin?.())
      return false
    player.connected = false
    player._reconnecting = true
    player.connect({
      guildId: player.guildId,
      voiceChannel,
      deaf: player.deaf,
      mute: player.mute
    })
    return true
  }

  _voiceDeadlineMs() {
    const ms = Number(this.player.aqua?.voiceConnectTimeout)
    return Number.isFinite(ms) && ms > 0 ? ms : 30000
  }

  // One deadline per player for its voice to come up, armed by every voice
  // attempt and cleared by a connected playerUpdate. Every other recovery
  // path is skipped while some flag is set (_reconnecting, _resuming,
  // _voiceRecovering) or on a NodeLink node, and a flag that never cleared
  // left the player silent for good. The deadline ignores all of them.
  // `ifNone` keeps a pending deadline: a voice PATCH belongs to the attempt
  // that armed it and must not stretch that attempt's window.
  armVoiceDeadline(ms = this._voiceDeadlineMs(), ifNone = false) {
    const player = this.player
    if (player.destroyed || !player._pendingTimers) return
    if (this._deadlineTimer && ifNone) return
    this._clearDeadlineTimer()
    const seq = this._deadlineSeq
    this._deadlineTimer = player._createTimer(() => {
      this._deadlineTimer = null
      this.onVoiceDeadline(seq).catch((error) =>
        reportSuppressedError(player, 'player.voiceDeadline', error, {
          guildId: player.guildId
        })
      )
    }, ms)
  }

  clearVoiceDeadline(reset = false) {
    this._clearDeadlineTimer()
    if (!reset) return
    this._deadlineRejoins = 0
    this._deadlineResent = false
  }

  _clearDeadlineTimer() {
    this._deadlineSeq++
    if (!this._deadlineTimer) return
    clearTimeout(this._deadlineTimer)
    this.player._pendingTimers?.delete(this._deadlineTimer)
    this._deadlineTimer = null
  }

  async onVoiceDeadline(seq) {
    const player = this.player
    if (player.destroyed || seq !== this._deadlineSeq) return
    const guildId = player.guildId

    player._reconnecting = false
    player._isActivelyReconnecting = false
    player._resuming = false
    player._voiceRecovering = false
    player._clearVoiceRecovery(undefined, 'voice_deadline')

    // An idle player may get no playerUpdate at all, so `connected` is not
    // proof that it is down.
    const node = player.nodes
    let remote = null
    try {
      remote = await node.rest.getPlayer(guildId)
    } catch (error) {
      reportSuppressedError(player, 'player.voiceDeadline.get', error, {
        guildId,
        node: node?.name
      })
    }
    if (player.destroyed || seq !== this._deadlineSeq) return
    if (player.aqua?.debugTrace) {
      player.aqua._trace('player.voiceDeadline', {
        guildId,
        node: node?.name,
        remoteConnected: !!remote?.state?.connected,
        rejoins: this._deadlineRejoins,
        resent: this._deadlineResent
      })
    }

    if (remote?.state?.connected) {
      player.connected = true
      this.clearVoiceDeadline(true)
      return
    }

    const voiceChannel = this._functions.toId(player.voiceChannel)
    if (!voiceChannel || player.connection?.isWaitingForDisconnect) {
      player.destroy()
      return
    }

    // No voice on the node: the update was lost (a 429), so send it again.
    // Voice but not connected: Discord refused those credentials, and only
    // a fresh join gets new ones.
    const voice = remote?.voice
    const nodeHasVoice = !!(voice?.token && voice?.endpoint && voice?.sessionId)
    if (!nodeHasVoice && !this._deadlineResent) {
      if (player.connection?.resendVoiceUpdate(true)) {
        this._deadlineResent = true
        this.armVoiceDeadline(DEADLINE_RECHECK_MS)
        player.connection.flushVoiceUpdate()
        return
      }
    }

    if (this._deadlineRejoins < DEADLINE_REJOINS) {
      this._deadlineRejoins++
      player._claimVoiceRecovery('voice_deadline')
      player.aqua?.emit?.(AqualinkEvents.PlayerReconnect, player, {
        code: null,
        fresh: true,
        resuming: false,
        reason: 'voice_deadline'
      })
      if (this.rejoinVoice(voiceChannel)) return
    }

    // Out of attempts. SocketClosed then destroy, so "socketClosed ends the
    // player" holds on this path too.
    const payload = {
      op: 'event',
      type: 'WebSocketClosedEvent',
      guildId,
      code: null,
      reason: 'voice_deadline',
      byRemote: false,
      timeout: true
    }
    player.aqua?.emit?.(AqualinkEvents.ReconnectionFailed, player, {
      code: null,
      error: new Error(`Voice did not connect in time (guild=${guildId})`),
      fresh: true,
      payload,
      reason: 'voice_deadline',
      retriesLeft: 0
    })
    player.aqua?.emit?.(AqualinkEvents.SocketClosed, player, payload)
    player.destroy()
  }

  async socketClosed(_player, _track, payload) {
    const player = this.player
    if (player.destroyed || player._reconnecting) return
    if (player.aqua?.debugTrace) {
      const conn = player.connection
      player.aqua._trace('player.socketClosed', {
        guildId: player.guildId,
        code: payload?.code,
        generation: conn?.generation,
        sinceVoiceChange: conn?._voiceChangedAt
          ? Date.now() - conn._voiceChangedAt
          : null
      })
    }

    const code = payload?.code
    // An adopted player's voice is moving to this process's gateway session,
    // and that closes the old socket: a real 4006/4014, or NodeLink's own
    // 4014 when the new voice PATCH replaces a live connection. A rejoin
    // here would redo the handover, and the 4006 rebuild restarts the track.
    if (player._adoptGuard && (code === 4006 || code === 4014)) {
      if (player.aqua?.debugTrace) {
        player.aqua._trace('player.socketClosed.ignored', {
          guildId: player.guildId,
          code,
          reason: 'adopt_handover'
        })
      }
      return
    }
    if (code === 4014 || code === 4022) {
      return this.freshVoiceRejoin(code, payload)
    }

    if (code === 4006 && player._resuming) {
      if (!player.connection?._isTransient4006?.()) {
        return this.freshVoiceRejoin(code, payload)
      }
      if (player.aqua?.debugTrace) {
        player.aqua._trace('player.socketClosed.ignored', {
          guildId: player.guildId,
          code,
          reason: 'transient_while_resuming'
        })
      }
      return
    }

    const isRecoverable = [4015, 4009, 4006].includes(code)

    if (code === 4015 && !player.nodes?.info?.isNodelink) {
      const recoveryToken = player._claimVoiceRecovery('socket_closed_resume')
      player._reconnecting = true
      player._isActivelyReconnecting = true
      try {
        if (!player._isVoiceRecoveryActive(recoveryToken)) return
        await this.attemptVoiceResume()
        player._clearVoiceRecovery(recoveryToken, 'socket_closed_resumed')
        player._reconnecting = false
        player._isActivelyReconnecting = false
        return
      } catch (error) {
        player._reconnecting = false
        reportSuppressedError(player, 'player.socketClosed.resume', error, {
          guildId: player.guildId,
          code
        })
      }
    }

    if (!isRecoverable) {
      player.aqua.emit(AqualinkEvents.SocketClosed, player, payload)
      player.destroy()
      return
    }

    const aqua = player.aqua
    const vcId = this._functions.toId(player.voiceChannel)
    const tcId = this._functions.toId(player.textChannel)
    const { guildId, deaf, mute } = player

    if (!vcId) {
      aqua?.emit?.(AqualinkEvents.SocketClosed, player, payload)
      return
    }

    const state = {
      volume: player.volume,
      position: player.position,
      paused: player.paused,
      loop: player.loop,
      isAutoplayEnabled: player.isAutoplayEnabled,
      currentTrack: player.current,
      queue: player.queue?.toArray() || [],
      previousIdentifiers: Array.from(player.previousIdentifiers),
      previousTracks: player.previousTracks?.toArray?.() || [],
      filters: player.filters?.toJSON?.() || null,
      dataStore: player._dataStore ? Array.from(player._dataStore) : null,
      fading: player.fading ? JSON.parse(JSON.stringify(player.fading)) : null,
      crossfade: player.crossfade ? { ...player.crossfade } : null,
      ducking: !!player.ducking,
      loudnessNormalizer: !!player.loudnessNormalizer,
      autoplaySeed: player.autoplaySeed,
      nowPlayingMessage: player.nowPlayingMessage,
      voiceState: player.connection
        ? {
            sessionId: player.connection.sessionId || null,
            endpoint: player.connection.endpoint || null,
            token: player.connection.token || null,
            region: player.connection.region || null,
            channelId: player.connection.channelId || null
          }
        : null
    }

    player._reconnecting = true
    player._isActivelyReconnecting = true
    player.destroy({
      preserveClient: true,
      skipRemote: true,
      preserveMessage: true,
      preserveReconnecting: true,
      preserveTracks: true
    })

    const reconnectNonce = player._reconnectNonce
    player._reconnectTimers = new Set()
    const reconnectTimers = player._reconnectTimers
    const tryReconnect = async (attempt) => {
      if (aqua?.destroyed || player._reconnectNonce !== reconnectNonce) {
        this._functions.clearTimers(reconnectTimers)
        player._reconnectTimers = null
        player._reconnecting = false
        player._isActivelyReconnecting = false
        return
      }
      const activePlayer = aqua?.players?.get?.(String(guildId))
      if (activePlayer && activePlayer !== player && !activePlayer.destroyed) {
        this._functions.clearTimers(reconnectTimers)
        player._reconnectTimers = null
        player._reconnecting = false
        player._isActivelyReconnecting = false
        return
      }
      try {
        const np = await aqua.createConnection({
          guildId,
          voiceChannel: vcId,
          textChannel: tcId,
          deaf,
          mute,
          defaultVolume: state.volume,
          preserveMessage: true,
          resuming: true
        })
        if (!np) throw new Error('Failed to create player')
        if (player._reconnectNonce !== reconnectNonce || aqua?.destroyed) {
          try {
            np.destroy?.()
          } catch {}
          this._functions.clearTimers(reconnectTimers)
          player._reconnectTimers = null
          player._reconnecting = false
          player._isActivelyReconnecting = false
          return
        }
        const latestActivePlayer = aqua?.players?.get?.(String(guildId))
        if (
          latestActivePlayer &&
          latestActivePlayer !== player &&
          latestActivePlayer !== np &&
          !latestActivePlayer.destroyed
        ) {
          try {
            np.destroy?.()
          } catch {}
          this._functions.clearTimers(reconnectTimers)
          player._reconnectTimers = null
          player._reconnecting = false
          player._isActivelyReconnecting = false
          return
        }

        np.reconnectionRetries = 0
        np.loop = state.loop
        np.isAutoplayEnabled = state.isAutoplayEnabled
        np.autoplaySeed = state.autoplaySeed
        np.previousIdentifiers = new Set(state.previousIdentifiers)
        np.nowPlayingMessage = state.nowPlayingMessage
        for (const track of state.previousTracks || [])
          np.previousTracks?.push(track)
        if (state.dataStore?.length && np.set) {
          for (const [key, value] of state.dataStore) np.set(key, value)
        }
        if (state.fading) np.setFading?.(state.fading)
        if (state.crossfade) np.setCrossfade?.(state.crossfade)
        if (state.ducking) np.setDucking?.(true)
        if (state.loudnessNormalizer) np.setLoudnessNormalizer?.(true)
        if (state.filters && np.filters?.applySnapshot) {
          np.filters
            .applySnapshot(state.filters)
            .updateFilters()
            .catch(() => {})
        }
        if (state.voiceState && np.connection) {
          np.connection.sessionId =
            state.voiceState.sessionId || np.connection.sessionId
          np.connection.endpoint =
            state.voiceState.endpoint || np.connection.endpoint
          np.connection.token = state.voiceState.token || np.connection.token
          np.connection.region = state.voiceState.region || np.connection.region
          np.connection.channelId =
            state.voiceState.channelId || np.connection.channelId
          np.connection._lastEndpoint =
            state.voiceState.endpoint || np.connection._lastEndpoint
          if (
            np.connection.sessionId &&
            np.connection.endpoint &&
            np.connection.token
          ) {
            np.connection._lastVoiceDataUpdate = Date.now()
            np.connection.resendVoiceUpdate(true)
          }
        }

        const ct = state.currentTrack
        if (ct) np.queue.add(ct)
        for (const q of state.queue) if (q !== ct) np.queue.add(q)

        if (ct) {
          await np.play(undefined, { oneShot: ct.oneShot })
          if (state.position > 5000)
            np._createTimer(
              () => !np.destroyed && np.seek(state.position),
              this.SEEK_DELAY
            )
          if (state.paused)
            np._createTimer(
              () => !np.destroyed && np.pause(true),
              this.PAUSE_DELAY
            )
        }

        this._functions.clearTimers(reconnectTimers)
        player._reconnectTimers = null
        player._reconnecting = false
        player._isActivelyReconnecting = false
        aqua.emit(AqualinkEvents.PlayerReconnected, np, {
          oldPlayer: player,
          restoredState: state
        })
      } catch (error) {
        if (player._reconnectNonce !== reconnectNonce || aqua?.destroyed) {
          this._functions.clearTimers(reconnectTimers)
          player._reconnectTimers = null
          player._reconnecting = false
          player._isActivelyReconnecting = false
          return
        }
        const retriesLeft = this.RECONNECT_MAX - attempt
        aqua.emit(AqualinkEvents.ReconnectionFailed, player, {
          error,
          code,
          payload,
          retriesLeft
        })

        if (retriesLeft > 0) {
          this._functions.createTimer(
            () => tryReconnect(attempt + 1),
            Math.min(this.RETRY_BACKOFF_BASE * attempt, this.RETRY_BACKOFF_MAX),
            reconnectTimers
          )
        } else {
          this._functions.clearTimers(reconnectTimers)
          player._reconnectTimers = null
          player._reconnecting = false
          player._isActivelyReconnecting = false
          aqua.emit(AqualinkEvents.SocketClosed, player, payload)
        }
      }
    }

    tryReconnect(1)
  }

  flushDeferredPlay() {
    const player = this.player
    if (
      !player._deferredStart ||
      player.destroyed ||
      !player.current?.track ||
      !player._updateBatcher
    )
      return
    player._deferredStart = false
    const updateData = {
      track: { encoded: player.current.track },
      paused: player.paused
    }
    if (player.current.userData)
      updateData.track.userData = player.current.userData
    if (player.position > 0) updateData.position = player.position
    if (player.aqua?.debugTrace) {
      player.aqua._trace('player.play.deferred.flush', {
        guildId: player.guildId,
        hasEndpoint: !!player.connection?.endpoint
      })
    }
    player.batchUpdatePlayer(updateData, true).catch((error) =>
      reportSuppressedError(player, 'player.deferredPlay.flush', error, {
        guildId: player.guildId
      })
    )
  }
}

module.exports = PlayerLifecycle
