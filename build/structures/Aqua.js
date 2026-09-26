const fs = require('node:fs')
const path = require('node:path')
const _readline = require('node:readline')
const { EventEmitter } = require('node:events')
const { AqualinkEvents } = require('./AqualinkEvents')
const AquaRecovery = require('./AquaRecovery')
const Node = require('./Node')
const Player = require('./Player')
const Track = require('./Track')
const { emitOperationalError, reportSuppressedError } = require('./Reporting')
const { version: pkgVersion } = require('../../package.json')

const SEARCH_PREFIX = ':'
// The URLs a node loads as they are. Everything else is searched.
const URL_QUERY_RE = /^(?:https?|ftts):\/\//i
const EMPTY_ARRAY = Object.freeze([])
const EMPTY_TRACKS_RESPONSE = Object.freeze({
  loadType: 'empty',
  exception: null,
  playlistInfo: null,
  pluginInfo: {},
  tracks: EMPTY_ARRAY
})

const MAX_CONCURRENT_OPS = 10
const BROKEN_PLAYER_TTL = 300000
const FAILOVER_CLEANUP_TTL = 600000
const PLAYER_BATCH_SIZE = 20
const RECONNECT_DELAY = 400
// Score weights. systemLoad is a 0-1 fraction of the whole machine on both
// Lavalink and NodeLink, so CPU_WEIGHT is the cost of a fully pegged host.
const CPU_WEIGHT = 100
const PROCESS_CPU_WEIGHT = 25
const PLAYER_WEIGHT = 0.75
// A player exists here as soon as it is created, but on the node only once
// its first PATCH lands, so the frame just before it may not count it yet.
const PENDING_GRACE_MS = 5000
const MEMORY_WEIGHT = 40
const MEMORY_PRESSURE_FROM = 0.9
const REST_WEIGHT = 0.05
// A node that has never sent stats is an unknown, not an idle one.
const NO_STATS_PENALTY = 50
// One point of priority costs about as much as ten players.
const PRIORITY_WEIGHT = 10

// Gates are what remove a node from selection; warns are informational.
// frameStats is deliberately absent, for the reason given in scoreNode.
const DEFAULT_NODE_HEALTH = Object.freeze({
  maxCpuLoad: 0.9,
  maxMemoryUsage: 0.95,
  warnCpuLoad: 0.75,
  warnMemoryUsage: 0.85
})
const NODE_TIMEOUT = 30000
const MAX_CACHE_SIZE = 20
const MAX_FAILOVER_QUEUE = 50
const MAX_REBUILD_LOCKS = 100
const WRITE_BUFFER_SIZE = 100
const TRACE_BUFFER_SIZE = 3000
// 0 = send as soon as the queue is reached, which is what every other client
// does. Discord's gateway limit is per shard and the host library already
// enforces it (discord.js, Seyfert and friends all bucket their sends), so
// pacing here is a second, cruder queue stacked on a correct one. Set it to a
// positive number only for a library that does not queue its own sends.
const DEFAULT_VOICE_STATE_INTERVAL = 0

const DEFAULT_OPTIONS = Object.freeze({
  shouldDeleteMessage: false,
  defaultSearchPlatform: 'ytsearch',
  leaveOnEnd: false,
  restVersion: 'v4',
  plugins: [],
  autoResume: true,
  infiniteReconnects: true,
  loadBalancer: 'leastLoad',
  nodeResolver: null,
  nodeHealth: null,
  useHttp2: false,
  debugTrace: false,
  traceMaxEntries: TRACE_BUFFER_SIZE,
  traceSink: null,
  autoRegionMigrate: false,
  failoverOptions: Object.freeze({
    enabled: true,
    maxRetries: 3,
    retryDelay: 1000,
    preservePosition: true,
    resumePlayback: true,
    cooldownTime: 5000,
    maxFailoverAttempts: 5
  }),
  maxQueueSave: 10,
  persistTracks: 'uri',
  maxTracksRestore: 20,
  trackResolveConcurrency: 4,
  restTimeout: 30000,
  // null = derive from the node's maxSockets (128 and 64 by default).
  restConcurrency: null,
  restSearchConcurrency: null,
  brokenPlayerStorePath: null,
  voiceStateInterval: DEFAULT_VOICE_STATE_INTERVAL
})

const _functions = {
  delay: (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, ms)
      t.unref?.()
    }),
  noop: () => {},
  makeTrack: (t, requester, node) => new Track(t, requester, node),
  safeCall(fn) {
    try {
      const result = fn()
      return result?.then ? result.catch(this.noop) : result
    } catch {}
  },
  parseRequester(str) {
    if (!str || typeof str !== 'string') return null
    const i = str.indexOf(':')
    return i > 0
      ? { id: str.substring(0, i), username: str.substring(i + 1) }
      : null
  },
  clamp01: (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0
  },
  unrefTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  }
}

