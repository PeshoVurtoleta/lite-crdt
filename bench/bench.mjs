// Honest microbenchmark for @zakkster/lite-crdt. Measures op-apply and read
// throughput on this machine. Numbers are illustrative, not promises -- run it
// yourself: `npm run bench`. No figures from here are baked into the README.
//
// Sizing note: incremental add/edit touch the ordered projection at O(n) in
// list length (one array splice + a positional scan). That is fine for the
// collection sizes CRDTs are used at (tens to low thousands). Bulk-loading a
// large document is the job of mergeState(), benched separately below, which
// rebuilds the projection once rather than per element.

import {createCRDTDoc} from "../CRDT.js";

function bench(label, iters, fn) {
    for (let i = 0; i < Math.min(iters, 2000); i++) fn(i); // warmup
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn(i);
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    const opsSec = (iters / ms) * 1000;
    console.log(
        "  " + label.padEnd(36) +
        (opsSec | 0).toLocaleString().padStart(13) + " ops/s" +
        ("  (" + ms.toFixed(1) + " ms)").padStart(14),
    );
}

console.log("\n@zakkster/lite-crdt microbench  (node " + process.version + ")\n");

{
    const doc = createCRDTDoc({replicaId: "A"});
    const m = doc.map("m");
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
    bench("LWW-Map set (local, 8 hot keys)", 200000, (i) => m.set(keys[i & 7], i));
    doc.dispose();
}
{
    const doc = createCRDTDoc({replicaId: "A"});
    bench("LWW-Map applyOp (remote set, 1k keys)", 200000, (i) =>
        doc.applyOp({t: "set", c: "m", k: "k" + (i & 1023), v: i, l: i + 1, r: "Z"}));
    doc.dispose();
}
{
    const doc = createCRDTDoc({replicaId: "A"});
    const L = doc.array("L");
    const SIZE = 1000;
    bench("OR-Set push (build " + SIZE + " fresh)", SIZE, (i) => L.push({id: "i" + i, v: i}));
    bench("OR-Set push (edit existing in 1k)", 50000, (i) => L.push({id: "i" + (i % SIZE), v: i}));
    bench("OR-Set values() snapshot (1k)", 5000, () => L.values());
    doc.dispose();
}
{
    const doc = createCRDTDoc({replicaId: "A"});
    bench("OR-Set applyOp (remote add, 1k)", 1000, (i) =>
        doc.applyOp({t: "add", c: "L", id: "x" + i, n: i, v: i, l: i + 1, r: "Z"}));
    doc.dispose();
}
{
    const doc = createCRDTDoc({replicaId: "A"});
    const m = doc.map("m"), L = doc.array("L");
    for (let i = 0; i < 2000; i++) {
        m.set("k" + i, i);
        L.push({id: "i" + i, v: i});
    }
    bench("getState (2k map + 2k set)", 3000, () => doc.getState());
    const snap = doc.getState();
    bench("mergeState into fresh doc (4k)", 1000, () => {
        const d = createCRDTDoc({replicaId: "B"});
        d.mergeState(snap);
        d.dispose();
    });
    doc.dispose();
}
console.log("");
