// lite-crdt interactive demo. Imports the real library from source via the
// import map in demo.html. UI re-renders are driven entirely by lite-signal
// effects bound to each replica's CRDT projection.

import { createCRDTDoc } from "@zakkster/lite-crdt";
import { effect } from "@zakkster/lite-signal";

const $ = (id) => document.getElementById(id);

// --- module state (reassigned on reset) ---
let A, B;
const queue = [];        // [{ from:'A'|'B', op, dup?:true }]
let linked = true;
let stops = [];          // effect disposers
let flushTimer = 0;
const els = {};          // DOM nodes cached once at boot (no per-effect lookups)

// --- helpers ---
function mk(tag, name) {
    const doc = createCRDTDoc({ replicaId: name }); // readable replicaId; "Bob" > "Alice" decides LWW ties
    return {
        tag, name, doc, counter: 0,
        map: doc.map("meta"),
        todos: doc.array("todos"),
        reactions: doc.counter("reactions"),   // PN-Counter (1.1): converges by max-per-replica
        listEl: $("list-" + tag), capEl: $("cap-" + tag),
        titleEl: $("title-" + tag), addEl: $("add-" + tag),
        reactEl: $("react-" + tag),
    };
}
const other = (tag) => (tag === "A" ? B : A);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function opLabel(op) {
    switch (op.t) {
        case "set": return "set " + op.k;
        case "del": return "del " + op.k;
        case "add": return "add #" + op.id;
        case "upd": return "edit #" + op.id;
        case "rm":  return "remove #" + op.id;
        case "cinc": return "reactions \u2191";
        case "cdec": return "reactions \u2193";
        default:    return op.t;
    }
}
function log(msg) {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    const div = document.createElement("div");
    div.innerHTML = '<span class="t">' + t + "</span>  " + esc(msg);
    els.log.prepend(div);
}

// stable, key-order-insensitive stringify so the badge never reports a false
// divergence from object key ordering (array order is meaningful and kept).
function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") {
        return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
}

// --- rendering (called from effects) ---
function renderTodos(r) {
    const items = r.todos.values();
    r.listEl.innerHTML = items.map((it) =>
        '<li><button class="chk' + (it.done ? " done" : "") + '" data-id="' + esc(it.id) + '" data-act="toggle" title="toggle done"></button>'
        + '<span class="txt' + (it.done ? " done" : "") + '">' + esc(it.text) + ' <span class="idtag">#' + esc(it.id) + "</span></span>"
        + '<button class="del" data-id="' + esc(it.id) + '" data-act="del" title="delete">remove</button></li>'
    ).join("");
    r.capEl.textContent = "OR-Set \u00b7 " + items.length + (items.length === 1 ? " item" : " items");
}
function syncTitle(r) {
    const v = r.map.get("title") || "";
    if (document.activeElement !== r.titleEl) r.titleEl.value = v; // don't clobber active typing
}
function renderReactions(r) {
    if (r.reactEl) r.reactEl.textContent = String(r.reactions.value()); // reactive PN-Counter read
}
function renderQueue() {
    els.queue.innerHTML = queue.map((e) =>
        '<li class="from-' + e.tag + '"><span class="who">' + e.tag + "</span>"
        + '<span class="opx">' + esc(opLabel(e.op)) + "</span>"
        + (e.dup ? '<span class="dup">duplicate</span>' : "") + "</li>"
    ).join("");
    els.qcount.textContent = queue.length + " in flight";
}
function refreshBadge() {
    const same = stable(A.doc.snapshot()) === stable(B.doc.snapshot());
    void A.reactions.value(); void B.reactions.value();   // track counters too
    const badge = els.badge;
    if (same) {
        if (badge.classList.contains("div")) { badge.classList.add("flash"); setTimeout(() => badge.classList.remove("flash"), 600); }
        badge.className = "badge ok";
        els.badgeLabel.textContent = "STATES CONVERGED";
        els.badgeSub.textContent = "both replicas are byte-for-byte identical";
    } else {
        badge.className = "badge div";
        els.badgeLabel.textContent = "DIVERGENT";
        const n = queue.length;
        els.badgeSub.textContent = n ? (n + " op(s) in flight \u2014 deliver to converge") : "deliver or state-sync to converge";
    }
}

