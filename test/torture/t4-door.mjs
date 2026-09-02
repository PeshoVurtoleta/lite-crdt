/**
 * T4 -- the remote-op / mergeState validation door. The fails-before /
 * passes-after proof for C-01..C-07: each poison op or state is REJECTED
 * (reported to onError, never thrown, never applied), validate(doc) passes, and
 * the canonical snapshot is byte-identical to a clean run that never saw the
 * poison. Plus: a batch drops only its bad frame, and a crafted BroadcastChannel
 * frame cannot throw out of onmessage.
 */
import { createCRDTDoc, connectBroadcastChannel } from "../../CRDT.js";
import { check, canon, validate } from "./harness.mjs";

// Each case: `good` seeds a clean prefix, `poison` is the exact op(s) that
// corrupted v1.1.1, `after` is a further good edit. clean = good+after (no
// poison); dirty = good+poison+after. They must reach the identical snapshot.
const CASES = [
    {
        name: "C-01 l=Infinity poisons the clock",
        good: (x) => { x.map("m").set("a", 1); },
        poison: (x) => x.applyOp({ t: "set", c: "m", k: "b", l: Infinity, r: "peer", v: 2 }),
        after: (x) => { x.map("m").set("c", 3); x.map("m").set("c", 4); },
    },
    {
        name: "C-02 l=NaN freezes a register",
        good: () => {},
        poison: (x) => x.applyOp({ t: "set", c: "m", k: "k", l: NaN, r: "peer", v: "stuck" }),
        after: (x) => { x.map("m").set("k", "fresh"); },
    },
    {
        name: "C-03 non-number counter cumulative",
        good: (x) => { x.counter("c").inc(5); },
        poison: (x) => {
            x.applyOp({ t: "cinc", c: "c", r: "peer", p: "999" });
            x.applyOp({ t: "cinc", c: "c", r: "p2", p: Infinity });
            x.applyOp({ t: "cinc", c: "c", r: "p3", p: NaN });
            x.applyOp({ t: "cdec", c: "c", r: "p4", n: -5 });
        },
        after: () => {},
    },
    {
        name: "C-04 set op with missing / non-number l",
        good: (x) => { x.map("m").set("seed", 0); },
        poison: (x) => {
            x.applyOp({ t: "set", c: "m", k: "b", r: "peer", v: 1 });
            x.applyOp({ t: "set", c: "m", k: "b", l: "5", r: "peer", v: 1 });
        },
        after: () => {},
    },
    {
        name: "C-05 kind-mismatched remote op",
        good: (x) => { x.map("x").set("a", 1); },
        poison: (x) => x.applyOp({ t: "add", c: "x", id: "1", n: 0, v: {}, l: 5, r: "peer" }),
        after: (x) => { x.map("x").set("b", 2); },
    },
    {
        name: "C-07 l at the 2^53 ceiling",
        good: () => {},
        poison: (x) => x.applyOp({ t: "set", c: "m", k: "x", l: 2 ** 53, r: "peer", v: "remote" }),
        after: (x) => { x.map("m").set("y", "a"); },
    },
    {
        // RGA `ldel` door: a non-finite `l`, an empty `br`, a non-finite `bl` and a
        // ceiling `l` are each dropped-and-reported; a legitimate later delete still
        // lands, so the poisoned run reaches the same converged list as the clean one.
        name: "list ldel with degenerate l / br / bl is dropped",
        good: (x) => { x.list("seq").insert(0, "a"); x.list("seq").insert(1, "b"); }, // births (1,"R"),(2,"R")
        poison: (x) => {
            x.applyOp({ t: "ldel", c: "seq", l: Infinity, r: "peer", bl: 1, br: "R" }); // bad l
            x.applyOp({ t: "ldel", c: "seq", l: 9, r: "peer", bl: 1, br: "" });          // empty br
            x.applyOp({ t: "ldel", c: "seq", l: 9, r: "peer", bl: NaN, br: "R" });       // bad bl
            x.applyOp({ t: "ldel", c: "seq", l: 2 ** 53, r: "peer", bl: 1, br: "R" });   // ceiling l
        },
        after: (x) => { x.list("seq").delete(0); }, // legitimately delete "a" -> ["b"]
    },
    {
        // RGA `lmv` door: a non-finite `l`, an empty `br`, a non-finite `bl`, a
        // non-string `or` and a ceiling `l` are each dropped-and-reported; a
        // legitimate later move still lands, so the poisoned run reaches the same
        // converged list as the clean one.
        name: "list lmv with degenerate l / br / bl / or is dropped",
        good: (x) => { x.list("seq").insert(0, "a"); x.list("seq").insert(1, "b"); }, // births (1,"R"),(2,"R")
        poison: (x) => {
            x.applyOp({ t: "lmv", c: "seq", l: Infinity, r: "peer", bl: 1, br: "R", or: null }); // bad l
            x.applyOp({ t: "lmv", c: "seq", l: 9, r: "peer", bl: 1, br: "", or: null });          // empty br
            x.applyOp({ t: "lmv", c: "seq", l: 9, r: "peer", bl: NaN, br: "R", or: null });        // bad bl
            x.applyOp({ t: "lmv", c: "seq", l: 9, r: "peer", bl: 1, br: "R", or: 5, ol: 1 });      // non-string or
            x.applyOp({ t: "lmv", c: "seq", l: 2 ** 53, r: "peer", bl: 1, br: "R", or: null });    // ceiling l
        },
        after: (x) => { x.list("seq").move(1, 0); }, // legitimately move "b" before "a" -> ["b","a"]
    },
];

