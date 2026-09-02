/**
 * T7 -- soak, retention, conservation. Build-up / tear-down cycles over merge
 * traffic. After each cycle: validate(doc) passes and dispose() leaves nothing
 * retained (a lite-leak witness -- a second, independent signal from the heap
 * gate: a leaked JS object and a leaked signal node cannot mask each other).
 *
 * The retention BOUND (C-10: the live `adds` map is O(live ids), not O(ops)) is
 * asserted here as of C2: after a bounded id set is churned through many
 * add/delete cycles, the number of `adds` entries never exceeds the live-id
 * count -- an emptied id's dead tag Map is dropped, not retained. valueReg is
 * deliberately KEPT (it carries the LWW max-lamport register; dropping it would
 * diverge -- see decisions/0002).
 */
import { createLeakTracker } from "@zakkster/lite-leak";
import { createCRDTDoc } from "../../CRDT.js";
import { SEED, makePrng, frac, check, validate, canon } from "./harness.mjs";
import { drive } from "./corpus.mjs";

const CYCLES = Math.max(1, Number(process.env.TORTURE_CYCLES) || 200);

export function run() {
    const tracker = createLeakTracker({ name: "lite-crdt-soak" });

    for (let cycle = 0; cycle < CYCLES; cycle++) {
        const log = drive(SEED + 5000 + cycle, { replicas: 2, rounds: 8, opsPerRound: 5 });
        const d = createCRDTDoc({ replicaId: "SOAK" });
        const handle = tracker.track(d, () => d.dispose(), "doc");
        for (const op of log) d.applyOp(op);
        validate(d);
        // tear down: dispose must release everything this cycle allocated.
        d.dispose();
        tracker.untrack(handle);
    }

    check(tracker.size() === 0, () => `T7: leak tracker retained ${tracker.size()} docs after ${CYCLES} dispose cycles`);

    // Door-specific retention witness: 4096 apply/reject cycles (every cycle
    // feeds one good op AND one poison op through the door, so the reject path
    // itself is exercised, not just the happy path) must leave nothing tracked
    // once every doc is disposed -- no retention across the reject-and-continue
    // door (a rejected op's report()/onError closure must not pin the doc).
    const DOOR_CYCLES = 4096;
    const doorTracker = createLeakTracker({ name: "lite-crdt-door-soak" });
    for (let i = 0; i < DOOR_CYCLES; i++) {
        const d = createCRDTDoc({ replicaId: "DOOR", onError: () => {} });
        const handle = doorTracker.track(d, () => d.dispose(), "door-doc");
        d.map("m").set("k", i);                                            // good
        d.applyOp({ t: "set", c: "m", k: "k", l: Infinity, r: "evil", v: -1 }); // reject
        d.applyOp({ t: "cinc", c: "c", r: "evil", p: "999" });              // reject
        d.dispose();
        doorTracker.untrack(handle);
    }
    check(doorTracker.size() === 0, () => `T7: leak tracker retained ${doorTracker.size()} docs after ${DOOR_CYCLES} apply/reject cycles`);

    // Retention soak (C-10): churn a BOUNDED id set through many add/delete
    // cycles. Each delete empties an id's tag Map; that dead entry must be
    // dropped, so `adds` stays O(live ids) -- never O(cycles). If the empty entry
    // leaked, adds size would climb toward RETAIN_CYCLES instead of <= ID_COUNT.
    const RETAIN_CYCLES = 4096;
    const ID_COUNT = 16;
    const rprng = makePrng(SEED ^ 0x5a17);
    const rd = createCRDTDoc({ replicaId: "RETAIN" });
    const arr = rd.array("bag");
    for (let i = 0; i < RETAIN_CYCLES; i++) {
        const id = "id" + (Math.floor(frac(rprng) * ID_COUNT));
        // add then (usually) delete the same id: an emptied id must drop its
        // adds entry, while its value register legitimately persists.
        arr.add({ id, v: i });
        if (frac(rprng) < 0.75) arr.deleteById(id);
    }
    // The internal probe (not getState -- getState filters emptied tag Maps out):
    // `adds` must equal the live member count, so no dead empty entry lingers.
    const r = arr._retention();
    check(r.adds === arr.size, () => `T7: adds map holds ${r.adds} entries but only ${arr.size} ids are live (${r.adds - arr.size} dead empty entries -- C-10 leak)`);
    check(r.adds <= ID_COUNT, () => `T7: adds map grew to ${r.adds} over ${ID_COUNT} ids after ${RETAIN_CYCLES} cycles (retention is not O(live ids))`);
    check(r.valueReg <= ID_COUNT, () => `T7: valueReg grew to ${r.valueReg} over ${ID_COUNT} ids (should be one register per distinct id)`);
    validate(rd);
    rd.dispose();

    // C-14 re-baseline: the WIDENED auto-minted replicaId (34 chars: "r-" + 32
    // hex) lengthens every tagKey (`replicaId + "#" + n`) it stamps. Re-run the
    // retention soak on a doc created WITHOUT a caller replicaId so the wider id
    // genuinely feeds the tag path, and confirm the retention bound is
    // WIDTH-INDEPENDENT: `adds` is still O(live ids), never O(cycles), no matter
    // how long the id is. The RETAIN soak above uses a short caller id ("RETAIN");
    // this one proves the wider default does not change the invariant.
    const wd = createCRDTDoc();                 // auto-mint the id
    // OLD id width was ~10 chars ("r-" + 8 hex), tagKey ~ 12 bytes; NEW id width
    // is 34 chars, tagKey ~ 36 bytes. Pin the NEW width so a silent narrowing of
    // genReplicaId (a uniqueness regression) fails here.
    const ID_WIDTH = 34;
    check(wd.replicaId.length === ID_WIDTH, () => `T7: auto-minted replicaId width is ${wd.replicaId.length}, expected ${ID_WIDTH} (genReplicaId narrowed -- uniqueness regression)`);
    const warr = wd.array("wbag");
    const wprng = makePrng(SEED ^ 0x71d7);
    for (let i = 0; i < RETAIN_CYCLES; i++) {
        const id = "id" + (Math.floor(frac(wprng) * ID_COUNT));
        warr.add({ id, v: i });
        if (frac(wprng) < 0.75) warr.deleteById(id);
    }
    const wr = warr._retention();
    check(wr.adds === warr.size, () => `T7: (wide id) adds holds ${wr.adds} entries but ${warr.size} ids are live (${wr.adds - warr.size} dead empty entries -- C-10 leak)`);
    check(wr.adds <= ID_COUNT, () => `T7: (wide id) adds grew to ${wr.adds} over ${ID_COUNT} ids after ${RETAIN_CYCLES} cycles (retention not O(live ids) -- width leaked into growth)`);
    // Every live tagKey is exactly one id-width + "#" + a decimal counter, so the
    // per-tag byte cost is bounded by the id width, not the cycle count. The
    // widened id costs ~24 extra bytes PER LIVE TAG (a memory cost), never a
    // per-op allocation (T6 proves apply stays zero-alloc).
    validate(wd);
    wd.dispose();

    // C4 compaction soak: churn a BOUNDED live id set through a large add/delete
    // workload on TWO docs stepped in lock-step -- one compacts at its own frontier
    // (single writer, so its versionVector() IS the global min), the other never
    // compacts. The compacting doc's tombstone census must fall to O(live ids); the
    // uncompacted control's grows O(ops). Observable state stays identical, and the
    // leak witness returns to 0 after dispose (decisions/0004).
    const CHURN = 20000;
    const CID = 24;
    const compactTracker = createLeakTracker({ name: "lite-crdt-compact-soak" });
    const cprng = makePrng(SEED ^ 0xc0117ac7);
    const comp = createCRDTDoc({ replicaId: "COMP" });
    const ctrl = createCRDTDoc({ replicaId: "COMP" });          // same id -> identical op stream
    const compH = compactTracker.track(comp, () => comp.dispose(), "comp");
    const ctrlH = compactTracker.track(ctrl, () => ctrl.dispose(), "ctrl");
    const compArr = comp.array("bag"), ctrlArr = ctrl.array("bag");
    const compMap = comp.map("kv"), ctrlMap = ctrl.map("kv");
    for (let i = 0; i < CHURN; i++) {
        const id = "id" + (Math.floor(frac(cprng) * CID));
        const k = "k" + (Math.floor(frac(cprng) * CID));
        const del = frac(cprng) < 0.7;
        const mdel = frac(cprng) < 0.5;
        compArr.add({ id, v: i }); ctrlArr.add({ id, v: i });
        if (del) { compArr.deleteById(id); ctrlArr.deleteById(id); }
        compMap.set(k, i); ctrlMap.set(k, i);
        if (mdel) { compMap.delete(k); ctrlMap.delete(k); }
        if ((i & 4095) === 4095) comp.compact(comp.versionVector());   // periodic reclamation
    }
    comp.compact(comp.versionVector());

    const compRem = compArr._retention().removed;
    const ctrlRem = ctrlArr._retention().removed;
    check(compRem <= CID, () => `T7/C4: compacted removed census ${compRem} exceeds the live id bound ${CID}`);
    check(compArr._retention().valueReg <= CID, () => `T7/C4: compacted valueReg ${compArr._retention().valueReg} exceeds the live id bound ${CID}`);
    check(ctrlRem > compRem, () => `T7/C4: uncompacted control census ${ctrlRem} is not larger than the compacted ${compRem}`);
    check(ctrlRem > CID, () => `T7/C4: uncompacted control census ${ctrlRem} should be O(ops), far above the live id bound ${CID}`);
    // Observable convergence is untouched by compaction.
    check(canon(comp) === canon(ctrl), () => "T7/C4: compaction changed the observable snapshot vs the uncompacted control");
    validate(comp); validate(ctrl);

    comp.dispose(); ctrl.dispose();
    compactTracker.untrack(compH); compactTracker.untrack(ctrlH);
    check(compactTracker.size() === 0, () => `T7/C4: leak tracker retained ${compactTracker.size()} docs after the compaction soak`);
}
