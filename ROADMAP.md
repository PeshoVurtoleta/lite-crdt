# lite-crdt — enriched roadmap

Eight sessions for one package. Supersedes the terse `lite-crdt` section of
`ROADMAP.ecosystem.md` (three bullet-milestones: 1.1 ergonomics, 1.2 compaction,
2.0 RGA). The ergonomics milestone already shipped in v1.1.0 (`counter`,
`transact`, `undo/redo`), so this roadmap does not re-plan it — it plans what
running the code revealed instead.

**Why it grew.** The original three-bullet plan assumed the core was correct and
the work was additive (compaction, then RGA). I pulled the repo and ran the
code. The core *merge algebra* is correct — 200 seeded convergence fuzz runs, op-
based and state-based, reordered and duplicated, all converged (section 2, the
one honest strength). But the package is not shippable and it is not safe:

| Axis | State |
| --- | --- |
| **Publishing** | **There is no `package.json`.** No deps declared, no `type:module`, no `exports`, no `files[]`, no `test`/`torture` scripts, no `engines`, no version sync. The package imports `@zakkster/lite-store` + `@zakkster/lite-signal` and cannot be installed. |
| **Correctness (local)** | Good. The mutation API is hardened: `counterStep` rejects non-integers, `__proto__` keys throw at `set()`, ticks are monotonic, reads are wrapped read-only. |
| **Correctness (remote)** | **Broken.** `applyOp`/`applyOps`/`mergeState` validate the op *envelope* (`t`,`c` are strings) and nothing else. Every field that drives convergence — `l`, `r`, `p`, `n` — is trusted. Four S1 corruptions and three S2 crashes follow, all reproduced. |
| **Gate** | `bench/torture/convergence-fuzzer.mjs` exists and is good, but it is not wired (no `package.json`), runs with `onCapacityExceeded:"grow"` (so it never tests zero-alloc), has no `lite-gc-profiler`/`lite-leak` witnesses, no controls tier, and — the sharp part — **only ever replays ops the library itself emitted, so it is structurally blind to every remote-op finding below.** |

None of the sessions are padding. Each is anchored to a finding ID in section 3,
and **every finding was reproduced against `main` on 2026-08-30**, not inferred
from reading.

The one sentence this whole roadmap turns on:

> **The local mutation path validates its input. The remote apply/merge path
> validates nothing. Convergence math is not the bug; the trust boundary is.**

---

## 1. Scope check (do this before anything else)

The published scope is **`@zakkster`** (one `s`). The peers this package needs
for its gate resolve to real directories in the suite:

| Package | Directory | Role |
| --- | --- | --- |
| `@zakkster/lite-store` | `LiteStore` (v1.2.0) | runtime dep (reactive read model) |
| `@zakkster/lite-signal` | `LiteSignal` (v1.5.0) | transitive runtime dep |
| `@zakkster/lite-gc-profiler` | `LiteGCProfiler` **and** `LiteGcProfiler` | devDep (zero-alloc gate) |
| `@zakkster/lite-leak` | `LiteLeak` | devDep (retention witness) |

**Two directories both claim `@zakkster/lite-gc-profiler`** (`LiteGCProfiler` and
`LiteGcProfiler`). Before wiring the devDep in C0, confirm which one is the
published/canonical source and pin to it; do not guess from the casing. Grep the
ecosystem for `@zakksters` (trailing `s`) before trusting any devDep line — the
sibling roadmap found that exact typo live on the registry.

The version string lives in exactly one place today (`CRDT.js:2`,
`v1.1.0`) — not in `CRDT.d.ts`, not in `llms.txt`, and there is no `VERSION`
export and no `package.json` to hold a fourth. C0 establishes three-place sync
(package.json + `VERSION` const + CHANGELOG) from its release forward.

---

## 2. Shared law (holds every session)

1. **Fail closed on every unverified state. Null is not zero.** A remote op or a
   merge payload is untrusted input from another machine. It is validated at the
   door or it does not enter. It must never be accepted, silently poison a
   register or the Lamport clock, and surface three edits later as a frozen key
   or a `NaN` counter. `llms.txt` already states the intent for one key
   (`__proto__`: "a peer must not be able to crash us"); this law extends that
   sentence to the whole remote surface.
2. **The type contract is the runtime contract.** `CRDT.d.ts` declares `l:
   number`, `r: string`, `p: number`. The runtime accepts `l: "5"`, `l: NaN`,
   `p: "999"`. Where the `.d.ts` already promises a shape, the door enforces it —
   the types stop being a suggestion.
3. **Convergence is the gate, not a feature.** Op-based AND state-based, under
   reordering and duplication, N replicas reach a byte-identical *canonical*
   snapshot. Every session ends with the convergence fuzz green, and no session
   may add an op field or merge path without extending the fuzz to cover it.
4. **Idempotent + commutative by construction — and provably so.** Every op
   applied twice equals once; every pair of ops applies in either order to the
   same state. This is asserted as a law over the fuzz corpus (T0), not assumed
   from the design comment.
5. **Bytes in a hot body, not instructions.** The door's validation runs on
   `applyOp`/`mergeState` — the network-receive path, not a per-frame render
   path — so it is allowed to cost. But `emit`, `apply`'s happy path, and the
   reactive `reconcile` must gain zero allocation; prove it with the alloc gate,
   do not assert it.
6. **Every gate must be provably able to fail.** Every torture tier ships a
   deliberately-broken control variant that makes the suite exit non-zero. A
   convergence gate that cannot see a dropped op is decoration (see the note on
   the existing fuzzer, and AR-02 in the sibling roadmap).

