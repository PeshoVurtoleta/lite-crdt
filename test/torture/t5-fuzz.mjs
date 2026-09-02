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

// Pointwise-min of an array of version vectors (a missing writer counts as 0):
// the SAFE compaction frontier -- every replica has observed everything at/below it.
function minVector(vvs) {
    const keys = new Set();
    for (const vv of vvs) for (const k in vv) keys.add(k);
    const out = Object.create(null);
    for (const k of keys) {
        let m = Infinity;
        for (const vv of vvs) { const n = typeof vv[k] === "number" ? vv[k] : 0; if (n < m) m = n; }
        out[k] = m === Infinity ? 0 : m;
    }
    return out;
}

// A malformed delta the mergeState door MUST reject without diverging any replica.
const POISON_DELTA = {
    replicaId: "evil", clock: Infinity,
    cols: {
        M: { kind: "map", entries: "notanobject" },
        A: { kind: "set", adds: {}, removed: "notarray", values: {} },
        C: { kind: "counter", p: null, n: {} },
    },
};

// The convergence-preservation fuzz (C4): a SECOND replica set runs the SAME
// shuffled+duplicated op stream in delivery ROUNDS; after each round it compacts
// every replica at the CURRENT global min-frontier. Because each original op is
// delivered in exactly one round (duplicates only WITHIN a round) and rounds only
// add higher-lamport ops, a min-frontier at a round boundary is genuinely stable:
// no dropped tombstone's op can be re-delivered. The compacting set must stay
// byte-identical to the non-compacting oracle (decisions/0004).
function compactionParallel(log, seed, target) {
    const next = makePrng(seed ^ 0x5eed4c4);
    const REPS = 3;
    const compActers = [];
    const controls = [];
    for (let i = 0; i < REPS; i++) {
        compActers.push(createCRDTDoc({ replicaId: "K" + i }));
        controls.push(createCRDTDoc({ replicaId: "N" + i }));
    }
    // Deliver the log in emission-order chunks (rounds). Each op appears in exactly
    // one round; duplicates are sprinkled WITHIN the round it belongs to.
    const ROUNDS = 5;
    const chunk = Math.ceil(log.length / ROUNDS) || 1;
    for (let start = 0; start < log.length; start += chunk) {
        const batch = log.slice(start, start + chunk);
        // build a shuffled + duplicated delivery for THIS batch
        const delivery = batch.slice();
        for (let i = delivery.length - 1; i > 0; i--) {
            const j = Math.floor(frac(next) * (i + 1));
            const t = delivery[i]; delivery[i] = delivery[j]; delivery[j] = t;
        }
        for (const op of batch) if (frac(next) < 0.25) delivery.splice(Math.floor(frac(next) * (delivery.length + 1)), 0, op);
        // occasionally inject a malformed delta into the compacting set: the door
        // must reject it, leaving convergence untouched.
        for (let i = 0; i < REPS; i++) {
            for (const op of delivery) { compActers[i].applyOp(op); controls[i].applyOp(op); }
            if (frac(next) < 0.5) compActers[i].mergeState(POISON_DELTA);   // door-rejected, no divergence
        }
        // round boundary: every replica has seen every op so far -> min-frontier is stable.
        const V = minVector(compActers.map((d) => d.versionVector()));
        for (const d of compActers) d.compact(V);
    }
    for (let i = 0; i < REPS; i++) {
        check(canon(compActers[i]) === target, () => `T5/C4 seed ${seed}: compacting replica ${i} diverged from oracle`);
        check(canon(controls[i]) === target, () => `T5/C4 seed ${seed}: control replica ${i} diverged from oracle`);
        validate(compActers[i]);
    }
    for (const d of compActers) d.dispose();
    for (const d of controls) d.dispose();
}

// getStateSince delta sync under ASYMMETRIC per-writer lag (C4): a peer that has
// heard from a random SUBSET of writers ENTIRELY (not a prefix) -- so its frontier
// is at each included writer's max and ZERO on the excluded ones. This is the shape
// that breaks a minAck-filtered `removed` (caught up on a tag's add-writer, never
// told of its remove-writer). One `mergeState(sender.getStateSince(peerVV))` must
// converge the peer to the full-sync oracle -- proving getStateSince ships every
// needed tombstone.
function deltaAsymmetricLag(log, seed, target) {
    const next = makePrng(seed ^ 0xde17a5);
    const writers = [...new Set(log.map((o) => o.r))];
    if (writers.length < 2) return;   // need >= 2 writers to make a proper subset
    let include;
    do { include = new Set(writers.filter(() => frac(next) < 0.5)); }
    while (include.size === 0 || include.size === writers.length);

    const S = createCRDTDoc({ replicaId: "SND" });
    for (const op of log) S.applyOp(op);
    check(canon(S) === target, () => `T5/C4 delta seed ${seed}: sender diverged from oracle`);

    const P = createCRDTDoc({ replicaId: "PER" });
    for (const op of log) if (include.has(op.r)) P.applyOp(op);   // drop excluded writers ENTIRELY

    // The exact advertised call. One delta frame must converge the lagging peer.
    P.mergeState(S.getStateSince(P.versionVector()));
    check(canon(P) === target, () => `T5/C4 delta seed ${seed}: asymmetric-lag peer diverged after getStateSince (include=${[...include].join(",")})`);
    // Idempotent under a second delivery of the same delta.
    P.mergeState(S.getStateSince(P.versionVector()));
    check(canon(P) === target, () => `T5/C4 delta seed ${seed}: peer not idempotent under a re-delivered delta`);
    validate(P);
    S.dispose(); P.dispose();
}

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

        // C4: a parallel replica set that compacts at min-frontiers each round must
        // converge byte-identically to the same oracle (and reject malformed deltas).
        compactionParallel(log, seed, target);
        // C4: getStateSince deltas under asymmetric per-writer lag must converge too.
        deltaAsymmetricLag(log, seed, target);

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
