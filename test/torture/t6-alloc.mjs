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
import { runOpsGate, check } from "./harness.mjs";

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
}
