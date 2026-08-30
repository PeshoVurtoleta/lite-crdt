/**
 * T1 -- degenerate payloads. Every op type crossed with every degenerate field
 * (l = NaN / +-Inf / "5" / missing / 2^53; r missing/""/non-string; k/id
 * non-string; add n non-number; rm g non-array-of-strings; counter p/n =
 * "9"/NaN/Inf/-5), each pinned to the DECIDED policy (reject-and-continue,
 * decisions/0001): the op is DROPPED and reported to onError, state is left
 * byte-identical to the clean baseline, and validate() still passes.
 */
import { createCRDTDoc } from "../../CRDT.js";
import { check, canon, validate } from "./harness.mjs";

// Degenerate field batteries. Every value here must FAIL the door for the field
// it stands in for. `k`/`id` are only required to be strings (empty string is a
// legal key), so "" is deliberately absent from those.
const BAD_L = [undefined, null, "5", NaN, Infinity, -Infinity, 2 ** 53, 2 ** 53 + 1];
const BAD_R = [undefined, null, "", 5, {}];
const BAD_KEY = [undefined, null, 5, {}, true];
const BAD_N_ADD = [undefined, null, "0", {}, true];
const BAD_G = [undefined, null, "peer#0", [5], [null], [{}], [undefined]];
const BAD_PN = [undefined, null, "9", NaN, Infinity, -Infinity, -5];

function safe(v) {
    return typeof v === "number" && !isFinite(v) ? String(v)
        : v === undefined ? "__undef__" : v;
}

export function run() {
    // Envelope: an unknown op type is still a hard reject (throw), distinct from
    // a known type with a degenerate field (dropped-and-reported).
    const d0 = createCRDTDoc({ replicaId: "T1" });
    let threw = false;
    try { d0.applyOp({ t: "bogus", c: "x" }); } catch (e) { threw = e && e.code === "malformed_op"; }
    check(threw, () => "T1: applyOp with an unknown op type was not rejected as malformed_op");
    d0.dispose();

    // Clean baseline across all three collection kinds.
    const errors = [];
    const d = createCRDTDoc({ replicaId: "T1", onError: (e) => errors.push(e) });
    d.map("M").set("seed", 1);
    d.array("A").add({ id: "seed", v: 1 });
    d.counter("C").inc(3);
    const baseline = canon(d);
    const baseErr = errors.length;

    // Build the poison battery: every op type x every degenerate field.
    const poison = [];
    for (const l of BAD_L) poison.push({ t: "set", c: "M", k: "seed", l, r: "peer", v: 9 });
    for (const r of BAD_R) poison.push({ t: "set", c: "M", k: "seed", l: 9, r, v: 9 });
    for (const k of BAD_KEY) poison.push({ t: "set", c: "M", k, l: 9, r: "peer", v: 9 });
    for (const l of BAD_L) poison.push({ t: "del", c: "M", k: "seed", l, r: "peer" });
    for (const r of BAD_R) poison.push({ t: "del", c: "M", k: "seed", l: 9, r });
    for (const k of BAD_KEY) poison.push({ t: "del", c: "M", k, l: 9, r: "peer" });
    for (const l of BAD_L) poison.push({ t: "add", c: "A", id: "seed", n: 0, v: 9, l, r: "peer" });
    for (const r of BAD_R) poison.push({ t: "add", c: "A", id: "seed", n: 0, v: 9, l: 9, r });
    for (const id of BAD_KEY) poison.push({ t: "add", c: "A", id, n: 0, v: 9, l: 9, r: "peer" });
    for (const n of BAD_N_ADD) poison.push({ t: "add", c: "A", id: "seed", n, v: 9, l: 9, r: "peer" });
    for (const l of BAD_L) poison.push({ t: "upd", c: "A", id: "seed", v: 9, l, r: "peer" });
    for (const id of BAD_KEY) poison.push({ t: "upd", c: "A", id, v: 9, l: 9, r: "peer" });
    for (const l of BAD_L) poison.push({ t: "rm", c: "A", id: "seed", g: ["peer#0"], l, r: "peer" });
    for (const r of BAD_R) poison.push({ t: "rm", c: "A", id: "seed", g: ["peer#0"], l: 9, r });
    for (const id of BAD_KEY) poison.push({ t: "rm", c: "A", id, g: ["peer#0"], l: 9, r: "peer" });
    for (const g of BAD_G) poison.push({ t: "rm", c: "A", id: "seed", g, l: 9, r: "peer" });
    for (const p of BAD_PN) poison.push({ t: "cinc", c: "C", r: "peer", p });
    for (const r of BAD_R) poison.push({ t: "cinc", c: "C", r, p: 1 });
    for (const n of BAD_PN) poison.push({ t: "cdec", c: "C", r: "peer", n });
    for (const r of BAD_R) poison.push({ t: "cdec", c: "C", r, n: 1 });

    for (const op of poison) {
        d.applyOp(op);
        check(canon(d) === baseline, () => "T1: a degenerate op mutated state: t=" + op.t +
            " l=" + safe(op.l) + " r=" + safe(op.r) + " k=" + safe(op.k) + " id=" + safe(op.id) +
            " n=" + safe(op.n) + " p=" + safe(op.p) + " g=" + JSON.stringify(op.g));
        validate(d);
    }
    // Reject-and-continue: every poison op reported exactly once, none applied.
    check(errors.length - baseErr === poison.length, () =>
        "T1: not every degenerate op was reported to onError (" + (errors.length - baseErr) + "/" + poison.length + ")");

    // A subsequent GOOD op still lands -- the door drops poison, not the writer.
    d.map("M").set("seed", 2);
    check(d.map("M").get("seed") === 2, () => "T1: a good local write after poison was lost");
    validate(d);
    d.dispose();
}
