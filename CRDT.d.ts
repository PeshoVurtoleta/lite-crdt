// Type definitions for @zakkster/lite-crdt
// Project: https://www.npmjs.com/package/@zakkster/lite-crdt
// Definitions by: Zahary Shinikchiev

/** Package version (three-place sync with package.json and CHANGELOG.md). */
export const VERSION: string;

export type CRDTErrorCode =
    | "kind_mismatch"
    | "malformed_op"
    | "readonly"
    | "misconfigured";

/** Typed error for programmer mistakes (kind mismatch, malformed op, writing a read-only projection, missing id). */
export class CRDTError extends Error {
    name: "CRDTError";
    code: CRDTErrorCode;
    constructor(code: CRDTErrorCode, message: string, opts?: { cause?: unknown });
}

/* ── Operations (the transport-facing wire format) ── */

/** LWW-Map: set a key. */
export interface SetOp<V = unknown> { t: "set"; c: string; k: string; v: V; l: number; r: string; }
/** LWW-Map: delete a key (timestamped tombstone). */
export interface DelOp { t: "del"; c: string; k: string; l: number; r: string; }
/** OR-Set: add an element with a fresh membership tag (`n` is the per-replica tag counter). */
export interface AddOp<V = unknown> { t: "add"; c: string; id: string; n: number; v: V; l: number; r: string; }
/** OR-Set: update an existing element's value (LWW, no membership change). */
export interface UpdOp<V = unknown> { t: "upd"; c: string; id: string; v: V; l: number; r: string; }
/** OR-Set: remove the observed membership tags `g` for an element. */
export interface RmOp { t: "rm"; c: string; id: string; g: string[]; l: number; r: string; }

/** PN-Counter: carries the replica's NEW cumulative increment total. Merged by max (no Lamport). */
export interface CIncOp { t: "cinc"; c: string; r: string; p: number; }
/** PN-Counter: carries the replica's NEW cumulative decrement total. Merged by max (no Lamport). */
export interface CDecOp { t: "cdec"; c: string; r: string; n: number; }

/** Any operation. Ops are plain JSON-serializable objects, commutative and idempotent. */
export type Op = SetOp | DelOp | AddOp | UpdOp | RmOp | CIncOp | CDecOp;

/* ── Collections ── */

/**
 * Last-Write-Wins map. Conflicts resolve by a (lamport, replicaId) total order;
 * deletes are timestamped tombstones that compete with writes.
 *
 * `get`/`has` are fine-grained reactive reads (re-run only when that key
 * changes). `keys`/`values`/`entries`/`size` are coarse reactive reads (re-run
 * on any change to the map). `store` is a read-only reactive projection for
 * custom fine-grained binding; mutating it throws.
 */
export interface LWWMap<V = unknown> {
    /**
     * Read-only reactive projection (a lite-store). Writing to it throws
     * CRDTError("readonly") at ANY depth -- nested objects and arrays reached
     * through it are wrapped too, so `map.store.cfg.theme = x` throws rather
     * than mutating CRDT state without emitting an op.
     */
    readonly store: Readonly<Record<string, V>>;
    get(key: string): V | undefined;
    has(key: string): boolean;
    readonly size: number;
    /** Keys in SORTED order -- replica-independent, so peers agree on iteration order. */
    keys(): string[];
    /** Values in sorted-key order. Nested objects come back read-only. */
    values(): V[];
    /** Entries in sorted-key order. Nested values come back read-only. */
    entries(): [string, V][];
    /**
     * Set a key. Emits a `set` op.
     * @throws {CRDTError} `misconfigured` if `key` is `"__proto__"`, which a
     * store projection cannot hold (the write would silently evaporate).
     */
    set(key: string, value: V): void;
    /**
     * Delete a key. Emits a `del` op.
     * @throws {CRDTError} `misconfigured` if `key` is `"__proto__"`.
     */
    delete(key: string): void;
    /** Plain deep-cloned snapshot of present entries. */
    snapshot(): Record<string, V>;
}

export interface ArrayOptions<V = unknown> {
    /** Derive a stable element id. Defaults to `value.id`. Required if elements have no `id`. */
    identify?: (value: V) => string | number;
}

/**
 * Observed-Remove set keyed by a stable element id, with a last-write-wins
 * value register per id. A fresh `add` creates a membership tag (add-wins for
 * concurrent add/remove); re-adding an id that is already present edits its
 * value (LWW) without disturbing list order. Order is deterministic across
 * replicas by each element's first-add (lamport, replicaId).
 *
 * `store` is a read-only reactive array projection; mutating it throws.
 */
export interface ORSet<V = unknown> {
    /** Read-only reactive array projection (a lite-store). Mutating it throws CRDTError("readonly"). */
    readonly store: ReadonlyArray<V>;
    has(value: V): boolean;
    hasId(id: string | number): boolean;
    get(id: string | number): V | undefined;
    readonly size: number;
    values(): V[];
    ids(): string[];
    /** Add a new element, or edit the value of an existing one (LWW). Emits an `add` or `upd` op. Returns the element id. */
    add(value: V): string;
    /** Alias for {@link add}. */
    push(value: V): string;
    /** Remove an element by value (via `identify`). Removes only observed tags. Returns whether anything was removed. */
    delete(value: V): boolean;
    /** Remove an element by id. Removes only observed tags. */
    deleteById(id: string | number): boolean;
    /** Plain deep-cloned snapshot of current elements in order. */
    snapshot(): V[];
}

