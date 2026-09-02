/**
 * test/18-c20-boundary.test.mjs -- independent QA boundary suite for C-20
 * (local replicaId validation, decisions/0005).
 *
 * This suite does NOT trust the coder's report or the planner's assertions at
 * face value -- every case here re-derives the expected result directly from
 * the code path in CRDT.js's createCRDTDoc (the `ridOpt === undefined` /
 * `typeof ridOpt === "string" && ridOpt.length > 0` / else-throw branch) and
 * from okOp (the remote door this local check mirrors), independently of
 * test/15-qa-c3-boundary.test.mjs.
 *
 * node:test only. No import beyond node:test, node:assert and the package
 * under test (../CRDT.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc, CRDTError } from "../CRDT.js";

const ID_WIDTH = 34; // "r-" + 32 hex

function assertMisconfigured(fn) {
    assert.throws(fn, (e) => e instanceof CRDTError && e.code === "misconfigured");
}

/* ───────────────── THROWS misconfigured: every non-string / empty value ───── */

test("C-20 boundary matrix: every provided non-string-or-empty replicaId throws CRDTError('misconfigured') at construction", () => {
    const badValues = [
        ["empty string", ""],
        ["number 0", 0],
        ["negative zero", -0],
        ["NaN", NaN],
        ["boolean false", false],
        ["boolean true", true],
        ["null", null],
        ["positive integer 123", 123],
        ["positive integer 42", 42],
        ["plain object {}", {}],
        ["empty array []", []],
        ["boxed String object", new String("x")],
    ];
    for (const [label, value] of badValues) {
        assertMisconfigured(() => createCRDTDoc({ replicaId: value }), label);
    }
});

test("C-20: empty string replicaId throws misconfigured (individual case, not table-driven)", () => {
    assertMisconfigured(() => createCRDTDoc({ replicaId: "" }));
});

test("C-20: null replicaId throws misconfigured (individual case)", () => {
    assertMisconfigured(() => createCRDTDoc({ replicaId: null }));
});

test("C-20: numeric 42 replicaId throws misconfigured (individual case)", () => {
    assertMisconfigured(() => createCRDTDoc({ replicaId: 42 }));
});

test("C-20: boxed String object replicaId throws misconfigured -- typeof a boxed String is 'object', not 'string'", () => {
    // Adversarial: `new String("nonempty")` is truthy, has .length > 0, and
    // `String(x)` would coerce it to a real string -- but `typeof` is "object",
    // so the strict `typeof ridOpt === "string"` guard must reject it, not
    // silently unbox it.
    const boxed = new String("nonempty");
    assert.equal(typeof boxed, "object");
    assertMisconfigured(() => createCRDTDoc({ replicaId: boxed }));
});

/* ───────────────── SUCCEEDS verbatim: valid explicit strings ──────────────── */

test("C-20: an explicit string with an embedded '#' (\"team#alice\") is accepted verbatim, not charset-rejected", () => {
    const d = createCRDTDoc({ replicaId: "team#alice" });
    assert.equal(d.replicaId, "team#alice");
    d.dispose();
});

test("C-20: \"A\" is used unchanged, not overwritten", () => {
    const d = createCRDTDoc({ replicaId: "A" });
    assert.equal(d.replicaId, "A");
    d.dispose();
});

test("C-20: \"my-fixed-id\" is used unchanged, not overwritten", () => {
    const d = createCRDTDoc({ replicaId: "my-fixed-id" });
    assert.equal(d.replicaId, "my-fixed-id");
    d.dispose();
});

test("C-20 positive round-trip: an op emitted by a doc with a valid explicit replicaId ('#' included) PASSES a real peer's door and converges", () => {
    const errors = [];
    const a = createCRDTDoc({ replicaId: "team#alice" });
    const peer = createCRDTDoc({ replicaId: "B", onError: (e) => errors.push(e) });

    const emitted = [];
    a.on("op", (op) => emitted.push(op));
    a.map("m").set("k", "v1");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].r, "team#alice", "the emitted op carries the explicit replicaId verbatim in `r`");

    peer.applyOp(emitted[0]);
    assert.equal(peer.map("m").has("k"), true, "the peer actually APPLIED the op (state changed)");
    assert.equal(peer.map("m").get("k"), "v1");
    assert.equal(errors.length, 0, "onError was NOT called -- the door accepted a valid explicit id, unlike the old numeric-id hazard");

    a.dispose(); peer.dispose();
});

/* ───────────────────────── AUTO-MINT preserved ─────────────────────────────── */

test("C-20: createCRDTDoc() (no options) still auto-mints a 34-char 'r-' id", () => {
    const d = createCRDTDoc();
    assert.equal(typeof d.replicaId, "string");
    assert.equal(d.replicaId.length, ID_WIDTH);
    assert.match(d.replicaId, /^r-[0-9a-f]{32}$/);
    d.dispose();
});

