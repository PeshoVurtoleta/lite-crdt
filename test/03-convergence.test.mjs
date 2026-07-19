import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";
import { rng, shuffle } from "./helpers.mjs";

/**
 * Drive several replicas through interleaved, deliberately-divergent local
 * operations (they do NOT sync during generation), capturing every emitted op.
 * Overlapping key/id spaces guarantee genuine concurrent conflicts. The
 * returned log can then be replayed in any order into fresh docs.
 */
function drive(seed, { replicas, rounds, opsPerRound }) {
    const rand = rng(seed);
    const log = [];
    const docs = [];
    for (let i = 0; i < replicas; i++) {
        const d = createCRDTDoc({ replicaId: "R" + i });
        d.on("op", (op) => log.push(op));
        docs.push(d);
    }
    const KEYS = ["k0", "k1", "k2", "k3", "k4"];
    const IDS = ["0", "1", "2", "3", "4", "5"];
    const val = () => Math.floor(rand() * 1000);

    for (let r = 0; r < rounds; r++) {
        for (const d of docs) {
            const n = 1 + Math.floor(rand() * opsPerRound);
            for (let o = 0; o < n; o++) {
                const action = Math.floor(rand() * 4);
                const m = d.map("m");
                const L = d.array("L");
                if (action === 0) m.set(KEYS[Math.floor(rand() * KEYS.length)], val());
                else if (action === 1) m.delete(KEYS[Math.floor(rand() * KEYS.length)]);
                else if (action === 2) L.push({ id: IDS[Math.floor(rand() * IDS.length)], v: val() });
                else L.deleteById(IDS[Math.floor(rand() * IDS.length)]);
            }
        }
    }
    for (const d of docs) d.dispose();
    return log;
}

/** Apply an op log (optionally shuffled + duplicated) to a fresh doc, return snapshot. */
function replay(log, seed, { duplicate = false } = {}) {
    const doc = createCRDTDoc({ replicaId: "REPLAY" });
    let ops = shuffle(log, rng(seed));
    if (duplicate) {
        // sprinkle in duplicates of ~20% of the ops
        const dups = shuffle(log, rng(seed + 7)).slice(0, Math.floor(log.length * 0.2));
        ops = shuffle(ops.concat(dups), rng(seed + 13));
    }
    for (const op of ops) doc.applyOp(op);
    const snap = doc.snapshot();
    doc.dispose();
    return snap;
}

test("convergence: 3 replicas, replay converges regardless of delivery order", () => {
    const log = drive(1, { replicas: 3, rounds: 6, opsPerRound: 3 });
    assert.ok(log.length > 20, "generated a non-trivial op log");
    const reference = replay(log, 100);
    for (const seed of [101, 202, 303, 404, 505]) {
        assert.deepEqual(replay(log, seed), reference, "order " + seed + " converges");
    }
});

test("convergence is tolerant of duplicate delivery", () => {
    const log = drive(2, { replicas: 3, rounds: 6, opsPerRound: 3 });
    const reference = replay(log, 100);
    for (const seed of [11, 22, 33, 44]) {
        assert.deepEqual(replay(log, seed, { duplicate: true }), reference, "dup order " + seed + " converges");
    }
});

test("convergence: many replicas (6) with heavy contention", () => {
    const log = drive(3, { replicas: 6, rounds: 5, opsPerRound: 4 });
    const reference = replay(log, 1);
    for (const seed of [2, 3, 4, 5, 6, 7, 8]) {
        assert.deepEqual(replay(log, seed, { duplicate: true }), reference);
    }
});

test("live replicas converge once all ops are delivered", () => {
    const log = drive(4, { replicas: 4, rounds: 5, opsPerRound: 3 });
    const reference = replay(log, 99);
    // three live docs each receive the full log in a different order
    const snaps = [50, 60, 70].map((seed) => {
        const d = createCRDTDoc({ replicaId: "LIVE" + seed });
        for (const op of shuffle(log, rng(seed))) d.applyOp(op);
        const s = d.snapshot();
        d.dispose();
        return s;
    });
    for (const s of snaps) assert.deepEqual(s, reference);
});

test("convergence holds across several independent seeds", () => {
    for (const seed of [10, 20, 30, 40, 50]) {
        const log = drive(seed, { replicas: 3, rounds: 5, opsPerRound: 3 });
        const reference = replay(log, seed * 2);
        assert.deepEqual(replay(log, seed * 3, { duplicate: true }), reference, "seed " + seed);
        assert.deepEqual(replay(log, seed * 5), reference, "seed " + seed);
    }
});