/**
 * Positive-Negative counter: per-replica cumulative increments and decrements,
 * merged by max (idempotent + commutative, no Lamport). Ideal for votes, likes
 * and presence counts.
 */
export interface PNCounter {
    /** Reactive current value (subscribe). */
    value(): number;
    /** Untracked current value. */
    peek(): number;
    /** Reactive current value, as a getter alias for {@link value}. */
    readonly size: number;
    /**
     * Increment by `by` (default 1; non-positive deltas are ignored). Emits a `cinc` op.
     * @throws {CRDTError} `misconfigured` if `by` is not an integer, or exceeds
     * `Number.MAX_SAFE_INTEGER`. A counter that silently miscounts is worse than
     * one that refuses.
     */
    inc(by?: number): void;
    /**
     * Decrement by `by` (default 1; non-positive deltas are ignored). Emits a `cdec` op.
     * @throws {CRDTError} `misconfigured` if `by` is not an integer, or exceeds
     * `Number.MAX_SAFE_INTEGER`.
     */
    dec(by?: number): void;
    /** Plain numeric snapshot. */
    snapshot(): number;
}

/* ── Document ── */

/** Opaque, JSON-serializable full-state payload produced by {@link CRDTDoc.getState}. */
export interface DocState {
    replicaId: string;
    clock: number;
    cols: Record<string, unknown>;
}

export interface CRDTDocOptions {
    /** Stable id for this replica. Auto-generated if omitted; an explicit, per-session-unique id is recommended. */
    replicaId?: string;
    /** Initial Lamport clock value (default 0). */
    clock?: number;
    /** Receives errors thrown by `op`/`change` listeners (which are otherwise isolated). */
    onError?: (error: Error) => void;
    /** Capacity of the local undo/redo rings (default 100). Set to 0 to disable history entirely. */
    undoDepth?: number;
}

export interface CRDTDoc {
    readonly replicaId: string;
    /** Current Lamport time. */
    clock(): number;
    /** Get or create a named LWW-Map. Throws if the name already exists as an array. */
    map<V = unknown>(name: string): LWWMap<V>;
    /** Get or create a named OR-Set. Throws if the name already exists as a map. */
    array<V = unknown>(name: string, options?: ArrayOptions<V>): ORSet<V>;
    /** Get or create a named PN-Counter. Throws if the name already exists as another kind. */
    counter(name: string): PNCounter;
    /**
     * Run `fn`, buffering every op it emits and flushing them as ONE op-array
     * payload: a single `ops` event (one network frame, one `applyOps` on the
     * far side) and a single coalesced `change`. Nested transactions flush only
     * at the outermost boundary. Ops staged before a throw are still flushed.
     * Returns `fn`'s return value.
     */
    transact<T>(fn: () => T): T;
    /** Undo the most recent LOCAL edit (emits its inverse op). Returns false if the undo ring is empty. */
    undo(): boolean;
    /** Redo the most recently undone edit. Returns false if the redo ring is empty. */
    redo(): boolean;
    /** Whether an undo is available. */
    canUndo(): boolean;
    /** Whether a redo is available. */
    canRedo(): boolean;
    /** Clear both undo and redo rings. */
    clearHistory(): void;
    /** Apply a remote op. Idempotent and commutative; never re-emits. Auto-creates the collection if unseen. */
    applyOp(op: Op): void;
    /** Apply a batch of remote ops. */
    applyOps(ops: Op[]): void;
    /** Serialize the full converged state for hydrating a late joiner in one payload. */
    getState(): DocState;
    /** Merge a remote full state (idempotent and commutative). */
    mergeState(state: DocState): void;
    /** Subscribe to locally-generated ops, one call per op (forward these to your transport). Returns a disposer. */
    on(type: "op", cb: (op: Op) => void): () => void;
    /** Subscribe to batched local ops: one call per transaction (or a 1-op array per single edit). Returns a disposer. */
    on(type: "ops", cb: (ops: Op[]) => void): () => void;
    /** Subscribe to any convergent state change (local or remote). Returns a disposer. */
    on(type: "change", cb: () => void): () => void;
    /** Plain deep-cloned snapshot of every collection. */
    snapshot(): Record<string, unknown>;
    /** Release all signals and clear listeners. */
    dispose(): void;
}

/** Create a CRDT document: a namespace of convergent collections sharing one Lamport clock and replica id. */
export function createCRDTDoc(options?: CRDTDocOptions): CRDTDoc;

/**
 * Wire a document to a native BroadcastChannel for zero-config cross-tab sync.
 * Broadcasts local ops, applies received ops (idempotent), and performs a
 * state handshake so a late-joining tab is hydrated without an op-log replay.
 */
export function connectBroadcastChannel(doc: CRDTDoc, channelName: string): { dispose(): void };
