# C5 plan — lite-crdt v2.0.0 — `doc.list(name)` RGA positional sequence

> Planner output, persisted for resume. This is the sub-arc spec: model, wire
> format, session breakdown (C5.1..C5.5), falsifiable assertions mapped to the
> torture tiers, and the reviewer risk register. Author `decisions/0006` from the
> MODEL section; the coder picks up **C5.1** first.

---

## SPEC — where the work lives

**Hot body.** The `list` collection adds a doubly-linked anchor chain + a
two-level `Map(r -> Map(l -> node))` id index (no string keys, no `splice` on the
hot path), so remote `lins`/`ldel`/`lmv` apply is pointer surgery on the
doc-owned `scratchOp` (extended by `ol, or, bl, br`). Core-three apply/emit bytes
are unchanged.

**Cold path.** `okOp` + `kindFromOpType` + `okState` gain a `list` branch;
`getState`/`mergeState`/`getStateSince`/`compact` gain a `list` kind. Index->origin
resolution and the pending-origin buffer live only on the emit / receive-reorder
paths.

---

## MODEL (write into decisions/0006-rga-sequence.md)

Two layers, one record.

- **Anchors.** Immutable id `(l, r)`. Position fixed forever by the RGA scan
  `j = origin+1; while cmpOK(node[j]) > cmpOK(l, r) j++` (concurrent same-origin
  ties descend by `(lamport, replicaId)`). Origin `or === null` = HEAD sentinel.
- **Elements.** Identity = birth anchor id `(bl, br)`; a monotone `del` flag; and
  an LWW **position register** `(ml, mr) -> anchorKey`.

**MOVE = first-class LWW position register, value drawn from the anchor space,
NOT a reference to a live element.** `lmv` unconditionally mints a fresh anchor at
the target origin (so a concurrent insert naming it still lands) and
conditionally writes the register under `tsWins`.

Rejected alternatives (record why in 0006):
- *Delete + reinsert* — duplicates under concurrent move-of-same-element, orphans
  concurrent inserts that named the element, costs O(moves) tombstones.
- *Element-relative move registers* — `X.after(Y) || Y.after(X)` is a cycle with
  no deterministic linearization. Anchor-valued registers are cycle-free by
  construction.

Convergence of the hard cases:
- Concurrent moves of one element -> one winner (tsWins), one abandoned anchor.
- Move || delete **commute** because they write **disjoint fields** (monotone
  flag vs LWW register): delete always wins, resurrection is unrepresentable.

**Out-of-order is PENDING, not dropped.** An `lins` whose origin anchor is unseen
goes into a capped pending map keyed by `(l, r)`, drained when the origin
integrates. `ldel`/`lmv` for an unseen element create a placeholder record.
Dropping instead diverges under reorder. Cap + `onError` on overflow (fail
closed).

### Anchor compaction — the stricter condition

A plain LWW/OR tombstone is reclaimable at `l <= minAck` (everyone saw it, so
nothing can still lose to it). For an **anchor**, `l <= minAck` is exactly the
condition that every replica *may now name it as an origin*: necessary, **not
sufficient**. Two tiers:

- **Tier 1** (always, at `minAck`): drop the element's **payload `v` and record**
  when `del && delL <= minAck && ml <= minAck`; keep the bare anchor
  `{l, r, prev, next}`. Reclaims the unbounded bytes, leaves the origin skeleton.
- **Tier 2** (anchor unlink, requires **global quiescence**):
  `minAck >= max(V.values()) && minAck >= doc.clock()` => no op naming any anchor
  is in flight => every unoccupied anchor is unlinkable. This is the ONLY sound
  discharge of "no future op names A" from a version vector. State it in 0006 and
  in llms.txt as the caller contract, alongside 0004's no-redelivery-below-frontier
  assumption.

---

## WIRE (new, additive)

```
{ t:"lins", c, l, r, or, ol, v }
{ t:"ldel", c, l, r, bl, br }
{ t:"lmv",  c, l, r, bl, br, or, ol }
```

**Door** (reject-and-continue, single-read off `scratchOp`, C-18):
`l` finite `< 2^53`; `r` non-empty string; `or` is `null` (HEAD) **or** a
non-empty string with finite `ol < 2^53`; `bl` finite `< 2^53`; `br` non-empty
string.

**State:**
```
{ kind:"list",
  nodes:{ "r#l":[or,ol] },
  elems:{ "r#l":[ml,mr,anchorKey,del,dl,dr,v] } }
```
`Object.create(null)`, keys sorted, split on `lastIndexOf("#")`. `mergeState`
**re-runs integration from origins in ascending `(l, r)`**; it never trusts a
transmitted order (a node's origin always has a strictly lower lamport, so the
origin is present by then; a still-orphaned node is dropped + reported).
`getStateSince(V)`: nodes by `l > V[r]`; an element ships if any of its three
stamps beats `V[thatWriter]` — because an `ldel` **stores its remover** (`dl, dr`),
per-writer delta filtering IS sound here (the 0004 hazard does not recur).

