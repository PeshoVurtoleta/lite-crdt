/**
 * test/15-qa-c3-boundary.test.mjs -- independent QA boundary suite for session
 * C3 (v1.2.1): the undo contract (C-13) and replica identity (C-14).
 *
 * This suite does NOT trust the coder's report or the planner's assertions at
 * face value -- every case here re-derives the expected result from the code
 * paths in CRDT.js (genReplicaId / apply / runInverse) and asserts against
 * that, independently of test/regressions.test.mjs and test/14-identity.test.mjs.
 *
 * node:test only. No import beyond node:test, node:assert and the package
 * under test (../CRDT.js) -- no peer dependency is needed for this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc, CRDTError } from "../CRDT.js";

const ID_WIDTH = 34; // "r-" + 32 hex

/* ───────────────────────── C-13: undo contract probes ─────────────────────── */

test("C-13 probe: undo of a removal converges across two replicas via the fresh-add op, without resurrecting the old tombstoned tag", () => {
    const a = createCRDTDoc({ replicaId: "A" });
    const b = createCRDTDoc({ replicaId: "B" });
    const fromA = [];
    const fromB = [];
    a.on("op", (op) => fromA.push(op));
    b.on("op", (op) => fromB.push(op));

    const A = a.array("L");
    const B = b.array("L");

    // 1. A adds x; deliver that add to B so both observe the SAME tag (A#0).
    A.add({ id: "x", v: "hello" });
    assert.equal(fromA.length, 1);
    b.applyOp(fromA.shift());
    assert.equal(B.hasId("x"), true, "B observed the initial add");

    // 2. CONCURRENT removes: A and B each independently delete x, both
    // referencing the only tag either has observed (A#0). Neither has seen the
    // other's delete yet -- this is the "peer concurrently holds the tombstone"
    // setup from decisions/0003.
    A.deleteById("x");
    B.deleteById("x");
    assert.equal(A.hasId("x"), false);
    assert.equal(B.hasId("x"), false);

    // 3. A undoes ITS OWN delete. Per decisions/0003 (C-13, option (a)) this
    // must mint a FRESH tag (A#1) and re-add -- it must NOT attempt to
    // un-tombstone A#0 (which would diverge against B, per the (b)-unsound
    // analysis).
    const okUndo = a.undo();
    assert.equal(okUndo, true);
    assert.equal(A.hasId("x"), true, "A's own undo restores membership locally");
    assert.equal(A.get("x").v, "hello");

    // The tag actually driving A's local membership must NOT be the original
    // tombstoned tag -- inspect getState() directly (only tag left alive for id
    // 'x' must differ from the original "A#0").
    const aState = a.getState().cols.L;
    assert.ok(aState.removed.includes("A#0"), "A#0 is tombstoned on A");
    const liveTagsOnA = Object.keys(aState.adds.x || {});
    assert.equal(liveTagsOnA.length, 1, "exactly one live tag for x after undo");
    assert.notEqual(liveTagsOnA[0], "A#0", "undo must not resurrect the old tombstoned tag; it must mint a fresh one");

    // 4. Deliver every emitted op to the OTHER replica (order: A's ops then B's
    // op, out of the causal order either replica originally applied them in
    // locally, to prove commutativity too).
    for (const op of fromA) b.applyOp(op);
    for (const op of fromB) a.applyOp(op);

    // 5. Convergence: both replicas end up with x LIVE (via the fresh tag) and
    // the value restored, and byte-identical CONVERGED STATE. `getState().cols`
    // is the shared CRDT payload; `replicaId` is each doc's own identity (by
    // design "A" vs "B") and is deliberately excluded from the convergence
    // comparison -- comparing the whole getState() (as a first draft of this
    // test did) is a self-inflicted false failure, not a library bug: two
    // converged replicas are NOT supposed to agree on each other's replicaId.
    assert.equal(A.hasId("x"), true, "A still has x after absorbing B's concurrent (already-subsumed) delete");
    assert.equal(B.hasId("x"), true, "B converges on A's undo (fresh-add) op -- x reappears on B too");
    assert.equal(A.get("x").v, "hello");
    assert.equal(B.get("x").v, "hello");
    assert.deepEqual(a.getState().cols, b.getState().cols, "A and B converge to byte-identical collection state after the undo op propagates");
    assert.deepEqual(a.snapshot(), b.snapshot(), "A and B converge to byte-identical projected snapshot too");

    // The old tag stays dead on BOTH replicas -- no resurrection anywhere.
    const bState = b.getState().cols.L;
    assert.ok(bState.removed.includes("A#0"), "A#0 stays tombstoned on B too");
    assert.equal(Object.keys(bState.adds.x || {}).length, 1);
    assert.notEqual(Object.keys(bState.adds.x)[0], "A#0");

    a.dispose(); b.dispose();
});

