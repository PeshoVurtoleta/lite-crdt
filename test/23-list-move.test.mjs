// C5.3 -- RGA list: move (lmv). MOVE is a first-class LWW position register whose
// value is drawn from the anchor space: applyLmv UNCONDITIONALLY mints + integrates
// a fresh anchor at the destination origin and CONDITIONALLY writes the register
// under tsWins. Covers: two concurrent moves of one element -> one converged
// position (both delivery orders; losing move's anchor abandoned); move || delete
// commute (disjoint fields, delete wins, no resurrection); sequential moves compose
// (latest stamp wins); self-move / no-op; the born-moved placeholder (a move whose
// birth lins has not arrived); a concurrent insert naming a (losing) move's minted
// anchor still lands (why the mint is unconditional); the PINNED backward-typing
// interleaving anomaly (a known RGA property, NOT a bug); move(from, to) index
// validation fails closed and a remote move of a deleted element is an invisible
// no-op; and a scaled mixed lins/ldel/lmv reorder+duplication mini-fuzz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc } from "../CRDT.js";

function capture(doc, sink) { doc.on("op", (op) => sink.push(op)); }

function makePrng(seed) {
    let x = seed >>> 0 || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}
function shuffle(arr, rng) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = rng() % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const p of permutations(rest)) out.push([arr[i]].concat(p));
    }
    return out;
}

// Build the three-element base log ["a","b","c"] on replica A. Births: a=(1,"A"),
// b=(2,"A"), c=(3,"A"). Returns the captured lins ops.
function baseLog() {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a");
    A.list("seq").insert(1, "b");
    A.list("seq").insert(2, "c");
    A.dispose();
    return log;
}

test("two concurrent moves of ONE element converge to one position; the losing move's anchor is abandoned", () => {
    const base = baseLog();
    // Move "b" (birth 2,"A") two ways, concurrently, with distinct stamps:
    //  - M1 (10,"X"): to HEAD.
    //  - M2 (11,"Y"): to the tail (after "c" = origin (A,3)). Higher stamp -> WINS.
    const M1 = { t: "lmv", c: "seq", l: 10, r: "X", bl: 2, br: "A", or: null, ol: undefined };
    const M2 = { t: "lmv", c: "seq", l: 11, r: "Y", bl: 2, br: "A", or: "A", ol: 3 };

    // R1 sees M1 then M2; R2 the opposite. Both must converge to the tsWins winner.
    const R1 = createCRDTDoc({ replicaId: "R1" });
    R1.applyOps(base); R1.applyOp(M1); R1.applyOp(M2);
    const R2 = createCRDTDoc({ replicaId: "R2" });
    R2.applyOps(base); R2.applyOp(M2); R2.applyOp(M1);

    assert.deepEqual(R1.list("seq").values(), ["a", "c", "b"], "R1: M2 (higher stamp) wins -> b after c");
    assert.deepEqual(R2.list("seq").values(), ["a", "c", "b"], "R2: same winner regardless of arrival order");
    assert.deepEqual(R1.list("seq").ids(), ["A#1", "A#3", "A#2"], "ids track BIRTH identity across the move");
    assert.deepEqual(R2.list("seq").ids(), ["A#1", "A#3", "A#2"]);
    assert.equal(JSON.stringify(R1.snapshot()), JSON.stringify(R2.snapshot()));
    // Accounting: 3 births + 2 minted move anchors = 5; the losing move's anchor is
    // abandoned (occupies no element), so live elems stays 3.
    assert.equal(R1.list("seq")._retention().anchors, 5, "both moves minted an anchor; the loser's is abandoned");
    assert.equal(R1.list("seq")._retention().elems, 3, "count tracks LIVE elements, not anchors");
    assert.equal(R2.list("seq")._retention().anchors, 5);
    assert.equal(R2.list("seq")._retention().elems, 3);

    // Redelivering either move in any order is a pure no-op (anchor already minted).
    R1.applyOp(M1); R1.applyOp(M2); R1.applyOp(M2);
    assert.deepEqual(R1.list("seq").values(), ["a", "c", "b"]);
    assert.equal(R1.list("seq")._retention().anchors, 5);
    R1.dispose(); R2.dispose();
});

