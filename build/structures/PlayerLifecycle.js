const { AqualinkEvents } = require('./AqualinkEvents')
const { reportSuppressedError } = require('./Reporting')

// Fresh joins a player gets, from closes and the deadline together, until
// it connects; the deadline also gets one re-send when the node never got
// the voice update.
const MAX_REJOINS = 2
// How long after a re-send the node is asked again: it answers quickly.
const DEADLINE_RECHECK_MS = 5000
// Deadlines in a row the node did not answer (no response, or a 5xx)
// before the player is moved to another node.
const UNREACHABLE_BEFORE_MOVE = 2

class PlayerLifecycle {
  // How long a voice close waits before it is acted on, so that a voice
  // change that was already under way when it arrived can show itself.
  static CLOSE_GRACE_MS = 2000
  // How long a rejoin waits for Discord's new credentials before it leaves
  // the channel for real, and how long that leave waits for Discord to
  // confirm it before joining anyway.
  static REJOIN_SERVER_WAIT_MS = 5000
  static LEAVE_CONFIRM_MS = 5000

  constructor(player, deps) {
    this.player = player
    this._functions = deps._functions
    this.PLAYER_STATE = deps.PLAYER_STATE
    this.VOICE_TRACE_INTERVAL = deps.VOICE_TRACE_INTERVAL
    this.PLAYER_UPDATE_SILENCE_THRESHOLD = deps.PLAYER_UPDATE_SILENCE_THRESHOLD

    this._deadlineTimer = null
    this._deadlineSeq = 0
    this._rejoins = 0
    this._deadlineResent = false
    this._deadlineCheck = false
    this._deadlineUnreachable = 0
    this._leaveRejoinTimer = null
    this._leaveRejoinSeq = 0
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
      if (wasConnected) {
        if (player.aqua?.debugTrace) {
          player.aqua._trace('player.voice.down', {
            guildId: player.guildId,
            reconnecting: !!player._reconnecting
          })
        }
        // The server reconnects a resumable drop itself; the deadline acts
        // if it does not.
        this.armVoiceDeadline(undefined, true)
      }
    } else {
      this.clearVoiceDeadline(true)
      player.state = this.PLAYER_STATE.READY
      player._reconnecting = false
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

  // A playing player the node has gone quiet about. A dead node socket is
  // the node's own liveness check; this is a node that is up but no longer
  // reports this player. The voice deadline asks the node and acts.
  voiceWatchdog() {
    const player = this.player
    if (player.destroyed || !player.connection) return
    if (
      !player.playing ||
      player.paused ||
      !player.voiceChannel ||
      player._reconnecting
    )
      return
    const now = Date.now()
    const silenceMs = now - (player._lastPlayerUpdateAt || 0)
    if (silenceMs < this.PLAYER_UPDATE_SILENCE_THRESHOLD) return
    if (player.aqua?.debugTrace) {
      player.aqua._trace('player.voice.silence', {
        guildId: player.guildId,
        silenceMs
      })
    }
    player._lastPlayerUpdateAt = now
    player.connected = false
    this.armVoiceDeadline(undefined, true)
  }

  // Drops the voice credentials and joins the channel again, so Discord
  // hands out new ones. _reconnecting marks the rejoin as under way for
  // play() and trackEnd until the player connects or the deadline acts.
  // A join to the channel the bot is already in may get no new
  // credentials, so if none come the rejoin leaves for real and joins again.
  rejoinVoice(voiceChannel) {
    const player = this.player
    if (!voiceChannel || !player.connection?._prepareFreshVoiceJoin?.())
      return false
    this._cancelLeaveRejoin()
    player.voiceRejoining = false
    player.connected = false
    player._reconnecting = true
    player.connect({
      guildId: player.guildId,
      voiceChannel,
      deaf: player.deaf,
      mute: player.mute
    })
    this._awaitVoiceServer()
    return true
  }

  // The rejoin cleared the credentials, so they are back once Discord's
  // VOICE_SERVER_UPDATE for the join has arrived.
  _awaitVoiceServer() {
    const player = this.player
    const conn = player.connection
    const seq = ++this._leaveRejoinSeq
    this._leaveRejoinTimer = player._createTimer(() => {
      this._leaveRejoinTimer = null
      if (player.destroyed || seq !== this._leaveRejoinSeq) return
      if (player.connection !== conn || (conn.token && conn.endpoint)) return
      this._leaveAndJoin(seq)
    }, PlayerLifecycle.REJOIN_SERVER_WAIT_MS)
  }

  // Leaves the channel and joins it again, which always starts a new voice
  // session, as part of the same rejoin. The bot's own null voice state
  // that answers the leave is this player's doing, not a disconnect: the
  // connection hands it back here (no PlayerMove, no null-channel grace),
  // and `voiceRejoining` tells the host not to end the player over it.
  // The node keeps its player; the join's credentials replace its voice.
  _leaveAndJoin(seq) {
    const player = this.player
    const conn = player.connection
    player.voiceRejoining = true
    player.aqua?.emit?.(AqualinkEvents.PlayerReconnect, player, {
      code: null,
      fresh: true,
      resuming: false,
      reason: 'leave_rejoin'
    })
    if (player.destroyed || seq !== this._leaveRejoinSeq) return
    if (player.aqua?.debugTrace) {
      player.aqua._trace('player.voice.leaveRejoin', {
        guildId: player.guildId,
        voiceChannel: player.voiceChannel
      })
    }
    // The join re-arms the deadline; it must not act on the leave.
    this.clearVoiceDeadline()
    conn._selfLeave = () => this._joinAfterLeave(seq)
    this._leaveRejoinTimer = player._createTimer(() => {
      this._leaveRejoinTimer = null
      this._joinAfterLeave(seq)
    }, PlayerLifecycle.LEAVE_CONFIRM_MS)
    player.send({
      guild_id: player.guildId,
      channel_id: null,
      self_deaf: player.deaf,
      self_mute: player.mute
    })
  }

  _joinAfterLeave(seq) {
    const player = this.player
    if (player.destroyed || seq !== this._leaveRejoinSeq) return
    this._cancelLeaveRejoin()
    const voiceChannel = this._functions.toId(player.voiceChannel)
    if (!voiceChannel || !player.connection?._prepareFreshVoiceJoin?.()) {
      this.armVoiceDeadline()
      return
    }
    player.connected = false
    player._reconnecting = true
    player.connect({
      guildId: player.guildId,
      voiceChannel,
      deaf: player.deaf,
      mute: player.mute
    })
  }

  _cancelLeaveRejoin() {
    this._leaveRejoinSeq++
    if (this._leaveRejoinTimer) {
      clearTimeout(this._leaveRejoinTimer)
      this.player._pendingTimers?.delete(this._leaveRejoinTimer)
      this._leaveRejoinTimer = null
    }
    if (this.player.connection) this.player.connection._selfLeave = null
  }

  _voiceDeadlineMs() {
    const ms = Number(this.player.aqua?.voiceConnectTimeout)
    return Number.isFinite(ms) && ms > 0 ? ms : 30000
  }

  // One deadline per player for its voice to come up, armed by every voice
  // attempt and by voice going down, and cleared by a connected
  // playerUpdate. It is the only backstop, on every node type, and it does
  // not care what state the player's flags are in.
  // `ifNone` keeps a pending deadline: a voice PATCH belongs to the attempt
  // that armed it and must not stretch that attempt's window. `check` is an
  // early look (after a move or a re-send), which re-sends a lost update
  // but leaves a handshake still in progress to the normal deadline.
  armVoiceDeadline(ms = this._voiceDeadlineMs(), ifNone = false, check = false) {
    const player = this.player
    if (player.destroyed || !player._pendingTimers) return
    if (this._deadlineTimer && ifNone) return
    this._clearDeadlineTimer()
    this._deadlineCheck = check
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
    // Voice is up. A rejoin still waiting for new credentials has its
    // answer; one that has already left must still join.
    if (!this.player.connection?._selfLeave) {
      this._cancelLeaveRejoin()
      this.player.voiceRejoining = false
    }
    this._rejoins = 0
    this._deadlineResent = false
    this._deadlineUnreachable = 0
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
    const check = this._deadlineCheck

    // An idle player may get no playerUpdate at all, so `connected` is not
    // proof that it is down.
    const node = player.nodes
    let remote = null
    let unreachable = false
    try {
      remote = await node.rest.getPlayer(guildId)
    } catch (error) {
      // No answer, or the node's REST failing, says nothing about voice. A
      // 4xx is an answer: the node does not have the player.
      const status = error?.statusCode || error?.response?.statusCode || 0
      unreachable = !status || status >= 500
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
        check,
        unreachable,
        remoteConnected: !!remote?.state?.connected,
        rejoins: this._rejoins,
        resent: this._deadlineResent
      })
    }

