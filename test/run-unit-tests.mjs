#!/usr/bin/env node
/**
 * OpenSNES Runtime Unit Test Runner
 *
 * Loads each unit test ROM into the snes9x emulator, runs it for N frames,
 * then reads tests_passed/tests_failed from WRAM to determine real pass/fail.
 *
 * Usage:
 *   node tools/opensnes-emu/test/run-unit-tests.mjs [--verbose]
 *
 * Requires: opensnes-emu WASM core built (tools/opensnes-emu/core/build/)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import createSnes9x from '../core/build/snes9x_libretro.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENSNES = join(__dirname, '..', '..', '..');
const UNIT_DIR = join(OPENSNES, 'tests', 'unit');
const FRAMES_TO_RUN = 60;

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

// ── Emulator setup ──────────────────────────────────────────────────

let core;

async function initEmulator() {
    core = await createSnes9x({ noInitialRun: true, noExitRuntime: true,
        print: () => {}, printErr: () => {} });

    const envCb = core.addFunction((cmd, data) => {
        if (cmd === 10) return 1; // PIXEL_FORMAT
        if (cmd === 3) { core.setValue(data, 1, 'i8'); return 1; } // CAN_DUPE
        return 0;
    }, 'iii');
    core._retro_set_environment(envCb);
    core._retro_set_video_refresh(core.addFunction(() => {}, 'viiii'));
    core._retro_set_audio_sample(core.addFunction(() => {}, 'vii'));
    core._retro_set_audio_sample_batch(core.addFunction((d, f) => f, 'iii'));
    core._retro_set_input_poll(core.addFunction(() => {}, 'v'));
    core._retro_set_input_state(core.addFunction(() => 0, 'iiiii'));
    core._retro_init();
}

function loadROM(path) {
    const rom = readFileSync(path);
    const ptr = core._malloc(rom.length);
    core.HEAPU8.set(rom, ptr);
    const info = core._malloc(16);
    core.setValue(info, 0, 'i32');
    core.setValue(info + 4, ptr, 'i32');
    core.setValue(info + 8, rom.length, 'i32');
    core.setValue(info + 12, 0, 'i32');
    const ok = core._retro_load_game(info);
    core._free(info);
    if (!ok) { core._free(ptr); return false; }
    return true;
}

function runFrames(n) {
    for (let i = 0; i < n; i++) core._retro_run();
}

function readWRAM(addr) {
    // WRAM via bridge
    return core._bridge_read_wram(addr);
}

// ── Test discovery ──────────────────────────────────────────────────

function discoverTests() {
    const tests = [];
    for (const name of readdirSync(UNIT_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
        const dir = join(UNIT_DIR, name);
        const sfc = readdirSync(dir).find(f => f.endsWith('.sfc'));
        const sym = readdirSync(dir).find(f => f.endsWith('.sym'));
        if (!sfc || !sym) continue;

        const symContent = readFileSync(join(dir, sym), 'utf-8');
        const passMatch = symContent.match(/^([0-9a-f]{2}:[0-9a-f]{4})\s+tests_passed$/m);
        const failMatch = symContent.match(/^([0-9a-f]{2}:[0-9a-f]{4})\s+tests_failed$/m);

        tests.push({
            name,
            sfcPath: join(dir, sfc),
            symPath: join(dir, sym),
            runtime: !!(passMatch && failMatch),
            passAddr: passMatch ? parseInt(passMatch[1].replace(':', ''), 16) : null,
            failAddr: failMatch ? parseInt(failMatch[1].replace(':', ''), 16) : null,
        });
    }
    return tests;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    console.log('========================================');
    console.log('OpenSNES Runtime Unit Tests (opensnes-emu)');
    console.log('========================================');

    await initEmulator();
    const tests = discoverTests();

    let total = 0, passed = 0, failed = 0, compileOnly = 0;
    const failures = [];

    for (const test of tests) {
        total++;

        if (!test.runtime) {
            compileOnly++;
            if (VERBOSE) console.log(`  [COMPILE] ${test.name} (no runtime assertions)`);
            continue;
        }

        // Load ROM
        core._retro_reset();
        if (!loadROM(test.sfcPath)) {
            console.log(`  \x1b[31m[FAIL]\x1b[0m ${test.name} — ROM load failed`);
            failed++;
            failures.push({ name: test.name, reason: 'ROM load failed' });
            continue;
        }

        // Run
        runFrames(FRAMES_TO_RUN);

        // Read results — address is bank:addr, we want just the addr part
        const addr = test.passAddr & 0xFFFF;
        const testsPassed = readWRAM(addr);
        const testsFailed = readWRAM((test.failAddr) & 0xFFFF);

        if (testsFailed === 0 && testsPassed > 0) {
            passed++;
            console.log(`  \x1b[32m[PASS]\x1b[0m ${test.name} (${testsPassed} assertions)`);
        } else if (testsPassed === 0 && testsFailed === 0) {
            // Tests didn't run (maybe needs more frames or has init issue)
            failed++;
            const reason = 'no assertions executed (0 passed, 0 failed)';
            console.log(`  \x1b[31m[FAIL]\x1b[0m ${test.name} — ${reason}`);
            failures.push({ name: test.name, reason });
        } else {
            failed++;
            const reason = `${testsFailed} failed, ${testsPassed} passed`;
            console.log(`  \x1b[31m[FAIL]\x1b[0m ${test.name} — ${reason}`);
            failures.push({ name: test.name, reason, testsPassed, testsFailed });
        }

        core._retro_unload_game();
    }

    console.log('');
    console.log('========================================');
    console.log(`Total:        ${total}`);
    console.log(`Runtime:      ${passed + failed} (${passed} passed, ${failed} failed)`);
    console.log(`Compile-only: ${compileOnly}`);
    console.log('========================================');

    if (failures.length > 0) {
        console.log('');
        console.log('Failures:');
        for (const f of failures) {
            console.log(`  ${f.name}: ${f.reason}`);
        }
        process.exit(1);
    } else {
        console.log('\n\x1b[32mAll runtime tests passed\x1b[0m');
    }
}

main().catch(err => { console.error(err); process.exit(1); });