class Aqua extends EventEmitter {
  constructor(client, nodes, options = {}) {
    super()
    if (!client) throw new Error('Client is required')
    if (!Array.isArray(nodes) || !nodes.length)
      throw new TypeError('Nodes must be non-empty Array')

    this.client = client
    this.nodes = nodes
    this.nodeMap = new Map()
    this.players = new Map()
    this.clientId = null
    this.initiated = false
    this.destroyed = false
    this.version = pkgVersion

    const merged = { ...DEFAULT_OPTIONS, ...options }
    this.options = merged
    this.failoverOptions = {
      ...DEFAULT_OPTIONS.failoverOptions,
      ...options.failoverOptions
    }

    this.shouldDeleteMessage = merged.shouldDeleteMessage
    this.defaultSearchPlatform = merged.defaultSearchPlatform
    this.leaveOnEnd = merged.leaveOnEnd
    this.restVersion = merged.restVersion || 'v4'
    this.plugins = merged.plugins
    this.autoResume = merged.autoResume
    this.infiniteReconnects = merged.infiniteReconnects
    this.urlFilteringEnabled = merged.urlFilteringEnabled
    this.restrictedDomains = merged.restrictedDomains || []
    this.allowedDomains = merged.allowedDomains || []
    this._loadBalancer = merged.loadBalancer
    this.nodeResolver =
      typeof merged.nodeResolver === 'function' ? merged.nodeResolver : null
    this.nodeHealth = { ...DEFAULT_NODE_HEALTH, ...(merged.nodeHealth || {}) }
    this.excludedNodes = new Set()
    this.autoRegionMigrate = merged.autoRegionMigrate
    this.useHttp2 = merged.useHttp2
    this.maxQueueSave = merged.maxQueueSave
    this.persistTracks = merged.persistTracks
    this.maxTracksRestore = merged.maxTracksRestore
    this.trackResolveConcurrency = Math.max(
      1,
      Number(merged.trackResolveConcurrency) || 4
    )
    // Pacing is global rather than per guild, so any positive value costs N
    // intervals to move N guilds. See DEFAULT_VOICE_STATE_INTERVAL.
    this.voiceStateInterval =
      Number.isFinite(merged.voiceStateInterval) &&
      merged.voiceStateInterval >= 0
        ? merged.voiceStateInterval
        : DEFAULT_VOICE_STATE_INTERVAL
    this.brokenPlayerStorePath =
      typeof merged.brokenPlayerStorePath === 'string' &&
      merged.brokenPlayerStorePath.trim()
        ? merged.brokenPlayerStorePath
        : path.join(process.cwd(), `AquaBrokenPlayers.${process.pid}.jsonl`)
    this.send = merged.send || this._createDefaultSend()
    this.debugTrace = !!merged.debugTrace
    this.traceMaxEntries = Math.max(
      100,
      Number(merged.traceMaxEntries) || TRACE_BUFFER_SIZE
    )
    this.traceSink =
      typeof merged.traceSink === 'function' ? merged.traceSink : null
    this._traceBuffer = this.debugTrace ? new Array(this.traceMaxEntries) : null
    this._traceBufferCount = 0
    this._traceBufferIndex = 0
    this._traceSeq = 0

    this._failoverState = Object.create(null)
    this._guildLifecycleLocks = new Map()
    this._brokenPlayers = new Map()
    this._rebuildLocks = new Set()
    this._selectionEpoch = 0
    this._nodeLoadCache = new Map()
    this._playerJoinedAt = new WeakMap()
    this._eventHandlers = null
    this._loading = false
    this._voiceStateQueue = []
    this._voiceStateQueueHead = 0
    this._voiceStateQueued = new Set()
    this._voiceStatePending = new Map()
    this._voiceStateFlushTimer = null
    this._lastVoiceStateSendAt = 0
    this._voiceStateWaiters = new Map()
    this._voiceStateDrainWaiters = []
    this._recovery = new AquaRecovery(this, {
      _functions,
      MAX_CONCURRENT_OPS,
      BROKEN_PLAYER_TTL,
      FAILOVER_CLEANUP_TTL,
      MAX_FAILOVER_QUEUE,
      MAX_REBUILD_LOCKS,
      PLAYER_BATCH_SIZE,
      RECONNECT_DELAY,
      NODE_TIMEOUT,
      EMPTY_ARRAY
    })

    if (this.autoResume) this._bindEventHandlers()
  }

  _trace(event, data = null) {
    if (!this.debugTrace) return
    if (
      !this._traceBuffer ||
      this._traceBuffer.length !== this.traceMaxEntries
    ) {
      this._traceBuffer = new Array(this.traceMaxEntries)
      this._traceBufferCount = 0
      this._traceBufferIndex = 0
    }
    const resolvedData = typeof data === 'function' ? data() : data
    const entry = {
      seq: ++this._traceSeq,
      at: Date.now(),
      event,
      data: resolvedData
    }
    this._traceBuffer[this._traceBufferIndex] = entry
    this._traceBufferIndex = (this._traceBufferIndex + 1) % this.traceMaxEntries
    if (this._traceBufferCount < this.traceMaxEntries) this._traceBufferCount++
    if (this.traceSink) _functions.safeCall(() => this.traceSink(entry))
    if (this.listenerCount(AqualinkEvents.Debug) > 0) {
      this.emit(AqualinkEvents.Debug, 'trace', JSON.stringify(entry))
    }
  }

  getTrace(limit = 300) {
    const max = Math.max(1, Number(limit) || 300)
    if (!this._traceBuffer) return []
    const count = Math.min(max, this._traceBufferCount)
    if (!count) return []
    const out = new Array(count)
    let start =
      (this._traceBufferIndex - count + this.traceMaxEntries) %
      this.traceMaxEntries
    for (let i = 0; i < count; i++) {
      out[i] = this._traceBuffer[start]
      start = (start + 1) % this.traceMaxEntries
    }
    return out
  }

  clearTrace() {
    if (this._traceBuffer) this._traceBuffer.fill(undefined)
    this._traceBufferCount = 0
    this._traceBufferIndex = 0
  }

  _createDefaultSend() {
    return (packet) => {
      const guildId = packet?.d?.guild_id
      if (!guildId) return
      const guild =
        this.client.guilds?.cache?.get?.(guildId) ||
        this.client.cache?.guilds?.get?.(guildId)
      if (!guild) return
      const gateway = this.client.gateway
      if (gateway?.send) gateway.send(gateway.calculateShardId(guildId), packet)
      else if (guild.shard?.send) guild.shard.send(packet)
    }
  }

  queueVoiceStateUpdate(data) {
    const guildId = data?.guild_id ? String(data.guild_id) : null
    if (!guildId) return false

    const isLeave = data.channel_id === null || data.channel_id === undefined
    let slot = this._voiceStatePending.get(guildId)
    if (!slot) {
      slot = { leave: null, join: null }
      this._voiceStatePending.set(guildId, slot)
    }

    if (isLeave) {
      // "join then leave" nets out to "not in the channel", and the join was
      // never seen by Discord, so the leave replaces it.
      slot.join = null
      slot.leave = data
    } else {
      // A join must never replace a pending leave. The player that leave
      // belongs to is already gone, and dropping it strands the bot in the
      // channel; the two are sent one interval apart instead.
      slot.join = data
    }

    if (!this._voiceStateQueued.has(guildId)) {
      this._voiceStateQueued.add(guildId)
      this._voiceStateQueue.push(guildId)
    }

    if (this.debugTrace) {
      this._trace('voice.queue.enqueue', {
        guildId,
        kind: isLeave ? 'leave' : 'join',
        size: this._voiceStateQueued.size
      })
    }
    this._scheduleVoiceStateFlush()
    return true
  }