---

## 3. Verified findings

Reproduced against `main` on 2026-08-30 with `@zakkster/lite-store@1.2.0` +
`@zakkster/lite-signal@1.5.0`. Severity: **S1** = silent data loss or
corruption, **S2** = broken documented guarantee (incl. a crash a peer can
trigger), **S3** = hygiene / contract gap.

### The remote trust boundary (the core of this roadmap)

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **C-01** | **S1** | **A remote op poisons the Lamport clock, permanently and silently.** `applyOp` does `if (typeof op.l === "number" && op.l > lamport) lamport = op.l` (`CRDT.js:835`) with no finiteness check. One op with `l: Infinity` sets `lamport = Infinity`; `tick()` is `++lamport` (`CRDT.js:681`), so every subsequent local write also gets `Infinity`, they all tie, `tsWins` returns false on a tie — and **every later local edit silently loses to the first one at that timestamp.** The doc never recovers. | `applyOp({t:"set",c:"m",k:"b",l:Infinity,r:"x",v:1})` -> `clock()===Infinity`; then two `set`s to the same key, second does not win |
| **C-02** | **S1** | **A register written with `l: NaN` can never be overwritten.** `tsWins(op.l,...,NaN,...)` compares `op.l !== NaN` (always true) then `op.l > NaN` (always false), so no later write ever beats a NaN-stamped register. A single malformed remote `set` freezes that key forever; the legitimate local edit that follows vanishes with no error. | `applyOp({t:"set",...,k:"k",l:NaN,...,v:"stuck"})` then `map.set("k","fresh")` -> `get("k")==="stuck"` |
| **C-03** | **S1** | **A remote counter op poisons the value into a string / NaN / Infinity.** `apply` for `cinc`/`cdec` does `if (op.p > cur) P.set(op.r, op.p)` (`CRDT.js:590`) with no numeric check, and `recompute` sums with `+` (`CRDT.js:580`). `p:"999"` makes the value `"5999"` (string concat); `p:Infinity` makes it `Infinity`; `p:NaN` sticks. The **local** path is guarded by `counterStep` (`CRDT.js:560`); the **remote** path is not — same asymmetry as C-01/C-02. | `counter.inc(5)`; `applyOp({t:"cinc",c:"c",r:"e",p:"999"})` -> `peek()==="5999"` |
| **C-04** | **S1** | **`applyOp` validates the envelope and trusts the payload.** The only check is `t` and `c` are strings (`CRDT.js:830`). `set`/`del` ops with `l` missing / `null` / `"5"` / `NaN`, or `r` missing, are all applied. This is the umbrella over C-01/C-02: there is no per-type payload schema on the receive path, and `llms.txt:116` ("malformed_op — applyOp received a non-op or unknown op type") describes only the envelope check, overselling it. | `applyOp({t:"set",c:"m",k:"b",r:"x",v:1})` (no `l`) -> accepted, register stored with `l===undefined` |
| **C-05** | **S2** | **A kind-mismatched remote op crashes the receiver.** A `set` op naming a collection that exists locally as a set (or vice-versa) makes `getCollection` throw `CRDTError(kind_mismatch)` (`CRDT.js:762`), which propagates **uncaught** out of `applyOps` — and `connectBroadcastChannel.onmessage` calls `doc.applyOps(m.ops)` with no guard (`CRDT.js:919`). One crafted frame from any tab aborts the batch mid-apply (partial application) and throws in the message handler. The `onError` hook covers local dispatch, not the apply path. | `map("x").set("a",1)`; `applyOp({t:"add",c:"x",id:"1",...})` -> throws `kind_mismatch` |
| **C-06** | **S2** | **`mergeState` is not fail-closed on a malformed payload.** A peer's `getState()` output is untrusted. A set collection missing `removed` throws a raw `TypeError` (`s.removed.length`, `CRDT.js:475`); `cols:null`, a map missing `entries`, and a counter missing `p` are silently accepted as no-ops. Malformed state should be rejected as a `CRDTError`, not crash or silently drop. | `mergeState({cols:{A:{kind:"set",adds:{},values:{}}}})` -> `TypeError` |
| **C-07** | **S2** | **The Lamport clock silently stops advancing at 2^53.** Once `lamport >= 2^53`, `++lamport` is a float no-op, so concurrent local writes all tie and causal ordering degrades to replicaId-only — silently. Reachable independently of C-01 by a remote op carrying a large finite `l` (a peer can freeze the clock with `l: 2**53`), and the door (C1) is where the bound is enforced. | `applyOp({t:"set",...,l:2**53,...})` then two local sets -> `clock()` never advances |

