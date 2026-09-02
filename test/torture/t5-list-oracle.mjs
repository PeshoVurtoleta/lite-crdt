/**
 * T5 (list) -- the load-bearing RGA convergence oracle (ASSERTION 1).
 *
 * N replicas emit a concurrent `lins`/`ldel`/`lmv` log (with periodic partial
 * cross-delivery so origins genuinely span replicas). The clean log feeds an
 * INDEPENDENT reference RGA (test/torture/rga-oracle.mjs -- array-of-anchors +
 * a birth-keyed element map, re-derived from scratch, no linked list, no pending
 * buffer). The log is then replayed into fresh docs in many shuffled + duplicated
 * + POISON-injected orders; every replay must render byte-identical to the oracle
 * AND to every other replay, re-delivering the whole log must not change the
 * render (idempotence), validate(doc) must pass after every replay, and the
 * injected poison must actually have been exercised (poisonSeen > 0).
 */
import { createCRDTDoc } from "../../CRDT.js";
import { SEED, makePrng, frac, check, validate } from "./harness.mjs";
import { createOracle, renderList } from "./rga-oracle.mjs";

const SCALE = Math.max(1, Number(process.env.TORTURE_SCALE) || 1);

// Malformed list frames the door MUST reject (every one fails okOp on a field),
// so injecting them mutates nothing and diverges no replica.
const POISON = [
    { t: "lins", c: "seq", l: Infinity, r: "evil", or: null, v: 9 },
    { t: "lins", c: "seq", l: NaN, r: "evil", or: null, v: 9 },
    { t: "lins", c: "seq", l: 1, r: "", or: null, v: 9 },              // empty replicaId
    { t: "lins", c: "seq", l: 2 ** 53, r: "evil", or: null, v: 9 },    // clock ceiling
    { t: "lins", c: "seq", l: 1, r: "evil", or: 5, ol: 1, v: 9 },      // numeric origin
    { t: "lins", c: "seq", l: 1, r: "evil", or: "x", ol: "5", v: 9 },  // string ol
    { t: "ldel", c: "seq", l: 1, r: "evil", bl: NaN, br: "x" },        // non-finite bl
    { t: "ldel", c: "seq", l: 1, r: "evil", bl: 1, br: "" },           // empty br
    { t: "lmv", c: "seq", l: Infinity, r: "evil", bl: 1, br: "x", or: null }, // bad l
    { t: "lmv", c: "seq", l: 1, r: "evil", bl: 1, br: "x", or: 7, ol: 1 },    // numeric origin
];

// Drive `replicas` docs through random local list edits, cross-delivering a
// random subset each round so origins span replicas. Returns the emitted log.
function driveList(seed, rounds, replicas) {
    const next = makePrng(seed);
    const pick = (n) => Math.floor(frac(next) * n);
    const docs = [];
    const log = [];
    for (let i = 0; i < replicas; i++) {
        const d = createCRDTDoc({ replicaId: "L" + i });
        d.on("op", (op) => log.push(op));
        docs.push(d);
    }
    const applied = new Array(replicas).fill(0);
    let token = 0;
    for (let r = 0; r < rounds; r++) {
        for (let di = 0; di < replicas; di++) {
            const l = docs[di].list("seq");
            const n = 1 + pick(3);
            for (let o = 0; o < n; o++) {
                const size = l.size;
                const kind = size > 1 ? pick(4) : size > 0 ? pick(2) : 0;
                if (kind === 0 || size === 0) l.insert(pick(size + 1), di * 1000000 + (token++));
                else if (kind === 1) l.delete(pick(size));
                else l.move(pick(size), pick(size));
            }
        }
        // Partial cross-delivery: a random subset of docs catches up on the log.
        const upto = log.length;
        for (let di = 0; di < replicas; di++) {
            if (frac(next) < 0.55) {
                for (let j = applied[di]; j < upto; j++) docs[di].applyOp(log[j]);
                applied[di] = upto;
            }
        }
    }
    for (const d of docs) d.dispose();
    return log;
}

export function run() {
    const RUNS = 24 * SCALE;
    let poisonSeen = 0;
    for (let run = 0; run < RUNS; run++) {
        const seed = SEED + 7000 + run;
        const log = driveList(seed, 14, 5);
        if (log.length === 0) continue;

        // The independent oracle over the CLEAN log.
        const oracle = createOracle();
        for (const op of log) oracle.apply(op);
        const target = oracle.render();

        const next = makePrng((seed ^ 0x0ac1e5) >>> 0);
        const renders = [];
        for (let s = 0; s < 8; s++) {
            const order = log.slice();
            for (let i = order.length - 1; i > 0; i--) {
                const j = Math.floor(frac(next) * (i + 1));
                const t = order[i]; order[i] = order[j]; order[j] = t;
            }
            // duplicates (redelivery)
            for (const op of log) if (frac(next) < 0.15) order.splice(Math.floor(frac(next) * (order.length + 1)), 0, op);
            // adversarial poison the door must reject
            let injected = 0;
            for (const p of POISON) if (frac(next) < 0.6) { order.splice(Math.floor(frac(next) * (order.length + 1)), 0, p); injected++; }

            const errs = [];
            const d = createCRDTDoc({ replicaId: "D" + s, onError: () => { errs.push(1); } });
            const l = d.list("seq");
            for (const op of order) d.applyOp(op);
            check(errs.length === injected, () => `T5-list seed ${seed} shuffle ${s}: door dropped ${errs.length} of ${injected} injected poison frames`);
            poisonSeen += injected;

            const rendered = renderList(l);
            check(rendered === target, () => `T5-list seed ${seed} shuffle ${s}: diverged from the independent oracle\n    doc=${rendered}\n    oracle=${target}`);
            // Idempotent under a full re-delivery of the whole (poisoned) order.
            for (const op of order) d.applyOp(op);
            check(renderList(l) === target, () => `T5-list seed ${seed} shuffle ${s}: not idempotent under re-delivery`);
            validate(d);
            renders.push(rendered);
            d.dispose();
        }
        // Every replay agrees with every other (byte-for-byte).
        for (let s = 1; s < renders.length; s++) {
            check(renders[s] === renders[0], () => `T5-list seed ${seed}: replay ${s} disagrees with replay 0 (mutual divergence)`);
        }
    }
    check(poisonSeen > 0, () => "T5-list: no poison frames were injected -- the door was never exercised");
}