export function run() {
    // Envelope check (already held in v1.1.1): a non-op is rejected (throw).
    const d = createCRDTDoc({ replicaId: "T4" });
    for (const bad of [null, undefined, 42, "op", {}, { t: "set" }, { c: "m" }]) {
        let threw = false;
        try { d.applyOp(bad); } catch (e) { threw = e && e.code === "malformed_op"; }
        check(threw, () => `T4: applyOp did not reject a malformed envelope: ${JSON.stringify(bad)}`);
    }
    d.dispose();

    // Per-finding fails-before / passes-after.
    for (const c of CASES) {
        const clean = createCRDTDoc({ replicaId: "R" });
        c.good(clean); c.after(clean);
        const target = canon(clean);
        validate(clean);
        clean.dispose();

        const errors = [];
        const dirty = createCRDTDoc({ replicaId: "R", onError: (e) => errors.push(e) });
        c.good(dirty);
        const before = errors.length;
        check(!throws(() => c.poison(dirty)), () => `T4 ${c.name}: poison threw out of applyOp`);
        check(errors.length > before, () => `T4 ${c.name}: poison was not reported (reject-and-continue)`);
        c.after(dirty);
        validate(dirty);
        check(canon(dirty) === target, () => `T4 ${c.name}: poisoned run diverged from the clean run`);
        dirty.dispose();
    }

    // C-06: mergeState fails closed on a malformed payload (missing `removed`),
    // reported, no throw, and validate() still passes.
    const errs = [];
    const d6 = createCRDTDoc({ replicaId: "M6", onError: (e) => errs.push(e) });
    check(!throws(() => d6.mergeState({ cols: { A: { kind: "set", adds: {}, values: {} } } })),
        () => "T4 C-06: mergeState threw on a malformed payload");
    check(errs.length >= 1, () => "T4 C-06: malformed mergeState payload was not reported");
    validate(d6);
    d6.dispose();

    // Batch atomicity: one bad frame in a batch drops only itself (kind-mismatch
    // path -- report-and-continue inside applyOp).
    const berr = [];
    const db = createCRDTDoc({ replicaId: "B", onError: (e) => berr.push(e) });
    db.map("x").set("a", 1);
    check(!throws(() => db.applyOps([
        { t: "add", c: "x", id: "1", n: 0, v: {}, l: 5, r: "peer" }, // kind-mismatch -> dropped
        { t: "set", c: "x", k: "b", l: 9, r: "peer", v: 2 },          // good -> applied
    ])), () => "T4: applyOps threw on a batch containing a bad frame");
    check(db.map("x").get("b") === 2, () => "T4: the good op after a bad frame was dropped");
    check(berr.length >= 1, () => "T4: the bad frame in the batch was not reported");
    db.dispose();

    // applyOps is RESILIENT even to a STRICT-throw frame (unknown op type): the
    // throw is caught and routed to onError, the batch continues, good op applies.
    const rerr = [];
    const dr = createCRDTDoc({ replicaId: "RS", onError: (e) => rerr.push(e) });
    check(!throws(() => dr.applyOps([
        { t: "bogus", c: "m" },                                        // unknown op type -> would throw out of applyOp
        { t: "set", c: "m", k: "good", l: 5, r: "peer", v: 42 },       // good -> must still apply
    ])), () => "T4: applyOps threw on an unknown-op-type frame");
    check(dr.map("m").get("good") === 42, () => "T4: the good op after an unknown-type frame was dropped");
    check(rerr.length >= 1, () => "T4: the unknown-type frame was not reported");
    // A single applyOp stays STRICT: an unknown op type still throws.
    check(throws(() => dr.applyOp({ t: "bogus", c: "m" })), () => "T4: single applyOp did not throw on an unknown op type");
    dr.dispose();

    // S1: a set collection whose live add-id has no value register must be
    // rejected at the door -- no crash, reported, doc stays readable, and
    // getState() never re-emits a live add-id with no value. Includes
    // prototype-name add-ids ("toString"/"constructor"): the cross-check is
    // Object.hasOwn, not `in`, so a proto-name key cannot slip past it.
    for (const badId of ["x", "toString", "constructor"]) {
        const serr = [];
        const ds = createCRDTDoc({ replicaId: "S1", onError: (e) => serr.push(e) });
        check(!throws(() => ds.mergeState({ cols: { A: { kind: "set", adds: { [badId]: { "peer#0": 5 } }, removed: [], values: {} } } })),
            () => "T4 S1: adds-without-values mergeState crashed for id '" + badId + "'");
        check(serr.length >= 1, () => "T4 S1: the malformed set collection ('" + badId + "') was not reported");
        check(!throws(() => ds.array("A").snapshot()), () => "T4 S1: doc unreadable after malformed merge ('" + badId + "')");
        check(!throws(() => ds.getState()), () => "T4 S1: getState() throws after malformed merge ('" + badId + "')");
        validate(ds);
        const A = ds.getState().cols.A;
        if (A) for (const id in A.adds) {
            const tags = A.adds[id];
            let live = false; for (const _t in tags) { live = true; break; }
            check(!live || Object.hasOwn(A.values, id), () => "T4 S1: getState() re-emitted a live add-id '" + id + "' with no value register");
        }
        ds.dispose();
    }

    // C-18 (TOCTOU): a live-accessor payload must not validate benign then poison
    // at use. The door reads every untrusted scalar exactly once.
    // mergeState -- benign-then-poison value register: single read gets benign.
    {
        const errs = [];
        const d = createCRDTDoc({ replicaId: "T11a", onError: (e) => errs.push(e) });
        const values = {};
        let calls = 0;
        Object.defineProperty(values, "x", { enumerable: true, get() { calls++; return calls === 1 ? [1, "peer", "benign"] : [Infinity, "peer", "POISON"]; } });
        check(!throws(() => d.mergeState({ clock: 1, cols: { A: { kind: "set", adds: { x: { "peer#0": 1 } }, removed: [], values } } })),
            () => "T4 C-18: TOCTOU mergeState threw");
        check(calls === 1, () => "T4 C-18: mergeState read the untrusted register " + calls + " times (TOCTOU open)");
        validate(d);
        d.dispose();
    }
    // mergeState -- always-poison value register: single read is poison -> dropped.
    {
        const errs = [];
        const d = createCRDTDoc({ replicaId: "T11b", onError: (e) => errs.push(e) });
        const values = {};
        Object.defineProperty(values, "x", { enumerable: true, get() { return [Infinity, "peer", "POISON"]; } });
        check(!throws(() => d.mergeState({ clock: 1, cols: { A: { kind: "set", adds: { x: { "peer#0": 1 } }, removed: [], values } } })),
            () => "T4 C-18: always-poison mergeState threw");
        check(errs.length >= 1, () => "T4 C-18: always-poison register not reported");
        validate(d);
        d.dispose();
    }
    // applyOp -- benign-then-poison op.l: single read gets benign, clock stays finite.
    {
        const d = createCRDTDoc({ replicaId: "T11c" });
        let calls = 0;
        const op = { t: "set", c: "m", k: "x", r: "peer", v: "V" };
        Object.defineProperty(op, "l", { enumerable: true, get() { calls++; return calls === 1 ? 1 : Infinity; } });
        check(!throws(() => d.applyOp(op)), () => "T4 C-18: TOCTOU applyOp threw");
        check(calls === 1, () => "T4 C-18: applyOp read op.l " + calls + " times (TOCTOU open)");
        check(Number.isFinite(d.clock()), () => "T4 C-18: clock went non-finite via a TOCTOU op-l re-read");
        validate(d);
        d.dispose();
    }
    // applyOp -- always-poison counter op.p: single read is poison -> dropped.
    {
        const errs = [];
        const d = createCRDTDoc({ replicaId: "T11d", onError: (e) => errs.push(e) });
        d.counter("c").inc(5);
        const op = { t: "cinc", c: "c", r: "peer" };
        Object.defineProperty(op, "p", { enumerable: true, get() { return Infinity; } });
        check(!throws(() => d.applyOp(op)), () => "T4 C-18: always-poison counter applyOp threw");
        check(errs.length >= 1, () => "T4 C-18: always-poison counter op not reported");
        check(Number.isFinite(d.counter("c").peek()) && d.counter("c").peek() === 5, () => "T4 C-18: counter poisoned via a TOCTOU op-p re-read");
        validate(d);
        d.dispose();
    }

    // C-19: mergeState must advance the doc clock past every lamport it absorbs
    // (symmetric with applyOp), or a later local write emits a lower lamport and
    // silently loses forever -- validate(doc) would then fail on an ACCEPTED state.
    {
        const d = createCRDTDoc({ replicaId: "T12m" });
        d.mergeState({ clock: 0, cols: { m: { kind: "map", entries: { x: [9, "peer", 0, "remote"] } } } });
        validate(d); // register l=9 <= clock only if the clock advanced
        check(d.clock() >= 9, () => "T4 C-19: clock did not advance past a merged register lamport (" + d.clock() + ")");
        d.map("m").set("x", "MY_LOCAL_EDIT");
        check(d.map("m").get("x") === "MY_LOCAL_EDIT", () => "T4 C-19: a later local map write was frozen out by a merged register");
        validate(d);
        d.dispose();
    }
    {
        const d = createCRDTDoc({ replicaId: "T12s" });
        d.mergeState({ clock: 0, cols: { A: { kind: "set", adds: { u: { "peer#0": 12 } }, removed: [], values: { u: [12, "peer", "remote"] } } } });
        validate(d);
        check(d.clock() >= 12, () => "T4 C-19: clock did not advance past a merged OR-Set lamport (" + d.clock() + ")");
        d.array("A").add({ id: "u", v: "MY_LOCAL_EDIT" });
        check(d.array("A").get("u").v === "MY_LOCAL_EDIT", () => "T4 C-19: a later local OR-Set edit was frozen out by a merged value");
        validate(d);
        d.dispose();
    }

    checkBroadcastGuard();
    checkListPlaceholderFlood();
    checkListMovePlaceholderFlood();
}