### Structure, retention, and determinism

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **C-08** | **S3 (blocker)** | **No `package.json`.** Cannot be published or installed; no declared deps, `type:module`, `exports`, `files[]`, `engines`, `test`/`torture` scripts, devDeps, `VERSION`, or version sync. Worse than the sibling packages' starting state — they at least had a `package.json` and a runner. | `ls package.json` -> not found |
| **C-09** | **S3** | **No gated torture harness.** The bench fuzzer is not wired, runs with `onCapacityExceeded:"grow"` (never tests zero-alloc), lacks `lite-gc-profiler`/`lite-leak` witnesses and `maxArrayBuffersGrowth`, has no controls tier, and **only replays library-emitted ops** — so it cannot exercise C-01..C-07. Coverage without exercise. | read `bench/torture/convergence-fuzzer.mjs` |
| **C-10** | S3 | **Retention past the declared tombstone growth.** After an OR-Set id's tags are all removed, `adds` keeps an empty `Map` for the id and `valueReg` keeps its value register forever (never deleted in the `rm` path, `CRDT.js:405`). The `removed` set growing is the declared v2-GC item; the empty-`adds` + `valueReg` retention is **undeclared**. | 1000× `add({id:"x"})`/`delete` -> `valueReg` still holds `x`, `adds` holds an empty map |
| **C-11** | S3 | **`doc.snapshot()` top-level key order is replica-dependent.** Per-collection snapshots sort their keys, but the doc-level object iterates `cols` in per-replica *creation* order (`CRDT.js:869`). Two converged replicas emit byte-different `snapshot()` JSON, so any caller that hashes/diffs the whole-doc snapshot sees false divergence. | two replicas, same ops different order -> equal per-collection, unequal `JSON.stringify(snapshot())` |
| **C-12** | S3 | **A collection named `__proto__` is silently lost by `getState()`.** `out[name]` on a plain object (`CRDT.js:843`) drops `__proto__`, so that collection vanishes from state-based sync (and a crafted `mergeState` can throw on it). Map *keys* are guarded (`CRDT.js:220`); collection *names* are not. | `map("__proto__").set("k",1)`; `getState().cols` -> `{}` |
| **C-13** | S3 (contract) | **Undo of an OR-Set removal re-times element order.** Undo re-adds the id with a fresh tag, so its order key changes and it can reappear at a different index (membership + value restored, position not). The bench fuzzer's own comment calls this "legitimate re-timing" — so this needs a **written contract decision** (is undo order-preserving?), not an assumed bug. | `add(1),add(2),delete(1),undo()` -> `[{2},{1}]`, not `[{1},{2}]` |
| **C-14** | S3 (contract) | **Equal `(lamport, replicaId)` ops with different values diverge** (first-applied wins). Depends on the replica-uniqueness + monotonic-lamport assumption, which `genReplicaId()` backs with only ~2^32 of entropy (8 hex chars). Document the assumption; consider widening the id. | two ops `l:5,r:"z"` with `v:"one"`/`v:"two"` in opposite orders -> two replicas disagree |

### Review-discovered during C1 (fixed in 1.1.2)

These were not in the original registry above; the reviewer surfaced them while
auditing the C1 door diff, and every one was reproduced with a concrete input.
They are all the same class as C-01..C-07 (the untrusted receive boundary), which
is why they belong to the door session that found them rather than a later one.

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **C-15** | **S1** | A crafted `mergeState` set collection with a live add-id absent from `values` (including a prototype-name id, e.g. `toString`, via an `in`-chain walk) passed shape validation, then `rebuildProjection` dereferenced `.v` off `undefined` -> raw `TypeError`, permanent collection corruption, and the poison re-emitted in the next `getState()`. Fixed: `okState` cross-checks live add-ids against an own-property `values` entry (`Object.hasOwn`). | `mergeState({cols:{A:{kind:"set",adds:{toString:{"peer#0":5}},removed:[],values:{}}}})` |
| **C-16** | S2 | `applyOps([{t:"bogus"}, goodOp])` threw out of the batch and dropped every following good op (the C-05 batch-halt class on the direct-caller path). Fixed: `applyOp` stays strict; `applyOps` is resilient -- each bad frame is caught, reported to `onError`, and the batch continues. | `applyOps([{t:"bogus",c:"m"}, {t:"set",c:"m",k:"good",l:5,r:"peer",v:42}])` -> good op lost |
| **C-17** | S3 | A local write that hit the `clock_ceiling` recorded a phantom undo entry before it threw, so `canUndo()` returned true for a write that never applied. Fixed: `tick()` runs before `record()`. | drive clock to `2^53-1`, local `set()` throws, `canUndo()` was true |
| **C-18** | **S1** | A time-of-check/time-of-use double-read let a live-accessor payload (getter/Proxy) return a benign value to the validator and a poison one to the merge, slipping a non-finite lamport/counter past the door. Not reachable via a serializing transport (JSON is static); reachable via a same-process live object. Fixed: `applyOp` copies each untrusted field once into a reused per-doc scratch op (zero-alloc) and validates+applies off it; `mergeState` reads each field once. | `values.x` getter returning `[1,"peer","ok"]` then `[Infinity,"peer","POISON"]` |
| **C-19** | S2 | `mergeState` advanced the clock only from `state.clock`, leaving an absorbed register at a lamport above the clock -> the merged key was silently, permanently frozen against later local writes, self-propagating via `getState()`. Fixed: `mergeState` advances the clock past every register/tag lamport it absorbs, symmetric with `applyOp`; lamports `>= 2^53` are dropped. | `mergeState({clock:0,cols:{m:{kind:"map",entries:{x:[9,"peer",0,"remote"]}}}})` then local `set("x",...)` loses |

### QA-discovered during C3 (deferred as a non-blocking follow-up; fixed in 1.3.1)

