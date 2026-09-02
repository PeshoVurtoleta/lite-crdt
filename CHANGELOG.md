# Changelog

All notable changes to `@zakkster/lite-crdt` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-09-02

Tombstone compaction + delta sync (`decisions/0004-compaction-and-delta.md`). A
FEATURE release, but a narrow one: the convergence algebra of the base CRDTs does
NOT change, the wire format does NOT change (no new op type; `removed` still
serializes as a lamport-less sorted array, byte-compatible with 1.2.x), and the
C1 remote-op door and C2/C3 logic are EXTENDED, never rewritten. Compaction only
RECLAIMS causally-stable tombstones and value registers -- state no future op can
still need. A 1.3.0 replica and a 1.2.x replica still converge over plain ops and
full-state sync; a 1.2.x peer simply never compacts.

### Added

- **`doc.versionVector()`** -- a prototype-free, JSON-serializable snapshot of the
  doc's per-writer version vector (`replicaId -> max observed lamport`), safe to
  hand a peer for a delta request.
- **`doc.compact(V)`** -- PURELY LOCAL memory reclamation. Drops every
  causally-stable tombstone (LWW delete, OR removed-tag, and the C2-retained OR
  value register for a stable NON-member) that every replica in the frontier `V`
  has already observed. Emits nothing, adds no op type, changes no wire byte.
  Returns the count reclaimed. The safety condition is the CONSERVATIVE global
  frontier `minAck = min(V.values())`: drop a tombstone with lamport `l` iff
  `l <= minAck`. `V` MUST be the pointwise-min version vector across ALL replicas;
  a malformed `V` is reported to `onError` and reclaims nothing (fail closed,
  never throws).
- **`doc.getStateSince(V)`** -- the `getState()` shape filtered to just what a
  peer at version vector `V` has not yet seen (per-writer `l > V[r]`; counters
  ship FULL, being small and max-idempotent). A valid PARTIAL state consumed by
  the SAME `mergeState` door, so one delta frame converges a lagging peer instead
  of a full state dump. `mergeState(getStateSince(V))` on a replica already at `V`
  is a no-op; empty `V` yields the full state. A malformed `V` fails closed to a
  full `getState()`.

### Changed

- The OR-Set `removed` tombstone set is now internally a `Map(tagKey ->
  rmLamport)` (the removing op's lamport is the tombstone's causal-stability key).
  It still SERIALIZES as the sorted key ARRAY -- no lamport crosses the wire, so
  the format stays byte-identical to 1.2.x. Absorbing a 1.2.x lamport-less
  `removed` array stamps each tag `MAX_LAMPORT - 1` (fail closed: unknown
  provenance == not-yet-stable, never reclaimed early).
- The doc maintains a version vector. The ONLY new per-op work is one in-place,
  O(1), ZERO-ALLOCATION max-update on the already-validated `applyOp` scratch
  (`observe(s.r, s.l)`); counters carry no lamport and never touch it. The T6
  zero-alloc gate on `set`/`upd`/`cinc` is unaffected (major=0, minor=0).

### Notes

- Wire byte-compatible; convergence unchanged (proven byte-identical to an
  uncompacted control by the t5 convergence fuzz and `test/16-compaction.test.mjs`).
  The OR-Set value register is now reclaimable under causal stability -- exactly at
  the seam decisions/0002 named for C4. `getState()` MAY legitimately shrink after
  compaction (fewer tombstones); the observable `snapshot()` never changes.

## [1.2.1] - 2026-09-02

Two S3 contract findings (`decisions/0003-undo-and-replica-identity.md`). The
convergence algebra does NOT change, the wire format does NOT change (replica
ids are opaque to the wire -- a wider id serializes as an ordinary string and
round-trips byte-compatibly), and the remote-op door (C1) and C2 serialization /
retention work are untouched. Only one cold helper (`genReplicaId`) changes; the
undo, apply, add, rm and tick hot bodies gain zero branches and zero bytes.

### Changed

