import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc, connectBroadcastChannel, CRDTError } from "../CRDT.js";
import { installBroadcastChannel, resetBroadcastChannel, flush } from "./helpers.mjs";

test("connectBroadcastChannel throws when BroadcastChannel is unavailable", () => {
    resetBroadcastChannel();
    const doc = createCRDTDoc({ replicaId: "A" });
    assert.throws(() => connectBroadcastChannel(doc, "room"), (e) => e instanceof CRDTError && e.code === "misconfigured");
    doc.dispose();
});

test("two connected docs converge via broadcast ops", async () => {
    installBroadcastChannel();
    try {
        const A = createCRDTDoc({ replicaId: "A" });
        const B = createCRDTDoc({ replicaId: "B" });
        const cA = connectBroadcastChannel(A, "room");
        const cB = connectBroadcastChannel(B, "room");
        await flush();

        A.map("settings").set("theme", "dark");
        A.array("todos").push({ id: "1", text: "milk" });
        B.array("todos").push({ id: "2", text: "eggs" });
        await flush();

        assert.deepEqual(A.snapshot(), B.snapshot(), "both tabs converge");
        assert.equal(B.map("settings").get("theme"), "dark");
        // both adds propagated (deterministic ordering itself is covered in suites 02/03)
        assert.deepEqual(A.array("todos").ids().slice().sort(), ["1", "2"]);

        cA.dispose(); cB.dispose();
        A.dispose(); B.dispose();
    } finally {
        resetBroadcastChannel();
    }
});

test("a late-joining tab is hydrated via the state handshake", async () => {
    installBroadcastChannel();
    try {
        const A = createCRDTDoc({ replicaId: "A" });
        const cA = connectBroadcastChannel(A, "room2");
        await flush();

        // A does work before B exists
        A.map("m").set("k", "v");
        A.array("L").push({ id: "1", v: 1 });
        A.array("L").push({ id: "2", v: 2 });
        await flush();

        // B joins late and requests state
        const B = createCRDTDoc({ replicaId: "B" });
        const cB = connectBroadcastChannel(B, "room2");
        await flush();

        assert.deepEqual(B.snapshot(), A.snapshot(), "late joiner hydrated without op replay");

        cA.dispose(); cB.dispose();
        A.dispose(); B.dispose();
    } finally {
        resetBroadcastChannel();
    }
});

test("dispose stops further cross-tab sync", async () => {
    installBroadcastChannel();
    try {
        const A = createCRDTDoc({ replicaId: "A" });
        const B = createCRDTDoc({ replicaId: "B" });
        const cA = connectBroadcastChannel(A, "room3");
        const cB = connectBroadcastChannel(B, "room3");
        await flush();

        A.map("m").set("a", 1);
        await flush();
        assert.equal(B.map("m").get("a"), 1);

        cB.dispose(); // B stops listening
        A.map("m").set("b", 2);
        await flush();
        assert.equal(B.map("m").get("b"), undefined, "B no longer receives ops");

        cA.dispose();
        A.dispose(); B.dispose();
    } finally {
        resetBroadcastChannel();
    }
});

test("three connected tabs all converge", async () => {
    installBroadcastChannel();
    try {
        const docs = ["A", "B", "C"].map((id) => createCRDTDoc({ replicaId: id }));
        const conns = docs.map((d) => connectBroadcastChannel(d, "room4"));
        await flush();

        docs[0].array("L").push({ id: "1", v: 1 });
        docs[1].array("L").push({ id: "2", v: 2 });
        docs[2].map("m").set("x", 9);
        docs[0].array("L").push({ id: "1", v: 100 }); // edit
        await flush(40);

        const ref = docs[0].snapshot();
        assert.deepEqual(docs[1].snapshot(), ref);
        assert.deepEqual(docs[2].snapshot(), ref);

        conns.forEach((c) => c.dispose());
        docs.forEach((d) => d.dispose());
    } finally {
        resetBroadcastChannel();
    }
});
