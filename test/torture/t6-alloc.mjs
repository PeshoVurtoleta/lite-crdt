/**
 * T6 -- the zero-alloc gate on the receive path.
 *
 * An op-based CRDT necessarily allocates the op object when it EMITS (the op is
 * the payload), so the zero-alloc claim lives on APPLY: receiving a remote op
 * mutates registers in place and must not allocate. Gate applyOp for map, set,
 * and counter ops against maxMajor:0 / maxArrayBuffersGrowth:0 with
 * stabilize:'deep'. All docs and ops are built once, outside the measured window.
 */
import { createCRDTDoc } from "../../CRDT.js";
import { measureOps } from "@zakkster/lite-gc-profiler";
import { runOpsGate, check, RULES } from "./harness.mjs";

// First-delivery insert is the ONE list-apply path that must allocate: it mints
// a node + an element record, pushes into the byR index Map, and grows the
// projection array by one slot. Measured surviving cost is a flat ~242-252
// bytes/op, INDEPENDENT of list length (proven O(1), not O(n)) -- the planner's
// "96 = one node" model under-counted (there are TWO objects plus an array slot
// plus a Map entry per insert, not one node). This ceiling is a REGRESSION gate
// tuned just above the true cost: it catches a doubling (a second allocation
// slipping onto the path) or an O(n) leak, while admitting the inherent single-
// node cost. It is EXPLICITLY excluded from the 0-B steady-state claim below.
const FIRST_DELIVERY_MAX = 320;