C3's independent QA suite (`test/15-qa-c3-boundary.test.mjs`) enumerated two
misconfiguration cases the C3 planner had not, and PINNED them as the
then-current behaviour. They are pre-existing (not a C3 regression), so C3 shipped
and this was logged as a follow-up rather than blocking the release. Fixed in the
v1.3.1 patch below (rebased past C4/1.3.0, which landed first); the C3 pins were
flipped to assert the corrected behaviour.

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **C-20** | S2 | **A caller-supplied `replicaId` is not validated at the local boundary.** `createCRDTDoc` does `opts.replicaId \|\| genReplicaId()` (`CRDT.js:879`) with no type/emptiness check, while the remote door `okOp` requires `typeof op.r === "string" && op.r.length > 0` (`CRDT.js:826/831`). (1) A non-string but truthy id is accepted locally, but every op it emits carries a non-string `r` that EVERY peer's door DROPS -> the replica's writes never converge, a one-way silent divergence with zero `onError` locally. (2) A falsy id (`""`, `0`, `null`) falls through the `\|\|` and is silently auto-minted, overriding a caller who supplied a specific id. Fixed: `createCRDTDoc` validates a provided id to a non-empty string (mirroring the door -- no charset/length cap, so `"team#alice"` stays valid), throws `CRDTError("misconfigured")` otherwise; only an OMITTED (`=== undefined`) id auto-mints. The fail-closed enforcement of the uniqueness assumption C-14 only documented. `decisions/0005` (line refs are pre-1.3.0; `createCRDTDoc` moved after the C4 merge). | `createCRDTDoc({replicaId:42})` mutates locally but every peer drops its ops; `createCRDTDoc({replicaId:""})` silently auto-mints instead of using `""` |

### The one invariant that catches the structural findings

A test-only `validate(doc)` asserting, per collection:

```
OR-Set:  every id with tags.size > 0 has a valueReg entry AND a cached order key;
         proj[] is exactly the live ids in `order`; `order` is sorted by order key.
LWW-Map: proj keys == entries whose register is not a tombstone; every register
         lamport is finite.
Counter: every P/N value is a finite, non-negative number.
Doc:     lamport is finite; lamport >= every stored register lamport.
```

C-01, C-02, C-03, C-07 and C-10 all violate one of these lines the moment they
occur. It is O(state) so it belongs in `validate()` and between torture phases,
never on a hot path — the centrepiece of C1's proof, run after every fuzz
sequence.

---

## 4. The torture suite (`test/torture.mjs`) — spec

One harness, the fixed T0..T9 tier namespace (sparse — wire what the package
needs, reserve the rest), built once in C0 and extended by each later session.
The harness spine is lifted verbatim from lite-bvh: `SEED` + `makePrng`
(xorshift32, 0-seed guarded), `check(cond, msgThunk)` (message built by a thunk,
only on failure — a per-iteration template literal is an allocation that fails
your own gate), `die`, and `runOpsGate` with `RULES = { maxMajor: 0, maxPauseMs:
4, maxArrayBuffersGrowth: 0 }` and `stabilize: 'deep'`.

```
test/
  torture.mjs           # entry: runs tiers in order, prints exactly "ok", exit 0/1
  torture/
    harness.mjs         # SEED, makePrng, check/die, runOpsGate, validate(doc), canon()
    t0-laws.mjs         # idempotence / commutativity / associativity of apply + merge
    t1-degenerate.mjs   # every op type crossed with every degenerate payload
    t4-door.mjs         # the remote-op + mergeState validation door (C1 fills this)
    t5-fuzz.mjs         # differential convergence fuzz vs a reference apply (the oracle)
    t6-alloc.mjs        # zero-alloc gate on emit/apply/reconcile + maxArrayBuffersGrowth
    t7-soak.mjs         # merge-cycle soak + retention bound + lite-leak witness
    t9-controls.mjs     # every gate above, deliberately broken, must fail
```

`test/` and `bench/` never enter `files[]`. `npm pack --dry-run` proves it.

**Registry note (the C-09 trap).** lite-crdt state lives in lite-signal nodes via
lite-store. The gate must pre-grow the signal registry to the run's high-water
mark *before* the measured window (`createRegistry({ maxNodes, maxLinks })` with
`onCapacityExceeded:"throw"`), never `"grow"` — a registry that grows mid-measure
is the allocation the gate exists to catch, hiding under the profiler's
ArrayBuffer blind spot. This is exactly why the existing bench fuzzer's `"grow"`
registry can never be a zero-alloc gate.

### Tier T0 — metamorphic laws
Over the fuzz corpus: `apply(op)` twice == once (idempotence); `apply(a);apply(b)`
== `apply(b);apply(a)` (commutativity) into a canonical snapshot; `mergeState` is
idempotent and commutative; `getState` then `mergeState` into a fresh doc is the
identity; a single `emit` delivered to a peer == the peer applying that one op.

### Tier T1 — degenerate payloads
Cross every op type with: `l` = `0`, `-1`, `NaN`, `+Inf`, `-Inf`, `"5"`, missing,
`2^53`, `2^53+1`; `r` = missing, `""`, a replicaId containing `#`; `v` =
`undefined`, `NaN`, `-0`, a `__proto__`-bearing object; counter `p`/`n` =
`"9"`, `NaN`, `Inf`, `-5`, `2.5`; OR-Set `id` = `null`, `""`, `"__proto__"`,
a number. Pin the **decided** policy for each (throw / clamp / ignore) — pinning
"this throws `CRDTError(malformed_op)`" is a valid contract; leaving it unpinned
is not.

### Tier T4 — the validation door
The CRDT analogue of lite-bvh's handle-abuse tier. For every finding C-01..C-07:
a **fails-before / passes-after** test that feeds the poison op/state and asserts
(a) it is rejected per the recorded policy, and (b) `validate(doc)` passes and the
snapshot is **byte-identical** to a clean run that never saw the poison. Plus:
kind-mismatch routed to `onError` (not thrown), a malformed `mergeState` rejected
as a `CRDTError`, and the BroadcastChannel receive path proven not to throw on a
crafted frame.