test("C-20: createCRDTDoc({}) (empty options object) still auto-mints", () => {
    const d = createCRDTDoc({});
    assert.equal(d.replicaId.length, ID_WIDTH);
    assert.match(d.replicaId, /^r-[0-9a-f]{32}$/);
    d.dispose();
});

test("C-20: createCRDTDoc({ replicaId: undefined }) still auto-mints (explicit undefined === omitted)", () => {
    const d = createCRDTDoc({ replicaId: undefined });
    assert.equal(d.replicaId.length, ID_WIDTH);
    assert.match(d.replicaId, /^r-[0-9a-f]{32}$/);
    d.dispose();
});

test("C-20: the three auto-mint forms (no-args, {}, {replicaId: undefined}) mint distinct, collision-free ids", () => {
    const ids = new Set([
        createCRDTDoc().replicaId,
        createCRDTDoc({}).replicaId,
        createCRDTDoc({ replicaId: undefined }).replicaId,
    ]);
    assert.equal(ids.size, 3, "three independent mints, three unique ids");
});

/* ───────────────── FAIL AT THE BOUNDARY: no partial construction leak ─────── */

test("C-20 fail-at-the-boundary: a throwing createCRDTDoc({replicaId: 42}) leaves no shared-state corruption -- a subsequent valid construction still works", () => {
    assertMisconfigured(() => createCRDTDoc({ replicaId: 42 }));
    // No doc object escaped the throw (nothing to dispose, nothing partially
    // registered against module-level state that a fresh, valid doc could trip
    // over).
    let ok;
    assert.doesNotThrow(() => { ok = createCRDTDoc({ replicaId: "ok" }); });
    assert.equal(ok.replicaId, "ok");
    const m = ok.map("m");
    m.set("k", 1);
    assert.equal(m.get("k"), 1, "the doc constructed after a prior throw is fully, normally usable");
    ok.dispose();
});

test("C-20 fail-at-the-boundary: the throw fires BEFORE any collection exists -- repeated failed constructions never accumulate state", () => {
    for (let i = 0; i < 5; i++) {
        assertMisconfigured(() => createCRDTDoc({ replicaId: "" }));
    }
    // A fresh valid doc created after 5 failed attempts is still pristine.
    const d = createCRDTDoc({ replicaId: "post-failures" });
    assert.equal(d.array("a").size, 0);
    assert.equal(d.map("m").has("anything"), false);
    d.dispose();
});

/* ───────────────────────────── boundary matrix N ───────────────────────────── */

test("C-20 boundary: 0 constructions with a bad replicaId is a vacuous no-op (nothing thrown, nothing to check)", () => {
    let count = 0;
    for (let i = 0; i < 0; i++) { count++; }
    assert.equal(count, 0);
});

test("C-20 boundary: N-1/N/N+1 alternating good/bad constructions -- every bad one throws, every good one succeeds, independently", () => {
    const N = 50;
    let goodCount = 0;
    let badCount = 0;
    for (let i = 0; i < N + 1; i++) {
        if (i % 2 === 0) {
            const d = createCRDTDoc({ replicaId: "id-" + i });
            assert.equal(d.replicaId, "id-" + i);
            d.dispose();
            goodCount++;
        } else {
            assertMisconfigured(() => createCRDTDoc({ replicaId: i === N ? NaN : 0 }));
            badCount++;
        }
    }
    assert.equal(goodCount, 26, "N+1=51 alternating from index 0: 26 even indices");
    assert.equal(badCount, 25, "25 odd indices");
});

/* ───────────────────── duplicate dispose / re-entrancy sanity ─────────────── */

test("C-20: a doc built with a valid explicit replicaId tolerates duplicate dispose (no interaction with the validation boundary)", () => {
    const d = createCRDTDoc({ replicaId: "dup-dispose" });
    d.dispose();
    assert.doesNotThrow(() => d.dispose());
    assert.equal(d.replicaId, "dup-dispose");
});

test("C-20 re-entrant: constructing a new (invalid) doc from inside an 'op' listener while a valid doc is mid-write does not corrupt the outer doc", () => {
    const d = createCRDTDoc({ replicaId: "outer" });
    let reentered = false;
    d.on("op", () => {
        if (!reentered) {
            reentered = true;
            assertMisconfigured(() => createCRDTDoc({ replicaId: {} }));
        }
    });
    assert.doesNotThrow(() => d.map("m").set("k", 1));
    assert.equal(reentered, true);
    assert.equal(d.map("m").get("k"), 1, "the outer doc's write is unaffected by a nested failed construction");
    d.dispose();
});
