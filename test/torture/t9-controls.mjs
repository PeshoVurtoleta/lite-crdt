/**
 * T9 -- controls. Every gate the suite relies on, deliberately broken, must be
 * caught here. If a control slips through, T9 fails the whole run -- a gate that
 * cannot fail is decoration.
 */
import { createCRDTDoc } from "../../CRDT.js";
import { runOpsGate, validate, canon, die } from "./harness.mjs";

export function run() {
    // Control 1 -- the zero-alloc gate must REJECT a retained-allocation loop.
    const leak = [];
    const g = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (g.report.ok) die("T9 control 1: an allocating hot loop passed the zero-alloc gate");
    leak.length = 0;

    // Control 2 -- validate() must THROW on a poisoned clock (this is finding
    // C-01, still live in v1.1.1: applyOp with l:Infinity poisons the clock).
    const poisoned = createCRDTDoc({ replicaId: "BAD" });
    poisoned.applyOp({ t: "set", c: "m", k: "x", l: Infinity, r: "peer", v: 1 });
    let caught = false;
    try { validate(poisoned); } catch { caught = true; }
    if (!caught) die("T9 control 2: validate() passed a doc with a non-finite clock");
    poisoned.dispose();

    // Control 3 -- the convergence equality is NON-VACUOUS: two docs fed
    // genuinely different logs must produce different canonical snapshots, so a
    // convergence check that compares them would actually fail.
    const a = createCRDTDoc({ replicaId: "A" });
    const b = createCRDTDoc({ replicaId: "B" });
    a.applyOp({ t: "set", c: "m", k: "k", l: 1, r: "A", v: "one" });
    b.applyOp({ t: "set", c: "m", k: "k", l: 2, r: "B", v: "two" });
    if (canon(a) === canon(b)) die("T9 control 3: divergent docs compared equal (convergence gate is vacuous)");
    a.dispose(); b.dispose();
}
