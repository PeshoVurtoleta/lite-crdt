/**
 * T5 -- differential convergence fuzz (the oracle). N replicas emit a random op
 * log; the log is replayed in many shuffled, duplicated orders into fresh docs;
 * every replay must reach the identical canonical snapshot, and equal to a
 * single-order reference apply -- the reference IS the oracle.
 *
 * A gated, fixed-capacity descendant of bench/torture/convergence-fuzzer.mjs.
 * C1 will inject adversarial (malformed) ops into the stream that the door must
 * reject without diverging any replica -- the coverage the bench fuzzer lacks.
 */
import { createCRDTDoc } from "../../CRDT.js";
import { SEED, makePrng, frac, check, canon, validate } from "./harness.mjs";
import { drive } from "./corpus.mjs";

const SCALE = Math.max(1, Number(process.env.TORTURE_SCALE) || 1);

export function run() {
    const RUNS = 24 * SCALE;
    for (let run = 0; run < RUNS; run++) {
        const seed = SEED + 1000 + run;
        const log = drive(seed, { replicas: 3, rounds: 30, opsPerRound: 6 });
        const next = makePrng(seed ^ 0xc0ffee);

        // Reference / oracle: apply once, in emission order.
        const ref = createCRDTDoc({ replicaId: "REF" });
        for (const op of log) ref.applyOp(op);
        const target = canon(ref);
        validate(ref);
        ref.dispose();

        // 8 shuffled + duplicated replays must all reach `target`.
        for (let s = 0; s < 8; s++) {
            const order = log.slice();
            for (let i = order.length - 1; i > 0; i--) {
                const j = Math.floor(frac(next) * (i + 1));
                const t = order[i]; order[i] = order[j]; order[j] = t;
            }
            // sprinkle duplicates (redelivery)
            for (const op of log) if (frac(next) < 0.15) order.splice(Math.floor(frac(next) * (order.length + 1)), 0, op);

            const d = createCRDTDoc({ replicaId: "D" + s });
            for (const op of order) d.applyOp(op);
            check(canon(d) === target, () => `T5 seed ${seed} shuffle ${s}: diverged from oracle`);
            // idempotent under a full re-delivery
            for (const op of order) d.applyOp(op);
            check(canon(d) === target, () => `T5 seed ${seed} shuffle ${s}: not idempotent`);
            validate(d);
            d.dispose();
        }
    }
}
