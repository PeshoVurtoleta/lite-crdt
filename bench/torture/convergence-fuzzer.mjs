/**
 * bench/torture/convergence-fuzzer.mjs -- seeded, oracle-checked CRDT soak.
 *
 * Not a benchmark -- CONVERGENCE + CORRECTNESS detection:
 *
 *   - CONVERGENCE  several replicas diverge locally (map set/del, OR-Set add/upd/rm,
 *     counter inc/dec) over a small, conflict-dense key space; the captured op log
 *     is replayed in MANY shuffled orders WITH duplicates into fresh docs. Every
 *     replay must reach the identical snapshot (order included) -- the core
 *     commutative + idempotent guarantee.
 *   - TRANSACT     random transactions emit exactly one `ops` frame + one `change`;
 *     forwarding those frames to a peer converges it.
 *   - UNDO/REDO    a random interleaving of local edits, undo and redo, each step
 *     checked against a reference history stack of snapshots (OR-Set compared by
 *     membership/value; undo re-add legitimately re-times element order).
 *
 * Exit code: 0 on clean run, 1 on any assertion failure.
 * Usage: node bench/torture/convergence-fuzzer.mjs        (TORTURE_SCALE=10 to crank)
 *
 * NOTE: installs a roomy default registry with onCapacityExceeded:"grow" (docs use
 * the default lite-signal registry via lite-store/lite-signal).
 */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { createRegistry, setDefaultRegistry, effect, stats } from "@zakkster/lite-signal";
import { createCRDTDoc } from "../../CRDT.js";
import { rng, shuffle } from "../../test/helpers.mjs";

setDefaultRegistry(createRegistry({ maxNodes: 1 << 20, maxLinks: 1 << 22, onCapacityExceeded: "grow" }));
const SCALE = Math.max(1, Number(process.env.TORTURE_SCALE) || 1);
const ri = (rand, n) => Math.floor(rand() * n);

function drive(seed, { replicas, rounds, opsPerRound }) {
    const rand = rng(seed);
    const log = [];
    const docs = [];
    for (let i = 0; i < replicas; i++) { const d = createCRDTDoc({ replicaId: "R" + i }); d.on("op", (op) => log.push(op)); docs.push(d); }
    const KEYS = ["k0", "k1", "k2", "k3"], IDS = ["0", "1", "2", "3", "4"], CTRS = ["votes", "score"];
    const val = () => ri(rand, 1000);
    for (let r = 0; r < rounds; r++) for (const d of docs) {
        for (let o = 0, n = 1 + ri(rand, opsPerRound); o < n; o++) {
            const a = ri(rand, 6);
            if (a === 0) d.map("m").set(KEYS[ri(rand, 4)], val());
            else if (a === 1) d.map("m").delete(KEYS[ri(rand, 4)]);
            else if (a === 2) d.array("L").push({ id: IDS[ri(rand, 5)], v: val() });
            else if (a === 3) d.array("L").deleteById(IDS[ri(rand, 5)]);
            else if (a === 4) d.counter(CTRS[ri(rand, 2)]).inc(1 + ri(rand, 5));
            else d.counter(CTRS[ri(rand, 2)]).dec(1 + ri(rand, 5));
        }
    }
    for (const d of docs) d.dispose();
    return log;
}

function convergence() {
    const RUNS = 6 * SCALE;
    let replays = 0, ops = 0;
    for (let run = 0; run < RUNS; run++) {
        const log = drive(0x100 + run * 7, { replicas: 4, rounds: 30, opsPerRound: 4 });
        ops += log.length;
        const ref = createCRDTDoc({ replicaId: "REF" });
        for (const op of log) ref.applyOp(op);
        const target = ref.snapshot(); ref.dispose();
        for (let s = 0; s < 8; s++) {
            const rand = rng(run * 1000 + s * 13 + 1);
            let order = shuffle(log, rand);
            for (const op of log) if (rand() < 0.15) order.splice(ri(rand, order.length + 1), 0, op);
            const d = createCRDTDoc({ replicaId: "P" + s });
            for (const op of order) d.applyOp(op);
            assert.deepEqual(d.snapshot(), target, `run ${run} shuffle ${s} converged`);
            for (const op of order) d.applyOp(op);
            assert.deepEqual(d.snapshot(), target, `run ${run} shuffle ${s} idempotent`);
            d.dispose(); replays++;
        }
    }
    return `${ops.toLocaleString()} ops, ${replays} shuffled+duplicated replays all converged`;
}