test("move || delete of the same element commute -> deleted (invisible) on every replica; move does not resurrect", () => {
    const base = baseLog();
    const MV = { t: "lmv", c: "seq", l: 10, r: "X", bl: 2, br: "A", or: null, ol: undefined }; // move "b" to head
    const DEL = { t: "ldel", c: "seq", l: 11, r: "Z", bl: 2, br: "A" };                          // delete "b"

    const R1 = createCRDTDoc({ replicaId: "R1" });
    R1.applyOps(base); R1.applyOp(MV); R1.applyOp(DEL);   // move then delete
    const R2 = createCRDTDoc({ replicaId: "R2" });
    R2.applyOps(base); R2.applyOp(DEL); R2.applyOp(MV);   // delete then move

    assert.deepEqual(R1.list("seq").values(), ["a", "c"], "R1: b is deleted regardless of the concurrent move");
    assert.deepEqual(R2.list("seq").values(), ["a", "c"], "R2: same -- a move never resurrects a deleted element");
    assert.deepEqual(R1.list("seq").ids(), ["A#1", "A#3"]);
    assert.deepEqual(R2.list("seq").ids(), ["A#1", "A#3"]);
    assert.equal(R1.list("seq").size, 2);
    assert.equal(R2.list("seq").size, 2);
    assert.equal(JSON.stringify(R1.snapshot()), JSON.stringify(R2.snapshot()), "move||delete converge byte-identically");

    // Every permutation, each op twice, still converges to the deleted state.
    const rng = makePrng(0xC0FFEE);
    for (const perm of permutations([...base, MV, DEL])) {
        const flooded = [];
        for (const op of perm) { flooded.push(op, op); }
        const d = createCRDTDoc({ replicaId: "P" });
        d.applyOps(shuffle(flooded, rng));
        assert.deepEqual(d.list("seq").values(), ["a", "c"], "move||delete diverged under a reorder+dup permutation");
        assert.equal(d.list("seq").store.length, d.list("seq").size);
        d.dispose();
    }
});

test("sequential moves of one element compose: the latest stamp wins", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    const L = A.list("seq");
    L.insert(0, "a"); L.insert(1, "b"); L.insert(2, "c"); // [a,b,c]
    L.move(1, 0);   // b -> front: [b,a,c]
    assert.deepEqual(L.values(), ["b", "a", "c"]);
    L.move(0, 2);   // b (now at 0) -> post-removal index 2: remove b -> [a,c], insert@2 -> [a,c,b]
    assert.deepEqual(L.values(), ["a", "c", "b"]);
    assert.deepEqual(L.ids(), ["A#1", "A#3", "A#2"], "identity stable across two moves");
    A.dispose();
    assert.equal(log.length, 5, "3 inserts + 2 moves");

    // A peer receiving the whole log in any shuffled+duplicated order converges.
    const rng = makePrng(0xABCD);
    for (let t = 0; t < 200; t++) {
        const flooded = [];
        for (const op of log) { const n = 1 + (rng() % 2); for (let i = 0; i < n; i++) flooded.push(op); }
        const d = createCRDTDoc({ replicaId: "P" });
        d.applyOps(shuffle(flooded, rng));
        assert.deepEqual(d.list("seq").values(), ["a", "c", "b"], "sequential-move stream diverged");
        assert.deepEqual(d.list("seq").ids(), ["A#1", "A#3", "A#2"]);
        d.dispose();
    }
});

