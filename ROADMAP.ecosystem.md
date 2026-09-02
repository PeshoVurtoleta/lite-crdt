# @zakkster/* Feature Roadmaps

Ten modules, versioned milestones. Each roadmap starts from the repo's own deferred/out-of-scope list, then adds ecosystem leverage. Global conventions assumed for every release and not repeated per item: version bumped in three places, CHANGELOG.md + llms.txt updated, `node:test`, ASCII source, zero-GC claims gated on `perf_hooks` scavenge counting / pool counters, ownership-adjacent changes verified against `owner-hazard-repro.mjs`.

---

## lite-store (1.0 -> 1.x)

Current: 75 tests, four exports, lazy per-key signals, cycle-safe disposal. The README already names its own debts.

**1.1 — `reconcile(s, next, opts?)`.** Structural diff-apply for wholesale data replacement (server refetch, lite-query integration) that patches leaf-by-leaf instead of nuking the subtree and its signals. Key by identity or `opts.key`. This is the single biggest ergonomic gap: today `s.items = freshItems` disposes every tracked signal and re-fires everything. Gate: replacing 1000 rows where 3 changed fires 3 effects, pool flat.

**1.2 — `transaction(s, fn)`.** The rollback primitive the README promises "with the cost stated at the call site": snapshot the touched subtree lazily (copy-on-first-write per meta, not deep-clone upfront), restore on throw. Explicitly not Immer; document the allocation cost. Pairs with lite-project for the overlay-style alternative.

**1.3 — Introspection hooks.** `storeStats(s)` (tracked keys, live signal count, proxy count) and a `observeStore(s, hook)` opcode stream mirroring lite-signal's graph-mutation hooks, so lite-devtools/lite-studio can render the store's sparse signal map. Zero cost when no hook installed.

**1.4 — Registry DI.** `createStoreFactory(registry)` matching `createMapper`/`createProjector`, for isolated graphs in tests and the zero-GC gate.

**Companion (separate package, per the FAQ): `lite-collections`.** `ReactiveMap`/`ReactiveSet` implementing native interfaces over direct lite-signal calls. Keeps the Proxy core from absorbing Vue/Valtio-class bundle weight. Don't fold in.

---

## lite-crdt (1.0 -> 2.0)

Current: LWW-Map + OR-Set, transport-agnostic ops, BroadcastChannel helper, getState/mergeState. v2 debts are already declared: RGA, tombstone GC, rich text.

**1.1 — Ergonomics, cheap wins.**
`doc.counter(name)` (PN-Counter — trivially convergent, high utility for votes/likes/presence counts). `doc.transact(fn)` emitting one op-array payload so a burst of edits is one network frame and one `applyOps` on the far side. Local undo: since ops are explicit, a bounded ring of inverse ops for the local replica's own edits is nearly free and no other library in this weight class ships it.

**1.2 — Tombstone compaction + delta sync.** Version-vector-tracked `compact()` collapsing LWW tombstones and observed-remove tags all replicas have acknowledged; `getStateSince(versionVector)` for delta hydration so a briefly-offline tab doesn't pull the full state. This is the "long-lived doc" unlock — right now a month-old doc grows monotonically.

**2.0 — `doc.list(name)`: RGA positional sequence.** Convergent insert-at-index and move-to-index. The declared order-of-magnitude item; ship it as the sole 2.0 headline rather than bundling. lite-room interop (RGA as a room storage type) follows in 2.1, not before the core sequence has soaked.

---

## lite-map (1.0 -> 1.x)

Current: mapArray/indexArray with parked-scope reuse. The "Not in 1.0" section is the roadmap — sequence it by risk.

**1.1 — Append/pop fast-paths.** O(1) prefix/suffix detection before the general keyed diff. Tail mutation is the dominant real-world case (feeds, logs, push/pop); the win is measurable and the change is local. Gate: 10k push/pop cycles, diff cost flat vs list length.

