/**
 * C-14 -- replica identity: uniqueness, portability, fail-closed minting.
 *
 * The whole `(lamport, replicaId)` total order (and every OR-Set tag
 * `replicaId + "#" + n`) assumes a globally-unique replicaId per replica. The
 * auto-minted id must therefore have negligible collision probability, a fixed
 * width, resolve a crypto source across every supported runtime (Web Crypto
 * global OR the node:crypto builtin -- Node 18.x default lacks the unflagged
 * global), and -- only in a realm with neither -- FAIL CLOSED rather than mint a
 * weak id (see decisions/0003, C-14).
 *
 * `CRYPTO` is resolved ONCE at module load, so an in-process stub of
 * `globalThis.crypto` cannot reach genReplicaId's branches after the first
 * import. To exercise the load-time resolution we re-import CRDT.js under a
 * cache-busting query (a distinct module URL re-evaluates the module, re-running
 * the top-level crypto resolution against whatever globals are stubbed at that
 * moment). What is stubbed vs inspected is stated at each test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc, CRDTError } from "../CRDT.js";

// The width genReplicaId actually produces: "r-" (2) + 32 hex chars. Both the
// randomUUID primary (dashes stripped) and the getRandomValues fallback yield
// this exact width. If genReplicaId changes width, THIS constant must change
// with it -- the test pins the real width, not a guess.
const ID_WIDTH = 34;

test("C-14: 1e5 auto-minted replica ids are collision-free and fixed-width", () => {
    // Real crypto, primary path. No stub.
    const N = 1e5;
    const ids = new Set();
    for (let i = 0; i < N; i++) {
        const d = createCRDTDoc();            // no replicaId -> auto-mint
        const id = d.replicaId;
        assert.equal(typeof id, "string");
        assert.equal(id.length, ID_WIDTH, "auto-minted id is not the expected width: " + id);
        assert.ok(id.startsWith("r-"), "auto-minted id lost its r- tag: " + id);
        ids.add(id);
        d.dispose();
    }
    assert.equal(ids.size, N, "auto-minted replica ids collided (" + (N - ids.size) + " duplicates in " + N + ")");
});

test("C-14: with no Web Crypto global, node:crypto backs minting (Node 18.x default runtime)", async () => {
    // Node 18.x LTS default runtime does NOT expose the unflagged globalThis.crypto
    // (it landed in Node 19.0.0). Stub the global absent and re-evaluate the module
    // so its load-time resolver must fall back to the node:crypto builtin. Minting
    // must still succeed -- this is the S2 portability fix.
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
        Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
        const m = await import("../CRDT.js?c14=node18-" + Date.now());
        const d = m.createCRDTDoc();
        assert.equal(d.replicaId.length, ID_WIDTH, "node:crypto fallback minted the wrong width: " + d.replicaId);
        assert.ok(d.replicaId.startsWith("r-"));
        d.dispose();
    } finally {
        Object.defineProperty(globalThis, "crypto", original);
    }
});

test("C-14: genReplicaId fails closed in a realm with neither Web Crypto nor node:crypto", async () => {
    // Simulate a genuinely crypto-less realm: no Web Crypto global AND a non-Node
    // realm (process.versions.node falsy), so the load-time resolver skips the
    // node:crypto branch and CRYPTO stays null. createCRDTDoc must THROW
    // misconfigured rather than mint a weak id. Both globals restored in finally.
    const origCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const origNode = process.versions.node;
    try {
        Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
        Object.defineProperty(process.versions, "node", { value: undefined, configurable: true });
        const m = await import("../CRDT.js?c14=cryptoless-" + Date.now());
        assert.throws(
            () => m.createCRDTDoc(),          // no replicaId -> must reach genReplicaId
            (e) => e instanceof m.CRDTError && e.code === "misconfigured",
            "createCRDTDoc did not fail closed with a misconfigured CRDTError in a crypto-less realm"
        );
    } finally {
        Object.defineProperty(globalThis, "crypto", origCrypto);
        Object.defineProperty(process.versions, "node", { value: origNode, configurable: true });
    }
    // Sanity: the normally-imported module (real crypto) still mints fine.
    const d = createCRDTDoc();
    assert.equal(d.replicaId.length, ID_WIDTH);
    d.dispose();
});

// COVERED BY INSPECTION: genReplicaId's `getRandomValues` branch. The load-time
// resolver only adopts a source that exposes `randomUUID` (the Web Crypto global
// is gated on it; node:crypto's `webcrypto` exposes both). No stub can make
// CRYPTO a getRandomValues-only object, so that branch is not reachable via an
// in-process stub; it is a defensive path for a crypto object lacking randomUUID
// and is verified by reading CRDT.js genReplicaId.

test("C-14: a caller-supplied replicaId is used verbatim (auto-mint not invoked)", () => {
    const d = createCRDTDoc({ replicaId: "my-fixed-id" });
    assert.equal(d.replicaId, "my-fixed-id");
    d.dispose();
});