// The delete-before-insert placeholder buffer is an unbounded-growth DoS surface
// (a crafted `ldel` naming a birth that never arrives): it MUST cap at PENDING_MAX
// and fail closed, exactly like the origin buffer, and a re-delivered placeholder
// for an already-tombstoned birth must NOT consume a second slot (dedup by birth).
function checkListPlaceholderFlood() {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "LPF", onError: (e) => errs.push(e) });
    const l = d.list("seq");
    const PENDING_MAX = 4096;
    const FLOOD = PENDING_MAX + 64;
    for (let i = 0; i < FLOOD; i++) {
        // Each ldel names a distinct, never-arriving birth -- a crafted-frame flood.
        check(!throws(() => d.applyOp({ t: "ldel", c: "seq", l: 1000 + i, r: "att" + i, bl: i, br: "ghost" + i })),
            () => "T4: a placeholder ldel flood frame threw out of applyOp");
    }
    check(l.size === 0, () => "T4: a fictional-birth ldel must delete nothing (size " + l.size + ")");
    check(l._retention().pending === PENDING_MAX, () => "T4: the delete placeholder buffer must cap at PENDING_MAX (" + l._retention().pending + ")");
    check(errs.length >= 60, () => "T4: overflow placeholder ldels past the cap must be reported (" + errs.length + ")");
    validate(d);
    // A re-delivered placeholder for an already-tombstoned birth must not grow the buffer.
    const before = l._retention().pending;
    d.applyOp({ t: "ldel", c: "seq", l: 1, r: "att0", bl: 0, br: "ghost0" });
    check(l._retention().pending === before, () => "T4: a re-delivered placeholder ldel consumed a new slot (dedup by birth broken)");
    // The doc stays fully usable after the flood.
    check(!throws(() => l.insert(0, "good-local")), () => "T4: a local insert after the placeholder flood threw");
    check(l.size === 1, () => "T4: a genuine insert after the placeholder flood did not apply");
    validate(d);
    d.dispose();
}