**1.2 — LIS minimal-move ordering.** Longest-increasing-subsequence pass so reorders touch the theoretical-floor set of index signals. Pre-allocate the LIS scratch arrays at high-water mark to keep the pass itself zero-GC. Bench before/after on a 1k-row shuffle — if index-signal sets aren't the bottleneck in practice, this can slip.

**1.3 — By-value `mapArray` opt-in.** `{ byValue: true }`, Solid-style plain-value ergonomics, with the pool cost documented (inserts re-run mapFn, no parked reuse). Accessor mode stays the default.

**1.4 — Pool observability.** `mapped.stats()` → `{ live, parked, highWater }` for lite-studio and for tuning `maxPool`. One frozen reusable object, no allocation per read.

---

## lite-await (1.x)

Current: whenSignal/allOf/anyOf/raceOf/fromPromise/whenStatechart, 85 tests, 4096-cycle leak probe. Repo has a ROADMAP.md — reconcile these against it.

**1.1 — The missing bridge direction: `toAsyncIterable(source, opts)`.** Signal → async iterator (multi-shot), with the same timeout/AbortSignal options and structural cleanup on `return()`. Today the bridge is one-shot both ways; this feeds `lite-query/stream`, lite-stream, and any `for await` consumer without hand-rolled subscribe loops. Backpressure policy: latest-wins by default, `{ buffer: n }` opt-in — same vocabulary as streamQuery.

**1.2 — `settledOf(specs, opts)`.** Best-effort sibling of allOf: waits for every spec to settle, resolves with `{ status, value | reason }[]` (Promise.allSettled semantics). Completes the combinator quartet.

**1.3 — Scoped defaults: `createAwaitScope(ctrl?)`.** Returns `{ whenSignal, allOf, ... }` pre-bound to an AbortController + optional default timeout, so a room/component disposes every in-flight await with one `scope.abort()` instead of threading `signal:` through each call site. This formalizes the lite-room `dispose()` recipe already in the README.

**1.4 — `whenStatechart` multi-target.** `whenStatechart(machine, ['live', 'error'])` resolving `{ state }` first-of — the raceOf pattern without two signals.

---

## lite-query (1.1 -> 2.0)

Current: query/mutation/streamQuery, cross-tab coherence + sharedFetch, 152 tests. README names the two trailing edges itself: pagination and devtools.

**1.2 — `infiniteQuery(qc, opts)`.** Cursor pagination first-class: `pages()`, `fetchNextPage()`, `hasNextPage()`, `getNextCursor(lastPage)`. Currently a Cookbook recipe; promoting it removes the last honest "trails TanStack" row in the comparison table. Plus `qc.prefetch(key, fetcher)` for route-loader warm-up (pairs with lite-router).

**1.3 — Persistence adapter.** `persistQueryClient(qc, { save, load, version })` with a lite-persist recipe: serialize resolved entries, stamp a schema version, hydrate on boot before first observer attach. Instant cold-start is the highest-leverage UX feature per line of code.

**1.4 — Devtools.** `qc.inspect(hook)` push-mode feed (entry lifecycle, staleness transitions, cross-tab traffic, sharedFetch leader/follower events) mirroring lite-studio's `watchGraph` shape, then a cache panel in lite-studio consuming it. Closes the declared roadmap item.

**2.0 candidates.** Shared *streaming*: extend the leader-election model to streamQuery so one tab owns the socket and followers receive frames over BroadcastChannel (today each tab connects). Offline mutation queue with replay-on-reconnect. Both are semantics-heavy — 2.0 territory, don't rush them into 1.x.

---

## lite-color-engine (1.1 -> 1.x)

Current: parse → OKLCH Float32 → lerp/pack/LUT; 1.1 added deltaEok and the MINDE packer.

**1.2 — Wide gamut.** `packOklchBufferToUint32P3(buf, off, alpha?)` for `display-p3` canvas contexts, and a CSS-Color-4-style gamut-map packer (chroma-reduction toward the sRGB boundary) as the third accuracy tier: Fast / accurate-clamp / gamut-mapped. Parse side: `color(display-p3 r g b)` input. The 10-year-old-MacBook constraint still holds — P3 is opt-in output, never the default path.