test("self-move / no-op move converges and leaves order intact", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    const L = A.list("seq");
    L.insert(0, "a"); L.insert(1, "b"); L.insert(2, "c");
    L.move(1, 1);   // remove b -> [a,c], insert@1 -> [a,b,c] : unchanged
    assert.deepEqual(L.values(), ["a", "b", "c"], "self-move leaves the visible order unchanged");
    assert.deepEqual(L.ids(), ["A#1", "A#2", "A#3"]);
    L.move(0, 0);   // head self-move
    assert.deepEqual(L.values(), ["a", "b", "c"]);
    A.dispose();

    const ref = createCRDTDoc({ replicaId: "Z" });
    ref.applyOps(log);
    assert.deepEqual(ref.list("seq").values(), ["a", "b", "c"], "self-move stream converges to the same order");
    assert.equal(ref.list("seq").store.length, ref.list("seq").size);
    ref.dispose();
});

test("move delivered BEFORE its birth lins (born-moved placeholder) converges once the birth arrives", () => {
    // seed=(1,"S"); a=(5,"A") born after seed; move a to HEAD with stamp (9,"M").
    const insSeed = { t: "lins", c: "seq", l: 1, r: "S", or: null, ol: undefined, v: "seed" };
    const insA = { t: "lins", c: "seq", l: 5, r: "A", or: "S", ol: 1, v: "a" };
    const moveA = { t: "lmv", c: "seq", l: 9, r: "M", bl: 5, br: "A", or: null, ol: undefined };

    // Deliver the move before the birth: it mints its HEAD anchor and pends the
    // register on the birth identity; the birth then relinks the newborn there.
    const d = createCRDTDoc({ replicaId: "Z" });
    const L = d.list("seq");
    d.applyOp(insSeed);
    d.applyOp(moveA);
    assert.deepEqual(L.values(), ["seed"], "the move applies to nothing yet (birth unseen)");
    assert.equal(L._retention().pending, 1, "the move is held as a born-moved placeholder");
    assert.equal(L._retention().anchors, 2, "the move minted its destination anchor unconditionally");
    d.applyOp(insA);
    assert.deepEqual(L.values(), ["a", "seed"], "the newborn is relinked to the moved anchor (at HEAD)");
    assert.equal(L._retention().pending, 0, "the placeholder is reconciled, not stranded");
    assert.deepEqual(L.ids(), ["A#5", "S#1"]);

    // In-order reference and every permutation (each op twice) converge identically.
    const ref = createCRDTDoc({ replicaId: "R" });
    ref.applyOp(insSeed); ref.applyOp(insA); ref.applyOp(moveA);
    assert.deepEqual(ref.list("seq").values(), ["a", "seed"]);
    ref.dispose();

    for (const perm of permutations([insSeed, insA, moveA])) {
        const dd = createCRDTDoc({ replicaId: "P" });
        for (const op of perm) { dd.applyOp(op); dd.applyOp(op); }
        assert.deepEqual(dd.list("seq").values(), ["a", "seed"], "born-moved diverged for a permutation");
        assert.equal(dd.list("seq")._retention().pending, 0);
        assert.deepEqual(dd.list("seq").ids(), ["A#5", "S#1"]);
        dd.dispose();
    }
    d.dispose();
});

test("concurrent born-moved: two moves of an unborn element keep the tsWins winner; the loser's anchor is abandoned", () => {
    const insSeed = { t: "lins", c: "seq", l: 1, r: "S", or: null, ol: undefined, v: "seed" };
    const insA = { t: "lins", c: "seq", l: 5, r: "A", or: "S", ol: 1, v: "a" };
    // Two concurrent moves of the not-yet-born "a": M1 (8,"P") to HEAD; M2 (9,"Q")
    // after seed. M2 has the higher stamp -> it wins when the birth arrives.
    const M1 = { t: "lmv", c: "seq", l: 8, r: "P", bl: 5, br: "A", or: null, ol: undefined };
    const M2 = { t: "lmv", c: "seq", l: 9, r: "Q", bl: 5, br: "A", or: "S", ol: 1 };

    for (const perm of permutations([insSeed, insA, M1, M2])) {
        const d = createCRDTDoc({ replicaId: "P" });
        d.applyOps(perm);
        // M2 wins: "a" sits after seed. seed then a.
        assert.deepEqual(d.list("seq").values(), ["seed", "a"], "born-moved winner diverged for a permutation");
        assert.deepEqual(d.list("seq").ids(), ["S#1", "A#5"]);
        assert.equal(d.list("seq")._retention().pending, 0);
        assert.equal(d.list("seq")._retention().elems, 2);
        d.dispose();
    }
});

