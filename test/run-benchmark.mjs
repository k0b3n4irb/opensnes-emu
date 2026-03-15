#!/usr/bin/env node
/**
 * OpenSNES Compiler Benchmark
 *
 * Compiles bench_functions.c with the current compiler, runs cycle count
 * analysis, and compares against the stored baseline.
 *
 * Usage:
 *   node tools/opensnes-emu/test/run-benchmark.mjs              # compare vs baseline
 *   node tools/opensnes-emu/test/run-benchmark.mjs --update      # update baseline
 *   node tools/opensnes-emu/test/run-benchmark.mjs --pvsneslib   # also run PVSnesLib ROM
 */

import { execSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENSNES = join(__dirname, '..', '..', '..');
// Benchmark sources: fixtures first, fallback to legacy tests/
const BENCH_FIXTURES = join(__dirname, 'fixtures', 'benchmark');
const BENCH_LEGACY = join(OPENSNES, 'tests', 'benchmark');
const BENCH_HOME = existsSync(BENCH_FIXTURES) ? BENCH_FIXTURES : BENCH_LEGACY;
const BENCH_SRC = join(BENCH_HOME, 'bench_functions.c');
const BENCH_BASELINE = join(BENCH_HOME, 'bench_functions.asm');
const CC = join(OPENSNES, 'bin', 'cc65816');
const CYCLECOUNT = join(OPENSNES, 'devtools', 'cyclecount', 'cyclecount.py');
const TMP_ASM = '/tmp/opensnes_bench_current.asm';

const UPDATE = process.argv.includes('--update');
const PVSNESLIB = process.argv.includes('--pvsneslib');

const C = { pass: '\x1b[32m', fail: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m' };

function sh(cmd) {
    try {
        return execSync(cmd, { cwd: OPENSNES, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });
    } catch (e) {
        return null;
    }
}

async function main() {
    console.log('========================================================');
    console.log('OpenSNES Compiler Benchmark');
    console.log('========================================================\n');

    // Check prerequisites
    if (!existsSync(CC)) { console.error('cc65816 not found'); process.exit(1); }
    if (!existsSync(BENCH_SRC)) { console.error('bench_functions.c not found'); process.exit(1); }
    if (!existsSync(CYCLECOUNT)) { console.error('cyclecount.py not found'); process.exit(1); }

    // Compile with current compiler
    console.log('Compiling benchmark with current compiler...');
    const compileResult = sh(`${CC} ${BENCH_SRC} -o ${TMP_ASM}`);
    if (!compileResult) {
        console.error(`${C.fail}Compilation failed${C.reset}`);
        process.exit(1);
    }
    console.log(`${C.pass}Compiled OK${C.reset}\n`);

    // Run cycle count on current
    console.log('Current compiler cycle counts:');
    const current = sh(`python3 ${CYCLECOUNT} ${TMP_ASM}`);
    if (current) console.log(current);

    // Compare with baseline if exists
    if (existsSync(BENCH_BASELINE)) {
        console.log('\nComparison vs stored baseline:');
        const comparison = sh(`python3 ${CYCLECOUNT} --compare ${BENCH_BASELINE} ${TMP_ASM}`);
        if (comparison) {
            console.log(comparison);

            // Parse total delta
            const match = comparison.match(/TOTAL\s+(\d+)\s+(\d+)\s+([+-]?\d+)\s+([+-]?\d+\.?\d*)%/);
            if (match) {
                const [, before, after, delta, pct] = match;
                const pctNum = parseFloat(pct);
                if (pctNum < -1) {
                    console.log(`${C.pass}IMPROVEMENT: ${pct}% faster than baseline${C.reset}`);
                } else if (pctNum > 1) {
                    console.log(`${C.fail}REGRESSION: ${pct}% slower than baseline${C.reset}`);
                } else {
                    console.log(`${C.dim}No significant change vs baseline${C.reset}`);
                }
            }
        }
    } else {
        console.log(`${C.warn}No baseline found. Run with --update to create one.${C.reset}`);
    }

    // Update baseline
    if (UPDATE) {
        copyFileSync(TMP_ASM, BENCH_BASELINE);
        console.log(`\n${C.pass}Baseline updated: ${BENCH_BASELINE}${C.reset}`);
    }

    // PVSnesLib ROM comparison
    if (PVSNESLIB) {
        const pvsBench = join(OPENSNES, '..', 'pvsneslib', 'snes-examples', 'bin', 'benchmark.sfc');
        if (existsSync(pvsBench)) {
            console.log('\n========================================================');
            console.log('PVSnesLib Benchmark ROM (runtime in emulator)');
            console.log('========================================================');
            try {
                const createSnes9x = (await import(join(__dirname, '..', 'core', 'build', 'snes9x_libretro.mjs'))).default;
                const core = await createSnes9x({ noInitialRun: true, noExitRuntime: true,
                    print: () => {}, printErr: () => {} });
                core._retro_set_environment(core.addFunction((cmd, data) => {
                    if (cmd === 10) return 1;
                    if (cmd === 3) { core.setValue(data, 1, 'i8'); return 1; }
                    return 0;
                }, 'iii'));
                core._retro_set_video_refresh(core.addFunction(() => {}, 'viiii'));
                core._retro_set_audio_sample(core.addFunction(() => {}, 'vii'));
                core._retro_set_audio_sample_batch(core.addFunction((d, f) => f, 'iii'));
                core._retro_set_input_poll(core.addFunction(() => {}, 'v'));
                core._retro_set_input_state(core.addFunction(() => 0, 'iiiii'));
                core._retro_init();

                const { readFileSync } = await import('node:fs');
                const rom = readFileSync(pvsBench);
                const ptr = core._malloc(rom.length);
                core.HEAPU8.set(rom, ptr);
                const info = core._malloc(16);
                core.setValue(info, 0, 'i32');
                core.setValue(info + 4, ptr, 'i32');
                core.setValue(info + 8, rom.length, 'i32');
                core.setValue(info + 12, 0, 'i32');
                core._retro_load_game(info);
                core._free(info);

                for (let i = 0; i < 300; i++) core._retro_run();

                console.log('PVSnesLib benchmark ROM ran 300 frames (5 seconds).');
                console.log('Results visible on screen — use emu_screenshot to view.');
                console.log(`PC: 0x${core._bridge_get_pc().toString(16)}`);
            } catch (e) {
                console.log(`${C.warn}Could not run PVSnesLib ROM: ${e.message}${C.reset}`);
            }
        } else {
            console.log(`\n${C.warn}PVSnesLib benchmark ROM not found at ${pvsBench}${C.reset}`);
        }
    }
}

main().catch(err => { console.error(err); process.exit(1); });