  flushVoiceState(guildId = null) {
    if (guildId != null) {
      const id = String(guildId)
      if (!this._voiceStatePending.has(id)) return Promise.resolve()
      return new Promise((resolve) => {
        const waiters = this._voiceStateWaiters.get(id)
        if (waiters) waiters.push(resolve)
        else this._voiceStateWaiters.set(id, [resolve])
        this._scheduleVoiceStateFlush()
      })
    }

    if (!this._voiceStateQueued.size) return Promise.resolve()
    return new Promise((resolve) => {
      this._voiceStateDrainWaiters.push(resolve)
      this._scheduleVoiceStateFlush()
    })
  }

  getVoiceStateQueueDelay(guildId) {
    const target = guildId ? String(guildId) : ''
    if (!target || !this._voiceStateQueued.has(target)) return 0

    let packets = 0
    const seen = new Set()
    for (
      let index = this._voiceStateQueueHead;
      index < this._voiceStateQueue.length;
      index++
    ) {
      const queuedGuildId = this._voiceStateQueue[index]
      if (
        !queuedGuildId ||
        seen.has(queuedGuildId) ||
        !this._voiceStateQueued.has(queuedGuildId)
      ) {
        continue
      }
      seen.add(queuedGuildId)
      packets += this._voiceStatePacketCount(queuedGuildId)
      if (queuedGuildId === target) {
        return packets * this.voiceStateInterval
      }
    }

    return this._voiceStateQueued.size * this.voiceStateInterval
  }

  _voiceStatePacketCount(guildId) {
    const slot = this._voiceStatePending.get(guildId)
    if (!slot) return 0
    return (slot.leave ? 1 : 0) + (slot.join ? 1 : 0)
  }

  _scheduleVoiceStateFlush(delay = 0) {
    if (this._voiceStateFlushTimer) {
      this._applyVoiceStateTimerRef()
      return
    }
    this._voiceStateFlushTimer = setTimeout(
      () => {
        this._voiceStateFlushTimer = null
        this._flushVoiceStateQueue()
      },
      Math.max(0, delay)
    )
    this._applyVoiceStateTimerRef()
  }

  _applyVoiceStateTimerRef() {
    const timer = this._voiceStateFlushTimer
    if (!timer) return
    // An idle queue must never hold the process open, but a caller awaiting
    // flushVoiceState() must: otherwise a shutdown exits before its own
    // leaves reach the gateway.
    if (this._voiceStateDrainWaiters.length || this._voiceStateWaiters.size) {
      timer.ref?.()
    } else {
      timer.unref?.()
    }
  }

  _resolveVoiceStateWaiters(guildId) {
    const waiters = this._voiceStateWaiters.get(guildId)
    if (!waiters) return
    this._voiceStateWaiters.delete(guildId)
    for (const resolve of waiters) _functions.safeCall(resolve)
  }

  _resolveVoiceStateDrain() {
    if (this._voiceStateDrainWaiters.length) {
      const waiters = this._voiceStateDrainWaiters
      this._voiceStateDrainWaiters = []
      for (const resolve of waiters) _functions.safeCall(resolve)
    }
    // Nothing is queued any more, so a per-guild waiter can never be
    // satisfied later. Settle them rather than leaving a caller hanging.
    if (this._voiceStateWaiters.size) {
      const pending = Array.from(this._voiceStateWaiters.values())
      this._voiceStateWaiters.clear()
      for (const waiters of pending) {
        for (const resolve of waiters) _functions.safeCall(resolve)
      }
    }
  }

  _flushVoiceStateQueue() {
    if (!this._voiceStateQueued.size) {
      this._resolveVoiceStateDrain()
      return
    }

    const now = Date.now()
    const waitFor = this.voiceStateInterval - (now - this._lastVoiceStateSendAt)
    if (waitFor > 0) {
      this._scheduleVoiceStateFlush(waitFor)
      return
    }

    let guildId = null
    while (this._voiceStateQueueHead < this._voiceStateQueue.length) {
      const candidate = this._voiceStateQueue[this._voiceStateQueueHead]
      this._voiceStateQueue[this._voiceStateQueueHead] = undefined
      this._voiceStateQueueHead++
      if (candidate && this._voiceStateQueued.has(candidate)) {
        guildId = candidate
        this._voiceStateQueued.delete(candidate)
        break
      }
    }

    if (
      this._voiceStateQueueHead > 1024 ||
      this._voiceStateQueueHead > this._voiceStateQueue.length / 2
    ) {
      this._voiceStateQueue = this._voiceStateQueue.slice(
        this._voiceStateQueueHead
      )
      this._voiceStateQueueHead = 0
    }

    const slot = guildId ? this._voiceStatePending.get(guildId) : null
    let data = null
    if (slot) {
      if (slot.leave) {
        data = slot.leave
        slot.leave = null
      } else if (slot.join) {
        data = slot.join
        slot.join = null
      }
    }

    // A guild whose join is still waiting goes to the back of the queue, so
    // the leave it follows is a full interval ahead of it.
    const stillPending = !!(slot && (slot.leave || slot.join))
    if (guildId) {
      if (stillPending) {
        this._voiceStateQueued.add(guildId)
        this._voiceStateQueue.push(guildId)
      } else {
        this._voiceStatePending.delete(guildId)
      }
    }

    if (data) {
      this._lastVoiceStateSendAt = now
      if (this.debugTrace) {
        this._trace('voice.queue.send', {
          guildId,
          channelId: data.channel_id ?? null,
          remaining: this._voiceStateQueued.size
        })
      }
      _functions.safeCall(() => this.send({ op: 4, d: data }))
    }

    if (guildId && !stillPending) this._resolveVoiceStateWaiters(guildId)

    if (this._voiceStateQueued.size) {
      this._scheduleVoiceStateFlush(this.voiceStateInterval)
    } else {
      this._resolveVoiceStateDrain()
    }
  }