test("C-13: undo of the LAST (only) add removes the element entirely (boundary N=1)", () => {
    const d = createCRDTDoc({ replicaId: "A" });
    const a = d.array("L");
    a.add({ id: "only", v: 1 });
    assert.equal(a.size, 1);
    d.undo();
    assert.equal(a.size, 0, "undo of the sole add leaves the set empty");
    assert.equal(a.hasId("only"), false);
    d.dispose();
});

test("C-13: undo/redo round-trip of a removal -- redo re-applies the removal", () => {
    const d = createCRDTDoc({ replicaId: "A" });
    const a = d.array("L");
    a.add({ id: "1", v: "one" });
    a.add({ id: "2", v: "two" });
    a.deleteById("1");
    d.undo();  // re-add id 1 (fresh tag)
    assert.deepEqual(a.values().map((v) => v.id), ["2", "1"]);
    d.redo(); // re-apply the removal
    assert.equal(a.hasId("1"), false, "redo re-applies the removal");
    assert.equal(a.hasId("2"), true);
    assert.equal(a.size, 1);
    d.dispose();
});

test("C-13: undo of a removal, then a concurrent REMOTE remove of the same id, still converges with no resurrection", () => {
    // A distinct axis from the two-way probe above: here the remote's rm op is
    // delivered to A AFTER A's own undo, i.e. the causal order the remote's
    // delete-of-the-original-tag reaches A is deliberately varied.
    const a = createCRDTDoc({ replicaId: "A" });
    const b = createCRDTDoc({ replicaId: "B" });
    const A = a.array("L");
    const B = b.array("L");

    A.add({ id: "x", v: 1 });
    const addOp = { t: "add", c: "L", id: "x", n: 0, v: 1, l: a.clock(), r: "A" };
    b.applyOp(addOp);
    assert.equal(B.hasId("x"), true);

    A.deleteById("x");                 // A: tombstones A#0 locally
    const rmOpFromA = { t: "rm", c: "L", id: "x", g: ["A#0"], l: a.clock(), r: "A" };
    B.deleteById("x");                 // B: independently tombstones the SAME A#0 (concurrent)
    const rmOpFromB = { t: "rm", c: "L", id: "x", g: ["A#0"], l: b.clock(), r: "B" };

    a.undo();                          // A mints a fresh tag re-add (NOT A#0)
    assert.equal(A.hasId("x"), true);
    const freshTag = Object.keys(a.getState().cols.L.adds.x)[0];
    assert.notEqual(freshTag, "A#0");

    // Deliver B's independent (already-subsumed) rm to A AFTER the undo.
    a.applyOp(rmOpFromB);
    assert.equal(A.hasId("x"), true, "a stale/duplicate rm of an already-tombstoned tag cannot undo A's fresh re-add");

    // Deliver A's rm then A's fresh-add (the undo op) to B.
    b.applyOp(rmOpFromA);
    // B must still converge once it also sees A's fresh add op explicitly.
    const freshAddOp = { t: "add", c: "L", id: "x", n: 1, v: 1, l: a.clock(), r: "A" };
    b.applyOp(freshAddOp);
    assert.equal(B.hasId("x"), true, "B converges on the fresh-add op emitted by A's undo");

    a.dispose(); b.dispose();
});

test("C-13: redo of a plain add/undo round-trip re-applies (sanity for the redo path used above)", () => {
    const d = createCRDTDoc({ replicaId: "A" });
    const a = d.array("L");
    a.add({ id: "z", v: 9 });
    d.undo();
    assert.equal(a.hasId("z"), false);
    d.redo();
    assert.equal(a.hasId("z"), true);
    assert.equal(a.get("z").v, 9);
    d.dispose();
});

/* ─────────────────────── C-14: replica identity boundary ──────────────────── */

test("C-14 boundary: 0 docs created is a no-op (vacuous uniqueness holds)", () => {
    const ids = new Set();
    assert.equal(ids.size, 0);
});

test("C-14 boundary: 1 doc -- auto-minted id has the right shape", () => {
    const d = createCRDTDoc();
    assert.equal(typeof d.replicaId, "string");
    assert.equal(d.replicaId.length, ID_WIDTH);
    assert.match(d.replicaId, /^r-[0-9a-f]{32}$/);
    d.dispose();
});

test("C-14 boundary: N-1/N/N+1 auto-minted ids stay collision-free across the boundary", () => {
    const N = 2000;
    const ids = new Set();
    const docs = [];
    for (let i = 0; i < N + 1; i++) {
        const d = createCRDTDoc();
        if (i === N - 1) assert.equal(ids.size, N - 1, "N-1 boundary: no collision yet");
        ids.add(d.replicaId);
        if (i === N - 1) assert.equal(ids.size, N, "adding the N-1th id (0-indexed) reaches N unique ids");
        docs.push(d);
    }
    assert.equal(ids.size, N + 1, "N+1 ids minted, N+1 unique -- zero collisions through the boundary");
    for (const d of docs) d.dispose();
});