### Core-three: byte-identical, confirmed

No change to `set/del/add/upd/rm/cinc/cdec` payloads, `tsWins`/`cmpOK`, `okOp`'s
existing branches, or the map/set/counter `getState` shapes, `mergeState`
algebra, `compact` conditions. The 2.0 break is exactly one thing and it is
forward-only: a 1.x peer's `applyOp` **throws `malformed_op`** on `lins/ldel/lmv`
and its `mergeState` drops `kind:"list"`. A 2.0 replica is a strict superset; a
1.x replica cannot consume list frames. Document as the deliberate break; nothing
else shifts.

---

## TASKS — the sub-arc

Version targets `2.0.0-alpha.N` in package.json + VERSION + CHANGELOG *Unreleased*,
**UNPUBLISHED**. Only **C5.5** runs `/release 2.0.0` — do not publish a half-built
RGA. Each alpha still ends coder -> reviewer -> qa with `npm test` +
`npm run torture` green.

### C5.1 — identity + insert + order (alpha.1) — FULL DETAIL, coder starts here

1. `CRDT.js:createRGAList(name, ctx)` — new factory beside `createORSet`. State:
   `head = {l:0, r:"", prev:null, next:null, e:null}` sentinel; `byR = new Map()`
   (`r -> Map(l -> node)`); `count` (live elements); `proj = store([])`;
   `rev = signal(0)`; `readOnlyView(proj, true, "list('"+name+"').store")`.
2. `createRGAList/nodeAt(r, l)` — two-level lookup, zero string concat, returns
   `undefined` on miss. **No `elemKey` string on any apply path**; string keys
   exist only in `getState`/`mergeState`.
3. `createRGAList/integrate(node, origin)` — the RGA scan:
   `let x = origin.next; while (x !== null && cmpOK(x.l, x.r, node.l, node.r) > 0) x = x.next;`
   link `node` before `x`. Pure pointer writes, zero allocation beyond the node.
4. `createRGAList/apply` — `lins` branch: idempotent early-return if
   `nodeAt(op.r, op.l)` exists (**the T6 steady-state path: zero alloc, no
   scan**); resolve origin (`op.or === null ? head : nodeAt(op.or, op.ol)`); on
   miss push to `pending`; else allocate node+element, integrate, `visIndexOf` ->
   `proj.splice(pos,0,v)`, `bump()`, `ctx.changed()`, then drain `pending` for
   this anchor.
5. `createRGAList/pending` — `Map("or#ol" -> array of frozen op copies)`, cap
   `PENDING_MAX = 4096`; overflow reports `CRDTError("malformed_state")` and
   drops. Cold path only.
6. `createRGAList/insert(index, value)` — LOCAL emit: clamp/validate `index`
   (integer, `0..size`, else `misconfigured`), walk to the anchor of the visible
   element at `index-1` (or HEAD), `ctx.tick()` **before** any `ctx.record()`
   (C-17), build `{t:"lins",c:name,l,r,or,ol,v}`, `apply` then `ctx.emit`.
   Allocation permitted here.
7. `CRDT.js:kindFromOpType` — `lins|ldel|lmv -> "list"`. `getCollection` —
   `kind === "list"` constructs `createRGAList`. `createCRDTDoc.list(name)` —
   disposed guard + `getCollection(name,"list")`.
8. `CRDT.js:scratchOp` — add `ol:undefined, or:undefined, bl:undefined,
   br:undefined`; `applyOp` copies them in the same single-read block.
9. `CRDT.js:okOp` — the `lins` branch (`or === null` OR non-empty string +
   finite `ol`).
10. `test/19-list-order.test.mjs` — concurrent same-origin tie order; 3-replica
    all-permutation convergence on `values()`+`ids()`; out-of-order origin
    (insert delivered before its origin) converges; duplicate delivery is a
    no-op; `.store` write and `push/splice` throw `readonly`.
11. `test/torture/harness.mjs:validate` — list clauses: every node's `l` finite
    and `<= clock`; `r` a string; the `prev/next` chain visits every node in
    `byR` exactly once; `proj.length === count`; every live element's anchor is
    reachable.

DONE-WHEN: 10 + 11 green, `npm run torture` prints `ok`, core-three suites
unchanged.

### C5.2 — delete + tombstones + door (alpha.2)
`ldel` apply (monotone flag, anchor survives, `proj.splice` out),
`list.delete(index)`/`deleteById(bl,br)`, placeholder element for a
delete-before-insert, `okOp` `ldel` branch, `t1-degenerate.mjs` RGA cross-product
(`l/ol/bl` in {0,-1,NaN,+/-Inf,"5",missing,2^53}; `or/br` in
{missing,"",null,`"__proto__"`,number}), `t4-door.mjs` list cases incl. a crafted
frame through BroadcastChannel and the pending-buffer flood.