### Tier T5 — differential convergence fuzz (the oracle)
Promote and harden `bench/torture/convergence-fuzzer.mjs`. N replicas emit random
ops over a conflict-dense key space; the op log is replayed in many shuffled,
duplicated orders into fresh docs; every replay must reach the identical
**canonical** snapshot (C-11's `canon()`), and identical to a single-order
reference apply — the reference IS the oracle. **New in this roadmap:** inject
malformed/adversarial ops into the stream (from T1's corpus) that the door must
reject *without diverging any replica* — the coverage the existing fuzzer
structurally lacks.

### Tier T6 — the zero-alloc gate
`runOpsGate` over a mixed `set`/`add`/`delete`/`inc`/`applyOp` loop with the
registry pre-grown: `maxMajor:0`, `maxArrayBuffersGrowth:0`, `stabilize:'deep'`.
Plus a direct structural assertion the heap gate cannot make — e.g. `emit` of a
single op does not allocate a new array on the `on('op')` path, and `apply`'s
happy path mutates registers in place.

### Tier T7 — soak, retention, conservation
`leak_cycles`-style build-up / tear-down over merge cycles. After each cycle:
`validate(doc)` passes; `dispose()` leaves zero retained (a `lite-leak`
`createLeakTracker` witness, a second independent signal from the heap gate); and
the retention bound from C-10's decision holds (removed/adds/valueReg growth is
whatever was decided, and it is *bounded* by that decision, not monotonic by
accident).

### Tier T9 — controls (the gate must be able to fail)
A non-idempotent `apply` (applies twice), a merge that drops a concurrent op, a
poison op that bypasses the door, an allocating hot loop, and a `"grow"` registry
under the alloc gate — each must exit non-zero. Include the **non-vacuity**
control from lite-bvh: prove the convergence gate actually *fails* on a real
divergence, not just passes on a corpus that never diverges.

---

## 5. Session order

```
C0 ──► C1 ──► C2 ──► C3 ──► C4 ──► C5(2.0)
 ✔      ✔     ✔      ✔      ✔     ◄── next
                      └► C3.1 (C-20, shipped as v1.3.1 on top of C4/1.3.0)
```
(C0 shipped as v1.1.1, published 2026-08-30. C3.1 is the C-20 follow-up logged
during C3's QA; originally scoped as v1.2.2, it was rebased past C4 and landed as
the v1.3.1 patch — a boundary fix, not a new arc item.)

`C0` (package.json + harness) blocks everything — there is no gate and no way to
`npm test` until it lands. `C1` (the validation door) blocks C2+ — do not build
retention, compaction or RGA on a structure a single remote op can corrupt. `C4`
(tombstone compaction + delta sync) and `C5` (RGA, the declared 2.0 headline)
are the original roadmap's feature line, re-sequenced to stand on a validated
base rather than a trusting one.

---

## 6. The briefs

===============================================================================
# C0 — lite-crdt v1.1.1 — package.json + node:test + the torture skeleton
===============================================================================

```markdown
---
package: "@zakkster/lite-crdt"
version_target: 1.1.1
status: shipped   # published 2026-08-30; 130 tests (123 pass / 7 todo), torture "ok"
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
runtime_deps: ["@zakkster/lite-store", "@zakkster/lite-signal"]
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [C-08, C-09]
blocks: [C1]
---

# lite-crdt — make it a package, stand up the gate

PURPOSE
  There is no package.json. The package cannot be installed, tested, or gated.
  Create it, then build the harness every later session leans on. No behaviour
  change — this session only makes the package real and the bugs visible.

TASKS
  - Author package.json: name "@zakkster/lite-crdt", version 1.1.1, type "module",
    main/module/exports -> ./CRDT.js, types -> ./CRDT.d.ts, sideEffects false,
    engines.node >=18, license MIT, author "Zahary Shinikchiev
    <shinikchiev@yahoo.com>" (never "Karadjov"). files[] = CRDT.js, CRDT.d.ts,
    llms.txt, CHANGELOG.md, LICENSE, FORMAT-if-any. dependencies: lite-store,
    lite-signal (pin to the installed sibling versions: store 1.2.0, signal 1.5.0
    — verify). devDependencies: lite-gc-profiler, lite-leak (resolve the
    LiteGCProfiler vs LiteGcProfiler ambiguity from section 1 first). scripts:
    "test":"node --expose-gc --test test/*.test.mjs",
    "torture":"node --expose-gc test/torture.mjs",
    "verify":"npm test && npm run torture", plus "prepublishOnly":"npm run verify".
  - Add a VERSION const exported from CRDT.js; sync CRDT.js header + VERSION +
    package.json + CHANGELOG. Three-place sync from this release forward.
  - Confirm the existing test/*.test.mjs run under `node --test` (they already use
    node:test import style). Add test/*.test.mjs to the glob; do NOT rewrite them.
  - Build test/torture.mjs + test/torture/harness.mjs per section 4. Wire T0, T5
    (promote the bench fuzzer), T6, T7, T9 now. Register T1 and T4 as tiers with
    one case each; C1 fills them. Add validate(doc) and canon(doc) to harness.mjs.
  - The bench fuzzer stays in bench/ as-is; T5 is a new, gated, pre-grown-registry
    descendant of it, not a move.

ASSERTIONS
  - `npm test` green under node:test. `npm run torture` prints exactly "ok", exit 0.
  - T9 controls each exit non-zero (a "grow" registry under the alloc gate; an
    allocating loop; a dropped-op merge).
  - T6 passes with the registry pre-grown and `maxArrayBuffersGrowth:0`,
    `stabilize:'deep'`.
  - `npm pack --dry-run` includes CRDT.js/.d.ts/llms.txt/CHANGELOG and EXCLUDES
    test/ and bench/.
  - The C-01..C-07 repros are registered as `todo`/failing with their reproductions.

NON-GOALS
  No fixes. No behaviour change. Findings recorded in CHANGELOG as known issues,
  fixed in C1.

DONE WHEN
  package.json exists and installs; `npm test` + `npm run torture` green; the
  seven remote-boundary findings registered as failing with reproductions
```

===============================================================================
# C1 — lite-crdt v1.1.2 — the remote-op validation door
===============================================================================

```markdown
---
package: "@zakkster/lite-crdt"
version_target: 1.1.2
status: shipped   # published 2026-08-30; 151 tests (151 pass / 0 todo), torture "ok"; door findings C-01..C-07, C-15..C-19
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
findings: [C-01, C-02, C-03, C-04, C-05, C-06, C-07, C-15, C-16, C-17, C-18, C-19]  # C-15..C-19 reviewer-discovered during C1
depends_on: [C0]
blocks: [C2, C3, C4]
---

# lite-crdt — the remote path must not trust its input

PURPOSE
  Seven ways for one remote op or merge payload to corrupt or crash a doc, all
  silent or uncaught, all because applyOp/applyOps/mergeState validate the
  envelope and trust the payload. This is the highest-severity work in the
  package and everything else waits on it.

WHY THESE SEVEN TOGETHER
  They are one bug in seven costumes: there is no schema at the receive door. Fix
  them separately and you write the same guard seven times. Fix them once, at the
  door, and the local path — which is already guarded — needs no change.

THE DECISION (record it before coding)
  Write decisions/0001-remote-op-door.md. The policy for a malformed remote op:
    A. THROW `CRDTError(malformed_op)` and let applyOps abort — simplest, but a
       peer can still halt a batch (turns C-05 into a feature, not a fix).
    B. REJECT-AND-CONTINUE — validate each op; a bad op is dropped and routed to
       `onError`, the batch continues, the doc is untouched. Recommended: it is
       the only option consistent with llms.txt's "a peer must not be able to
       crash us", and it makes applyOps atomic-per-op.
  Recommendation: B. The door returns a boolean; apply proceeds only on true;
  applyOps never throws on a bad frame.

TASKS
  - One validation predicate per op type, at the door (applyOp), before any
    mutation or clock merge:
      * `l`, when present, must be a finite number < 2^53 (C-01, C-02, C-07).
        The clock merge `lamport = max(lamport, op.l)` runs only after this.
      * `r` must be a non-empty string (C-04).
      * counter `p`/`n` must be finite non-negative numbers (C-03).
      * `set`/`del` require string `k`; `add`/`upd`/`rm` require string `id`;
        `rm` requires `g` an array of strings; `add` requires numeric `n`.
    A failing op is dropped + reported (policy B), never applied.
  - Route kind-mismatch (C-05) through the same door: a `set` op naming a set is a
    rejected op, reported to onError, not an uncaught throw. Wrap
    connectBroadcastChannel's receive path so a crafted frame cannot escape.
  - mergeState (C-06): validate `state.cols`, each collection's shape (map:
    `entries` object; set: `adds`/`removed`/`values`; counter: `p`/`n`), and each
    register's fields, before merging. Malformed -> `CRDTError` (this is a local
    programmer/peer error surfaced synchronously, unlike the async op stream) OR
    the same reject-and-continue — decide and record. A missing `removed` must not
    be a raw TypeError.
  - Bound the clock: enforce `l < 2^53` at the door AND clamp local `tick()` to
    fail closed (throw) rather than silently saturate if it ever reaches the
    ceiling (C-07). Record why 2^53 is the ceiling.
  - Add validate(doc) assertions for finite clock + finite register lamports so a
    poison that slips the door is caught between phases.
  - Fill torture T1 (degenerate payloads) and T4 (the door) completely per
    section 4.

HOT PATH
  The door runs on applyOp/mergeState — the network-receive path — so it may cost
  a few comparisons per op. It must add ZERO allocation (validate scalars in
  place, no per-op temp object/array) and it must NOT touch `emit`, `apply`'s
  happy path, or `reconcile`. Prove emit/apply unchanged with the alloc gate
  against the C0 baseline.

ASSERTIONS
  - Each of C-01..C-07 has a named fails-before/passes-after test: the poison is
    rejected AND validate(doc) passes AND the snapshot is byte-identical to a
    clean run.
  - After 10k good ops, one attempted poison of each kind, and 10k more, the
    canonical snapshot equals a run with no poison attempt.
  - applyOps of a batch containing one bad frame applies every good op and drops
    only the bad one (policy B); it never throws.
  - A crafted BroadcastChannel frame does not throw out of onmessage.
  - The convergence fuzz (T5), now with adversarial ops injected, stays 0
    divergences across the seed range.
  - emit/apply hot-path alloc gate within noise of C0.
  - torture "ok"; T9 controls (a poison that bypasses the door) fail.

NON-GOALS
  No retention/GC (C2). No new op types. No undo semantics change (C3). No
  compaction (C4).

DONE WHEN
  every remote-boundary finding has a fails-before/passes-after test; the door is
  the single choke point; fuzz green with adversarial ops; hot path unchanged
```

===============================================================================
# C2 — lite-crdt v1.2.0 — retention + snapshot determinism + name safety
===============================================================================

```markdown
---
package: "@zakkster/lite-crdt"
version_target: 1.2.0
status: shipped   # published 2026-09-02; 179 tests (179 pass / 0 todo), torture "ok"; findings C-10, C-11, C-12
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
findings: [C-10, C-11, C-12]
depends_on: [C1]
blocks: [C4]
---

# lite-crdt — stop retaining, make snapshots deterministic

PURPOSE
  Three smaller, independent hygiene fixes now that the door holds. None changes
  convergence; each removes a footgun and de-risks the compaction work in C4.

TASKS
  - C-10: on the `rm` path, when an id's tags reach size 0, delete its `adds`
    entry AND its `valueReg` entry (and okL/okR — already deleted via
    recomputeOK). Decide what happens if a later op re-adds the id: the value
    register is gone, so a bare `rm` then `add` with no value would surface
    `undefined` — confirm the add path always carries a value, or keep the value
    register and only drop the empty adds map. Record the choice; this is the
    seam the C4 tombstone GC widens.
  - C-11: canonicalize doc.snapshot() — sort the top-level collection names, so
    two converged replicas emit byte-identical JSON. getState() likewise. Cheap;
    it makes whole-doc hashing/diffing honest.
  - C-12: guard collection names the way map keys are guarded. `map("__proto__")`
    etc. throw at creation (misconfigured), OR getState writes cols into an
    Object.create(null) map so the name round-trips. Recommended: Object.create(
    null) for the getState `out` and the mergeState iteration — it also removes
    the crafted-`__proto__`-state throw for free.

ASSERTIONS
  - After 10k add/delete cycles of the same id, valueReg + adds hold O(live ids),
    not O(operations) — a named test with a before/after count.
  - canon() is unnecessary: raw JSON.stringify(snapshot()) is equal across two
    replicas converged in different orders, over the fuzz corpus.
  - A collection named "__proto__" either throws at creation or round-trips
    through getState/mergeState intact; ({}).polluted stays undefined.
  - Convergence fuzz green; retention soak (T7) shows the new bound.

NON-GOALS
  No tombstone GC / compaction (C4). No undo change (C3).

DONE WHEN
  retention is O(live), snapshots are replica-independent, names are safe;
  the fuzz and soak prove all three
```

===============================================================================
# C3 — lite-crdt v1.2.1 — undo contract + replica identity
===============================================================================

```markdown
---
package: "@zakkster/lite-crdt"
version_target: 1.2.1
status: shipped   # published 2026-09-02; 206 tests (206 pass / 0 todo), torture "ok"; findings C-13, C-14 (follow-up C-20 fixed in 1.3.1)
findings: [C-13, C-14]
depends_on: [C1]
---

# lite-crdt — decide what undo promises, and how unique a replica is

PURPOSE
  Two contract questions the code answers by accident today. Neither is a crash;
  both deserve a decision on the record instead of a fuzzer comment.

TASKS
  - C-13: decide whether undo of an OR-Set removal is order-preserving. Today it
    re-adds with a fresh tag and re-times. Options: (a) document "undo restores
    membership and value, not position" as the contract (zero code); (b) capture
    the removed tags in the undo record and re-add them verbatim so position is
    restored (more state per undo entry). Record the choice in
    decisions/0002-undo-semantics.md and make the bench fuzzer's comment cite it.
  - C-14: document the replica-uniqueness + monotonic-lamport assumption that
    convergence rests on, and widen genReplicaId() entropy (crypto.randomUUID
    full, or more chars) so a birthday collision across a realistic replica count
    is negligible. Add a test that two docs never collide across 1e5 creations.

ASSERTIONS
  - The chosen undo contract has a named test that pins the exact snapshot after
    add/add/delete/undo.
  - genReplicaId collision probability documented; the uniqueness test passes.

NON-GOALS
  No new undo op types. No compaction.

DONE WHEN
  undo semantics are on the record and tested; replica identity is documented and
  widened
```

===============================================================================
# C3.1 — lite-crdt v1.3.1 — validate replicaId at the local boundary (C-20)
===============================================================================

```markdown
---
package: "@zakkster/lite-crdt"
version_target: 1.3.1   # scoped as 1.2.2; rebased past C4 and shipped as 1.3.1
status: shipped   # 270 tests (270 pass / 0 todo) post-C4 merge, torture "ok"; finding C-20
findings: [C-20]
depends_on: [C1, C3, C4]   # C4 landed first; this rebased on top of it
---

# lite-crdt — fail closed on a misconfigured replicaId

PURPOSE
  The follow-up logged during C3's QA. `createCRDTDoc` trusted `opts.replicaId`
  without validation while every PEER's remote door (`okOp`, C1) rejects a
  non-string / empty `r`. So a locally-accepted misconfiguration became a
  one-way silent divergence — the exact fail-open the door philosophy forbids.
  Pre-existing, not a C3 regression; a patch, not a new arc session.

TASKS
  - C-20: at `createCRDTDoc`, validate a PROVIDED `replicaId` to a non-empty
    string, mirroring the door (`typeof === "string" && .length > 0`); throw
    `CRDTError("misconfigured")` otherwise. Only an OMITTED (`=== undefined`) id
    auto-mints. No charset cap (a tag `r#n` splits on the last "#", so
    "team#alice" is valid) and no length cap (the door imposes none; a stricter
    local rule would reject an id a peer legitimately emits). Cold path — once
    per doc, zero hot-body bytes. Record throw-on-falsy and mirror-the-door in
    decisions/0005; flip the C3-QA pins in test/15 that asserted the old
    behaviour; add test/18 as the independent boundary suite.