- **C-14** `genReplicaId()` entropy widened and made fail-closed. The
  auto-generated `replicaId` now comes from a crypto source resolved once at
  module load -- the Web Crypto global (browsers, Node >= 19) or the
  `node:crypto` `webcrypto` builtin (Node 18.x, whose default runtime lacks the
  unflagged `globalThis.crypto`; a Node builtin, not a runtime dep) -- using
  primary `randomUUID()` (122-bit, dashes stripped) or a 128-bit
  `getRandomValues(new Uint8Array(16))` fallback, both a 34-char `"r-..."` id.
  The old 32-bit `randomUUID().slice(0, 8)` primary and the weak `Math.random()`
  fallback are DELETED: only in a realm with NEITHER crypto source does
  `createCRDTDoc` throw `CRDTError("misconfigured")` rather than mint a collidable
  id -- a genuine last resort, not the common case, so `engines.node >= 18`
  holds. `genReplicaId` runs once per doc creation and is not on any hot path.
  Note: this makes CRDT.js use top-level await at module load (valid ESM; the
  repo has no CJS/`require` load of it).

### Documented

- **C-13** undo of an OR-Set removal restores MEMBERSHIP and VALUE, not list
  position: undo emits a fresh `add` op, so the element reappears at a re-timed
  index. This is now a written CONTRACT (option (a)); restoring position via a
  verbatim-tag re-add (option (b)) is rejected as UNSOUND -- `apply` discards an
  already-tombstoned tag (`CRDT.js` `if (!removed.has(tagKey))`), so (b) would
  require un-tombstoning it and would diverge permanently from any peer still
  holding that tombstone. Pinned by a regression test; no code change.
- **C-14** the replica-uniqueness + monotonic-lamport assumption the
  `(lamport, replicaId)` total order (and every OR-Set `replicaId + "#" + n` tag)
  rests on, plus the computed collision probability of the widened id, are
  recorded in `decisions/0003` and `llms.txt`.

## [1.2.0] - 2026-09-02

Three orthogonal hygiene fixes on the OR-Set and the cold serialization surface
(`decisions/0002-retention-and-names.md`). Convergence is UNCHANGED; the
remote-op door (C1) and the mutation API are untouched; existing state and ops
are byte-compatible with 1.1.2.

### Fixed

- **C-10** the OR-Set retained a dead empty tag `Map` for every id whose last
  live tag was removed, so `adds` grew O(ops) under add/delete churn. The empty
  entry is now dropped the moment `tags.size === 0` (in `apply`'s `rm` branch,
  after the order-key reads, and in the `mergeState` prune + consistency loops),
  making live-map retention O(live ids). The value register (`valueReg`) is
  deliberately RETAINED: it carries the max-lamport `(l, r)` timestamp, and
  dropping it would let a later lower-`l` re-add / `upd` win and diverge.
- **C-11** `snapshot()` and `getState()` iterated collections in per-replica
  creation order, so two converged replicas emitted different top-level key
  order. Both now iterate collection names SORTED, so converged replicas produce
  byte-identical JSON (each per-collection snapshot already sorted its own keys).
  The torture harness `canon()` shim that papered over this is removed.
