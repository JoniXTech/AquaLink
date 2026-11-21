// Gapless and crossfade promotions (docs/crossfade-promotion.md). Real Player/Queue, scripted node
// that keeps the host's nextTrack and promotes it the way NodeLink does
// (TrackEnd with the promotion reason, then TrackStart of the preloaded track).
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const repo = process.env.AQUALINK || require('node:path').join(__dirname, '..')
const Player = require(`${repo}/build/structures/Player.js`)
const Track = require(`${repo}/build/structures/Track.js`)

const mk = (id) =>
  new Track({ encoded: `enc-${id}`, info: { identifier: id, title: id, length: 200000 } })
const idOf = (enc) => enc?.slice(4)

/**
 * preload: 'head' (wavemusic today: the queue head) or 'loop' (the looping
 * track in track loop, the head otherwise).
 */
function setup({ preload = 'loop' } = {}) {
  const aqua = new EventEmitter()
  aqua.options = {}
  aqua.clientId = '9'
  aqua.promotionFallbacks = 0
  aqua.on('error', () => {})
  aqua._trace = () => {}
  const debug = []
  const node = { playing: null, next: null, position: 0, events: [], sends: [] }
  // The node's own view of the player, as its REST API gives it.
  node.gets = 0
  node.reply = null
  const rest = {
    getPlayer: async () => {
      node.gets++
      if (node.reply) await node.reply
      const encoded = node.playing
      return {
        track: encoded && { encoded, info: { identifier: idOf(encoded) } },
        state: { position: node.position, time: Date.now() }
      }
    }
  }
  const nodes = { rest, isNodelink: true, _emitDebug: (m) => debug.push(m) }
  const p = new Player(aqua, nodes, { guildId: '1' })
  p.connected = true
  p.voiceChannel = null
  const ev = (type, encoded, extra = {}) =>
    node.events.push({ type, track: { encoded, info: { identifier: idOf(encoded) } }, ...extra })
  p.updatePlayer = async (data) => {
    if ('track' in data) {
      const old = node.playing
      const enc = data.track.encoded
      node.sends.push(idOf(enc) ?? 'stop')
      if (enc == null) {
        if (old) ev('TrackEndEvent', old, { reason: 'stopped' })
        node.playing = null
      } else {
        if (old) ev('TrackEndEvent', old, { reason: 'replaced' })
        node.playing = enc
        node.position = data.position || 0
        ev('TrackStartEvent', enc)
      }
    }
    if ('nextTrack' in data) node.next = data.nextTrack?.encoded ?? null
    return {}
  }
  const starts = []
  // The host's track-start work: announce, then preload what comes next.
  aqua.on('trackStart', (player, track) => {
    starts.push(track.identifier)
    const want =
      preload === 'loop' && player.loop === 1 ? player.current : player.queue.first
    void player.updatePlayer({ nextTrack: want?.track ? { encoded: want.track } : null })
  })
  let queueEnds = 0
  aqua.on('queueEnd', () => queueEnds++)

  const one = async () => {
    await new Promise((r) => setImmediate(r))
    const e = node.events.shift()
    if (e) await p._handleEvent(e)
    return !!e
  }
  const flush = async () => {
    for (let i = 0; i < 100; i++) if (!(await one())) return
  }
  const finish = async () => {
    const enc = node.playing
    node.playing = null
    ev('TrackEndEvent', enc, { reason: 'finished' })
    await flush()
  }
  /** NodeLink's switch to the preloaded track (or `other`), end then start. */
  const promote = async (
    reason,
    { other = null, start = true, between = null, at = 0 } = {}
  ) => {
    const enc = node.playing
    const into = other ? `enc-${other}` : node.next
    assert.ok(into, 'nothing preloaded to promote')
    node.next = null
    node.playing = into
    node.position = at
    ev('TrackEndEvent', enc, { reason })
    if (start) ev('TrackStartEvent', into)
    await one()
    if (between) await between()
    await flush()
  }
  const hist = () => p.previousTracks.toArray().map((t) => t.identifier).join(',')
  return {
    p, aqua, node, starts, debug, flush, finish, promote, hist,
    queueEnds: () => queueEnds,
    queue: () => p.queue.toArray().map((t) => t.identifier).join(',')
  }
}