ASSERTIONS
  - A non-string replicaId (number/object/boolean/array) throws misconfigured.
  - A falsy replicaId ("", 0, null, false, NaN, -0) throws misconfigured.
  - A valid explicit id ("A", "team#alice") is used VERBATIM and its emitted op's
    `r` passes a real peer's door (round-trip converges).
  - The auto-mint path (omitted / {} / {replicaId: undefined}) is unchanged.
  - The throw fires at construction, before any collection or op.

NON-GOALS
  No change to the remote door, convergence algebra, wire format, genReplicaId,
  or any hot path. No charset or length restriction.

DONE WHEN
  a misconfigured replicaId fails loud at the boundary instead of diverging
  silently later; boundary suite green; torture "ok"
```

===============================================================================
# C4 — lite-crdt v1.3.0 — tombstone compaction + delta sync
===============================================================================

```markdown
---
package: "@zakkster/lite-crdt"
version_target: 1.3.0
status: shipped   # published 2026-09-02; 251 tests (251 pass / 0 todo), torture "ok"; findings [] (reviewer S1 getStateSince divergence + qa S1 version-vector TOCTOU caught + fixed in-pipeline)
findings: []
depends_on: [C2]
---

# lite-crdt — the long-lived-doc unlock (from the original roadmap's 1.2)