**1.3 — Batch kernels.** `lerpOklchBufferN(a, offA, b, offB, t, out, offOut, n)` and `packOklchBufferToUint32IntoN(src, dst, n)` — buffer→buffer bulk ops that amortize call overhead in particle systems (the 100k-particle milestone is exactly this shape). Also: precomputed 4k-entry sRGB transfer LUT option for the accurate packer — Fast-packer throughput at near-exact accuracy, one module-load allocation, opt-in.

**1.4 — Round-trip emit.** `formatOklchCss(buf, off, alpha?)` and `formatHex(buf, off)` string emitters (authoring layer, allocation fine) so the engine can feed lite-gradient-studio exports and demo telemetry without each consumer reimplementing the format.

---

## lite-gradient-studio (1.0 -> 1.x)

Current: 1D + N×M mesh, exporters, parser, extractPalette, 178 tests.

**1.1 — Close the palette loop + server raster.** `paletteToGradient(picks, opts)` — extractPalette output → suggested stop list (lightness-sorted, position-distributed), turning "image in, gradient out" into one call. Plus a documented server-raster recipe pairing `rasterizeTo` with lite-og (see lite-og 1.2 — the two packages meet in the middle here).

**1.2 — Animated gradients.** `GradientTimeline`: keyframed gradient states with `at(time, t, out)` interpolating stop lists through lite-ease, and a CSS `@property --stop-N` animation emitter for the no-JS path. This is the Gradient Studio (product) feature funnel — engine first, UI second.

**1.3 — Gamut-aware authoring API.** `stopGamut(stop)` → `'srgb' | 'p3' | 'out'` per stop, and `clampToGamut(gradient, target)` returning the chroma-reduced variant — the data an editor UI needs to draw in-gamut warnings. Depends on lite-color-engine 1.2 landing first; sequence accordingly.

**1.4 — Parser coverage.** `in oklch`/`in oklab` interpolation hints round-tripped through parse (emit already writes them), radial size keywords (`closest-side` etc.), and graceful skip-with-warning on unsupported functions instead of throw — designers paste messy CSS.

---

## lite-gl (1.0 -> 2.0)

Current: POINT pipeline shipped; quads and lines explicitly deferred but sketched in GLBackend.js. This roadmap is effectively the lite-charts-gl unblock list — sequence it against ChartsGL sessions.

**1.1 — QUAD pipeline.** `createQuadSink(gl, { capacity })`: instanced unit quad + `vertexAttribDivisor`, LAYOUT.QUAD already reserved at stride 9. Unlocks bars, scatter markers, heatmap cells in lite-charts-gl. Same dirty-window discipline; gate with the 1M-instance flat-counter test.

**1.2 — LINE pipeline.** Instanced screen-space-width segment quads (expand in the vertex shader from p0/p1 + width). This is the polyline story for line charts past the Canvas2D ceiling — the reason lite-charts-gl exists. Joins/caps: butt-only in 1.2, honest non-claim; round joins are a 1.3 follow-up if seams are visible at chart widths.

**1.3 — Multi-field scenes + picking.** One backend drawing N fields with shared program cache; scissor/viewport regions for multi-pane charts (the lite-charts view-signal shape is already camera-compatible by design); optional ID-buffer pick pass (`pick(x, y)` → instance index) for hover at 1M points without CPU hit-testing.

**2.0 — WebGPU sink.** Same `Sink` interface, zero core changes — the split was built for exactly this. Only when WebGPU coverage on the target-hardware floor justifies it; the iPhone 7 constraint says not yet.

---

## lite-project (1.0 -> 1.x)

Current: granular overlay projections, commit/revert/reconcile, projectStore + projectRoom adapters.

**1.1 — `projectQuery(qc, key)`.** Drafts over a lite-query cache entry: `set` stages, `commit()` routes through `setQueryData` (which triggers the mutation flow), auto-reconcile drops the overlay on refetch echo via the existing `confirmOnEcho` policy. This is the highest-value adapter — it turns lite-query's manual onMutate/onError rollback dance into three lines. Small surface, big payoff.