async function start(t, ...ids) {
  t.p.queue.add(...ids.map(mk))
  await t.p.play()
  await t.flush()
}

for (const reason of ['gapless', 'crossfading']) {
  describe(`a ${reason} end`, () => {
    it('plays on what the node promoted: no loop', async () => {
      const t = setup()
      await start(t, 'A', 'B', 'C')
      await t.promote(reason)
      await t.promote(reason)
      await t.finish()
      assert.deepEqual(t.node.sends, ['A'])
      assert.deepEqual(t.starts, ['A', 'B', 'C'])
      assert.equal(t.hist(), 'A,B,C')
      assert.equal(t.queueEnds(), 1)
      assert.equal(t.aqua.promotionFallbacks, 0)
    })

    it('track loop: adopts the looping track the host preloaded', async () => {
      const t = setup({ preload: 'loop' })
      await start(t, 'A', 'B')
      t.p.setLoop('track')
      // the host re-syncs its preload when the loop changes
      await t.p.updatePlayer({ nextTrack: { encoded: 'enc-A' } })
      await t.promote(reason)
      await t.promote(reason)
      assert.deepEqual(t.node.sends, ['A'])
      assert.deepEqual(t.starts, ['A', 'A', 'A'])
      assert.equal(t.hist(), 'A,A')
      assert.equal(t.queue(), 'B')
      assert.equal(t.p.current.identifier, 'A')
    })

    it('track loop with the head preloaded: replays the looping track, once', async () => {
      const t = setup({ preload: 'head' })
      await start(t, 'A', 'B')
      t.p.setLoop('track')
      await t.promote(reason)
      assert.deepEqual(t.node.sends, ['A', 'A'])
      assert.deepEqual(t.starts, ['A', 'A'])
      assert.equal(t.p.current.identifier, 'A')
      assert.equal(t.queue(), 'B')
      assert.equal(t.aqua.promotionFallbacks, 1)
      assert.equal(t.debug.length, 1)
      await t.finish()
      assert.equal(t.hist(), 'A,A')
    })

    it('queue loop: the ended track goes round again', async () => {
      const t = setup()
      await start(t, 'A', 'B')
      t.p.setLoop('queue')
      await t.promote(reason)
      assert.equal(t.queue(), 'A')
      await t.promote(reason)
      assert.equal(t.queue(), 'B')
      assert.deepEqual(t.node.sends, ['A'])
      assert.deepEqual(t.starts, ['A', 'B', 'A'])
      assert.equal(t.hist(), 'A,B')
    })

    it('the promoted track was the last: the queue ends after it', async () => {
      const t = setup()
      await start(t, 'A', 'B')
      await t.promote(reason)
      assert.equal(t.queue(), '')
      assert.equal(t.node.next, null)
      assert.equal(t.queueEnds(), 0)
      await t.finish()
      assert.equal(t.queueEnds(), 1)
      assert.deepEqual(t.starts, ['A', 'B'])
      assert.equal(t.hist(), 'A,B')
    })

    it('stop between the end and the start: the promoted track ends, the queue goes on', async () => {
      const t = setup()
      await start(t, 'A', 'B', 'C')
      await t.promote(reason, { between: async () => { t.p.stop() } })
      assert.deepEqual(t.starts, ['A', 'B', 'C'])
      assert.deepEqual(t.node.sends, ['A', 'stop', 'C'])
      assert.equal(t.hist(), 'A,B')
      assert.equal(t.p.current.identifier, 'C')
    })

    it('skip between the end and the start: skips the promoted track', async () => {
      const t = setup()
      await start(t, 'A', 'B', 'C', 'D')
      await t.promote(reason, { between: async () => { t.p.skip() } })
      assert.equal(t.p.current.identifier, 'C')
      assert.deepEqual(t.starts, ['A', 'B', 'C'])
      assert.equal(t.queue(), 'D')
      assert.equal(t.hist(), 'A,B')
    })

    it('a play between the end and the start: the promoted start is not that play\'s', async () => {
      const t = setup()
      await start(t, 'A', 'B')
      const X = mk('X')
      await t.promote(reason, { between: async () => { await t.p.play(X) } })
      assert.equal(t.p.current.identifier, 'X')
      assert.deepEqual(t.starts, ['A', 'X'])
      assert.equal(t.aqua.promotionFallbacks, 0)
    })

    it('a play while the promoted start is missing: its own start counts', async () => {
      const t = setup()
      await start(t, 'A', 'B')
      const X = mk('X')
      await t.promote(reason, {
        start: false,
        between: async () => { await t.p.play(X) }
      })
      assert.equal(t.p.current.identifier, 'X')
      assert.deepEqual(t.node.sends, ['A', 'X'])
      assert.deepEqual(t.starts, ['A', 'X'])
      assert.equal(t.aqua.promotionFallbacks, 0)
    })

    it('previous right after the promotion: one entry per play', async () => {
      const t = setup()
      await start(t, 'A', 'B')
      await t.promote(reason)
      const A = t.p.previousTracks.toArray().at(-1)
      await t.p.playPrevious(A)
      await t.flush()
      assert.equal(t.p.current.identifier, 'A')
      assert.equal(t.queue(), 'B')
      await t.finish()
      await t.finish()
      assert.deepEqual(t.starts, ['A', 'B', 'A', 'B'])
      assert.equal(t.hist(), 'A,B')
    })

    it('the node promoted something else: plays the queue head, counts it', async () => {
      const t = setup()
      await start(t, 'A', 'B')
      await t.promote(reason, { other: 'X' })
      assert.equal(t.p.current.identifier, 'B')
      assert.deepEqual(t.node.sends, ['A', 'B'])
      assert.deepEqual(t.starts, ['A', 'B'])
      assert.equal(t.aqua.promotionFallbacks, 1)
      assert.equal(t.debug.length, 1)
      await t.finish()
      assert.equal(t.hist(), 'A,B')
    })

    it('no TrackStart after the end: plays the queue head after the window', async () => {
      const t = setup()
      await start(t, 'A', 'B')
      await t.promote(reason, { start: false })
      assert.deepEqual(t.node.sends, ['A'])
      await new Promise((r) => setTimeout(r, 2100))
      await t.flush()
      assert.deepEqual(t.node.sends, ['A', 'B'])
      assert.deepEqual(t.starts, ['A', 'B'])
      assert.equal(t.aqua.promotionFallbacks, 1)
      await t.finish()
      assert.equal(t.hist(), 'A,B')
    })
  })
}