// --- the wire ---
function enqueue(tag, op) {
    queue.push({ tag, op });
    renderQueue(); refreshBadge();
    if (linked) scheduleFlush();
}
function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(deliverAll, 320);
}
function deliverIndex(i) {
    if (i < 0 || i >= queue.length) return;
    const e = queue.splice(i, 1)[0];
    other(e.tag).doc.applyOp(e.op);   // idempotent + commutative
    log(e.tag + " \u2192 " + (e.tag === "A" ? "B" : "A") + " : " + opLabel(e.op) + (e.dup ? " (duplicate)" : ""));
    renderQueue(); refreshBadge();
}
function deliverAll() {
    clearTimeout(flushTimer);
    while (queue.length) deliverIndex(0);
}
function shuffleQueue() {
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = queue[i]; queue[i] = queue[j]; queue[j] = t;
    }
    log("shuffled the op stream (" + queue.length + " queued)");
    renderQueue();
}
function duplicateOne() {
    if (!queue.length) return;
    const i = Math.floor(Math.random() * queue.length);
    const copy = { tag: queue[i].tag, op: queue[i].op, dup: true };
    queue.splice(Math.floor(Math.random() * (queue.length + 1)), 0, copy);
    log("duplicated an op (redelivery is a safe no-op)");
    renderQueue(); refreshBadge();
}
function forceSync() {
    B.doc.mergeState(A.doc.getState());
    A.doc.mergeState(B.doc.getState());
    queue.length = 0;
    clearTimeout(flushTimer);
    log("state-sync: each replica merged the other's full state");
    renderQueue(); refreshBadge();
}

// --- mutations from the UI ---
function addTodo(r) {
    const text = r.addEl.value.trim();
    if (!text) return;
    r.todos.push({ id: r.tag.toLowerCase() + "-" + (++r.counter), text, done: false });
    r.addEl.value = "";
}
function onListClick(r, ev) {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    if (btn.dataset.act === "del") {
        r.todos.deleteById(id);
    } else {
        const cur = r.todos.get(id);
        if (cur) r.todos.push({ ...cur, done: !cur.done }); // edit -> upd (LWW value, no reorder)
    }
}

// --- scenarios ---
function setLink(on) {
    linked = on;
    const b = $("link");
    b.dataset.state = on ? "on" : "off";
    b.textContent = "LINK: " + (on ? "ONLINE" : "OFFLINE");
    if (on) scheduleFlush();
}
function scenarioLWW() {
    forceSync(); setLink(false);
    A.map.set("title", "Alice's launch plan");
    B.map.set("title", "Bob's roadmap");
    log("offline: Alice and Bob set the title concurrently. Shuffle + Deliver all to resolve.");
    refreshBadge();
}
function scenarioAddWins() {
    forceSync(); setLink(false);
    A.todos.push({ id: "shared", text: "Draft the spec", done: false }); // A adds
    A.todos.deleteById("shared");                                         // ...then removes it (sees only its own tag)
    B.todos.push({ id: "shared", text: "Draft the spec (Bob)", done: false }); // B's concurrent fresh add
    log("offline: Alice added then deleted #shared; Bob added it concurrently. Deliver all \u2014 it survives (add-wins).");
    refreshBadge();
}
function scenarioBatch() {
    // transact() (1.1): a burst of edits leaves as ONE ops frame -> one network
    // send, one applyOps on the far side (see the "one frame" log line).
    A.doc.transact(() => {
        A.todos.push({ id: "a-batch1", text: "Write the RFC", done: false });
        A.todos.push({ id: "a-batch2", text: "Get sign-off", done: false });
        A.reactions.inc(2);
        A.map.set("title", "Sprint plan (batched)");
    });
    log("transact: Alice made 4 edits in one atomic frame.");
    refreshBadge();
}