// The born-moved placeholder buffer (mvPending) is the MOVE-side twin of the
// delete-before-insert buffer above -- a crafted `lmv` naming a birth that never
// arrives -- and must fail closed identically: cap at PENDING_MAX (shared budget
// with the origin + delete placeholder buffers), report every overflow, and never
// grow unbounded. Symmetric with checkListPlaceholderFlood (the reviewer's nit):
// that check only floods delPending via `ldel`; this one drives mvPending itself
// to overflow via `lmv`, so move-side DoS coverage is not a blind spot.
function checkListMovePlaceholderFlood() {
    const errs = [];
    const d = createCRDTDoc({ replicaId: "MPF", onError: (e) => errs.push(e) });
    const l = d.list("seq");
    const PENDING_MAX = 4096;
    const FLOOD = PENDING_MAX + 64;
    for (let i = 0; i < FLOOD; i++) {
        // Each lmv names a distinct, never-arriving birth (bl=i, br="ghost"+i) with
        // a HEAD origin (or:null) so step 1 (unconditional mint) always resolves
        // immediately -- only the born-moved registration (step 2, markMvPending)
        // is what must fail closed once the shared pendingCount budget is spent.
        check(!throws(() => d.applyOp({ t: "lmv", c: "seq", l: 1000 + i, r: "att" + i, bl: i, br: "ghost" + i, or: null, ol: undefined })),
            () => "T4: a born-moved lmv flood frame threw out of applyOp");
    }
    check(l.size === 0, () => "T4: a fictional-birth lmv must move nothing into visibility (size " + l.size + ")");
    check(l._retention().pending === PENDING_MAX, () => "T4: the move placeholder buffer must cap at PENDING_MAX (" + l._retention().pending + ")");
    check(errs.length >= 60, () => "T4: overflow born-moved lmvs past the cap must be reported (" + errs.length + ")");
    validate(d);
    // A re-delivered born-moved placeholder for an already-registered birth must
    // not grow the buffer (dedup by birth identity, exactly like delPending).
    const before = l._retention().pending;
    d.applyOp({ t: "lmv", c: "seq", l: 1, r: "att0", bl: 0, br: "ghost0", or: null, ol: undefined });
    check(l._retention().pending === before, () => "T4: a re-delivered born-moved lmv consumed a new slot (dedup by birth broken)");
    // The doc stays fully usable after the flood: a genuine local insert still
    // applies, and the birth-anchor mint from the flood (unconditional, step 1)
    // left FLOOD abandoned anchors linked -- the structural chain must still be
    // sound (validate() above already proved this holds mid-flood too).
    check(!throws(() => l.insert(0, "good-local")), () => "T4: a local insert after the move-placeholder flood threw");
    check(l.size === 1, () => "T4: a genuine insert after the move-placeholder flood did not apply");
    validate(d);
    d.dispose();
}

