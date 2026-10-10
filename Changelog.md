# Unreleased

## Voice recovery rework

Voice closes are now decided by one number, the connection's voice
`generation`, plus a per-player voice deadline, instead of a set of
suppression flags that could get stuck and leave a player silent for good.

- A voice close waits 2 s. If the voice generation moved (a new join, new
  credentials from Discord, an adopt) within 2 s on either side of it, it was
  the old connection's and is ignored; that covers Discord's real 4014 to
  the old socket when the bot is moved. So are closes from a node the
  player has moved off. A voice PATCH alone no longer counts: NodeLink no
  longer reports a replaced socket as a 4014.
- A current close: no voice channel, or 4014/4022, ends the player
  (`socketClosed`, then destroy). 4015 and the node's own codes are left to
  the server, which reconnects itself. Anything else (4006, 4009, ...) drops
  the credentials and rejoins the same channel.
- New option `voiceConnectTimeout` (default 30000). Every voice attempt arms
  it; when it runs out, aqualink asks the node, then re-sends or rejoins. It
  runs on every node type, NodeLink included.
- At most two rejoins (closes and deadline together) until the player
  connects. After that: `reconnectionFailed`, `socketClosed`, destroy.
- An unchanged voice update is now re-sent after a close, rather than being
  deduplicated, because the node takes it as "reconnect".
- When the deadline's request to the node gets no answer or a 5xx, no
  attempt is spent. After two in a row the player moves to another usable
  node; with none, it waits rather than being destroyed.
- The 5 s check after a move only re-sends a lost voice update. A node that
  holds the voice but is still connecting is left to the normal deadline.
- Node health counts REST failures. Three requests in a row that get no
  answer or a 5xx make a node `critical` (reason `rest failing: N in a row`),
  which keeps new players off it while another usable node exists. Any
  answer below 500 ends the run, and so do 60 s without a new failure.
  Configurable with `nodeHealth.maxRestFailures` and
  `nodeHealth.restFailureWindow`.
- A player restored while paused (failover, in-place rebuild) gets its track
  together with the pause, `{ track, paused: true }`. The pause used to go
  out on its own first, and a paused NodeLink player sends no playerUpdate,
  so the track waited for one forever. When the deadline finds voice up, it
  now sends a track still waiting for voice, and unpausing such a player
  sends the track rather than `{ paused: false }` alone.
- A rejoin waits 5 s for Discord's new credentials. A join to the channel
  the bot is already in may not produce any, so if none come it leaves the
  channel and joins again, as part of the same rejoin. The bot's own voice
  state with no channel that answers the leave is not a disconnect: no
  `playerMove` to `null`, no null-channel grace. `player.voiceRejoining` is
  true from the leave until voice is up; a host that ends its player when
  the bot leaves voice should skip that while it is set.
- A restored, migrated or rebuilt track starts at its position in the same
  update as the track. It used to get a separate seek after its TrackStart
  as well, or (migration, rebuild) start from 0 and rely on that seek. A
  track waiting for voice keeps its own start time, which the playerUpdate
  that brings voice up can no longer reset to 0, and a seek before it
  starts moves that start rather than going to a node with no track.

## Event changes

- `socketClosed`: the payload is typed as `VoiceClosePayload`. When the
  deadline gives up, `code` is `null` and `timeout` is `true`. Every
  `socketClosed` aqualink emits is now followed by destroy, and carries a
  stable `cause`: `no_channel`, `disconnected` (4014/4022),
  `rejoins_exhausted` (a close with no rejoins left) or `voice_deadline`.
  `code` and `reason` are left as the node sent them.
- `reconnectionFailed`: emitted once, when recovery gives up, with
  `retriesLeft: 0` and `reason` (`voice_deadline` or `rejoins_exhausted`).
  Typed as `ReconnectionFailedData`.
- `playerReconnect`: now typed (`PlayerReconnectData`). It carries `reason`
  for a rejoin, and `leave_rejoin` when the rejoin leaves the channel to
  join it again.
- `trackError` no longer stops the player. The node ends a failed track
  itself (NodeLink with `loadFailed`, Lavalink when the track next ends),
  and some exceptions leave the track playing, which the stop used to kill.