test("a concurrent insert naming a LOSING move's minted anchor as origin still lands (the mint is unconditional)", () => {
    const base = baseLog(); // [a,b,c]
    // Move "b" two ways: M1 (10,"X") to HEAD (loses), M2 (11,"Y") to tail (wins).
    const M1 = { t: "lmv", c: "seq", l: 10, r: "X", bl: 2, br: "A", or: null, ol: undefined };
    const M2 = { t: "lmv", c: "seq", l: 11, r: "Y", bl: 2, br: "A", or: "A", ol: 3 };
    // A child insert that names M1's minted anchor (X,10) as its origin. Even when
    // M1 loses (its anchor occupies no element), the anchor is still linked, so the
    // child must integrate right after it. If the mint were conditional, this child's
    // origin would be unseen and it would strand forever -> divergence.
    const child = { t: "lins", c: "seq", l: 20, r: "K", or: "X", ol: 10, v: "kid" };

    let ref = null;
    for (const perm of permutations([...base, M1, M2, child])) {
        const d = createCRDTDoc({ replicaId: "P" });
        d.applyOps(perm);
        const vals = d.list("seq").values();
        // b ends after c (M2 wins); kid lands where M1's abandoned HEAD anchor sits.
        assert.deepEqual(vals, ["kid", "a", "c", "b"], "child of a losing move's anchor was lost/misordered");
        assert.equal(d.list("seq")._retention().pending, 0, "nothing stranded in pending");
        if (ref === null) ref = JSON.stringify(d.snapshot());
        else assert.equal(JSON.stringify(d.snapshot()), ref, "unconditional-mint ordering diverged across a permutation");
        d.dispose();
    }
});

test("PINNED: the backward-typing interleaving anomaly (a known RGA property, NOT a bug)", () => {
    // Two replicas each type a two-char run at HEAD, backward (each new char inserted
    // at index 0). R1 types run "a1 a2"; R2 types run "b1 b2". Both runs share the
    // HEAD origin, so RGA orders all four by (lamport, replicaId) DESCENDING -- and
    // the two runs INTERLEAVE rather than staying contiguous. This is inherent to
    // RGA's concurrent-same-origin rule; we PIN the exact converged output so a
    // future refactor cannot silently change convergence. Do NOT "fix" this.
    const R1a = { t: "lins", c: "seq", l: 1, r: "R1", or: null, ol: undefined, v: "a2" }; // typed first
    const R1b = { t: "lins", c: "seq", l: 2, r: "R1", or: null, ol: undefined, v: "a1" }; // then pushed to front
    const R2a = { t: "lins", c: "seq", l: 1, r: "R2", or: null, ol: undefined, v: "b2" };
    const R2b = { t: "lins", c: "seq", l: 2, r: "R2", or: null, ol: undefined, v: "b1" };
    // DESC by (l, r): (2,"R2")=b1, (2,"R1")=a1, (1,"R2")=b2, (1,"R1")=a2.
    const PINNED = ["b1", "a1", "b2", "a2"];

    const rng = makePrng(0x51DE);
    for (const perm of permutations([R1a, R1b, R2a, R2b])) {
        const d = createCRDTDoc({ replicaId: "P" });
        d.applyOps(shuffle(perm, rng));
        assert.deepEqual(d.list("seq").values(), PINNED,
            "the RGA backward-typing interleaving output changed -- if intentional, update the pin deliberately");
        d.dispose();
    }
});