**1.2 — Patch emission.** `toPatch()` → iterate `{ key, from, to }` without allocation beyond one reusable record (callback style: `forEachPatch(fn)`), for sending drafts over the wire (lite-room, lite-crdt ops, HTTP PATCH). The overlay map already has everything; this is projection-as-serializer.

**1.3 — Overlay policies.** `set(key, v, { ttl })` auto-revert after ms (pending-state UX that self-heals on lost acks), and `commitWhere(pred)` / `clearWhere(pred)` for partial commits. TTL timers via injectable clock for deterministic tests, one timer per projection (min-heap or single re-armed timeout), not per key.

**1.4 — `projectCRDT(collection)`.** Fine-grained adapter over lite-crdt's LWW-Map (per-key granularity, unlike the coarse room-storage adapter), reconciling on `doc.on('change')`. Depends on nothing new in lite-crdt; ship when lite-crdt 1.1 lands to ride the same announcement.

---

## lite-og (1.0 -> 2.0)

Current: scene-graph → PNG/JPEG/WebP, greedy wrap, LRU image cache, typed errors. The scope section is the backlog.

**1.1 — Text robustness.** Character-level fallback break for words wider than `maxWidth` (the declared v1 hole), `maxLines` + ellipsis truncation (every real OG title needs it), and per-span rich text — `{ type: 'text', spans: [{ text, color, font? }] }` wrapped as one flow. These three close ~90% of real-world card layouts without touching the no-layout-engine principle.

**1.2 — OKLCH + mesh backgrounds.** Accept `oklch()` color strings everywhere (parse via lite-color-engine), interpolate gradient stops in OKLCH instead of whatever Canvas2D does natively (bake to a stop-dense sRGB gradient internally), and — the differentiator — `background: { type: 'mesh', cols, rows, stops }` rasterized through lite-gradient-studio's `rasterizeTo` into the canvas. Mesh-gradient OG cards, server-side, one dependency family. Nobody ships this.

**1.3 — Layout helpers, not layout engine.** Public `measureText(text, font, opts)` so callers can compute positions before building the scene, and `fitText(node, { minSize, maxSize })` shrink-to-fit for variable-length titles. Both are measurement conveniences over absolute coordinates — the no-flexbox line holds.

**2.0 — Edge runtime adapter.** The declared OffscreenCanvas candidate: a second backend behind the same scene contract for Workers/Vercel Edge, with the `@napi-rs/canvas` path unchanged. Font story is the hard part (no process-global registration in Workers) — scope it before committing.

---

## Sequencing across the ecosystem

Ordered by leverage, given lite-charts-gl and the lite-signal 1.9-rebuild line are the active fronts:

1. **lite-gl 1.1/1.2 (QUAD, LINE)** — directly unblocks lite-charts-gl sessions; everything else in that project queues behind these two pipelines.
2. **lite-store 1.1 (`reconcile`)** — unblocks clean lite-query ↔ lite-store data flow and removes the worst re-render footgun in the ecosystem.
3. **lite-project 1.1 (`projectQuery`)** — cheapest high-visibility win; three packages start telling one optimistic-updates story.
4. **lite-await 1.1 (`toAsyncIterable`)** — small, completes the bridge matrix, feeds streamQuery.
5. **lite-query 1.2 (`infiniteQuery`)** — deletes the last comparison-table concession.
6. **lite-map 1.1 (tail fast-paths)** — measurable, local, low-risk.
7. **lite-og 1.1 + lite-gradient-studio 1.1** — pair them; the mesh-background bridge (og 1.2) is the shared headline release.
8. **lite-color-engine 1.2 (P3/gamut)** — prerequisite for gradient-studio 1.3; schedule before it.
9. **lite-crdt 1.1 → 1.2** — compaction before RGA; RGA (2.0) is the big rock, plan it as its own arc like the signal 1.9 rebuild.

Everything above respects the standing gates: no zero-GC claim without scavenge-counter proof, no ownership change without the hazard repro, no benchmark figure that wasn't measured.
