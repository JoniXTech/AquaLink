class Queue {
  // `onChange(queue)` runs once per change, after it. `rev` starts from the
  // clock so a guild's next queue, even after a restart, starts above it.
  constructor(onChange = null, rev = 0) {
    this._items = []
    this._head = 0
    this._compactThreshold = 64
    this._onChange = onChange
    this._rev = Math.max(Date.now(), rev)
    this._batchDepth = 0
    this._batchChanged = false
  }

  get rev() {
    return this._rev
  }

  // Every change goes through here: one rev and one onChange per change, or
  // per batch.
  _changed() {
    if (this._batchDepth) {
      this._batchChanged = true
      return
    }
    this._rev++
    this._onChange?.(this)
  }

  // The changes `fn` makes count as one.
  _batch(fn) {
    this._batchDepth++
    try {
      return fn()
    } finally {
      if (--this._batchDepth === 0 && this._batchChanged) {
        this._batchChanged = false
        this._changed()
      }
    }
  }

  get size() {
    return this._items.length - this._head
  }

  get first() {
    return this._items[this._head] || null
  }

  get last() {
    return this._items[this._items.length - 1] || null
  }

  add(...tracks) {
    for (const track of tracks) {
      if (track?.disposed)
        throw new TypeError('Cannot add a disposed track to the queue')
    }
    if (!tracks.length) return this
    this._items.push(...tracks)
    this._changed()
    return this
  }

  remove(track) {
    const idx = this._items.indexOf(track, this._head)
    if (idx === -1) return false
    const removed = this._items[idx]
    this._items.splice(idx, 1)
    if (removed?.dispose) removed.dispose()
    this._changed()
    return true
  }

  clear({ dispose = true } = {}) {
    const had = this.size > 0
    if (dispose) {
      for (let i = this._head; i < this._items.length; i++) {
        if (this._items[i]?.dispose) this._items[i].dispose()
      }
    }
    this._items.length = 0
    this._head = 0
    if (had) this._changed()
  }

  _compact(force = false) {
    if (this._head <= 0) return
    if (!force && this._head < this._compactThreshold) return
    const len = this._items.length - this._head
    for (let i = 0; i < len; i++) {
      this._items[i] = this._items[this._head + i]
    }
    this._items.length = len
    this._head = 0
    if (this._compactThreshold < len) {
      this._compactThreshold = Math.min(len * 2, 1024)
    }
  }

  shuffle() {
    this._compact(true)
    // Fisher-Yates leaves the order as it was only when every j is i.
    let moved = false
    for (let i = this._items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      if (j === i) continue
      moved = true
      const temp = this._items[i]
      this._items[i] = this._items[j]
      this._items[j] = temp
    }
    if (moved) this._changed()
    return this
  }

  move(from, to) {
    const actualFrom = from + this._head
    const actualTo = to + this._head
    if (
      from < 0 ||
      actualFrom >= this._items.length ||
      to < 0 ||
      actualTo >= this._items.length ||
      from === to
    )
      return this
    const [item] = this._items.splice(actualFrom, 1)
    this._items.splice(actualTo, 0, item)
    this._changed()
    return this
  }

  swap(index1, index2) {
    const actual1 = index1 + this._head
    const actual2 = index2 + this._head
    if (
      index1 < 0 ||
      actual1 >= this._items.length ||
      index2 < 0 ||
      actual2 >= this._items.length ||
      index1 === index2
    )
      return this
    const temp = this._items[actual1]
    this._items[actual1] = this._items[actual2]
    this._items[actual2] = temp
    this._changed()
    return this
  }

  peek() {
    return this.first
  }

  toArray() {
    return this._items.slice(this._head)
  }

  at(index) {
    return this._items[this._head + index] || null
  }

  dequeue() {
    if (this._head >= this._items.length) return undefined
    const item = this._items[this._head]
    this._items[this._head] = undefined // Allow GC
    this._head++
    this._compact(false)
    this._changed()
    return item
  }

  isEmpty() {
    return this.size === 0
  }

  enqueue(track) {
    return this.add(track)
  }
}

module.exports = Queue
