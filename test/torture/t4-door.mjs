/**
 * T4 -- the remote-op / mergeState validation door (thin in v1.1.1; filled in
 * v1.1.2 / C1). The full tier is the fails-before/passes-after proof for
 * C-01..C-07: a poison op/state is rejected AND validate(doc) passes AND the
 * snapshot is byte-identical to a clean run.
 *
 * The door (reject-and-continue) does not exist yet, so this file registers only
 * the envelope check that already holds: a non-op is rejected.
 */
import { createCRDTDoc } from "../../CRDT.js";
import { check } from "./harness.mjs";

export function run() {
    const d = createCRDTDoc({ replicaId: "T4" });
    for (const bad of [null, undefined, 42, "op", {}, { t: "set" }, { c: "m" }]) {
        let threw = false;
        try { d.applyOp(bad); } catch (e) { threw = e && e.code === "malformed_op"; }
        check(threw, () => `T4: applyOp did not reject a malformed envelope: ${JSON.stringify(bad)}`);
    }
    d.dispose();

    // TODO(C1): payload validation (l/r/p/n finite & typed), kind-mismatch routed
    // to onError not thrown, mergeState fail-closed, the BroadcastChannel receive
    // path proven not to throw on a crafted frame.
}