- New `player.claimFailedTrack(track)`, for a host that retries a failed
  track. Called from the `trackError` listener, it makes the track's end
  emit `trackEnd` without playing the next track or emitting `queueEnd`,
  so the retry doesn't race aqualink's own advance. It returns `release()`,
  which runs that advance when the host gives up. The claim lapses at the
  next `trackStart`, or advances on its own after
  `Player.FAILED_TRACK_CLAIM_MS` (10 s). A `play()` of the claimed track
  (the retry) stops that timer, so a slow retry is not raced, and the next
  failure ends the claim unless the host claims again.
- `playerReconnected` is no longer emitted. A failed voice rejoins the same
  player instead of building a new one.

## Removed

`Player.reconnectionRetries`, `_voiceRecovering`, `_isActivelyReconnecting`,
`_voiceDownSince`, the voice recovery tokens, and the client-side voice
resume. `_reconnecting` now only means a rejoin is under way. `_resuming`
and `TrackStart`'s `resumed` flag are unchanged.

# Aqualink 2.7.1

- ignore message errors on shouldDeleteMessage
- Removed fs-extra usage, switch to fs/promises
- Fixed player breaking if no track given on autoResume
- Fixed an circular buffer cache related to user handling on autoResume / player saving
- Optimized node, made message handling faster, improved events binding efficiency, and other misc improviments.
  - This also improves the voice / audio stability, since its better for handling it.

## Breaking change

renamed the 'nodeConnect' event to 'nodeReady'

# Aqualink 2.7.0

## Rewrited the aqua class

- ~20-30% reduction in memory usage
-  ~15-25% improvement in response times
-  Better scalability with multiple concurrent operations
-  Reduced CPU overhead for repetitive operations
-  More efficient resource cleanup
-  Many optimizations related to caching, regions fetching
-  Added batch updates for less overload and speed.

## Added true node AutoResume 
 - Node disconnected? have a 2nd? Aqua will now use it.
  - Avalible options:
```js

const nodes = [
    {
        name: "Noded",
        host: NODE_HOST,
        port: NODE_PORT,
        password: NODE_PASSWORD,
        secure: false,
    },
    {
        name: "AquaLink", 
        host: NODE_HOST2,
        port: NODE_PORT2,
        password: NODE_PASSWORD2,
        secure: false,
    },
];

const aqua = new Aqua(client, nodes, {
    failoverOptions: {
        enabled: true, // enable it
        maxRetries: 3,  // max amounts of retrys until the node connects
        retryDelay: 1000,  // self-explain
        preservePosition: true,  // continue from the song position
        resumePlayback: true  //self-explain
    }
});
```

