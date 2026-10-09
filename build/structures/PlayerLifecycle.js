const { AqualinkEvents } = require('./AqualinkEvents')
const { reportSuppressedError } = require('./Reporting')

// Fresh joins a player gets, from closes and the deadline together, until
// it connects; the deadline also gets one re-send when the node never got
// the voice update.
const MAX_REJOINS = 2
// How long after a re-send the node is asked again: it answers quickly.
const DEADLINE_RECHECK_MS = 5000

class PlayerLifecycle {
  // How long a voice close waits before it is acted on, and how close to a
  // voice change it may arrive and still be taken for the old connection's.
  static CLOSE_GRACE_MS = 2000

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

    this._deadlineTimer = null
    this._deadlineSeq = 0
    this._rejoins = 0
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
    this._rejoins = 0
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
        rejoins: this._rejoins,
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

    if (this._rejoin(voiceChannel, null, 'voice_deadline')) return
    this._giveUp(
      'voice_deadline',
      {
        op: 'event',
        type: 'WebSocketClosedEvent',
        guildId,
        code: null,
        reason: 'voice_deadline',
        byRemote: false,
        timeout: true
      },
      new Error(`Voice did not connect in time (guild=${guildId})`)
    )
  }

  // A fresh join while any are left. False when they are used up.
  _rejoin(voiceChannel, code, reason) {
    const player = this.player
    if (this._rejoins >= MAX_REJOINS) return false
    this._rejoins++
    player._claimVoiceRecovery(reason)
    player.aqua?.emit?.(AqualinkEvents.PlayerReconnect, player, {
      code,
      fresh: true,
      resuming: false,
      reason
    })
    return this.rejoinVoice(voiceChannel)
  }

  // Ends the player: SocketClosed then destroy, so "socketClosed ends the
  // player" holds on every path. ReconnectionFailed comes first when the
  // rejoins ran out, as opposed to a close that leaves nothing to rejoin.
  _giveUp(reason, payload, error = null) {
    const player = this.player
    if (player.destroyed) return
    if (error) {
      player.aqua?.emit?.(AqualinkEvents.ReconnectionFailed, player, {
        code: payload?.code ?? null,
        error,
        fresh: true,
        payload,
        reason,
        retriesLeft: 0
      })
    }
    player.aqua?.emit?.(AqualinkEvents.SocketClosed, player, payload)
    player.destroy()
  }

  // A voice close is acted on only if it belongs to the current voice
  // attempt. One that arrives within the grace of a voice change, on either
  // side, is the old connection's: a channel move, an adopt handover, a
  // credential swap (NodeLink closes the replaced connection with a 4014)
  // or this player's own rejoin all close a socket nobody uses any more.
  // A real failure caught in that window is left to the voice deadline.
  async socketClosed(_player, _track, payload) {
    const player = this.player
    if (player.destroyed) return
    const conn = player.connection
    const code = payload?.code
    const receivedAt = Date.now()
    const generation = conn?.generation
    const grace = PlayerLifecycle.CLOSE_GRACE_MS

    // Not player._delay: destroy clears those timers, and this one has to
    // settle so the check below can see the player is gone.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, grace)
      timer.unref?.()
    })
    if (player.destroyed || !conn || player.connection !== conn) return

    const changedAt = conn._voiceChangedAt || 0
    let action
    if (conn.generation !== generation || changedAt >= receivedAt - grace) {
      action = 'old_connection'
    } else if (!player.voiceChannel || conn.isWaitingForDisconnect) {
      action = 'no_channel'
    } else if (code === 4014 || code === 4022) {
      // Disconnected or call ended with no voice change behind it: kicked,
      // channel deleted, or the gateway session dropped. The host decides.
      action = 'disconnected'
    } else if (code === 4015 || !(code >= 4000 && code <= 4999)) {
      // Discord's resumable close, or the node reporting on itself: the
      // server reconnects on its own.
      action = 'server_reconnects'
    } else {
      action = 'rejoin'
    }
    if (player.aqua?.debugTrace) {
      player.aqua._trace('player.socketClosed.decision', {
        guildId: player.guildId,
        code,
        action,
        generation,
        currentGeneration: conn.generation,
        rejoins: this._rejoins
      })
    }

    switch (action) {
      case 'old_connection':
        return
      case 'no_channel':
      case 'disconnected':
        return this._giveUp(action, payload)
      case 'server_reconnects':
        this.armVoiceDeadline(undefined, true)
        return
    }
    player.connected = false
    const voiceChannel = this._functions.toId(player.voiceChannel)
    if (this._rejoin(voiceChannel, code, 'socket_closed')) return
    this._giveUp(
      'rejoins_exhausted',
      payload,
      new Error(
        `Voice closed with ${code} and the rejoins are used up (guild=${player.guildId})`
      )
    )
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