test("C-20: an empty-string replicaId now throws misconfigured (was: silent auto-mint) -- see decisions/0005", () => {
    // Pre-C-20, `opts.replicaId || genReplicaId()` treated "" as absent and
    // silently fell back to an auto-minted id, discarding the caller's explicit
    // (if useless) input with zero signal. C-20 (decisions/0005, option A)
    // reverses this: a provided-but-invalid id is a caller error and must fail
    // loud, at construction, not fail open into a substituted id.
    assert.throws(
        () => createCRDTDoc({ replicaId: "" }),
        (e) => e instanceof CRDTError && e.code === "misconfigured",
        "an explicit empty string is now REJECTED, not silently replaced",
    );
});

test("C-20: null replicaId now throws misconfigured (was: silent auto-mint) -- see decisions/0005", () => {
    assert.throws(
        () => createCRDTDoc({ replicaId: null }),
        (e) => e instanceof CRDTError && e.code === "misconfigured",
    );
});

test("C-14 boundary: undefined replicaId falls back to auto-mint", () => {
    const d = createCRDTDoc({ replicaId: undefined });
    assert.equal(d.replicaId.length, ID_WIDTH);
    d.dispose();
});

test("C-20: NaN replicaId now throws misconfigured (was: silent auto-mint, because NaN is falsy) -- see decisions/0005", () => {
    assert.throws(
        () => createCRDTDoc({ replicaId: NaN }),
        (e) => e instanceof CRDTError && e.code === "misconfigured",
    );
});

test("C-20: -0 replicaId now throws misconfigured (was: silent auto-mint, because -0 is falsy) -- see decisions/0005", () => {
    assert.throws(
        () => createCRDTDoc({ replicaId: -0 }),
        (e) => e instanceof CRDTError && e.code === "misconfigured",
    );
});

test("C-14: an explicit, truthy caller-supplied replicaId is used VERBATIM (not overwritten)", () => {
    const d = createCRDTDoc({ replicaId: "my-fixed-id" });
    assert.equal(d.replicaId, "my-fixed-id");
    d.dispose();
});

test("C-14 (no C-12 regression): a __proto__ replicaId still round-trips getState -> mergeState without pollution", () => {
    const a = createCRDTDoc({ replicaId: "__proto__" });
    const c = a.counter("c");
    c.inc(5);
    const state = a.getState();
    assert.equal(Object.hasOwn(state.cols.c.p, "__proto__"), true, "the replicaId key is an own key, not a prototype reassignment");

    const b = createCRDTDoc({ replicaId: "B" });
    b.mergeState(state);
    assert.equal(b.counter("c").peek(), 5, "merge converges through a __proto__ replicaId key");
    assert.equal(Object.getPrototypeOf({}), Object.prototype, "global Object.prototype is not polluted");
    a.dispose(); b.dispose();
});

test("C-14 duplicate dispose: disposing a doc twice does not throw, replicaId stays readable", () => {
    const d = createCRDTDoc();
    const id = d.replicaId;
    d.dispose();
    assert.doesNotThrow(() => d.dispose());
    assert.equal(d.replicaId, id, "replicaId is still readable after a duplicate dispose");
});

test("C-14 dispose-during-iteration: disposing the doc from inside an 'op' listener while an undo() is in flight does not throw", () => {
    const d = createCRDTDoc({ replicaId: "A" });
    const m = d.map("m");
    m.set("k", 1);
    m.set("k", 2);
    let disposedInside = false;
    d.on("op", () => {
        if (!disposedInside) { disposedInside = true; d.dispose(); }
    });
    assert.doesNotThrow(() => d.undo());
    assert.equal(disposedInside, true);
    // Post-dispose calls remain inert, never throw.
    assert.doesNotThrow(() => d.undo());
    assert.doesNotThrow(() => d.redo());
    assert.doesNotThrow(() => d.dispose());
});

test("C-14 re-entrant write: calling undo() again from inside the 'op' listener of an in-flight undo() does not throw or corrupt history", () => {
    const d = createCRDTDoc({ replicaId: "A" });
    const m = d.map("m");
    m.set("k", 1);
    m.set("k", 2);
    m.set("k", 3);
    let reentered = false;
    let reentrantResult;
    d.on("op", () => {
        if (!reentered) {
            reentered = true;
            assert.doesNotThrow(() => { reentrantResult = d.undo(); });
        }
    });
    assert.doesNotThrow(() => d.undo());
    assert.equal(reentered, true, "the reentrant undo() call actually fired");
    // Whatever the final value ends up as, the doc must remain in a
    // self-consistent, readable state -- no throw reading canUndo/canRedo/get.
    assert.doesNotThrow(() => d.canUndo());
    assert.doesNotThrow(() => d.canRedo());
    assert.equal(typeof m.get("k"), "number", "the register is still a legal number, not corrupted (undefined/NaN) by the re-entrant history mutation");
    d.dispose();
});

