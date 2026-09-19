const HIGH = 'high'

function abortError(reason) {
  if (reason instanceof Error) return reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Per-node REST concurrency with two lanes.
 *
 * Player, session and voice calls run in the high lane and are only ever
 * bounded by the total. Searches, decodes and lyrics run in the low lane,
 * which is capped strictly below the total, so there is always capacity a
 * burst of searches cannot occupy and a pause or a skip never waits behind
 * one.
 */
class RestLimiter {
  constructor(concurrency, searchConcurrency) {
    this.concurrency = Math.max(1, Number(concurrency) || 32)
    this.searchConcurrency = Math.min(
      Math.max(1, this.concurrency - 1),
      Math.max(1, Number(searchConcurrency) || 16)
    )
    this.active = 0
    this.searchActive = 0
    this._high = []
    this._highHead = 0
    this._low = []
    this._lowHead = 0
  }

  get pending() {
    return this._high.length - this._highHead + (this._low.length - this._lowHead)
  }

  run(lane, fn, signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason))
    if (this._canStart(lane)) return this._start(lane, fn)

    return new Promise((resolve, reject) => {
      const entry = {
        fn,
        resolve,
        reject,
        signal: signal || null,
        cancelled: false,
        onAbort: null
      }
      if (signal) {
        // A queued request that is abandoned must never reach the wire.
        entry.onAbort = () => {
          if (entry.cancelled) return
          entry.cancelled = true
          entry.fn = null
          reject(abortError(signal.reason))
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      if (lane === HIGH) this._high.push(entry)
      else this._low.push(entry)
    })
  }

  clear(reason) {
    for (const queue of [this._high, this._low]) {
      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i]
        queue[i] = undefined
        if (!entry || entry.cancelled) continue
        this._detach(entry)
        entry.reject(reason || new Error('Rest destroyed'))
      }
      queue.length = 0
    }
    this._highHead = 0
    this._lowHead = 0
  }

  _canStart(lane) {
    if (this.active >= this.concurrency) return false
    return lane === HIGH || this.searchActive < this.searchConcurrency
  }

  _start(lane, fn) {
    this.active++
    if (lane !== HIGH) this.searchActive++
    let result
    try {
      result = fn()
    } catch (error) {
      this._release(lane)
      return Promise.reject(error)
    }
    return Promise.resolve(result).then(
      (value) => {
        this._release(lane)
        return value
      },
      (error) => {
        this._release(lane)
        throw error
      }
    )
  }

  _release(lane) {
    if (this.active > 0) this.active--
    if (lane !== HIGH && this.searchActive > 0) this.searchActive--
    this._pump()
  }

  _pump() {
    while (this._dispatch(HIGH)) {}
    while (this._dispatch('low')) {}
    this._compact()
  }

  _dispatch(lane) {
    const high = lane === HIGH
    const queue = high ? this._high : this._low

    while ((high ? this._highHead : this._lowHead) < queue.length) {
      const head = high ? this._highHead : this._lowHead
      const entry = queue[head]
      if (!entry || entry.cancelled) {
        queue[head] = undefined
        if (high) this._highHead++
        else this._lowHead++
        continue
      }
      if (!this._canStart(lane)) return false

      queue[head] = undefined
      if (high) this._highHead++
      else this._lowHead++
      this._detach(entry)
      this._start(lane, entry.fn).then(entry.resolve, entry.reject)
      return true
    }
    return false
  }

  _detach(entry) {
    if (entry.onAbort && entry.signal) {
      entry.signal.removeEventListener('abort', entry.onAbort)
      entry.onAbort = null
    }
  }

  _compact() {
    if (this._highHead > 1024 || this._highHead > this._high.length / 2) {
      this._high = this._high.slice(this._highHead)
      this._highHead = 0
    }
    if (this._lowHead > 1024 || this._lowHead > this._low.length / 2) {
      this._low = this._low.slice(this._lowHead)
      this._lowHead = 0
    }
  }
}

module.exports = { RestLimiter, abortError, HIGH }
