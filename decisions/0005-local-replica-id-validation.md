# 0005 -- local replicaId validation at the boundary

Status: **accepted** (implemented in v1.3.1 / session C-20 follow-up, rebased onto C4/1.3.0)
Findings: C-20
Related: decisions/0003 / C-14 -- C-14 DOCUMENTED the replica-uniqueness assumption
behind the `(lamport, replicaId)` total order; C-20 now ENFORCES the *shape* of
that id at the local `createCRDTDoc` boundary. decisions/0001 -- the remote-op
door `okOp` this validation mirrors (a `replicaId` arriving over the wire must be
a non-empty string; a locally-supplied one must clear the same bar).

## Context

The `(lamport, replicaId)` total order and every OR-Set tag (`replicaId + "#" + n`)
rest on the `replicaId` being a well-formed, non-empty string. The remote door
already enforces that shape on every incoming op (`okOp`, CRDT.js:822-842): a
counter op's `r` at CRDT.js:826 and every stamped op's `r` at CRDT.js:831 are
rejected unless `typeof op.r === "string" && op.r.length > 0`. The LOCAL boundary
had no matching check. `createCRDTDoc` minted the id with a bare
`const replicaId = opts.replicaId || genReplicaId();` (old CRDT.js:879), which
carried two hazards:

1. **Non-string but truthy id** (a number, an object, `true`). It was accepted
   locally and stamped into every op's `r`. But every PEER'S door runs `okOp`,
   whose `r` checks (CRDT.js:826/831) drop any op whose `r` is not a non-empty
   string. So this doc emits ops that EVERY peer silently drops -- a one-way
   divergence, and because the drop happens on the far side there is no `onError`
   on THIS side to signal it. The doc believes it is broadcasting; no peer ever
   converges on its edits.

2. **Falsy id** (`""` or `0`). It fell through the `||` and was silently
   auto-minted by `genReplicaId()`, OVERRIDING the caller's explicit value. A
   caller who passed `""` got a random id instead and never learned their input
   was discarded. (`""` is also the exact value the peer door would drop, so
   even honoring it verbatim would reproduce hazard 1.)

Both violate the house law: **fail closed on every unverified state / null is not
zero**. A misconfigured id is an unverified state; silently accepting or silently
overriding it is fail-open.

## Options considered

### (A) empty-string / falsy id: THROW (chosen) vs auto-mint-on-falsy (rejected)

An empty or falsy `replicaId` is a caller error, not an omission. Auto-minting on
falsy (the old behavior) is fail-open twice over: `""` emits an `r` the peer door
drops (the same divergence as hazard 1), and silently overriding a caller's
EXPLICIT falsy id hides their mistake behind a random id. **Chosen: throw.** A
provided id that cannot work is reported at construction, loud, once.

### (B) mirror the door exactly: non-empty string, NO charset/length cap (chosen)

- vs a **charset restriction** (rejected): a tag key is `replicaId + "#" + n`, and
  the tagKey parser splits on the LAST `"#"` (CRDT.js:378-383) precisely so an id
  may itself contain `"#"`. So `"team#alice"` is a valid id -- a charset rule that
  banned `"#"` would reject an id the tag machinery is explicitly built to support.
- vs a **length cap** (rejected): the remote door imposes NO length bound. A
  stricter local cap would reject an explicit id whose emitted ops the local door
  itself accepts (a peer legitimately emits ids of any length), splitting the local
  and remote contracts. The boundary must accept exactly what the door accepts.

**Chosen: mirror `okOp` -- `typeof id === "string" && id.length > 0`, nothing more.**

### (C) auto-mint boundary: only `=== undefined` auto-mints (chosen)

Auto-mint fires ONLY when `replicaId` is `undefined`, so an absent key and an
explicit `{ replicaId: undefined }` behave identically (JS default-parameter
semantics: an explicitly-passed `undefined` is the same as a missing argument).
Every OTHER explicit value -- including `null`, `""`, `0`, `false` -- is a
provided value and is validated (and thus rejected). This keeps "omitted" and
"provided" cleanly separated: omission auto-mints, provision is checked.

## Decision

`createCRDTDoc` resolves `replicaId` by this contract:

```
const ridOpt = opts.replicaId;
let replicaId;
if (ridOpt === undefined) {
    replicaId = genReplicaId();                 // omitted -> auto-mint
} else if (typeof ridOpt === "string" && ridOpt.length > 0) {
    replicaId = ridOpt;                         // provided, valid -> use verbatim
} else {
    throw new CRDTError("misconfigured", ...);  // provided, invalid -> fail loud
}
```

The throw fires BEFORE `lamport`, `cols`, `scratchOp`, and any collection is
created, so a misconfigured doc never half-constructs. The message names why the
id matters (it stamps every op's `r` and every OR-Set tag `r#n`, and drives the
total order) and tells the caller to omit `replicaId` to auto-mint.

## Consequences

- **Cold path.** The check runs once per doc in `createCRDTDoc`, never on
  `applyOp` / emit / `add` / `rm` / `upd` / `cinc` or any loop. Zero hot-path and
  zero allocation impact; the T6 zero-alloc gate is unaffected.
- **Wire format unchanged.** No op or state field changes; a valid id serializes
  exactly as before. Existing peers and persisted state stay byte-compatible.
- **Convergence algebra unchanged.** No merge, order, or tag computation is
  touched; only the id's construction-time validation.
- **The only behavior change** is that a previously-SILENT misconfiguration now
  THROWS `misconfigured` at construction. A caller who passes a valid non-empty
  string -- the documented contract, e.g. `"A"`, `"team#alice"`, or
  `crypto.randomUUID()` -- never hits the throw. It is a fail-loud that converts a
  one-way silent divergence (or a silently-overridden id) into an immediate,
  visible error at the exact point of misuse.