PURPOSE
  The declared v2 debt: LWW tombstones and OR removed-tags accumulate forever, so
  a month-old doc grows monotonically. This is the original roadmap's 1.2, now
  safe to build because the retention seam (C2) is clean and the merge door (C1)
  can be trusted to reject a malformed delta.

TASKS
  - Version-vector tracking: each doc tracks the max lamport seen per replicaId.
  - `compact(versionVector)` — collapse LWW tombstones and OR removed-tags that
    every replica in the vector has acknowledged. Convergence-preserving: a
    compacted doc merged with a lagging peer must reach the same state as if
    nothing was compacted.
  - `getStateSince(versionVector)` — delta hydration: a briefly-offline tab pulls
    only what changed, not the full state. The delta is validated by the C1 door
    on receipt.
  - Extend T5: fuzz compaction — random compacts interleaved with the op stream
    must never change the converged result vs an uncompacted control.

ASSERTIONS
  - A doc compacted at vector V, then merged with a peer that never saw V,
    converges to the same snapshot as an uncompacted pair.
  - getStateSince(V) + the pre-V state == getState() for any V.
  - Tombstone count is bounded by live entries after compaction, not by history.
  - Convergence fuzz green including compaction ops and adversarial deltas.

NON-GOALS
  No RGA (C5). No rich text.