function transactions() {
    const rand = rng(0x7A11);
    const a = createCRDTDoc({ replicaId: "A" }), b = createCRDTDoc({ replicaId: "B" });
    let frames = 0, changes = 0;
    a.on("ops", (ops) => { frames++; b.applyOps(ops); });
    a.on("change", () => changes++);
    const KEYS = ["k0", "k1", "k2"], IDS = ["0", "1", "2"];
    const TX = 800 * SCALE;
    for (let t = 0; t < TX; t++) {
        const bf = frames, bc = changes;
        a.transact(() => {
            for (let i = 0, n = 1 + ri(rand, 5); i < n; i++) {
                const act = ri(rand, 4);
                if (act === 0) a.map("m").set(KEYS[ri(rand, 3)], ri(rand, 100));
                else if (act === 1) a.array("L").push({ id: IDS[ri(rand, 3)], v: ri(rand, 100) });
                else if (act === 2) a.counter("c").inc(1 + ri(rand, 3));
                else a.map("m").delete(KEYS[ri(rand, 3)]);
            }
        });
        assert.equal(frames - bf, 1, `tx ${t} one ops frame`);
        assert.ok(changes - bc <= 1, `tx ${t} at most one change`);
    }
    assert.deepEqual(b.snapshot(), a.snapshot(), "peer converged after transactions");
    a.dispose(); b.dispose();
    return `${TX.toLocaleString()} transactions, one frame each, peer converged`;
}

function canon(snap) {
    const out = {};
    for (const k of Object.keys(snap).sort()) {
        const v = snap[k];
        out[k] = Array.isArray(v) ? v.slice().sort((x, y) => String(x.id).localeCompare(String(y.id))) : v;
    }
    return out;
}

function undoRedo() {
    const rand = rng(0x2222);
    const doc = createCRDTDoc({ replicaId: "A", undoDepth: 1 << 20 });
    const KEYS = ["k0", "k1", "k2", "k3"], IDS = ["0", "1", "2", "3"];
    doc.map("m"); doc.array("L"); doc.counter("c");
    const hist = [canon(doc.snapshot())];
    let cur = 0;
    const doEdit = () => {
        const act = ri(rand, 5);
        if (act === 0) doc.map("m").set(KEYS[ri(rand, 4)], ri(rand, 1000));
        else if (act === 1) { const p = KEYS.filter((k) => doc.map("m").has(k)); if (p.length) doc.map("m").delete(p[ri(rand, p.length)]); else doc.map("m").set(KEYS[ri(rand, 4)], ri(rand, 1000)); }
        else if (act === 2) doc.array("L").push({ id: IDS[ri(rand, 4)], v: ri(rand, 1000) });
        else if (act === 3) { const p = IDS.filter((id) => doc.array("L").hasId(id)); if (p.length) doc.array("L").deleteById(p[ri(rand, p.length)]); else doc.array("L").push({ id: IDS[ri(rand, 4)], v: ri(rand, 1000) }); }
        else doc.counter("c").inc(1 + ri(rand, 5));
        hist.length = cur + 1; hist.push(canon(doc.snapshot())); cur++;
    };
    const STEPS = 6000 * SCALE;
    for (let i = 0; i < STEPS; i++) {
        const r = rand();
        if (r < 0.55) doEdit();
        else if (r < 0.8) { if (doc.undo()) { cur--; assert.deepEqual(canon(doc.snapshot()), hist[cur], `undo to ${cur} step ${i}`); } else assert.equal(cur, 0); }
        else { if (doc.redo()) { cur++; assert.deepEqual(canon(doc.snapshot()), hist[cur], `redo to ${cur} step ${i}`); } else assert.equal(cur, hist.length - 1); }
        assert.equal(doc.canUndo(), cur > 0, `canUndo step ${i}`);
        assert.equal(doc.canRedo(), cur < hist.length - 1, `canRedo step ${i}`);
    }
    while (doc.undo()) cur--;
    assert.equal(cur, 0);
    assert.deepEqual(canon(doc.snapshot()), hist[0], "full undo returns to initial");
    doc.dispose();
    return `${STEPS.toLocaleString()} interleaved edit/undo/redo steps vs a reference stack`;
}

/**
 * Replica ids that contain the OR-Set tag separator. tagKey is
 * `replicaId + "#" + counter`, and the order key used to be recovered with
 * indexOf("#") -- so "team#alice" and "team#bob" both parsed to "team" and
 * collapsed onto one order key, permanently inverting list order between peers.
 */
