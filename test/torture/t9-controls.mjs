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

    // Control 2 -- validate() must THROW on a non-finite clock. The applyOp
    // l:Infinity vector that poisoned a real doc in v1.1.1 is now closed by the
    // door, so validate() is fed a stub whose clock() is non-finite (validate
    // only calls doc.clock() and doc.getState()); it must still bite.
    const nonFinite = { clock: () => Infinity, getState: () => ({ cols: {} }) };
    let caught = false;
    try { validate(nonFinite); } catch { caught = true; }
    if (!caught) die("T9 control 2: validate() passed a doc with a non-finite clock");

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