- **C-12** a `__proto__` collection name, OR-Set element id, or PN-Counter
  replicaId was silently lost (assigning it to a plain `{}` retargeted the
  object's prototype instead of creating an own key). For the counter this was a
  silent DIVERGENCE, not just a lost key: `getState().p`/`.n` are keyed by
  replicaId, so a `__proto__` replica's cumulative count vanished from
  serialized state and a hydrating peer converged to the wrong value with no
  `onError`. Every `getState()` output object keyed by caller-supplied data --
  the OR-Set `adds`/`values`, the counter `p`/`n`, the map `entries`, and the
  document `getState()`/`snapshot()` `cols` -- now builds over
  `Object.create(null)`, so a `__proto__` name/id/replicaId becomes an own key
  that round-trips through `getState -> mergeState` intact. This removes the
  crafted-`__proto__` hazard with no new throw (consistent with the door's
  reject-and-continue posture); the LWW-Map key guard is unchanged.

### Notes

- Convergence math is unchanged and `valueReg` is deliberately retained (the C4
  tombstone-GC seam widens later, gated by a causal-stability check).

## [1.1.2] - 2026-08-30

The remote-op validation door. `applyOp` / `applyOps` / `mergeState` previously
validated only the op envelope (`t`, `c` are strings) and trusted every field
that drives convergence; a single malformed or crafted remote frame could
silently corrupt a doc or crash the receiver. This release adds one
reject-and-continue validation door on the receive path
(`decisions/0001-remote-op-door.md`). The local mutation API, the convergence
algebra, and the zero-alloc receive hot path are unchanged; existing state and
ops are byte-compatible with 1.1.1.

### Fixed

- **C-01** a remote op with a non-finite `l` (e.g. `Infinity`) permanently
  poisoned the Lamport clock, silently dropping every later local write. `l` is
  now validated finite and `< 2^53` at the door.
- **C-02** a register written with `l: NaN` could never be overwritten (silent
  key freeze). Non-finite lamports are now rejected.
- **C-03** a remote counter op with a non-number / negative `p` or `n` poisoned
  the value (string concat / `NaN` / `Infinity`). Counter cumulatives are now
  validated finite and `>= 0`.
- **C-04** `applyOp` accepted `set`/`del` ops with a missing / non-number `l` or
  missing `r`. Per-op payload schema now enforced.
- **C-05** a kind-mismatched remote op threw uncaught out of `applyOps`. It is
  now dropped and reported to `onError`.
- **C-06** `mergeState` crashed with a raw `TypeError` on a malformed payload.
  It now validates each collection's shape and drops+reports malformed input.
- **C-07** the Lamport clock silently stopped advancing at 2^53. `tick()` now
  throws `clock_ceiling` at the boundary instead of saturating.
Findings C-15 through C-19 were discovered by the reviewer during this session's
audit (they are not in the original ROADMAP registry; see ROADMAP.md sec. 3):

- **C-15** a crafted `mergeState` set collection with an add-id absent from
  `values` (including a prototype-name id such as `toString`) crashed
  `rebuildProjection` and re-emitted the poison. The door now cross-checks live
  add-ids against an own-property (`Object.hasOwn`) `values` entry.
- **C-17** a local write that hit the clock ceiling recorded a phantom undo
  entry before it threw. `tick()` now runs before the undo record, so a failed
  write leaves no phantom inverse.
- **C-18** a time-of-check/time-of-use double-read let a live-accessor payload
  pass validation with a benign value and apply a poison one. `applyOp` now
  copies each untrusted field once into a reused per-doc scratch op (zero
  allocation) and validates + applies off the scratch; `mergeState` validates
  and merges each field from a single read.
- **C-19** `mergeState` advanced the clock only from `state.clock`, leaving an
  absorbed register at a lamport above the clock -> a permanent, self-
  propagating register freeze. `mergeState` now advances the clock past every
  register/tag lamport it absorbs, symmetric with `applyOp`.

### Changed

- **`applyOp` is STRICT; `applyOps` is RESILIENT (C-16).** A single `applyOp`
  throws `malformed_op` on a non-op envelope or unknown op type (local
  programmer-error surface); `applyOps` never throws on a bad frame -- each is
  caught, routed to `onError`, and the batch continues, so every good frame
  applies. The `BroadcastChannel` receive path is wrapped so a crafted frame
  cannot escape `onmessage`.
- **`onError`** now also receives every remote op / state the door drops (a
  malformed field, a kind-mismatch, a malformed merge payload), in addition to
  errors thrown by `op`/`change` listeners.

### Notes

- Verified by 151 `node:test` cases (0 failing) and the torture gate
  (`node --expose-gc test/torture.mjs` -> `ok`) at seeds 1/7/12345/99999 and
  `TORTURE_SCALE=4`. The `applyOp` receive hot path remains zero-allocation
  (`maxMajor: 0`, `maxArrayBuffersGrowth: 0`, `stabilize: 'deep'`).

## [1.1.1] - 2026-08-30

Packaging and gate release. No behaviour change to the runtime; existing state
and ops are byte-compatible with 1.1.0.

### Added

- **`package.json`** -- the package had none, so it could not be installed,
  tested, or published. Declares `type: module`, `exports`, `files[]`,
  `engines.node >=18`, its `@zakkster/lite-store` + `@zakkster/lite-signal`
  runtime deps, and `@zakkster/lite-gc-profiler` + `@zakkster/lite-leak` dev
  deps. Scripts: `test`, `torture`, `verify`.
- **`VERSION`** export from `CRDT.js`, in three-place sync with `package.json`
  and this file.
- **Gated torture harness** (`test/torture.mjs` + `test/torture/`): a seeded,
  zero-alloc-gated suite over the fixed T0..T9 tier namespace. Wired this
  release: T0 metamorphic laws, T5 differential convergence fuzz (a gated,
  fixed-capacity descendant of `bench/torture/convergence-fuzzer.mjs`), T6 the
  zero-alloc gate on the `applyOp` receive path (`maxArrayBuffersGrowth: 0`,
  `stabilize: 'deep'`), T7 the merge-cycle soak with a `lite-leak` retention
  witness, and T9 the controls tier (every gate proven able to fail). T1 and T4
  are registered thin and filled in 1.1.2.

### Known issues (reproduced; fixed in 1.1.2 -- see ROADMAP.md sec. 3)

The remote `applyOp` / `mergeState` path validates the op envelope (`t`, `c`)
but trusts the payload. Registered as `todo` regression tests in
`test/regressions.test.mjs`, each with a runnable reproduction:

- **C-01** a remote op with `l: Infinity` permanently poisons the Lamport clock.
- **C-02** a register written with `l: NaN` can never be overwritten.
- **C-03** a remote counter op with a non-number `p`/`n` poisons the value.
- **C-04** `applyOp` accepts `set`/`del` ops with missing / non-number `l`.
- **C-05** a kind-mismatched remote op throws uncaught out of `applyOps`.
- **C-06** `mergeState` throws a raw `TypeError` on a malformed payload.
- **C-07** the Lamport clock silently stops advancing at 2^53.

## [1.1.0] - 2026-07-16

### Added

- **PN-Counter** (`doc.counter(name)`): a Positive-Negative counter built from
  two grow-only per-replica maps (increments P, decrements N); the value is
  `sum(P) - sum(N)`. Ops carry a replica's new cumulative P (or N) and merge by
  **max**, so a counter op is idempotent and commutative like the LWW/OR ops --
  no Lamport clock needed. `inc(by=1)` / `dec(by=1)`, reactive `value()` and
  untracked `peek()`. Ideal for votes, likes and presence counts.
- **`doc.transact(fn)`**: buffers every op emitted during `fn` and flushes them
  as ONE op-array payload -- a single `ops` event (one network frame, one
  `applyOps` on the far side) and a single coalesced `change`. Reactive readers
  update once (the burst runs inside a lite-signal `batch`). Nested transactions
  flush only at the outermost boundary; ops staged before a throw still flush.
- **Local undo/redo**: `undo()` / `redo()` / `canUndo()` / `canRedo()` /
  `clearHistory()`. Because ops are explicit, the inverse of a local edit is
  captured at the mutation site into a bounded ring (`undoDepth`, default 100;
  0 disables). Undo/redo are themselves local edits: they emit a real op, so a
  peer applying it converges. Covers map set/delete, OR-Set add/update/remove,
  and counter inc/dec. A fresh edit clears the redo ring.
- **`doc.on("ops", cb)`**: batched op stream (one call per transaction, or a
  1-op array per single edit). The built-in BroadcastChannel transport now uses
  it, so a transaction crosses the wire as one frame; it still accepts legacy
  single-op frames on receive.

### Notes

- New op types `cinc` / `cdec` extend the `Op` union. They carry no Lamport
  field (counters converge by max, not by total order); `applyOp` skips the
  clock-merge step for them.
- No breaking changes: existing `map` / `array` / `on("op")` / `on("change")`
  behaviour is unchanged. 27 new tests (counter, transact, undo); 99 total.

### Changed

- **Map read APIs are ordered, not insertion-ordered.** `keys()`, `values()`,
  `entries()` and `snapshot()` on an LWW-Map now return keys in sorted order.
  Two replicas that converge on identical key/value pairs still *learn* those
  keys in different orders, so raw insertion order disagreed across replicas on
  385 of 400 fuzz seeds -- a list rendered from `entries()` sat in a different
  order on every peer, and a snapshot hash differed for identical state. Sorting
  is what makes the public read APIs replica-independent. If you were relying on
  insertion order, carry an explicit ordering field.
- **Peer dependency on `@zakkster/lite-store` raised to `^1.2.0`.** The rendered
  feed case (a collection held at a fixed cap while rows churn) needs lite-store's
  array shrink-path disposal; on 1.0.0 the node ledger grows without bound and the
  torture suite exhausts a 4,096-node registry.

### Fixed

Found by the adversarial suite below during the v1.1.0 prepublish review. The
theme is silent divergence: nothing throws, one replica simply ends up in a
different state than another, or a write is accepted and lost.

- **The `.store` read-only guard was one level deep.** Only the top object was
  protected: the `get` trap handed back the child store proxy raw, so
  `map.store.cfg.theme = "dark"` sailed through, mutated CRDT state, fired local
  UI reactivity and emitted **no op** -- the exact silent desync the guard exists
  to prevent. The guard is now applied at every depth, with nested views cached
  in a `WeakMap` so identity stays stable (`s.cfg === s.cfg`) and a hot render
  loop re-wraps nothing. `get()`, `values()` and `entries()` were handing out the
  same mutable internals by another door; they now wrap what they return.
- **The OR-Set's read APIs still handed out mutable internals.** The same fix was
  applied to the map's `get()` / `values()` / `entries()` but not to the set's:
  `roWrap` was destructured in the OR-Set and never called, so `array().get(id)`
  returned the raw stored value and `values()` the unwrapped targets. Writing
  through either mutated CRDT state and emitted no op. Both are now wrapped, so
  the guard holds through every read door; the documented read-spread-push edit
  pattern is unaffected.
- **A replicaId containing `#` inverted list order between peers.** OR-Set order
  keys are recovered from a `replicaId + "#" + counter` tag by splitting on the
  separator -- with `indexOf`, `"team#alice"` and `"team#bob"` both parsed to
  `"team"`, collapsing two distinct replicas onto one order key. Split on the
  LAST `#`, so any replicaId is safe.
- **`"__proto__"` as a map key evaporated.** `proj["__proto__"] = v` retargets
  the projection's prototype instead of creating an own key, so the write
  vanished: `get()` returned `{}`, `keys()` never listed it, `getState()` dropped
  it. A local `set()` / `delete()` now throws `CRDTError("misconfigured")` so the
  author finds out immediately, while an incoming remote op is *ignored* rather
  than throwing -- a peer must not be able to crash us with one crafted op.
- **Counter deltas were silently corrupted by `by | 0`.** `inc(2.5)` counted 2,
  `inc(1e10)` wrapped to 1410065408, and `inc(2**31)`, `inc(Infinity)` and
  `inc(NaN)` were all silent no-ops. Non-integer and unsafe-integer arguments now
  throw `CRDTError("misconfigured")`; non-positive stays a documented no-op. A
  counter that quietly miscounts is worse than one that refuses.

### Torture (opt-in: `npm run test:torture`)

- `test/11-torture.test.mjs` -- adversarial regression suite, part of the normal
  `npm test`. Each case pins one of the defects above, or a limit that is
  deliberately not fixed and must not drift silently.
- `bench/torture/convergence-fuzzer.mjs` — seeded, oracle-checked fuzz: op-log convergence
  under shuffled + duplicated delivery across map/OR-set/counter (the core
  commutative+idempotent guarantee); random transactions verified one-frame and
  peer-convergent; and a 6k-step undo/redo interleaving checked against a
  reference history stack. Scale with `TORTURE_SCALE`. Dev-only; not in `files[]`.

## [1.0.0] - 2026-06-02

### Added

- Initial release.
- `createCRDTDoc({ replicaId?, clock?, onError? })` -- a document namespace of
  convergent collections sharing one Lamport clock and replica id.
- **LWW-Map** (`doc.map`): last-write-wins register map; conflicts resolve by a
  `(lamport, replicaId)` total order; deletes are timestamped tombstones that
  compete with writes. Fine-grained reactive `get`/`has`; coarse reactive
  `keys`/`values`/`entries`/`size`.
- **OR-Set** (`doc.array`): observed-remove set keyed by a stable element id,
  with a last-write-wins value register per id. Add-wins for concurrent
  add/remove; re-adding a present id edits its value in place without changing
  order; `delete` removes only observed tags. Configurable `identify`.
- Reactive read-model: every collection projects converged state into a
  read-only `@zakkster/lite-store` proxy exposed as `collection.store`. Direct
  mutation of the projection throws `CRDTError("readonly")`.
- Transport-agnostic operation flow: `doc.on('op', cb)` out, `doc.applyOp(op)`
  in. Operations are plain JSON, commutative, and idempotent; delivery may be
  reordered and duplicated.
- Full-state sync for late joiners: `doc.getState()` / `doc.mergeState(state)`,
  idempotent and commutative.
- `doc.on('change', cb)`, `doc.snapshot()`, `doc.dispose()`, `doc.clock()`.
- `connectBroadcastChannel(doc, channelName)` -- optional zero-config cross-tab
  transport over the native BroadcastChannel, with a state handshake that
  hydrates late-joining tabs in one payload. Zero added dependency.
- `CRDTError` with `code` of `kind_mismatch`, `malformed_op`, `readonly`, or
  `misconfigured`.
- Full TypeScript definitions.
- 54 tests under `node --test`, including order-independent and
  duplicate-tolerant multi-replica convergence.

### Notes

- Out of scope for v1: RGA / positional sequences and reorder, rich text, and
  vector-clock tombstone garbage collection.
- Values are held by reference locally and copied over the wire; treat them as
  immutable.

[1.0.0]: https://github.com/PeshoVurtoleta/lite-crdt/releases/tag/v1.0.0