    // Nothing is spent on a node that cannot answer: a gateway rejoin
    // cannot fix its REST. Moved off it if it stays that way.
    if (unreachable) return this._onNodeUnreachable(node)
    this._deadlineUnreachable = 0

    // _resuming is left alone: it decides TrackStart.resumed, and the
    // TrackStart of a restored track can still be on its way.
    player._reconnecting = false

    // A paused player sends no playerUpdate, so a track deferred until
    // voice came up is sent here or never.
    if (remote?.state?.connected) {
      player.connected = true
      this.clearVoiceDeadline(true)
      this.flushDeferredPlay()
      return
    }

    const voiceChannel = this._functions.toId(player.voiceChannel)
    if (!voiceChannel || player.connection?.isWaitingForDisconnect) {
      this._giveUp('no_channel', this._deadlinePayload())
      return
    }

    // No voice on the node: the update was lost (a 429), so send it again.
    // Voice but not connected: Discord refused those credentials, and only
    // a fresh join gets new ones -- unless this is the early check, when
    // the node may simply still be shaking hands.
    const voice = remote?.voice
    const nodeHasVoice = !!(voice?.token && voice?.endpoint && voice?.sessionId)
    if (!nodeHasVoice && !this._deadlineResent) {
      if (player.connection?.resendVoiceUpdate(true)) {
        this._deadlineResent = true
        this.armVoiceDeadline(DEADLINE_RECHECK_MS, false, true)
        player.connection.flushVoiceUpdate()
        return
      }
    }
    if (check && nodeHasVoice) {
      this.armVoiceDeadline()
      return
    }