### C5.3 — move (alpha.3)
`lmv` apply: mint+integrate the anchor unconditionally, then
`tsWins(op.l,op.r,e.ml,e.mr)` guards the register write and the relink;
`list.move(from,to)`; tests for two concurrent moves -> one position, move||delete
-> deleted on every replica, move of a moved element, self-move no-op, and the
**pinned** RGA backward-typing interleaving output.

### C5.4 — serialization + delta + compaction (alpha.4)
`_getState`/`_mergeState` (ascending-`(l,r)` re-integration, orphan drop+report),
`_getStateSince`, `_compact(minAck, quiesced)` Tier1/Tier2, `doc.compact` computes
the quiescence predicate once, `_retention() -> {anchors, elems, pending}`,
`okState` list branch.

### C5.5 — gates, soak, docs, release (2.0.0)
`test/torture/rga-oracle.mjs` + T5 extension, T6, T7, T9 controls, README
(LiteSepforge spine), llms.txt, `CRDT.d.ts`, CHANGELOG,
`decisions/0006-rga-sequence.md`, golden core-three fixture, `/release 2.0.0`.

---

## ASSERTIONS (falsifiable, mapped to tiers)

1. **T5 oracle (load-bearing).** `test/torture/rga-oracle.mjs` = array-of-anchors
   + `Map(birthKey -> {v,del,ml,mr,aKey})`, same three rules, no linked list, no
   pending buffer (re-sorts and re-integrates from scratch each round). Fuzz:
   `24 * SCALE` seeds x 5 replicas x 8 shuffled+duplicated+poison-injected
   deliveries. **0 divergences**: every doc's `canon()` byte-equal to every other
   and to the oracle's `values()`/`ids()` rendering; re-delivering the whole log
   leaves `canon()` unchanged (idempotence); `validate(doc)` passes after every
   replay; `check(poisonSeen > 0)`.
2. **Core-three non-break.** For the frozen C4 corpus
   (`drive(seed,{replicas:3,rounds:30,opsPerRound:6})`, seeds
   `SEED+1000..+1023`), `JSON.stringify(doc.getState())` is **byte-identical to a
   checked-in v1.3.1 golden fixture**, and `okOp` returns identical verdicts on
   all 16 `POISON` entries. Any diff fails the gate.
3. **T6 GC budget.** `runOpsGate` over 40000 **redelivered** `lins` +
   winning/losing `lmv` + repeat `ldel` applies: `maxMajor:0`, `maxPauseMs:4`,
   `maxArrayBuffersGrowth:0`, `stabilize:'deep'` — plus the structural check the
   heap gate cannot make: `list._retention().anchors` and `.elems` unchanged by
   **exactly 0** across the window, and `pending === 0`. First-delivery insert is
   measured separately with a ceiling of **<= 96 bytes/op** (one node) and is
   explicitly excluded from the 0 B claim; the LOCAL `insert(index,...)` emit path
   is excluded.
4. **T7 retention/compaction soak.** 20000-op churn over 64 live ids on
   lock-stepped compacting/control docs; after a quiescent `compact(vv)`:
   `comp._retention().anchors <= comp.list("bag").size + 1` (head) and
   `.elems === size`; `ctrl._retention().anchors > 5000`;
   `canon(comp) === canon(ctrl)`. **No compacted anchor ever resurrects**:
   replaying the full log into `comp` after compaction leaves `canon(comp)`
   unchanged.
5. **Retention witness.** `createLeakTracker` over 4096 build-up/dispose cycles
   (each: 1 good list op + 1 rejected list frame + 1 pending-origin op left
   undrained): `tracker.size() === 0`, and `_retention().pending === 0` after
   `dispose()`.
6. **T9 non-vacuity.** Five controls each exit non-zero: ascending-tie ordering
   (`>` flipped to `<`); a move applied without the `tsWins` guard; an `lins`
   with an unknown origin dropped instead of pended; Tier-2 anchor unlink run
   **without** the quiescence predicate (must resurrect and be caught by #4); an
   allocating apply path.

---

## RISK REGISTER (reviewer must adversarially probe)

1. The origin-tie comparator **direction**, and its behaviour when the scan
   crosses a node from a *third* origin.
2. The backward-typing **interleaving anomaly** — pin the output, do not "fix" it.
3. The move register applied to an element whose insert has not arrived — the
   placeholder must retain the stamp.
4. **Tier-2 anchor reclamation without true quiescence**
   (`minAck >= max(V) >= clock`) — a single lagging replica makes it an S1
   resurrection.
5. The pending-origin buffer as an **unbounded-growth DoS** from crafted frames.