  _bindEventHandlers() {
    this._eventHandlers = {
      onNodeConnect: (node) => {
        if (this.debugTrace)
          this._trace('node.connect', { node: node?.name || node?.host })
        this._invalidateCache()
        this._performCleanup()
      },
      onNodeDisconnect: (node) => {
        if (this.debugTrace)
          this._trace('node.disconnect', { node: node?.name || node?.host })
        this._invalidateCache()
        queueMicrotask(() => {
          this._storeBrokenPlayers(node).catch((error) =>
            reportSuppressedError(
              this,
              'aqua.nodeDisconnect.storeBrokenPlayers',
              error,
              {
                node: node?.name || node?.host
              }
            )
          )
          this._performCleanup()
        })
      },
      onNodeReady: (node, { resumed }) => {
        if (this.debugTrace) {
          this._trace('node.ready', {
            node: node?.name || node?.host,
            resumed: !!resumed,
            players: this.players.size
          })
        }
        if (resumed) {
          const batch = []
          for (const player of this.players.values()) {
            if (player.nodes === node && player.connection) batch.push(player)
          }
          if (batch.length)
            queueMicrotask(() =>
              batch.forEach((p) => {
                p.connection.resendVoiceUpdate()
              })
            )
          return
        }
        queueMicrotask(() => {
          this._rebuildBrokenPlayers(node).catch((error) =>
            reportSuppressedError(
              this,
              'aqua.nodeReady.rebuildBrokenPlayers',
              error,
              {
                node: node?.name || node?.host
              }
            )
          )
        })
      }
    }
    this.on(AqualinkEvents.NodeConnect, this._eventHandlers.onNodeConnect)
    this.on(AqualinkEvents.NodeDisconnect, this._eventHandlers.onNodeDisconnect)
    this.on(AqualinkEvents.NodeReady, this._eventHandlers.onNodeReady)
  }

  destroy() {
    if (this._eventHandlers) {
      this.off(AqualinkEvents.NodeConnect, this._eventHandlers.onNodeConnect)
      this.off(
        AqualinkEvents.NodeDisconnect,
        this._eventHandlers.onNodeDisconnect
      )
      this.off(AqualinkEvents.NodeReady, this._eventHandlers.onNodeReady)
      this._eventHandlers = null
    }
    this.removeAllListeners()
    this.destroyed = true

    for (const id of Array.from(this.nodeMap.keys())) this._destroyNode(id)
    for (const player of Array.from(this.players.values()))
      _functions.safeCall(() => player.destroy())

    // The leaves those destroys just queued are the last thing this instance
    // owes Discord, so the queue is drained rather than cleared. Clearing it
    // first, as this used to, dropped every one of them.
    this._scheduleVoiceStateFlush()

    this.players.clear()
    this._failoverState = Object.create(null)
    this._guildLifecycleLocks.clear()
    this._brokenPlayers.clear()
    this._rebuildLocks.clear()
    this._nodeLoadCache.clear()
    this._invalidateCache()
    _functions.safeCall(() => this._recovery?.dispose?.())
    this._recovery = null
  }

  get loadBalancer() {
    return this._loadBalancer
  }

  set loadBalancer(value) {
    if (value === this._loadBalancer) return
    this._loadBalancer = value
    this._invalidateCache()
  }

  get leastUsedNodes() {
    return this._resolveNodes({
      reason: 'order',
      want: 'many',
      candidates: this._usableNodes(),
      region: null,
      guildId: null
    })
  }

  selectNode(reason = 'player', context = null) {
    const base = context?.candidates || this._usableNodes()
    return this._resolveNodes({
      reason,
      want: 'one',
      candidates: this._applyExclusions(base, context?.exclude),
      region: context?.region || null,
      guildId: context?.guildId || null
    })
  }

  excludeNode(identifier) {
    const id = typeof identifier === 'string' ? identifier : identifier?.name
    if (!id) return false
    this.excludedNodes.add(id)
    this._invalidateCache()
    return true
  }

  includeNode(identifier) {
    const id = typeof identifier === 'string' ? identifier : identifier?.name
    if (!id || !this.excludedNodes.delete(id)) return false
    this._invalidateCache()
    return true
  }

  async ejectNode(identifier, options = {}) {
    const id = typeof identifier === 'string' ? identifier : identifier?.name
    const node = this.nodeMap.get(id)
    if (!node) throw new Error(`Node not found: ${id}`)

    // Excluded first, so a player moved off it cannot be placed straight back
    // by a selection running between two moves.
    if (options.exclude !== false) this.excludeNode(id)

    const players = Array.from(node.players || [])
    const reason = options.reason || 'eject'
    let moved = 0
    let failed = 0

    for (const player of players) {
      const target = this.selectNode('failover', {
        exclude: [id],
        guildId: player.guildId
      })
      if (!target || target === node) {
        failed++
        continue
      }
      try {
        await this.movePlayerToNode(player.guildId, target, reason)
        moved++
      } catch (error) {
        failed++
        reportSuppressedError(this, 'aqua.ejectNode', error, {
          guildId: player.guildId,
          node: id
        })
      }
    }

    return { node: id, total: players.length, moved, failed }
  }

  _usableNodes() {
    const usable = []
    for (const n of this.nodeMap.values()) {
      if (n.isUsable) usable.push(n)
    }
    // Exclusions are applied here rather than only at selection, so a caller
    // reading leastUsedNodes[0] cannot route around them.
    return this._applyExclusions(usable, null)
  }

  /**
   * Exclusions are a preference, not a guarantee: if honouring them would
   * leave nothing to choose from, they are ignored rather than failing the
   * call.
   */
  _applyExclusions(nodes, exclude) {
    let filtered = nodes
    if (!filtered.length) return filtered

    if (this.excludedNodes.size) {
      const kept = filtered.filter((n) => !this.excludedNodes.has(n.name))
      if (kept.length) filtered = kept
    }

    if (exclude?.length) {
      const set = new Set(exclude.map((e) => (typeof e === 'string' ? e : e?.name)))
      const kept = filtered.filter((n) => !set.has(n.name))
      if (kept.length) filtered = kept
    }

    return filtered
  }