test("C-20: a non-string, truthy replicaId (a number) now throws misconfigured AT CONSTRUCTION -- the divergence hazard is closed at the boundary, not left to the remote door (was: accepted verbatim, silently broke convergence) -- see decisions/0005", () => {
    // Pre-C-20, `opts.replicaId || genReplicaId()` performed no typeof check: a
    // truthy non-string (e.g. a number) was accepted and stamped onto every
    // local op's `r` field, and every PEER's door (okOp, requiring
    // `typeof op.r === "string"`) silently dropped every op this doc emitted --
    // a one-way divergence with zero local signal. C-20 closes this exact
    // hazard at the LOCAL boundary: the doc can no longer even be constructed
    // with such an id, so the divergence can no longer occur at all.
    assert.throws(
        () => createCRDTDoc({ replicaId: 42 }),
        (e) => e instanceof CRDTError && e.code === "misconfigured",
        "a non-string truthy replicaId is now rejected at construction, before any collection or op exists",
    );
    // No doc, no collection, no op was ever created from the throwing call --
    // there is nothing to deliver to a peer and nothing for that peer's door to
    // silently drop anymore.
});

/* ─────────────────────────── Portability (C-14 fix) ────────────────────────── */

test("TLA sanity: `import('../CRDT.js')` resolves and createCRDTDoc is callable (the reviewer's Node 22+ require()-of-ESM NIT is expected and orthogonal)", async () => {
    const m = await import("../CRDT.js");
    assert.equal(typeof m.createCRDTDoc, "function");
    const d = m.createCRDTDoc({ replicaId: "tla-sanity" });
    assert.equal(d.replicaId, "tla-sanity");
    d.dispose();
});

test("C-14 portability: Node-18-default-runtime path (globalThis.crypto absent, node:crypto present) mints a valid id, does not throw", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
        Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
        const m = await import("../CRDT.js?qa-c3-node18=" + Date.now() + "-" + Math.random());
        let d;
        assert.doesNotThrow(() => { d = m.createCRDTDoc(); });
        assert.equal(d.replicaId.length, ID_WIDTH);
        assert.match(d.replicaId, /^r-[0-9a-f]{32}$/);
        d.dispose();
    } finally {
        Object.defineProperty(globalThis, "crypto", original);
    }
    // the real, un-stubbed module still mints fine after restore.
    const sanity = createCRDTDoc();
    assert.equal(sanity.replicaId.length, ID_WIDTH);
    sanity.dispose();
});

test("C-14 portability: a crypto-less realm (no Web Crypto global, no node:crypto) throws CRDTError('misconfigured'), never a weak/empty id", async () => {
    const origCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const origNode = process.versions.node;
    try {
        Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
        Object.defineProperty(process.versions, "node", { value: undefined, configurable: true });
        const m = await import("../CRDT.js?qa-c3-cryptoless=" + Date.now() + "-" + Math.random());
        assert.throws(
            () => m.createCRDTDoc(),
            (e) => e instanceof m.CRDTError && e.code === "misconfigured",
        );
        // it must never return an empty string, undefined, or a weak id -- there
        // is no return value at all, only a throw. Confirm no doc object leaked
        // out of a partially-successful call.
        let threw = false;
        let result;
        try { result = m.createCRDTDoc(); } catch { threw = true; }
        assert.equal(threw, true);
        assert.equal(result, undefined);
    } finally {
        Object.defineProperty(globalThis, "crypto", origCrypto);
        Object.defineProperty(process.versions, "node", { value: origNode, configurable: true });
    }
    const sanity = createCRDTDoc();
    assert.equal(sanity.replicaId.length, ID_WIDTH);
    sanity.dispose();
});

// COVERED BY INSPECTION (independently confirmed, not a stub): genReplicaId's
// `getRandomValues`-only fallback branch (CRDT.js, inside genReplicaId, the
// `else if (typeof CRYPTO.getRandomValues === "function")` arm) cannot be
// reached via an in-process stub. The load-time resolver only ever adopts a
// crypto source that exposes `randomUUID` (the Web Crypto global check is
// gated on `typeof globalThis.crypto.randomUUID === "function"`; node:crypto's
// `webcrypto` exposes both `randomUUID` and `getRandomValues` together, so it
// is never routed to this module with `randomUUID` missing). Producing an
// object with `getRandomValues` but no `randomUUID` would require patching
// `webcrypto` itself post-import, which is impractical and not attempted here.
// Verified by reading CRDT.js lines around genReplicaId's fallback branch.