    if (this._rejoin(voiceChannel, null, 'voice_deadline')) return
    this._giveUp(
      'voice_deadline',
      this._deadlinePayload(),
      new Error(`Voice did not connect in time (guild=${guildId})`)
    )
  }

  _deadlinePayload() {
    return {
      op: 'event',
      type: 'WebSocketClosedEvent',
      guildId: this.player.guildId,
      code: null,
      reason: 'voice_deadline',
      byRemote: false,
      timeout: true
    }
  }

  // The node's REST did not answer the deadline. Once is noise; in a row,
  // the node is the problem, so the player moves to another one if there is
  // one. Otherwise it waits: destroying it would end the session over a
  // REST outage that a rejoin cannot fix.
  _onNodeUnreachable(node) {
    const player = this.player
    const aqua = player.aqua
    this._deadlineUnreachable++
    if (this._deadlineUnreachable >= UNREACHABLE_BEFORE_MOVE) {
      const target = aqua?.selectNode?.('failover', {
        exclude: [node?.name],
        guildId: player.guildId
      })
      if (target && target !== node && target.isUsable) {
        if (aqua.debugTrace) {
          aqua._trace('player.voiceDeadline.move', {
            guildId: player.guildId,
            from: node?.name,
            to: target.name
          })
        }
        aqua.movePlayerToNode(player.guildId, target, 'node_unreachable').catch(
          (error) => {
            reportSuppressedError(player, 'player.voiceDeadline.move', error, {
              guildId: player.guildId
            })
            if (!player.destroyed) this.armVoiceDeadline()
          }
        )
        return
      }
    }
    this.armVoiceDeadline()
  }

  // A fresh join while any are left. False when they are used up.
  _rejoin(voiceChannel, code, reason) {
    const player = this.player
    if (this._rejoins >= MAX_REJOINS) return false
    this._rejoins++
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
  // `cause` says why aqualink ended it, apart from the close's own reason:
  // 'no_channel', 'disconnected', 'rejoins_exhausted' or 'voice_deadline'.
  _giveUp(cause, payload, error = null) {
    const player = this.player
    if (player.destroyed) return
    const closed = { ...payload, cause }
    if (error) {
      player.aqua?.emit?.(AqualinkEvents.ReconnectionFailed, player, {
        code: closed.code ?? null,
        error,
        fresh: true,
        payload: closed,
        reason: cause,
        retriesLeft: 0
      })
    }
    player.aqua?.emit?.(AqualinkEvents.SocketClosed, player, closed)
    player.destroy()
  }

  // A voice close is acted on only if it belongs to the socket of the
  // current voice attempt: one the node had accepted the credentials for
  // when the close arrived, with nothing new by the end of the grace. The
  // node replaces its socket on new credentials without reporting a close,
  // so a close after that PATCH is the current socket's. Before it, the
  // close is the previous socket's: Discord closes the old socket when the
  // bot is moved (a real 4014), and an adopt handover or this player's own
  // rejoin do the same. A move's 4014 can also arrive before the gateway's
  // voice update; the grace waits for that update to bump the generation.
  async socketClosed(_player, _track, payload) {
    const player = this.player
    if (player.destroyed) return
    const conn = player.connection
    const code = payload?.code
    const generation = conn?.generation
    const current = !!conn && conn._patchedGeneration === generation
    const grace = PlayerLifecycle.CLOSE_GRACE_MS

    // Not player._delay: destroy clears those timers, and this one has to
    // settle so the check below can see the player is gone.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, grace)
      timer.unref?.()
    })
    if (player.destroyed || !conn || player.connection !== conn) return

    let action
    if (!current || conn.generation !== generation) {
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
        patchedGeneration: conn._patchedGeneration,
        current,
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
    // The start time play() was given. player.position is the node's by
    // now: the playerUpdate that brings voice up overwrites it with 0.
    const startTime = player._deferredStartTime || 0
    player._deferredStartTime = 0
    player.position = startTime
    const updateData = {
      track: { encoded: player.current.track },
      paused: player.paused
    }
    if (player.current.userData)
      updateData.track.userData = player.current.userData
    if (startTime > 0) updateData.position = startTime
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