  getNodeHealth(node) {
    if (!node) return null
    const limits = this.nodeHealth
    const stats = node.stats
    const reasons = []

    if (!stats || !node.statsUpdatedAt) {
      // Never reported. Deliberately not 'critical': a node that has only
      // just connected has no stats yet, and gating it out would idle it
      // until its first frame -- 30s on NodeLink.
      return {
        status: 'unknown',
        score: this.scoreNode(node),
        cpuLoad: null,
        processLoad: null,
        memoryUsage: null,
        players: node.players?.size || 0,
        playingPlayers: 0,
        ping: 0,
        statsAge: null,
        reasons: ['no stats received yet']
      }
    }

    const cpu = stats.cpu
    const cpuLoad = _functions.clamp01(cpu?.systemLoad)
    const processLoad = _functions.clamp01(cpu?.nodelinkLoad ?? cpu?.lavalinkLoad)
    const reservable = stats.memory?.reservable || 0
    const memoryUsage = reservable > 0 ? stats.memory.used / reservable : null

    let status = 'healthy'
    if (cpuLoad > limits.maxCpuLoad) {
      status = 'critical'
      reasons.push(`cpu ${(cpuLoad * 100).toFixed(0)}%`)
    } else if (cpuLoad > limits.warnCpuLoad) {
      status = 'degraded'
      reasons.push(`cpu ${(cpuLoad * 100).toFixed(0)}%`)
    }

    if (memoryUsage !== null) {
      if (memoryUsage > limits.maxMemoryUsage) {
        status = 'critical'
        reasons.push(`memory ${(memoryUsage * 100).toFixed(0)}%`)
      } else if (memoryUsage > limits.warnMemoryUsage && status !== 'critical') {
        status = 'degraded'
        reasons.push(`memory ${(memoryUsage * 100).toFixed(0)}%`)
      }
    }

    return {
      status,
      score: this.scoreNode(node),
      cpuLoad,
      processLoad,
      memoryUsage,
      players: stats.players || 0,
      playingPlayers: stats.playingPlayers || 0,
      ping: stats.ping || 0,
      statsAge: Date.now() - node.statsUpdatedAt,
      reasons
    }
  }

  _resolveNodes(ctx) {
    // Only when picking one. The ordered list still shows every usable node,
    // with an unhealthy one sorted to the bottom by its score.
    if (ctx.want === 'one' && ctx.candidates.length > 1) {
      const healthy = ctx.candidates.filter(
        (n) => this.getNodeHealth(n)?.status !== 'critical'
      )
      // All of them being unhealthy means the pool is in trouble, not that
      // there is nothing to pick.
      if (healthy.length) ctx = { ...ctx, candidates: healthy }
    }

    if (this.nodeResolver) {
      const api = {
        score: (node) => this.scoreNode(node),
        sort: (nodes) => this._sortNodes(nodes || ctx.candidates),
        best: (nodes) => this._bestNode(nodes || ctx.candidates)
      }
      let result = null
      try {
        result = this.nodeResolver(ctx, api)
      } catch (error) {
        reportSuppressedError(this, 'aqua.nodeResolver', error, {
          reason: ctx.reason,
          guildId: ctx.guildId
        })
      }
      // Nullish means "use the built-in result", so a resolver can opt out
      // per reason without reimplementing the balancer.
      if (result) {
        if (Array.isArray(result)) {
          return ctx.want === 'one'
            ? result[0] || null
            : Object.freeze(result.slice())
        }
        return ctx.want === 'one' ? result : Object.freeze([result])
      }
    }

    return ctx.want === 'one'
      ? this._bestNode(ctx.candidates)
      : this._sortNodes(ctx.candidates)
  }

  _sortNodes(nodes) {
    const list = Array.isArray(nodes) ? nodes.slice() : []
    if (list.length < 2) return Object.freeze(list)

    if (this._loadBalancer === 'random') {
      // A real shuffle, computed per call. The old comparator was biased and
      // its result was then frozen for 12s, so every player in the window
      // went to the same node.
      for (let i = list.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0
        const t = list[i]
        list[i] = list[j]
        list[j] = t
      }
      return Object.freeze(list)
    }

    if (this._loadBalancer === 'leastRest') {
      list.sort((a, b) => (a.rest?.calls || 0) - (b.rest?.calls || 0))
      return Object.freeze(list)
    }

    const scored = list.map((n) => ({ node: n, score: this.scoreNode(n) }))
    scored.sort((a, b) => a.score - b.score)
    return Object.freeze(scored.map((x) => x.node))
  }

  _bestNode(nodes) {
    if (!nodes?.length) return null
    if (nodes.length === 1) return nodes[0]

    if (this._loadBalancer === 'random') {
      return nodes[(Math.random() * nodes.length) | 0]
    }

    const scoreOf =
      this._loadBalancer === 'leastRest'
        ? (n) => n.rest?.calls || 0
        : (n) => this.scoreNode(n)

    let best = nodes[0]
    let bestScore = scoreOf(best)
    for (let i = 1; i < nodes.length; i++) {
      const score = scoreOf(nodes[i])
      if (score < bestScore) {
        best = nodes[i]
        bestScore = score
      }
    }
    return best
  }

  _chooseLeastBusyNode(nodes) {
    return this._bestNode(nodes)
  }

  _invalidateCache() {
    this._selectionEpoch++
    if (this._nodeLoadCache.size) this._nodeLoadCache.clear()
  }