function throws(fn) {
    try { fn(); return false; } catch { return true; }
}

/**
 * A crafted BroadcastChannel frame must not throw out of onmessage. Uses a
 * synchronous BroadcastChannel stand-in so the handler can be driven directly
 * with crafted frames (real BC delivery is async and un-assertable in a sync
 * torture run); the handler is the exact code path connectBroadcastChannel wires.
 */
function checkBroadcastGuard() {
    const RealBC = globalThis.BroadcastChannel;
    let handler = null;
    class FakeBC {
        constructor(name) { this.name = name; }
        set onmessage(fn) { handler = fn; }
        get onmessage() { return handler; }
        postMessage() { /* no peers in the stand-in */ }
        close() { handler = null; }
    }
    globalThis.BroadcastChannel = FakeBC;
    try {
        const errors = [];
        const doc = createCRDTDoc({ replicaId: "BCG", onError: (e) => errors.push(e) });
        doc.map("m").set("a", 1);
        const conn = connectBroadcastChannel(doc, "chan");
        const crafted = [
            { t: "ops", from: "peer", ops: [{ t: "bogus", c: "m" }] },                              // unknown op type in a batch
            { t: "ops", from: "peer", ops: null },                                                  // ops not an array
            { t: "ops", from: "peer", ops: [{ t: "set" }] },                                        // malformed envelope in a batch
            { t: "op", from: "peer", op: { t: "set" } },                                            // malformed single-op envelope
            { t: "ops", from: "peer", ops: [{ t: "set", c: "m", k: "b", l: Infinity, r: "p", v: 2 }] }, // poison field
            { t: "state", from: "peer", state: { cols: { m: { kind: "map" } } } },                  // malformed state collection
            { t: "state", from: "peer", state: null },                                              // null state
            { t: "state", from: "peer", state: 42 },                                                // non-object state
            { t: "op", from: "peer", op: null },                                                    // null single op
            { t: "ops", from: "peer", ops: [{ t: "ldel", c: "seq", l: Infinity, r: "p", bl: 1, br: "A" }] }, // crafted ldel: bad l
            { t: "ops", from: "peer", ops: [{ t: "ldel", c: "seq", l: 5, r: "p", bl: NaN, br: "A" }] },      // crafted ldel: bad bl
            { t: "op", from: "peer", op: { t: "ldel", c: "seq", l: 5, r: "p", bl: 1, br: "" } },              // crafted ldel: empty br
            { t: "ops", from: "peer", ops: [{ t: "lmv", c: "seq", l: Infinity, r: "p", bl: 1, br: "A", or: null }] }, // crafted lmv: bad l
            { t: "ops", from: "peer", ops: [{ t: "lmv", c: "seq", l: 5, r: "p", bl: NaN, br: "A", or: null }] },       // crafted lmv: bad bl
            { t: "op", from: "peer", op: { t: "lmv", c: "seq", l: 5, r: "p", bl: 1, br: "A", or: 5, ol: 1 } },          // crafted lmv: non-string or
        ];
        for (const data of crafted) {
            let threw = false;
            try { handler({ data }); } catch { threw = true; }
            check(!threw, () => "T4: a crafted BroadcastChannel frame threw out of onmessage: " + JSON.stringify(data));
        }
        validate(doc);
        check(errors.length >= 1, () => "T4: crafted frames were not reported to onError");
        conn.dispose();
        doc.dispose();
    } finally {
        globalThis.BroadcastChannel = RealBC;
    }
}
