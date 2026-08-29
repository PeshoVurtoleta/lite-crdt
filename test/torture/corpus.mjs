/**
 * test/torture/corpus.mjs -- the shared op-log driver.
 *
 * `drive` runs several replicas over a small, conflict-dense key space (map
 * set/del, OR-Set add/delete, counter inc/dec) and returns the captured op log.
 * The log is the material T0 (laws) and T5 (convergence) replay. Docs are
 * disposed before returning so their signal nodes return to the pool.
 */
import { createCRDTDoc } from "../../CRDT.js";
import { makePrng, frac } from "./harness.mjs";

const KEYS = ["a", "b", "c", "d", "e"];

/** Build an op log by driving `replicas` docs through random local edits. */
export function drive(seed, cfg) {
    const replicas = cfg.replicas === undefined ? 3 : cfg.replicas;
    const rounds = cfg.rounds === undefined ? 40 : cfg.rounds;
    const opsPerRound = cfg.opsPerRound === undefined ? 6 : cfg.opsPerRound;
    const next = makePrng(seed);
    const pick = (n) => Math.floor(frac(next) * n);

    const docs = [];
    const log = [];
    for (let i = 0; i < replicas; i++) {
        const d = createCRDTDoc({ replicaId: "R" + i });
        d.on("op", (op) => log.push(op));
        docs.push(d);
    }
    for (let r = 0; r < rounds; r++) {
        for (const d of docs) {
            const n = 1 + pick(opsPerRound);
            for (let o = 0; o < n; o++) {
                const kind = pick(6);
                const k = KEYS[pick(KEYS.length)];
                try {
                    if (kind === 0) d.map("M").set(k, pick(100));
                    else if (kind === 1) d.map("M").delete(k);
                    else if (kind === 2) d.array("A").add({ id: k, v: pick(100) });
                    else if (kind === 3) d.array("A").delete({ id: k });
                    else if (kind === 4) d.counter("C").inc(1 + pick(5));
                    else d.counter("C").dec(1 + pick(5));
                } catch { /* misconfigured id etc. -- ignore, keep driving */ }
            }
        }
    }
    for (const d of docs) d.dispose();
    return log;
}