// --- lifecycle ---
function bindUI() {
    els.badge = $("badge"); els.badgeLabel = $("badge-label"); els.badgeSub = $("badge-sub");
    els.queue = $("queue"); els.qcount = $("qcount"); els.log = $("log");
    for (const tag of ["A", "B"]) {
        $("addbtn-" + tag).onclick = () => addTodo(tag === "A" ? A : B);
        $("add-" + tag).onkeydown = (e) => { if (e.key === "Enter") addTodo(tag === "A" ? A : B); };
        $("list-" + tag).onclick = (e) => onListClick(tag === "A" ? A : B, e);
        $("title-" + tag).oninput = () => (tag === "A" ? A : B).map.set("title", $("title-" + tag).value);
        $("react-up-" + tag).onclick = () => (tag === "A" ? A : B).reactions.inc();
        $("react-dn-" + tag).onclick = () => (tag === "A" ? A : B).reactions.dec();
        $("undo-" + tag).onclick = () => {
            const r = tag === "A" ? A : B;
            if (!r.doc.undo()) log(r.tag + ": nothing to undo");
            else log(r.tag + " \u21b6 undo (emits the inverse op \u2014 peers converge)");
        };
    }
    $("link").onclick = () => setLink(linked ? false : true);
    $("d-next").onclick = () => deliverIndex(0);
    $("d-all").onclick = deliverAll;
    $("d-shuf").onclick = shuffleQueue;
    $("d-dup").onclick = duplicateOne;
    $("d-sync").onclick = forceSync;
    $("sc-lww").onclick = scenarioLWW;
    $("sc-aw").onclick = scenarioAddWins;
    $("sc-batch").onclick = scenarioBatch;
    $("reset").onclick = reset;
}
function teardown() {
    stops.forEach((s) => { if (typeof s === "function") s(); });
    stops = [];
    if (A) A.doc.dispose();
    if (B) B.doc.dispose();
    queue.length = 0;
    clearTimeout(flushTimer);
}
function track(fn) { const s = effect(fn); stops.push(s); }
function init() {
    A = mk("A", "Alice");
    B = mk("B", "Bob");
    $("rid-A").textContent = A.doc.replicaId;
    $("rid-B").textContent = B.doc.replicaId;

    A.doc.on("op", (op) => enqueue("A", op));
    B.doc.on("op", (op) => enqueue("B", op));

    // 'ops' (1.1): fires once per transaction. Surface multi-op frames so the
    // batch scenario visibly crosses the wire as a single payload.
    A.doc.on("ops", (ops) => { if (ops.length > 1) log("A \u25b8 one frame: " + ops.length + " ops (transact)"); });
    B.doc.on("ops", (ops) => { if (ops.length > 1) log("B \u25b8 one frame: " + ops.length + " ops (transact)"); });

    track(() => renderTodos(A));
    track(() => renderTodos(B));
    track(() => syncTitle(A));
    track(() => syncTitle(B));
    track(() => renderReactions(A));
    track(() => renderReactions(B));
    // badge effect: read reactive sources from both docs so any change refreshes it
    track(() => { A.todos.values(); B.todos.values(); A.map.get("title"); B.map.get("title"); A.reactions.value(); B.reactions.value(); refreshBadge(); });

    // seed a small converged starting document
    A.todos.push({ id: "a-1", text: "Buy milk", done: false });
    A.todos.push({ id: "a-2", text: "Ship lite-crdt", done: false });
    B.todos.push({ id: "b-1", text: "Review the PR", done: true });
    A.counter = 2; B.counter = 1;
    deliverAll();
    renderQueue(); refreshBadge();
    log("ready \u2014 two replicas seeded and converged");
}
function reset() { teardown(); init(); log("reset"); }

try {
    bindUI();
    init();
} catch (e) {
    $("fail").style.display = "block";
    console.error(e);
}
