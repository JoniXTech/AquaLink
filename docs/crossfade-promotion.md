# Crossfade and gapless: aqualink plays the promoted track again

Status: cause measured, fix not yet written (see [Proposed fix](#proposed-fix)).

## Symptom

With crossfade on (NodeLink `crossfade` config plus a preloaded `nextTrack`),
listeners hear no blend: the old track seems to end and the next one starts at
0:00. Hosts log `trackStart` twice for the incoming track, about a second apart.
Gapless has the same fault, heard as a gap and a restart instead of a seamless
join.

## What happens

NodeLink starts the preloaded track itself at the boundary. At the end of a
crossfade it sends, in this order:

1. `TrackEndEvent` for the outgoing track, `reason: 'crossfading'` (gapless:
   `'gapless'`);
2. `TrackStartEvent` for the promoted track, which is already playing, mid-blend.

`Player.trackEnd` has no case for either reason. It takes them as an ordinary
end: `current = null`, emit `trackEnd`, and with a queue it calls `play()`. The
head of the queue is the track the node just promoted, because the host keeps
`nextTrack` equal to it. So aqualink sends
`PATCH { track: <promoted>, paused: false }` within a few milliseconds of the
promotion. NodeLink treats this as a new play:

- it stops the running stream at once, which throws away the part of the blend
  still buffered between the mixer and the voice sender;
- it loads the track again and starts it at 0:00;
- it sends a second `TrackStartEvent` for it, so every host-side start effect
  runs twice (now-playing message, logs, the host's next preload).

This has been so since crossfade was wired in (`16a0c13`). Neither `trackEnd`
nor the node's promotion order (end, then start) has changed since then.

## Measured

Local NodeLink at JoniXTech/nodelink `ab369e1f`, this package at `1e14f2d`
driving it the way the host does (crossfade config, `nextTrack` = queue head
at each start). Voice was the real `@performanc/voice` connection with only the
network replaced, recording every Opus packet the sender would put on UDP.
Track A was a 440 Hz tone, B a chirp whose pitch gives its position, both with
a 120 BPM click, served at about real-time rate. Crossfade 5 s.

| run | what the voice sender sent at the boundary | `trackStart` B |
|---|---|---|
| crossfade, aqualink as is | ~1.5 s of the blend, then A cut; nothing for 784 ms; ~0.6 s silence; B from 0:00 | 2 |
| crossfade, promotion honoured | the whole blend (A fades to 0 over ~4 s), B carries on | 1 |
| gapless, aqualink as is | B on time, then nothing for 769 ms; ~0.6 s silence; B from 0:00 again | 2 |
| gapless, promotion honoured | seamless | 1 |

NodeLink emits the `crossfading` end when its mixer has finished the blend.
The listener is a few seconds behind that (here ~3.5 s of buffered output),
which is why only the first part of the blend is heard before the replay
cuts it.

In production (four NodeLink nodes, 2026-11-20 09:06 to 23:47 UTC) every
logged crossfade promotion was followed by that `PATCH { track }` from
aqualink, 3 to 66 ms later: 626 of 626, in 14 guilds. 24 guilds sent
`nextTrack` preloads (gapless or crossfade), so all 24 are exposed at every
boundary they reach.

The three PATCHes around one promotion:

| when | body | from |
|---|---|---|
| +0 ms | `{ track: <promoted>, paused: false }` | `trackEnd` → `play()` |
| +15 ms | `{ nextTrack: <new head> }` | host, after the first `trackStart` |
| +1.4 s | `{ nextTrack: <new head> }` again | host, after the second `trackStart` |

## Not the cause

- The NodeLink voice path: with the promotion honoured, the full blend reaches
  the voice sender on the same build.
- The configured length: it reaches the node (`crossfade.duration: 10000` in
  the PATCH). NodeLink treats it as an upper bound; when its track analysis is
  uncertain it falls back to an equal-power blend of `min(8000, duration)` ms,
  which is the 8000 ms seen for a 10 s setting.

## Proposed fix

In `Player.trackEnd`, for `reason` `'gapless'` or `'crossfading'`:

- record the ended track (history, queue-loop re-add) and emit `trackEnd` as
  now, but do not `play()`; mark a promotion as pending instead;
- on the `TrackStartEvent` that follows, if `payload.track` is the head of the
  queue (`Track.same`), dequeue it as `current` and emit `trackStart` once;
- if the node promoted something else (the queue changed during the fade),
  `play()` the head as today, which replaces it;
- if no start arrives within a short timeout, `play()` the head as today.

Cases to cover in tests: track loop (the host preloads the queue head, not the
looping track, so the promoted track is not the one aqualink wants: replay as
today), queue loop, an empty queue at the boundary (autoplay), a `stop()` or
`skip()` during the pending window, Lavalink nodes (they never send these
reasons), and the restore path, whose `promoted` outcome already adopts the
node's track this way (`AquaRecovery`).