function separatorInReplicaId() {
    const IDS = ["team#alice", "team#bob", "team#carol"];
    const ROUNDS = 40 * SCALE;
    let checked = 0;
    for (let seed = 1; seed <= ROUNDS; seed++) {
        const rand = rng(seed);
        const docs = IDS.map((id) => createCRDTDoc({ replicaId: id }));
        const outbox = docs.map(() => []);
        docs.forEach((d, i) => d.on("op", (op) => outbox[i].push(JSON.parse(JSON.stringify(op)))));
        for (let r = 0; r < 12; r++) {
            const d = docs[ri(rand, docs.length)];
            if (rand() < 0.7) d.array("L").add({ id: "e" + ri(rand, 4), v: ri(rand, 100) });
            else d.array("L").deleteById("e" + ri(rand, 4));
        }
        for (let src = 0; src < docs.length; src++) {
            for (let dst = 0; dst < docs.length; dst++) if (src !== dst) docs[dst].applyOps(outbox[src]);
        }
        const views = docs.map((d) => JSON.stringify(d.array("L").snapshot()));
        assert.ok(views.every((v) => v === views[0]),
            `seed ${seed}: replicas with '#' in their id diverged\n  ` + views.join("\n  "));
        checked++;
        docs.forEach((d) => d.dispose());
    }
    return `${checked} seeds with '#'-bearing replica ids converged`;
}

/** The .store projection must refuse writes at EVERY depth, not just the root. */
function readOnlyDepth() {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    m.set("cfg", { theme: "dark", nested: { deep: 1 } });
    const a = doc.array("rows");
    a.add({ id: "r1", label: "one", tags: ["x"] });
    const attempts = [
        ["map root", () => { m.store.cfg = "x"; }],
        ["map nested", () => { m.store.cfg.theme = "light"; }],
        ["map deep", () => { m.store.cfg.nested.deep = 2; }],
        ["map nested delete", () => { delete m.store.cfg.theme; }],
        ["map get()", () => { m.get("cfg").theme = "x"; }],
        ["map values()", () => { m.values()[0].theme = "x"; }],
        ["map entries()", () => { m.entries()[0][1].theme = "x"; }],
        ["array push", () => { a.store.push({ id: "r2" }); }],
        ["array row field", () => { a.store[0].label = "hacked"; }],
        ["array nested arr", () => { a.store[0].tags.push("y"); }],
    ];
    for (const [what, fn] of attempts) {
        let threw = false;
        try { fn(); } catch { threw = true; }
        assert.ok(threw, `${what}: a write reached CRDT state without emitting an op`);
    }
    assert.equal(m.get("cfg").theme, "dark", "state mutated despite the guard");
    doc.dispose();
    return `${attempts.length} bypass routes all blocked`;
}

/**
 * A rendered bounded feed must hold a FLAT node ledger. Runs under a hard
 * ceiling on purpose: the "grow" registry this file installs globally would turn
 * a real leak into an invisible bleed. Binds per-row fields, because tracking
 * only .length allocates 3 nodes and passes against a badly leaking store.
 */
function feedNodeLedger() {
    const TICKS = 8000 * SCALE;
    setDefaultRegistry(createRegistry({ maxNodes: 4096 }));
    try {
        const doc = createCRDTDoc({ replicaId: "A", undoDepth: 0 });
        const a = doc.array("feed");
        const stop = effect(() => { const v = a.store; for (let i = 0; i < v.length; i++) void v[i].text; });
        let settled = 0;
        for (let i = 0; i < TICKS; i++) {
            a.add({ id: "m" + i, text: "hello" });
            if (a.size > 50) a.deleteById("m" + (i - 50));
            if (i === 999) settled = stats().activeNodes;
        }
        const end = stats().activeNodes;
        assert.equal(end, settled,
            `node ledger drifted ${settled} -> ${end} over ${TICKS} ticks at a fixed 50-row cap ` +
            "(needs a lite-store with the array shrink-path disposal fix)");
        stop(); doc.dispose();
        return `${TICKS.toLocaleString()} feed ticks, ledger flat at ${end} nodes`;
    } finally {
        setDefaultRegistry(createRegistry({ maxNodes: 1 << 20, maxLinks: 1 << 22, onCapacityExceeded: "grow" }));
    }
}

const t0 = performance.now();
let failures = 0;
function run(name, fn) {
    const s = performance.now();
    try { const info = fn(); console.log(`  PASS ${name}${info ? " -- " + info : ""} (${((performance.now() - s) / 1000).toFixed(2)}s)`); }
    catch (e) { failures++; console.error(`  FAIL ${name}: ${e.message}`); }
}

console.log(`lite-crdt convergence fuzzer (seeded, oracle-checked; scale ${SCALE})`);
run("op-log convergence under shuffle+dupes", convergence);
run("transactions are one frame + converge a peer", transactions);
run("undo/redo tracks a reference history stack", undoRedo);
run("replica ids containing the tag separator", separatorInReplicaId);
run("read-only projection is deep", readOnlyDepth);
run("rendered feed holds a flat node ledger", feedNodeLedger);
console.log(`${failures ? "FAIL" : "PASS"}: ${failures} failure(s) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
process.exit(failures ? 1 : 0);