  /**
   * Lower is better. `extraPlayers` accounts for players a caller is about to
   * place but has not placed yet, so a batch does not all land on one node.
   */
  scoreNode(node, options = null) {
    if (!node) return Number.POSITIVE_INFINITY

    const extraPlayers = options?.extraPlayers || 0
    const id = node.name || node.host
    if (!extraPlayers) {
      const cached = this._nodeLoadCache.get(id)
      if (cached && cached.epoch === this._selectionEpoch) return cached.load
    }

    const stats = node.stats
    // Players created since the last stats frame are invisible to the node's
    // own counters, so every new player used to land on the same node.
    const pending = this._pendingPlayers(node)
    const players =
      ((stats?.playingPlayers || 0) + pending + extraPlayers) * PLAYER_WEIGHT

    let load
    if (!stats || !node.statsUpdatedAt) {
      // Scoring this 0, as it used to, made a node that has never reported --
      // including one that was just destroyed -- the most attractive in the
      // pool.
      load = NO_STATS_PENALTY + players
    } else {
      const cpu = stats.cpu
      // Not divided by cores: both servers already report systemLoad as a
      // 0-1 fraction of the whole machine.
      const systemLoad = _functions.clamp01(cpu?.systemLoad)
      // NodeLink reports 0 outside worker mode, so this can only add.
      const processLoad = _functions.clamp01(
        cpu?.nodelinkLoad ?? cpu?.lavalinkLoad
      )
      load =
        systemLoad * CPU_WEIGHT + processLoad * PROCESS_CPU_WEIGHT + players

      // Heap against total RAM on NodeLink, JVM heap against max heap on
      // Lavalink: not comparable between node types, so memory is only a
      // guard against a node that is genuinely running out.
      const memory = stats.memory
      const reservable = memory?.reservable || 0
      if (reservable > 0) {
        const used = memory.used / reservable
        if (used > MEMORY_PRESSURE_FROM) {
          load +=
            ((used - MEMORY_PRESSURE_FROM) / (1 - MEMORY_PRESSURE_FROM)) *
            MEMORY_WEIGHT
        }
      }

      // Live in-flight REST depth. A tiebreaker, not a statement about the
      // node's health.
      load += (node.rest?.calls || 0) * REST_WEIGHT

      // frameStats is deliberately not read. NodeLink's counters are
      // cumulative since the current audio stream started and reset on every
      // track change, and its deficit is always equal to nulled, so they are
      // not comparable with Lavalink's per-minute window.
    }

    // Operator preference, applied either way: a node with no stats should
    // still be deprioritised if it was configured that way.
    load += (Number(node.priority) || 0) * PRIORITY_WEIGHT

    if (!extraPlayers) {
      if (this._nodeLoadCache.size >= MAX_CACHE_SIZE) {
        this._nodeLoadCache.delete(this._nodeLoadCache.keys().next().value)
      }
      this._nodeLoadCache.set(id, { load, epoch: this._selectionEpoch })
    }
    return load
  }

  /**
   * This client's players on `node` that its last stats frame did not count.
   * Not `players.size - stats.players`: NodeLink sums `players` over every
   * session on the node, so with other clients on it that is always 0.
   */
  _pendingPlayers(node) {
    const players = node.players
    if (!players?.size) return 0
    if (!node.statsUpdatedAt) return players.size
    const since = node.statsUpdatedAt - PENDING_GRACE_MS
    let pending = 0
    for (const player of players) {
      if ((this._playerJoinedAt.get(player) || 0) > since) pending++
    }
    return pending
  }

  _getNodeLoad(node) {
    return this.scoreNode(node)
  }

  async init(clientId) {
    if (clientId) {
      const newId = String(clientId)
      if (this.clientId !== newId) {
        this.clientId = newId
      }
    }

    if (this.initiated) return this
    if (!this.clientId) return this
    await this._loadNodeSessions().catch((error) =>
      reportSuppressedError(this, 'aqua.init.loadNodeSessions', error)
    )
    const results = await Promise.allSettled(
      this.nodes.map((n) =>
        Promise.race([
          this._createNode(n),
          _functions.delay(NODE_TIMEOUT).then(() => {
            throw new Error('Timeout')
          })
        ])
      )
    )
    if (!results.some((r) => r.status === 'fulfilled'))
      throw new Error('No nodes connected')
    if (this.plugins?.length) {
      await Promise.allSettled(
        this.plugins.map((p) => _functions.safeCall(() => p.load(this)))
      )
    }
    this.initiated = true
    return this
  }

  async _createNode(options) {
    const id = options.name || options.host
    this._destroyNode(id)
    const node = new Node(this, options, this.options)
    node.players = new Set()
    this.nodeMap.set(id, node)
    this._failoverState[id] = {
      connected: false,
      failoverInProgress: false,
      attempts: 0,
      lastAttempt: 0
    }
    await node.connect()
    this._failoverState[id].connected = true
    this._failoverState[id].failoverInProgress = false
    this._invalidateCache()
    this.emit(AqualinkEvents.NodeCreate, node)
    return node
  }

  _destroyNode(id) {
    const node = this.nodeMap.get(id)
    if (!node) return
    _functions.safeCall(() => node.destroy(true))
    this._cleanupNode(id)
  }

  _cleanupNode(id) {
    const node = this.nodeMap.get(id)
    if (node) {
      _functions.safeCall(() => node.removeAllListeners())
      _functions.safeCall(() => node.players.clear())
      this.nodeMap.delete(id)
    }
    delete this._failoverState[id]
    this._nodeLoadCache.delete(id)
    this._invalidateCache()
  }

  _storeBrokenPlayers(node) {
    return this._recovery.storeBrokenPlayers(node)
  }

  async _rebuildBrokenPlayers(node) {
    return this._recovery.rebuildBrokenPlayers(node)
  }

  async _rebuildPlayer(state, targetNode) {
    return this._recovery.rebuildPlayer(state, targetNode)
  }

  async handleNodeFailover(failedNode) {
    return this._recovery.handleNodeFailover(failedNode)
  }

  async _migratePlayersOptimized(players, nodes) {
    return this._recovery.migratePlayersOptimized(players, nodes)
  }

  async _migratePlayer(player, pickNode) {
    return this._recovery.migratePlayer(player, pickNode)
  }

  _regionMatches(configuredRegion, extractedRegion) {
    return this._recovery.regionMatches(configuredRegion, extractedRegion)
  }

  _findBestNodeForRegion(region) {
    return this._recovery.findBestNodeForRegion(region)
  }

  async movePlayerToNode(guildId, targetNode, reason = 'region', options = {}) {
    return this._recovery.movePlayerToNode(guildId, targetNode, reason, options)
  }

  async rebuildPlayer(guildId, options = {}) {
    return this._recovery.rebuildPlayerInPlace(guildId, options)
  }

  _capturePlayerState(player) {
    return this._recovery.capturePlayerState(player)
  }

  _createPlayerOnNode(targetNode, state) {
    return this._recovery.createPlayerOnNode(targetNode, state)
  }

  _seekAfterTrackStart(player, guildId, position, delay = 50) {
    return this._recovery.seekAfterTrackStart(player, guildId, position, delay)
  }

  async _restorePlayerState(newPlayer, state) {
    return this._recovery.restorePlayerState(newPlayer, state)
  }

