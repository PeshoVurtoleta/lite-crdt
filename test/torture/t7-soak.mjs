/**
 * T7 -- soak, retention, conservation. Build-up / tear-down cycles over merge
 * traffic. After each cycle: validate(doc) passes and dispose() leaves nothing
 * retained (a lite-leak witness -- a second, independent signal from the heap
 * gate: a leaked JS object and a leaked signal node cannot mask each other).
 *
 * The retention BOUND (C-10: valueReg/adds should be O(live), not O(ops)) is
 * decided and asserted in C2; this tier establishes the leak witness and the
 * per-cycle validate discipline now.
 */
import { createLeakTracker } from "@zakkster/lite-leak";
import { createCRDTDoc } from "../../CRDT.js";
import { SEED, makePrng, frac, check, validate } from "./harness.mjs";
import { drive } from "./corpus.mjs";

const CYCLES = Math.max(1, Number(process.env.TORTURE_CYCLES) || 200);

export function run() {
    const tracker = createLeakTracker({ name: "lite-crdt-soak" });

    for (let cycle = 0; cycle < CYCLES; cycle++) {
        const log = drive(SEED + 5000 + cycle, { replicas: 2, rounds: 8, opsPerRound: 5 });
        const d = createCRDTDoc({ replicaId: "SOAK" });
        const handle = tracker.track(d, () => d.dispose(), "doc");
        for (const op of log) d.applyOp(op);
        validate(d);
        // tear down: dispose must release everything this cycle allocated.
        d.dispose();
        tracker.untrack(handle);
    }

    check(tracker.size() === 0, () => `T7: leak tracker retained ${tracker.size()} docs after ${CYCLES} dispose cycles`);
}