export function run() {
    // Receiver doc, collections and keys established before the window.
    const d = createCRDTDoc({ replicaId: "RX" });
    const m = d.map("M");
    for (const k of ["a", "b", "c", "d"]) m.set(k, 0);
    const a = d.array("A");
    for (const id of ["a", "b", "c", "d"]) a.add({ id, v: 0 });
    d.counter("C").inc(1);

    // Pre-built remote ops targeting existing keys/ids (no new Map entries).
    const setOps = ["a", "b", "c", "d"].map((k) => ({ t: "set", c: "M", k, v: 0, l: 0, r: "peer" }));
    const updOps = ["a", "b", "c", "d"].map((id) => ({ t: "upd", c: "A", id, v: 0, l: 0, r: "peer" }));
    const incOps = [0, 1, 2, 3].map((i) => ({ t: "cinc", c: "C", r: "p" + i, p: 0 }));

    // set apply (LWW register, in-place).
    let g = runOpsGate((i) => { const op = setOps[i & 3]; op.l = 1000000 + i; op.v = i; d.applyOp(op); },
        { ops: 40000 });
    check(g.report.ok, () => `T6: applyOp(set) allocated -- verdict ${g.report.verdict} ${JSON.stringify(g.report.violations)}`);

    // OR-Set value update apply (in-place value register).
    g = runOpsGate((i) => { const op = updOps[i & 3]; op.l = 2000000 + i; op.v = i; d.applyOp(op); },
        { ops: 40000 });
    check(g.report.ok, () => `T6: applyOp(upd) allocated -- verdict ${g.report.verdict} ${JSON.stringify(g.report.violations)}`);

    // Counter apply (max merge, in-place).
    g = runOpsGate((i) => { const op = incOps[i & 3]; op.p = i; d.applyOp(op); },
        { ops: 40000 });
    check(g.report.ok, () => `T6: applyOp(cinc) allocated -- verdict ${g.report.verdict} ${JSON.stringify(g.report.violations)}`);

    d.dispose();

    // -- RGA list apply (ASSERTION 3) -----------------------------------------
    // The list steady-state receive path -- a REDELIVERED lins/ldel/lmv -- must
    // allocate NOTHING: a redelivered lins/lmv short-circuits on the byR index
    // (anchor already present, no scan, no node), a redelivered ldel on an
    // already-deleted element converges the remover stamp in place. Build a
    // converged state (inserts + WINNING and LOSING concurrent moves + deletes),
    // capture every op, then gate re-applying that whole op set on repeat.

    // Source P: a base sequence with some local moves and deletes.
    const linsOps = [], ldelOps = [], lmvOps = [];
    const S = createCRDTDoc({ replicaId: "P" });
    S.on("op", (op) => { if (op.t === "lins") linsOps.push(op); else if (op.t === "ldel") ldelOps.push(op); else if (op.t === "lmv") lmvOps.push(op); });
    const sl = S.list("seq");
    for (let i = 0; i < 64; i++) sl.insert(sl.size, i);
    for (let i = 0; i < 8; i++) sl.move(i, 40 + i);
    for (let i = 0; i < 8; i++) sl.delete(i);

    // Source Q: same elements (replay P's inserts), then CONCURRENT moves of the
    // same elements -- at the receiver some win and some lose against P's moves,
    // so redelivery exercises BOTH the winning and the losing lmv early-return.
    const Q = createCRDTDoc({ replicaId: "Q" });
    Q.on("op", (op) => { if (op.t === "lmv") lmvOps.push(op); });
    const ql = Q.list("seq");
    for (const op of linsOps) Q.applyOp(op);
    for (let i = 0; i < 12; i++) ql.move(i, 30 + i);

    // Receiver D: apply the full op set ONCE to reach the converged steady state.
    const dl2doc = createCRDTDoc({ replicaId: "RXL" });
    const dl = dl2doc.list("seq");
    const allList = linsOps.concat(ldelOps, lmvOps);
    for (const op of allList) dl2doc.applyOp(op);

    const before = dl._retention();
    const NL = allList.length;
    // Redeliver the whole op set on repeat: every apply is idempotent -> zero alloc.
    g = runOpsGate((i) => { dl2doc.applyOp(allList[i % NL]); }, { ops: 40000 });
    check(g.report.ok, () => `T6: list redelivery apply allocated -- verdict ${g.report.verdict} ${JSON.stringify(g.report.violations)}`);
    // The structural check the heap gate cannot make: not one node/element/pending
    // slot moved across the window.
    const after = dl._retention();
    check(after.anchors === before.anchors, () => `T6: list redelivery changed anchor census ${before.anchors} -> ${after.anchors} (a redelivered op minted a node)`);
    check(after.elems === before.elems, () => `T6: list redelivery changed element census ${before.elems} -> ${after.elems}`);
    check(after.pending === 0, () => `T6: list redelivery left ${after.pending} pending ops (a redelivered op was buffered, not idempotent)`);

    S.dispose(); Q.dispose(); dl2doc.dispose();

    // First-delivery insert, measured SEPARATELY (excluded from the 0-B claim):
    // it mints exactly one node + element + index entry + projection slot, a flat
    // O(1) cost. Ceiling is the regression gate, NOT a zero-alloc claim.
    const F = createCRDTDoc({ replicaId: "FX" });
    F.list("seq");
    const N = 40000;
    const insOps = new Array(N);
    for (let i = 0; i < N; i++) insOps[i] = { t: "lins", c: "seq", l: 100 + i, r: "peer", or: null, v: i };
    const fm = measureOps((i) => { F.applyOp(insOps[i]); }, { ops: N, warmup: 0, stabilize: "deep" });
    check(fm.bytesPerOp !== null && fm.bytesPerOp <= FIRST_DELIVERY_MAX,
        () => `T6: first-delivery list insert cost ${fm.bytesPerOp} B/op exceeds the ${FIRST_DELIVERY_MAX} B/op ceiling (a second allocation slipped onto the insert path)`);
    // maxMajor:0 / maxPauseMs:4 still hold on the first-delivery path (the cost is
    // surviving allocation, not GC churn).
    check(fm.summary.gc.major <= RULES.maxMajor, () => `T6: first-delivery insert triggered ${fm.summary.gc.major} major GC(s)`);
    F.dispose();
}