DONE WHEN
  compaction is convergence-preserving and fuzz-proven; delta sync validated at
  the door; a long-lived doc no longer grows monotonically
```

===============================================================================
# C5 — lite-crdt v2.0.0 — doc.list(name): RGA positional sequence
===============================================================================

```markdown
---
package: "@zakkster/lite-crdt"
version_target: 2.0.0
status: planned
findings: []
depends_on: [C4]
---

# lite-crdt — the declared 2.0 headline (from the original roadmap)

PURPOSE
  The order-of-magnitude item: a convergent positional sequence with
  insert-at-index and move-to-index (RGA). Ship it as the sole 2.0 headline, on a
  base that is validated (C1), deterministic (C2), and compactable (C4) — not
  bundled with anything else. Plan it as its own arc, like the signal 1.9 rebuild.

TASKS (planner expands into its own multi-session sub-arc)
  - RGA element identity, convergent insert-at-index, move-to-index, delete.
  - The same door discipline: every remote RGA op validated before apply.
  - The same gate discipline: zero-alloc apply, differential fuzz against a
    reference sequence oracle, retention/compaction of RGA tombstones via C4.
  - lite-room interop (RGA as a room storage type) is 2.1, AFTER the core
    sequence has soaked — not bundled into 2.0.

DONE WHEN
  doc.list converges under reorder/duplication; fuzz-proven against an oracle;
  the door and the alloc gate hold for every RGA op; shipped alone as 2.0.0
```

---

## 7. How to run it

In order. `status: planned -> shipped` after each `/release`. Author the brief in
the package, then `Use the planner subagent on BRIEF.md`, then coder, reviewer,
qa, then `/release`. Reviewer REJECTED goes back to coder, not forward.

### If you only do a subset

1. **C0 first, always.** There is no `package.json`; nothing can be tested,
   gated, or published until it exists. This is not optional and not deferrable.
2. **C1 is the headline.** Seven ways for one remote frame to silently corrupt or
   crash a doc, in a package whose entire premise is that peers exchange ops.
   Four are S1 silent corruption. The fix is one validation door, and the local
   path — already hardened — does not change. Nothing else should be built on a
   structure that a single `l: Infinity` poisons forever.
3. **C2 before C4.** Compaction widens the retention seam; clean the seam first.
4. **C4/C5 are the original roadmap, re-sequenced.** They were always the plan;
   they now stand on a validated base instead of a trusting one.

### The habit this roadmap is built around

Every finding in section 3 came from running the code, not reading it. The core
merge algebra reads correct and *is* correct — 200 convergence seeds prove it.
The bugs are all one layer out, at the boundary where another machine's bytes
enter, and they are invisible in review and obvious in a five-line probe:
`applyOp({t:"set",...,l:Infinity})` and read the clock.

The sharpest lesson is C-09, and it is the local twin of the sibling roadmap's
AR-02. lite-crdt *has* a torture fuzzer — seeded, oracle-checked, testing
convergence, transact, and undo/redo. It is genuinely good. And it cannot find a
single finding in section 3, because it only ever replays ops the library itself
emitted — well-formed, in-range, from a trusted writer. A convergence gate that
only feeds itself valid ops is a green light over the entire remote trust
boundary. When the reviewer subagent reads the T5 fuzz, the question is not "does
it prove convergence" — it is "would it fail if a peer sent a malformed op". Until
C1, the answer is no.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