test("move(from, to) validates both indices and fails closed (misconfigured)", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const L = doc.list("seq");
    L.insert(0, "a"); L.insert(1, "b"); L.insert(2, "c"); // size 3
    const isMis = (e) => e && e.code === "misconfigured";
    // from out of range / non-integer
    assert.throws(() => L.move(3, 0), isMis, "from === size has no live element");
    assert.throws(() => L.move(-1, 0), isMis);
    assert.throws(() => L.move(1.5, 0), isMis);
    assert.throws(() => L.move(NaN, 0), isMis);
    assert.throws(() => L.move(null, 0), isMis);
    assert.throws(() => L.move(undefined, 0), isMis);
    // to out of range / non-integer
    assert.throws(() => L.move(0, 3), isMis, "to === size is out of the post-removal range 0..size-1");
    assert.throws(() => L.move(0, -1), isMis);
    assert.throws(() => L.move(0, 1.5), isMis);
    assert.throws(() => L.move(0, Infinity), isMis);
    // a rejected move leaves order intact and emits nothing
    const emitted = [];
    capture(doc, emitted);
    assert.throws(() => L.move(5, 5), isMis);
    assert.equal(emitted.length, 0, "a rejected move emits no op");
    assert.deepEqual(L.values(), ["a", "b", "c"]);
    doc.dispose();
});

test("a remote move of an already-deleted element is an invisible no-op (no resurrection)", () => {
    const A = createCRDTDoc({ replicaId: "A" });
    const log = [];
    capture(A, log);
    A.list("seq").insert(0, "a"); // A#1
    A.list("seq").insert(1, "b"); // A#2
    A.list("seq").deleteById(2, "A"); // delete "b"
    A.dispose();

    const d = createCRDTDoc({ replicaId: "Z" });
    d.applyOps(log);
    assert.deepEqual(d.list("seq").values(), ["a"]);
    // A remote move naming the deleted "b" must not resurrect it or shift "a".
    d.applyOp({ t: "lmv", c: "seq", l: 20, r: "M", bl: 2, br: "A", or: null, ol: undefined });
    assert.deepEqual(d.list("seq").values(), ["a"], "moving a deleted element must stay invisible");
    assert.deepEqual(d.list("seq").ids(), ["A#1"]);
    assert.equal(d.list("seq").store.length, d.list("seq").size);
    d.dispose();
});

test("mixed lins/ldel/lmv stream converges under reorder + duplication (scaled mini-fuzz)", () => {
    const SCALE = Number(process.env.MOVE_FUZZ_SCALE) || 1;
    const seeds = 24 * SCALE;
    for (let s = 0; s < seeds; s++) {
        const rng = makePrng(0x1000 + s * 2654435761);
        // Drive one replica with random insert/delete/move; capture the op log.
        const A = createCRDTDoc({ replicaId: "A" });
        const log = [];
        capture(A, log);
        const L = A.list("seq");
        let val = 0;
        const OPS = 24;
        for (let i = 0; i < OPS; i++) {
            const size = L.size;
            const roll = rng() % 3;
            if (size === 0 || roll === 0) {
                L.insert(rng() % (size + 1), "v" + (val++));
            } else if (roll === 1 && size >= 1) {
                L.delete(rng() % size);
            } else if (size >= 1) {
                L.move(rng() % size, rng() % size);
            }
        }
        const reference = L.values();
        const refIds = L.ids();
        A.dispose();

        // Replay the log shuffled + duplicated on several replicas; all must match.
        for (let r = 0; r < 4; r++) {
            const flooded = [];
            for (const op of log) { const n = 1 + (rng() % 3); for (let k = 0; k < n; k++) flooded.push(op); }
            const d = createCRDTDoc({ replicaId: "R" + r });
            d.applyOps(shuffle(flooded, rng));
            assert.deepEqual(d.list("seq").values(), reference,
                "mixed stream diverged (seed " + s + ", replica " + r + ")");
            assert.deepEqual(d.list("seq").ids(), refIds, "ids diverged (seed " + s + ", replica " + r + ")");
            assert.equal(d.list("seq").store.length, d.list("seq").size);
            assert.equal(d.list("seq")._retention().pending, 0, "pending stranded after full delivery");
            d.dispose();
        }
    }
});
