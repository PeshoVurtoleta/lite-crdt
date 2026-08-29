/**
 * test/torture.mjs -- the lite-crdt torture gate.
 *
 * Runs the wired tiers strictly in sequence (lite-gc-profiler is one-measurement-
 * at-a-time; tiers never nest), prints exactly "ok" on success (exit 0), and on
 * any failure writes to stderr with a replay seed (exit 1). No gate output is a
 * FAIL -- silence never means pass.
 *
 *   npm run torture
 *   TORTURE_SEED=123 node --expose-gc test/torture.mjs      # replay a failure
 *   TORTURE_SCALE=10 node --expose-gc test/torture.mjs       # crank the fuzz
 *
 * Tier namespace is the fixed T0..T9 (sparse; wire what the package needs).
 * Wired in v1.1.1: T0, T1(thin), T4(thin), T5, T6, T7, T9. T1/T4 are filled in
 * v1.1.2 (the validation door).
 */
import { SEED, installRegistry } from "./torture/harness.mjs";
import { run as t0 } from "./torture/t0-laws.mjs";
import { run as t1 } from "./torture/t1-degenerate.mjs";
import { run as t4 } from "./torture/t4-door.mjs";
import { run as t5 } from "./torture/t5-fuzz.mjs";
import { run as t6 } from "./torture/t6-alloc.mjs";
import { run as t7 } from "./torture/t7-soak.mjs";
import { run as t9 } from "./torture/t9-controls.mjs";

const TIERS = [
    ["T0 laws", t0],
    ["T1 degenerate", t1],
    ["T4 door", t4],
    ["T5 convergence-fuzz", t5],
    ["T6 alloc", t6],
    ["T7 soak", t7],
    ["T9 controls", t9],
];

function main() {
    if (typeof globalThis.gc !== "function") {
        process.stderr.write("torture: FAIL -- run with --expose-gc (node --expose-gc test/torture.mjs)\n");
        process.exit(1);
    }
    installRegistry();
    for (const [name, run] of TIERS) {
        try {
            run();
        } catch (err) {
            process.stderr.write(
                "torture: FAIL -- " + name + " threw: " + ((err && err.stack) || err) +
                "\n  replay: TORTURE_SEED=" + SEED + " node --expose-gc test/torture.mjs\n",
            );
            process.exit(1);
        }
    }
    process.stdout.write("ok\n");
    process.exit(0);
}

main();
