/**
 * test/28-four-kind-convergence.test.mjs -- whole-arc convergence sanity (QA, C5.5).
 *
 * The 2.0 RGA work (`doc.list`) sits ALONGSIDE the core three (map/set/counter),
 * not in front of them: this gate drives all FOUR collection kinds in one doc,
 * across N replicas, with genuinely reordered + duplicated op delivery, and
 * proves the whole document -- not just one kind at a time -- converges to a
 * byte-identical getState(), a byte-identical snapshot(), and identical
 * PER-KIND values (map entries, set/array values, counter total, list
 * values()+ids()) on every replica, with the structural invariant
 * (torture harness `validate`, which dispatches to each list's own
 * `_validate` for the kind getState() does not expose) holding throughout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";
import { makePrng, frac, validate, canon } from "./torture/harness.mjs";

const KEYS = ["a", "b", "c", "d", "e"];

/**
 * Drive `replicas` docs through random local edits across all FOUR kinds
 * (map set/delete, set add/delete, counter inc/dec, list insert/delete/move),
 * with partial cross-delivery each round so list origins genuinely span
 * replicas (exactly like the T5-list driver). Returns the full emitted log.
 */
function driveFourKind(seed, rounds, replicas) {
    const next = makePrng(seed);
    const pick = (n) => Math.floor(frac(next) * n);
    const docs = [];
    const log = [];
    for (let i = 0; i < replicas; i++) {
        const d = createCRDTDoc({ replicaId: "F" + i });
        d.on("op", (op) => log.push(op));
        docs.push(d);
    }
    const applied = new Array(replicas).fill(0);
    let token = 0;
    for (let r = 0; r < rounds; r++) {
        for (let di = 0; di < replicas; di++) {
            const d = docs[di];
            const n = 1 + pick(5);
            for (let o = 0; o < n; o++) {
                const kind = pick(8);
                const k = KEYS[pick(KEYS.length)];
                try {
                    if (kind === 0) d.map("M").set(k, pick(1000));
                    else if (kind === 1) d.map("M").delete(k);
                    else if (kind === 2) d.array("A").add({ id: k, v: pick(1000) });
                    else if (kind === 3) d.array("A").delete({ id: k });
                    else if (kind === 4) d.counter("C").inc(1 + pick(5));
                    else if (kind === 5) d.counter("C").dec(1 + pick(5));
                    else if (kind === 6) {
                        const l = d.list("L");
                        l.insert(pick(l.size + 1), di * 1000000 + (token++));
                    } else {
                        const l = d.list("L");
                        if (l.size > 0) { if (pick(2) === 0) l.delete(pick(l.size)); else l.move(pick(l.size), pick(l.size)); }
                    }
                } catch { /* misconfigured (e.g. out-of-range index) -- keep driving */ }
            }
        }
        // Partial cross-delivery: a random subset of docs catches up on the log,
        // so list origins (and map/set/counter conflicts) genuinely span replicas.
        const upto = log.length;
        for (let di = 0; di < replicas; di++) {
            if (frac(next) < 0.5) {
                for (let j = applied[di]; j < upto; j++) docs[di].applyOp(log[j]);
                applied[di] = upto;
            }
        }
    }
    for (const d of docs) d.dispose();
    return log;
}

/**
 * getState() includes the doc's OWN `replicaId` (by design -- it is part of the
 * wire envelope, not the converged content), which legitimately differs between
 * the throwaway verification replicas below. Compare only the `cols` payload --
 * the actual converged CRDT content -- for byte-identity across replicas.
 */
function stateCols(d) { return JSON.stringify(d.getState().cols); }

/** Per-kind rendering used for the explicit cross-replica value comparison. */
function renderKinds(d) {
    const m = d.map("M"), a = d.array("A"), c = d.counter("C"), l = d.list("L");
    return JSON.stringify({
        map: m.entries(),
        set: a.values(),
        counter: c.peek(),
        listValues: l.values(),
        listIds: l.ids(),
    });
}

test("four-kind (map+set+counter+list) end-to-end convergence: N replicas, shuffled+duplicated delivery converges byte-identically across every kind", () => {
    const SEED = 0xC0FFEE;
    const REPLICAS = 4;
    const log = driveFourKind(SEED, 24, REPLICAS);
    assert.ok(log.length > 100, "expected a substantial mixed-kind op log (got " + log.length + ")");
    // The log must actually exercise all four op families, or this gate is vacuous.
    const seenTypes = new Set(log.map((op) => op.t));
    for (const t of ["set", "del", "add", "rm", "cinc", "cdec", "lins"]) {
        assert.ok(seenTypes.has(t), "op family '" + t + "' never appeared in the driven log -- convergence gate is vacuous for it");
    }

    const next = makePrng(SEED ^ 0xBEEF);
    const SHUFFLES = 6;
    const getStates = [], snapshots = [], kindRenders = [];
    for (let s = 0; s < SHUFFLES; s++) {
        const order = log.slice();
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(frac(next) * (i + 1));
            const t = order[i]; order[i] = order[j]; order[j] = t;
        }
        // Duplicates (redelivery): every op may reappear at a random position.
        for (const op of log) if (frac(next) < 0.2) order.splice(Math.floor(frac(next) * (order.length + 1)), 0, op);

        const d = createCRDTDoc({ replicaId: "V" + s });
        for (const op of order) d.applyOp(op);
        validate(d);   // structural invariant across all four kinds
        getStates.push(stateCols(d));
        snapshots.push(canon(d));
        kindRenders.push(renderKinds(d));

        // Idempotence: redelivering the WHOLE (already shuffled+duplicated) order
        // must not change anything -- neither the snapshot nor any per-kind render.
        for (const op of order) d.applyOp(op);
        validate(d);
        assert.equal(canon(d), snapshots[s], "shuffle " + s + ": redelivery changed the converged snapshot");
        assert.equal(renderKinds(d), kindRenders[s], "shuffle " + s + ": redelivery changed a per-kind render");
        d.dispose();
    }

    // Every replay converges to the SAME getState(), the SAME snapshot(), and the
    // SAME per-kind values -- byte-identical, regardless of delivery order.
    for (let s = 1; s < SHUFFLES; s++) {
        assert.equal(getStates[s], getStates[0], "shuffle " + s + ": getState() diverged from shuffle 0");
        assert.equal(snapshots[s], snapshots[0], "shuffle " + s + ": snapshot() diverged from shuffle 0");
        assert.equal(kindRenders[s], kindRenders[0], "shuffle " + s + ": a per-kind value diverged from shuffle 0 (map/set/counter/list)");
    }
});

test("four-kind convergence is NOT vacuous: two docs fed genuinely different four-kind logs must diverge", () => {
    const a = createCRDTDoc({ replicaId: "NA" });
    const b = createCRDTDoc({ replicaId: "NB" });
    a.map("M").set("k", 1);
    a.array("A").add({ id: "x", v: 1 });
    a.counter("C").inc(3);
    a.list("L").insert(0, "one");
    b.map("M").set("k", 2);
    b.array("A").add({ id: "y", v: 2 });
    b.counter("C").inc(7);
    b.list("L").insert(0, "two");
    assert.notEqual(renderKinds(a), renderKinds(b), "divergent four-kind docs compared equal -- the convergence gate would be vacuous");
    assert.notEqual(canon(a), canon(b));
    a.dispose(); b.dispose();
});
