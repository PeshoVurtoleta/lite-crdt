/**
 * test/27-golden-core-three.test.mjs -- the 2.0 non-break proof (ASSERTION 2).
 *
 * The v2.0.0 RGA work (doc.list / lins,ldel,lmv) is purely ADDITIVE: it must not
 * shift the map / set / counter wire format by a single byte. This gate pins that
 * promise to a checked-in GOLDEN fixture generated from the real v1.3.1 getState()
 * (test/fixtures/golden-core-three.json): the SAME deterministic corpus, driven
 * over the same fixed seed band, applied into the CURRENT (2.0) doc must produce a
 * getState() JSON byte-identical to what v1.3.1 produced. Any drift -- a reordered
 * key, a changed record shape, a new field -- fails here.
 *
 * The fixture was captured by replaying `drive(seed,{replicas:3,rounds:30,
 * opsPerRound:6})` (seeds 0x9e3779b9+1000 .. +1023) into an actual v1.3.1
 * createCRDTDoc and serializing getState(). It is the frozen core-three contract
 * going forward: regenerate it ONLY on a deliberate, documented wire-format change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCRDTDoc } from "../CRDT.js";
import { drive } from "./torture/corpus.mjs";

const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/golden-core-three.json", import.meta.url)), "utf8"));

// The core-three malformed-op corpus (mirrors T5's POISON). Every entry must be
// rejected by the door with the SAME verdict v1.3.1 gave: dropped + reported,
// never applied. okOp is internal, so the verdict is observed off the door.
const POISON = [
    { t: "set", c: "M", k: "a", l: Infinity, r: "evil", v: 999 },
    { t: "set", c: "M", k: "b", l: NaN, r: "evil", v: 999 },
    { t: "set", c: "M", k: "c", r: "evil", v: 999 },
    { t: "set", c: "M", k: "d", l: "5", r: "evil", v: 999 },
    { t: "set", c: "M", k: "e", l: 2 ** 53, r: "evil", v: 999 },
    { t: "del", c: "M", k: "a", l: -Infinity, r: "evil" },
    { t: "set", c: "M", k: "a", l: 1, r: "", v: 999 },
    { t: "add", c: "A", id: "a", n: 0, v: 999, l: NaN, r: "evil" },
    { t: "add", c: "A", id: "a", n: "x", v: 999, l: 1, r: "evil" },
    { t: "upd", c: "A", id: "a", v: 999, l: Infinity, r: "evil" },
    { t: "rm", c: "A", id: "a", g: [5], l: 1, r: "evil" },
    { t: "rm", c: "A", id: "a", g: "peer#0", l: 1, r: "evil" },
    { t: "cinc", c: "C", r: "evil", p: Infinity },
    { t: "cinc", c: "C", r: "evil", p: "9" },
    { t: "cinc", c: "C", r: "", p: 1 },
    { t: "cdec", c: "C", r: "evil", n: -5 },
];

test("core-three getState() is byte-identical to the v1.3.1 golden fixture (2.0 RGA work did not drift the wire format)", () => {
    const seeds = Object.keys(golden);
    assert.equal(seeds.length, 24, "expected 24 golden seed entries");
    for (const seedKey of seeds) {
        const seed = Number(seedKey) >>> 0;
        const log = drive(seed, { replicas: 3, rounds: 30, opsPerRound: 6 });
        const d = createCRDTDoc({ replicaId: "REF" });
        for (const op of log) d.applyOp(op);
        const got = JSON.stringify(d.getState());
        assert.equal(got, golden[seedKey], "seed " + seedKey + ": 2.0 getState() drifted from the v1.3.1 golden wire format");
        d.dispose();
    }
});

test("the core-three POISON corpus is rejected with the frozen door verdict (every op dropped + reported, none applied)", () => {
    for (const p of POISON) {
        const errs = [];
        const d = createCRDTDoc({ replicaId: "V", onError: (e) => errs.push(e) });
        d.applyOp(p);
        assert.equal(errs.length, 1, "poison op must be reported exactly once: " + JSON.stringify(p));
        // No collection state may have been created/mutated by a rejected op.
        const st = d.getState();
        assert.equal(Object.keys(st.cols).length, 0, "a rejected poison op must not create a collection: " + JSON.stringify(p));
        d.dispose();
    }
});
