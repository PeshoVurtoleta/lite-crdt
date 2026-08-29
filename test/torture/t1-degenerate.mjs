/**
 * T1 -- degenerate payloads (thin in v1.1.1; filled in v1.1.2 / C1).
 *
 * The full tier crosses every op type with every degenerate field (l = NaN /
 * +-Inf / "5" / missing / 2^53; r missing/""; counter p/n = "9"/NaN/Inf/-5;
 * id = null/""/"__proto__"), pinning the DECIDED policy for each. That policy
 * (reject-and-continue, decisions/0001) does not exist yet, so this file
 * registers only what already holds: an unknown op type is rejected.
 */
import { createCRDTDoc } from "../../CRDT.js";
import { check } from "./harness.mjs";

export function run() {
    const d = createCRDTDoc({ replicaId: "T1" });
    let threw = false;
    try { d.applyOp({ t: "bogus", c: "x" }); } catch (e) { threw = e && e.code === "malformed_op"; }
    check(threw, () => "T1: applyOp with an unknown op type was not rejected as malformed_op");
    d.dispose();

    // TODO(C1): every op type x every degenerate l/r/p/n/id, each pinned to the
    // reject-and-continue policy. Reproductions live in test/regressions.test.mjs
    // as todo tests until the door lands.
}