describe('the promoted track\'s position', () => {
  const tick = () => new Promise((r) => setImmediate(r))

  it('crossfade: read from the node, a blend\'s length in', async () => {
    const t = setup()
    await start(t, 'A', 'B')
    await t.promote('crossfading', { at: 6000 })
    await tick()
    assert.equal(t.p.current.identifier, 'B')
    assert.equal(t.p.position, 6000)
    assert.equal(t.node.gets, 1)
  })

  it('gapless: starts at 0, nothing to read', async () => {
    const t = setup()
    await start(t, 'A', 'B')
    await t.promote('gapless')
    await tick()
    assert.equal(t.p.position, 0)
    assert.equal(t.node.gets, 0)
  })

  it('a position written before the reply is newer and stays', async () => {
    const t = setup()
    await start(t, 'A', 'B')
    let answer
    t.node.reply = new Promise((r) => { answer = r })
    await t.promote('crossfading', { at: 6000 })
    // a playerUpdate or seek lands first
    await new Promise((r) => setTimeout(r, 5))
    t.p.position = 6400
    answer()
    await tick()
    assert.equal(t.p.position, 6400)
  })

  it('a play before the reply: the reply is not the new track\'s', async () => {
    const t = setup()
    await start(t, 'A', 'B')
    let answer
    t.node.reply = new Promise((r) => { answer = r })
    await t.promote('crossfading', { at: 6000 })
    await t.p.play(mk('X'), { startTime: 1000 })
    await t.flush()
    t.node.playing = 'enc-B' // the reply describes the node before the play
    t.node.position = 6000
    answer()
    await tick()
    assert.equal(t.p.current.identifier, 'X')
    assert.equal(t.p.position, 1000)
  })
})

describe('a finished end (Lavalink, or no preload)', () => {
  it('still plays the next track itself', async () => {
    const t = setup()
    await start(t, 'A', 'B')
    await t.finish()
    await t.finish()
    assert.deepEqual(t.node.sends, ['A', 'B'])
    assert.deepEqual(t.starts, ['A', 'B'])
    assert.equal(t.hist(), 'A,B')
  })
})