- Fixed an long-standing bug about node.destroy(), now it should work fine
- Reworked the seek() method thanks to @soulcosmic1406_ 
- Improved the destroy() method with connections
- Added seyfert package support (https://www.seyfert.dev/)

# Aqualink 2.6.4-r2

- Reworked node event handling, improved the speed and performance.
- Added new event:
```js
aqua.on("lyricsNotFound", (player, track, payload) => console.log(`Lyrics not found: ${track.info.title}`));
// Emitted when live lyrics din't found anything, should fix an error.
```

# Aqualink 2.6.4

- Rewrite the lyrics again
  - Improved support for lavalyrics / java timed lyrics
  - Improved fetching by using fallback system
  - Added live lyrics from lavalyrics

```js
// Turning on:
            player.subscribeLiveLyrics()
// Turning off:
            player.unsubscribeLiveLyrics();
```
Depends on lavalyrics API, so may break a lot

- Made getLyrics method more performant
- Add souldevs as a contribuitor on readme
New 2 events:
```js
aqua.on("lyricsFound", (player, track, payload) => console.log(`Lyrics found: ${track.info.title}`));
// Emitted when live lyrics found a lyric;

aqua.on("lyricsLine", async (player, track, payload) 
// Emitted when the lyrics starts updating by line (Eg: changing from line 1, to line 2, line 3 ...)
```

# Aqualink 2.6.3
- Rewrited the getLyrics method
  - Added skipTrackSource [true, false]
example usage.

 ```js
const lyricsResult = await player.getLyrics({
query: searchQuery,
useCurrentTrack: !searchQuery,
skipTrackSource: false
});
```

- Remade some code on the Connection handle, improved lazy load, improved speed and region fetching
- Rewrited the autoResume code, Way more lightweight, faster, and auto cleans up on reload
- Rewrited Rest handler, this makes way faster, and reduces the recourses usage by a lot (especially RAM)
- Rewrited player, way faster, improved batching speed and efficiency, also shuffle() now can contain both async and sync, for better performance
- Fixed timestamp on player
- Improved the HTTP2, Secure nodes handling
- Added Agents / keepalive, for better performance

# 2.6.2

- Added 2 new methods: Aqua.savePlayer()
Usage: ```js
process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  await aqua.savePlayer();
  process.exit(0);
})
```
Method 2: Aqua.loadPlayers()
Usage```
set autoResume to true
```

- Fixed some memory leaks on the aqua handler (specfific destroy)
- Improved the NODE performance (also fixed some bugs to stats)
- Added track.position (player.position) and timestamp
- Added playlist.thumbnail 
Example usage:
```js
console.log(result.playlistInfo.thumbnail)
```
- Misc fixes for player.connect()

# 2.6.1 Bug Fixes + Performance update - Aqualink

- Fix: destroy() not allowing to update voice channel status
- skip track source set to true on lyrics
- Reworked the player system to be way more lightweight, fast, and performant
- Rewrited some stuff on the node handler to be more lightweight, less bugs, better checks, better error checking / logging and bug fixes on memory leaks
- createPlayer will now listen to the destroy event, making it more performant
- Made the connection handler lazy-load, reducing the memory usage on initial and faster regions extraction, better early returnings
- remade the rest handler to be more performant with chunks

NEW EVENT SYSTEM
- moved from eventemitter3 to tseep

why? its way better for long living events, and players normally are long, also its more performant in memory and wayyy more lightweight, while beign better for "once", which aqualink uses a lot

Library    'Once' Ops/Sec    'Add-Remove'   Ops/Sec    
Tseep    108,688,843    70,905,688
EventEmitter3    52,871,196    113,090,638

# 2.6.0 Performance Update + Fixes - Aqualink

- Now player will respect the Aqua constructor options

now you can use:
```js
const aqua = new Aqua(client, nodes, {
  defaultSearchPlatform: "ytsearch",
  restVersion: "v4",
  shouldDeleteMessage: true, // Before you needed to set directly on player, now here on Aqua is the required one
  autoResume: true,
  infiniteReconnects: true, 
  leaveOnEnd: false, // // Before you needed to set directly on player, now here on Aqua is the required one
}); 
```

- Improved `resolve()` method speed by ~30% / 50% , also less requests beign sent
- Rewrited the player connection manager, improved the caching, speed, performance
  - Also improved the region fetching, making it faster and better direct calls
- Rewrited the `Filters` system
  - Much faster
  - Now uses batching updates, allowing multiple filters be updated with less network latency, more speed, and less recourses
- Optimizations on the Queue methods (Shuffle, remove, etc)
- Added track.duration on the track object

# 2.5.0 Performance update - Aqualink

- Rewrited `PLAYER` handler
  - 3x faster handling into loops, events handlings, and lookups
  - Made the autoplay faster for locating the sources
  - Added batch updates (Way less latency + less overhead for high demand bots, etc)
  - Improved lyrics by making it all in one
  - Improved the shuffle code
  - Improved Destroy method, this has way less memory leaks and cleans more
  - Made the connect method faster
  - Improved the previous / queue handling into arrays

- Improved `NODE` handler
  - Faster connections speed
  - Better checkings for message / payloads handling
  - Added jitter reconections (Better performance for reconnecting the node)
  - Improved the error checkings
  - Improved the stats creating speed / saving

- Improved `Rest` handler
  - some fixes related to https, http2
  - Improved async loading
  - Improved error checkings, more safer now

# 2.4.0 Rewrited performance - Aqualink

- Rewrited the `AUTOPLAY` module fully
  - Now uses my own method, so less chances of getting patched
  - New method is 3x faster, uses less memory, and less requests
  - Made the soundcloud only fetch the sounds, not the full page, making it way more memory efficient
  - Improved the fetching speed / memory cleaning up

- Rewrited the `AQUA` handler
  - Way faster nodes connecting (even on multiple)
  - Faster track resolving with less duplications
  - Better player creating with checks
  - Made the Voice Update dynamic (allow more speed), by setting server and state
  - Optimized the overall caching system
  - Now allocates less arrays

- Small optimizations on `Connection`
  - Improved the checkins, and make them faster too
  - Make the bot connect a bit more faster
  - Better logs on errors 

- Rewrite the `Player` handler
  - 30% Faster code
  - More smaller
  - Fixed more events handling
  - Improved event handling, now faster and less overhead on memory
  - Removed useless functions

- Improved the HTTP 2 / HTTP Support on REST, making it load faster, also made it fully async

## New track system

**now you can use both track.info and track.title (example: you can now use track.thumbnail, track.title directly)**
also new readme thanks to @lavalink.py

#  2.3.0 Another performance update - Aqualink

- now is ~21% more lightweight, reduced disk space

- Improved the `AQUA` module
  - 3x better cleanup system
  - Fixed some memory leaks
  - Improved long process support
  - Faster node caching

- Remade the `Player` module
  - Added circular buffer for previousTracks (way more memory efficient)
  - Reorganized the event handlings
  - Way better Memory management

- Rewrite the `Node` system
  - Fixed an memory leak in connections
  - Improved the overal speed
  - Improved code readbility / modules
  - improved cleanup System
  - Better long runtime
  - Rewrite the Filter system

- Improved `Rest` code
  - Fixed lyrics (both search and get)
  - Better chunks system for more performance

- Improved `fetchImage` speed and recourses

# 2.2.0 Performance Update - Aqualink

- Improved the `AQUA` module
  - Added  Fast path in getRequestNode (     Reduces unnecessary type checks    )
  - Early return in handleNoMatches (    Avoids unnecessary Spotify requests     )
  - Rewrite to use manual loops on constructResponse (      faster than Array.prototype.map, makes the playlists and tracks load way faster and less recourses     )
  - Pre-allocated arrays (    Avoids dynamic resizing   )
  - Also fixed it sending double requests to lavalink.


- Remade the `Player` module
  - More efficient track addition, void Array re-call
  - faster event handling with direct states
  - Faster autoplay system and more efficient by map()
  - Reduced Object Creation
  - Rewrite destroy() method
  - Also improved Resource Cleanup
  - Now emit TrackEnd and queueEnd correctly

- Rewrite the `autoplay` system
  - Added redirect handling
  - More efficient regex processing
  - Set for unique URLs to avoid duplicate
  - Use array chunks for better performance
  - About ~30%-40% faster for resolving now.

- Rewrite the Filter system
  - Uses Direct Assigments
  - Avoid recreating objects on each update
  - Property reuse in updateFilters()
  - Uses traditional for loop

## 2.1.0 Released - Aqualink

---
- Improved the `AQUA` module
  - Faster nodes loading
  - Faster plugin loading
  - Better listeners for player
  - Faster resolving system for playlists

- Remade the `Connection` system
  - Less overheard now.
  - Faster connections
  - Improved the checkings
  - Improved error handling
  - Fixed creating useless Objects and arrays

- Fully rewrite the `Node` system
  - Way faster connections
  - More stable (i think so)
  - Faster events / messages / payloads handling
  - Better stats handling (reusing, creating, destroyin)
  - Some more bug fixes and stuff i forgot.

- Remade the `Player` module
  - Now support Lazy Loading by default
  - Better State Updates
  - Improved Garbage Collection
  - Rewrite to use direct comparasions

- Improved the `Rest` module
  - Lazy loading of http2
  - Faster request chunks
  - Some overall upgrades

- Improved `Track` module
  - Faster track looking
  - More micro optimizations (use Boolean instead of !!)

- Remade the INDEX.D.TS File: Added more 1000 lines of code. Added autocomplete, options, and documented everything.
