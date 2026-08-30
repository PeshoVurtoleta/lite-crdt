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

// Adversarial malformed ops the door MUST reject. Every one fails okOp on a
// field (never a kind-mismatch), so it is dropped whether or not its target
// collection exists yet -- injecting them into a replay stream must not create
// a collection, mutate state, or diverge any replica from the clean oracle.
const POISON = [
    { t: "set", c: "M", k: "a", l: Infinity, r: "evil", v: 999 },
    { t: "set", c: "M", k: "b", l: NaN, r: "evil", v: 999 },
    { t: "set", c: "M", k: "c", r: "evil", v: 999 },              // no l
    { t: "set", c: "M", k: "d", l: "5", r: "evil", v: 999 },      // string l
    { t: "set", c: "M", k: "e", l: 2 ** 53, r: "evil", v: 999 },  // clock ceiling
    { t: "del", c: "M", k: "a", l: -Infinity, r: "evil" },
    { t: "set", c: "M", k: "a", l: 1, r: "", v: 999 },            // empty replicaId
    { t: "add", c: "A", id: "a", n: 0, v: 999, l: NaN, r: "evil" },
    { t: "add", c: "A", id: "a", n: "x", v: 999, l: 1, r: "evil" }, // non-number tag
    { t: "upd", c: "A", id: "a", v: 999, l: Infinity, r: "evil" },
    { t: "rm", c: "A", id: "a", g: [5], l: 1, r: "evil" },        // non-string tag
    { t: "rm", c: "A", id: "a", g: "peer#0", l: 1, r: "evil" },   // g not an array
    { t: "cinc", c: "C", r: "evil", p: Infinity },
    { t: "cinc", c: "C", r: "evil", p: "9" },
    { t: "cinc", c: "C", r: "", p: 1 },                           // empty replicaId
    { t: "cdec", c: "C", r: "evil", n: -5 },
];

export function run() {
    const RUNS = 24 * SCALE;
    let poisonSeen = 0;
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
            // sprinkle adversarial malformed ops the door must reject
            let injected = 0;
            for (const p of POISON) if (frac(next) < 0.5) { order.splice(Math.floor(frac(next) * (order.length + 1)), 0, p); injected++; }

            const errs = [];
            const d = createCRDTDoc({ replicaId: "D" + s, onError: () => { errs.push(1); } });
            for (const op of order) d.applyOp(op);
            check(errs.length === injected, () => `T5 seed ${seed} shuffle ${s}: door dropped ${errs.length} of ${injected} injected poison ops`);
            poisonSeen += injected;
            check(canon(d) === target, () => `T5 seed ${seed} shuffle ${s}: diverged from oracle`);
            // idempotent under a full re-delivery
            for (const op of order) d.applyOp(op);
            check(canon(d) === target, () => `T5 seed ${seed} shuffle ${s}: not idempotent`);
            validate(d);
            d.dispose();
        }
    }
    check(poisonSeen > 0, () => "T5: no adversarial ops were injected -- the door was never exercised");
}