  updateVoiceState({ d, t }) {
    if (
      !d?.guild_id ||
      (t !== 'VOICE_STATE_UPDATE' && t !== 'VOICE_SERVER_UPDATE')
    )
      return
    const player = this.players.get(String(d.guild_id))
    if (!player) return
    if (this.debugTrace) {
      this._trace('voice.gateway', {
        guildId: String(d.guild_id),
        type: t,
        hasSessionId: !!d.session_id,
        hasEndpoint: !!d.endpoint,
        hasChannelId: d.channel_id !== undefined
      })
    }

    d.txId = player.txId
    if (t === 'VOICE_STATE_UPDATE') {
      if (d.user_id !== this.clientId) return
      if (player.connection) {
        if (!d.channel_id && player.connection.voiceChannel) {
          player.connection.setStateUpdate(d)
        } else {
          player.connection.sessionId = d.session_id
          player.connection.setStateUpdate(d)
        }
      }
    } else {
      player.connection?.setServerUpdate(d)
    }
  }

  fetchRegion(region) {
    const usable = this._usableNodes()
    if (!region) return this._sortNodes(usable)

    const lower = String(region).toLowerCase()
    const matched = usable.filter((n) => n.regions?.includes(lower))
    // A region no node carries used to come back empty, which made
    // createConnection throw rather than use any node at all.
    return this._resolveNodes({
      reason: 'region',
      want: 'many',
      candidates: matched.length ? matched : usable,
      region: lower,
      guildId: null
    })
  }

  createConnection(options) {
    if (!this.initiated) throw new Error('Aqua not initialized')
    const existing = this.players.get(String(options.guildId))
    if (existing && !existing.destroyed) {
      if (
        options.voiceChannel &&
        existing.voiceChannel !== options.voiceChannel
      ) {
        _functions.safeCall(() => existing.connect(options))
      }
      return existing
    }
    const usable = this._usableNodes()
    if (!usable.length) throw new Error('No nodes available')

    const region = options.region ? String(options.region).toLowerCase() : null
    const matched = region
      ? usable.filter((n) => n.regions?.includes(region))
      : usable
    const node = this._resolveNodes({
      reason: 'player',
      want: 'one',
      candidates: matched.length ? matched : usable,
      region,
      guildId: String(options.guildId)
    })
    if (!node) throw new Error('No nodes available')
    return this.createPlayer(node, options)
  }

  createPlayer(node, options) {
    const guildId = String(options.guildId)
    const existing = this.players.get(guildId)
    if (existing) {
      _functions.safeCall(() =>
        existing.destroy({
          preserveMessage:
            options.preserveMessage || !!options.resuming || false,
          preserveTracks: !!options.resuming || false
        })
      )
    }
    const player = new Player(this, node, options)
    this.players.set(guildId, player)
    if (this.debugTrace) {
      this._trace('player.create', {
        guildId,
        node: node?.name || node?.host,
        voiceChannel: options.voiceChannel,
        textChannel: options.textChannel,
        resuming: !!options.resuming
      })
    }
    node?.players?.add?.(player)
    this._playerJoinedAt.set(player, Date.now())
    this._invalidateCache()
    player.once('destroy', () => this._handlePlayerDestroy(player))
    player.connect(options)
    this.emit(AqualinkEvents.PlayerCreate, player)
    return player
  }

  _handlePlayerDestroy(player) {
    player.nodes?.players?.delete?.(player)
    this._invalidateCache()
    const guildId = String(player.guildId)
    if (this.players.get(guildId) === player) this.players.delete(guildId)
    if (this.debugTrace) {
      this._trace('player.destroyed', {
        guildId,
        node: player?.nodes?.name || player?.nodes?.host
      })
    }
    this.emit(AqualinkEvents.PlayerDestroyed, player)
  }

  async destroyPlayer(guildId) {
    const id = String(guildId)
    const player = this.players.get(id)
    if (!player) return

    // Guard against recursive destroy calls triggered by Player.destroy().
    this.players.delete(id)
    await _functions.safeCall(() => player.destroy())

    // Fallback cleanup in case the player "destroy" listener was not attached.
    if (player?.nodes?.players?.has?.(player)) this._handlePlayerDestroy(player)
  }

  // Whether resolve sends the query as it is without raw: only a URL is.
  // Static so a host can key a cache on it without an instance.
  static isRawQuery(query) {
    return typeof query === 'string' && URL_QUERY_RE.test(query.trim())
  }

  isRawQuery(query) {
    return Aqua.isRawQuery(query)
  }

  // The identifier resolve sends without raw. Text is searched even when it
  // has a colon: NodeLink would read "Queen:" in "Queen: Bohemian Rhapsody"
  // as a source name and fail.
  formatQuery(query, source) {
    const q = typeof query === 'string' ? query.trim() : query
    if (Aqua.isRawQuery(q)) return q
    return `${source || this.defaultSearchPlatform}${SEARCH_PREFIX}${q}`
  }

  async resolve({ query, source, requester, nodes, signal, timeout, raw }) {
    if (!this.initiated) throw new Error('Aqua not initialized')
    const node = this._getRequestNode(nodes)
    if (!node) throw new Error('No nodes available')
    // raw is for a complete identifier, like sprec:... or a file path.
    const formatted = raw ? query : this.formatQuery(query, source)
    try {
      const response = await node.rest.loadTracks(formatted, {
        signal,
        timeout
      })
      if (
        !response ||
        response.loadType === 'empty' ||
        response.loadType === 'NO_MATCHES'
      )
        return EMPTY_TRACKS_RESPONSE
      return this._constructResponse(response, requester, node)
    } catch (error) {
      // Reachable now that Rest honours a signal; it never was before.
      if (error?.name === 'AbortError') throw error
      const err = new Error(`Resolve failed: ${error?.message || error}`)
      if (error?.statusCode != null) err.statusCode = error.statusCode
      if (error?.body) err.body = error.body
      if (error?.url) err.url = error.url
      err.cause = error
      throw err
    }
  }

