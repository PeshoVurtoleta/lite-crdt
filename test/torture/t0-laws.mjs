/**
 * T0 -- metamorphic laws. Over the op corpus, the two properties every op-based
 * CRDT must have by construction:
 *   idempotence  -- applying an op twice equals applying it once;
 *   commutativity -- applying a log in any order reaches the same canonical state.
 * Plus the state-based identity: getState() -> mergeState() into a fresh doc is
 * the identity.
 */
import { createCRDTDoc } from "../../CRDT.js";
import { SEED, makePrng, frac, check, canon, validate } from "./harness.mjs";
import { drive } from "./corpus.mjs";

function shuffle(arr, next) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(frac(next) * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
}

export function run() {
    const next = makePrng(SEED ^ 0x5a5a);
    for (let s = 0; s < 30; s++) {
        const log = drive(SEED + s, { replicas: 3, rounds: 20, opsPerRound: 5 });

        // Reference: apply the log in emission order.
        const ref = createCRDTDoc({ replicaId: "REF" });
        for (const op of log) ref.applyOp(op);
        const target = canon(ref);
        validate(ref);
        ref.dispose();

        // Commutativity: a shuffled order reaches the same canonical state.
        const shuf = createCRDTDoc({ replicaId: "SHUF" });
        for (const op of shuffle(log, next)) shuf.applyOp(op);
        check(canon(shuf) === target, () => `T0 seed ${SEED + s}: shuffled order diverged`);

        // Idempotence: replaying the same log a second time changes nothing.
        for (const op of log) shuf.applyOp(op);
        check(canon(shuf) === target, () => `T0 seed ${SEED + s}: not idempotent under replay`);
        validate(shuf);
        shuf.dispose();

        // State-based identity: getState() -> mergeState() reproduces the doc.
        const src = createCRDTDoc({ replicaId: "SRC" });
        for (const op of log) src.applyOp(op);
        const dst = createCRDTDoc({ replicaId: "DST" });
        dst.mergeState(src.getState());
        check(canon(dst) === canon(src), () => `T0 seed ${SEED + s}: getState/mergeState not the identity`);
        src.dispose(); dst.dispose();
    }
}