  _getRequestNode(nodes) {
    let candidates = null

    if (nodes) {
      if (nodes instanceof Node) {
        // An explicit node used to be returned even when it was unusable,
        // which turned one dead node into a failed search.
        if (nodes.isUsable) return nodes
      } else if (Array.isArray(nodes)) {
        const filtered = nodes.filter((n) => n?.isUsable)
        if (filtered.length) candidates = filtered
      } else if (typeof nodes === 'string') {
        const node = this.nodeMap.get(nodes)
        if (node?.isUsable) return node
      } else {
        throw new TypeError(`Invalid nodes: ${typeof nodes}`)
      }
    }

    return this.selectNode('rest', { candidates })
  }

  _constructResponse(response, requester, node) {
    const { loadType, data, pluginInfo: rootPlugin } = response || {}
    const base = {
      loadType,
      exception: null,
      playlistInfo: null,
      pluginInfo: rootPlugin || {},
      tracks: []
    }
    if (loadType === 'error' || loadType === 'LOAD_FAILED') {
      base.exception = data || response.exception || null
      return base
    }
    if (loadType === 'track' && data) {
      base.pluginInfo =
        data.pluginInfo ||
        data.info?.pluginInfo ||
        rootPlugin ||
        base.pluginInfo
      base.tracks.push(_functions.makeTrack(data, requester, node))
    } else if (loadType === 'playlist' && data) {
      const info = data.info
      if (info) {
        base.playlistInfo = {
          name: info.name || info.title,
          thumbnail:
            data.pluginInfo?.artworkUrl ||
            data.tracks?.[0]?.info?.artworkUrl ||
            null,
          ...info
        }
      }
      base.pluginInfo = data.pluginInfo || rootPlugin || base.pluginInfo
      base.tracks = Array.isArray(data.tracks)
        ? data.tracks.map((t) => _functions.makeTrack(t, requester, node))
        : []
    } else if (loadType === 'search') {
      base.tracks = Array.isArray(data)
        ? data.map((t) => _functions.makeTrack(t, requester, node))
        : []
    }
    return base
  }

  get(guildId) {
    const player = this.players.get(String(guildId))
    if (!player) throw new Error(`Player not found: ${guildId}`)
    return player
  }

  async search(query, requester, source) {
    if (!query || !requester) return null
    try {
      const { tracks } = await this.resolve({
        query,
        source: source || this.defaultSearchPlatform,
        requester
      })
      return tracks || null
    } catch {
      return null
    }
  }

  _serializePlayer(player) {
    // A one-shot is not saved, so a restart mid-clip does not replay it.
    const current = player.current?.oneShot ? null : player.current
    const requester = player.requester || current?.requester
    const full = this.persistTracks === 'full'
    return {
      g: player.guildId,
      // the node that holds the player, which is where a restore looks for
      // it if that node's session resumes
      n: player.nodes?.name || player.nodes?.host || null,
      t: player.textChannel,
      v: player.voiceChannel,
      u: full ? (current?.toJSON() ?? null) : current?.uri || null,
      ud: current?.userData || null,
      p: current ? player.position || 0 : 0,
      ts: player.timestamp || 0,
      q: player.queue
        .toArray()
        .slice(0, this.maxQueueSave)
        .map((tr) => (full ? tr.toJSON() : tr.uri)),
      r: requester ? `${requester.id}:${requester.username}` : null,
      vol: player.volume,
      pa: player.paused,
      pl: player.playing,
      nw: player.nowPlayingMessage?.id || null,
      loop: player.loop,
      resuming: true
    }
  }

  async savePlayer(filePath = './AquaPlayers.jsonl') {
    const lockFile = `${filePath}.lock`
    const tempFile = `${filePath}.tmp`
    let ws = null
    let lockAcquired = false
    try {
      await fs.promises.writeFile(lockFile, String(process.pid), { flag: 'wx' })
      lockAcquired = true
      ws = fs.createWriteStream(tempFile, { encoding: 'utf8', flags: 'w' })
      let streamError = null
      ws.on('error', (error) => {
        streamError = error
      })
      const buffer = []
      const write = (chunk) => {
        if (ws.write(chunk)) return Promise.resolve()
        return new Promise((resolve, reject) => {
          const onDrain = () => {
            cleanup()
            resolve()
          }
          const onError = (error) => {
            cleanup()
            reject(error)
          }
          const cleanup = () => {
            ws.off('drain', onDrain)
            ws.off('error', onError)
          }
          ws.once('drain', onDrain)
          ws.once('error', onError)
        })
      }

      const nodeSessions = {}
      for (const node of this.nodeMap.values()) {
        if (node.sessionId) nodeSessions[node.name] = node.sessionId
      }
      buffer.push(JSON.stringify({ type: 'node_sessions', data: nodeSessions }))
      for (const player of this.players.values()) {
        buffer.push(JSON.stringify(this._serializePlayer(player)))

        if (buffer.length >= WRITE_BUFFER_SIZE) {
          const chunk = `${buffer.join('\n')}\n`
          buffer.length = 0
          await write(chunk)
        }
      }

      if (buffer.length) await write(`${buffer.join('\n')}\n`)
      if (streamError) throw streamError
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          ws.off('finish', onFinish)
          reject(error)
        }
        const onFinish = () => {
          ws.off('error', onError)
          resolve()
        }
        ws.once('error', onError)
        ws.once('finish', onFinish)
        ws.end()
      })
      ws = null
      await fs.promises.rename(tempFile, filePath)
    } catch (error) {
      console.error(`[Aqua/Autoresume]Error saving players:`, error)
      emitOperationalError(this, null, error)
      if (ws) _functions.safeCall(() => ws.destroy())
      await fs.promises.unlink(tempFile).catch(_functions.noop)
    } finally {
      if (ws) _functions.safeCall(() => ws.destroy())
      if (lockAcquired)
        await fs.promises.unlink(lockFile).catch(_functions.noop)
    }
  }

  async loadPlayers(filePath = './AquaPlayers.jsonl') {
    return this._recovery.loadPlayers(filePath)
  }

  async _restorePlayer(p) {
    return this._recovery.restorePlayer(p)
  }

  async _waitForFirstNode(timeout = NODE_TIMEOUT) {
    return this._recovery.waitForFirstNode(timeout)
  }

  _performCleanup() {
    return this._recovery.performCleanup()
  }

  async _loadNodeSessions(filePath = './AquaPlayers.jsonl') {
    return this._recovery.loadNodeSessions(filePath)
  }
}

module.exports = Aqua
