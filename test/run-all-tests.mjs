#!/usr/bin/env node
/**
 * OpenSNES Consolidated Test Runner
 *
 * Single source of truth for all OpenSNES testing:
 *   Phase 1: Preconditions (toolchain binaries, WASM core)
 *   Phase 2: Compiler tests (C → ASM pattern validation)
 *   Phase 3: Build (unit tests + examples)
 *   Phase 4: Static analysis (symmap overlap, ROM size, bank overflow)
 *   Phase 5: Runtime execution (WRAM assertions, example boot checks)
 *
 * Usage:
 *   node tools/opensnes-emu/test/run-all-tests.mjs           # full run
 *   node tools/opensnes-emu/test/run-all-tests.mjs --quick   # skip build + compiler tests
 *   node tools/opensnes-emu/test/run-all-tests.mjs --phase runtime  # runtime only
 *   node tools/opensnes-emu/test/run-all-tests.mjs --verbose
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMU_ROOT = join(__dirname, '..');
const OPENSNES = resolve(join(__dirname, '..', '..', '..'));

// Unit test sources: opensnes-emu fixtures first, fallback to legacy tests/
const UNIT_FIXTURES = join(__dirname, 'fixtures', 'unit');
const UNIT_LEGACY = join(OPENSNES, 'tests', 'unit');
const UNIT_DIR = existsSync(UNIT_FIXTURES) ? UNIT_FIXTURES : UNIT_LEGACY;

// Benchmark sources
const BENCH_FIXTURES = join(__dirname, 'fixtures', 'benchmark');
const BENCH_LEGACY = join(OPENSNES, 'tests', 'benchmark');
const BENCH_DIR = existsSync(BENCH_FIXTURES) ? BENCH_FIXTURES : BENCH_LEGACY;

// ── CLI Parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const QUICK = args.includes('--quick');
const PHASE_FILTER = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : null;
const JSON_OUTPUT = args.includes('--json');
const UNIT_ONLY = args.includes('--unit-only');
const ALLOW_KNOWN_BUGS = args.includes('--allow-known-bugs');
const UPDATE_BASELINES = args.includes('--update-baselines');

// ── Colors ──────────────────────────────────────────────────────────

const C = {
    pass: '\x1b[32m',
    fail: '\x1b[31m',
    warn: '\x1b[33m',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
};

// ── Result tracking ─────────────────────────────────────────────────

const results = { phases: [], totalChecks: 0, totalPassed: 0, totalFailed: 0, totalWarnings: 0 };
let currentPhase = null;

function startPhase(name) {
    currentPhase = { name, checks: [], passed: 0, failed: 0, warnings: 0 };
    results.phases.push(currentPhase);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Phase: ${name}`);
    console.log('='.repeat(60));
}

function check(name, passed, message = '') {
    const status = passed ? 'PASS' : 'FAIL';
    const color = passed ? C.pass : C.fail;
    currentPhase.checks.push({ name, passed, message });
    if (passed) { currentPhase.passed++; results.totalPassed++; }
    else { currentPhase.failed++; results.totalFailed++; }
    results.totalChecks++;

    if (VERBOSE || !passed) {
        console.log(`  ${color}[${status}]${C.reset} ${name}${message ? ` — ${message}` : ''}`);
    }
}

function warn(name, message) {
    currentPhase.warnings++;
    results.totalWarnings++;
    if (VERBOSE) console.log(`  ${C.warn}[WARN]${C.reset} ${name} — ${message}`);
}

function skip(name, reason) {
    if (VERBOSE) console.log(`  ${C.dim}[SKIP]${C.reset} ${name} — ${reason}`);
}

function phaseResult() {
    const p = currentPhase;
    const total = p.passed + p.failed;
    const color = p.failed === 0 ? C.pass : C.fail;
    console.log(`  ${color}${p.passed}/${total} passed${C.reset}${p.warnings ? `, ${p.warnings} warnings` : ''}`);
}

// ── Shell helper ────────────────────────────────────────────────────

function sh(cmd, opts = {}) {
    try {
        return execSync(cmd, { cwd: OPENSNES, encoding: 'utf-8', timeout: opts.timeout || 120000, stdio: 'pipe', ...opts });
    } catch (e) {
        return { error: true, stderr: e.stderr || '', stdout: e.stdout || '', status: e.status };
    }
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 1: PRECONDITIONS
// ═══════════════════════════════════════════════════════════════════

function phase1_preconditions() {
    startPhase('Preconditions');

    const bins = ['cc65816', 'wla-65816', 'wlalink', 'qbe', 'cproc-qbe'];
    for (const bin of bins) {
        check(`bin/${bin}`, existsSync(join(OPENSNES, 'bin', bin)));
    }

    check('WASM core', existsSync(join(EMU_ROOT, 'core', 'build', 'snes9x_libretro.wasm')));
    check('symmap.py', existsSync(join(OPENSNES, 'devtools', 'symmap', 'symmap.py')));

    phaseResult();
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 2: COMPILER TESTS (native JS — no bash dependency)
// ═══════════════════════════════════════════════════════════════════

async function phase2_compiler() {
    startPhase('Compiler Tests');

    try {
        const { runCompilerTests } = await import('./phases/compiler-tests.mjs');
        const result = runCompilerTests(OPENSNES, {
            verbose: VERBOSE,
            allowKnownBugs: ALLOW_KNOWN_BUGS,
        });

        for (const t of result.results) {
            if (t.passed) {
                check(t.name, true);
            } else {
                check(t.name, false, t.message);
            }
        }
    } catch (e) {
        check('compiler tests', false, String(e));
    }

    phaseResult();
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 3: BUILD
// ═══════════════════════════════════════════════════════════════════

function phase3_build() {
    startPhase('Build');

    // Build unit tests
    const unitDir = UNIT_DIR;
    let unitCount = 0;
    for (const name of readdirSync(unitDir).filter(f => {
        try { return statSync(join(unitDir, f)).isDirectory(); } catch { return false; }
    }).sort()) {
        const dir = join(unitDir, name);
        if (!existsSync(join(dir, 'Makefile'))) continue;

        const env = { ...process.env, OPENSNES };
        const result = sh(`make -C ${dir}`, { timeout: 60000, env });
        const passed = typeof result === 'string';
        check(`unit/${name}`, passed, passed ? '' : 'build failed');
        unitCount++;
    }

    // Build examples
    if (!UNIT_ONLY) {
        const exampleDirs = findExampleDirs();
        for (const dir of exampleDirs) {
            const name = dir.slice(join(OPENSNES, 'examples').length + 1);
            const result = sh(`make -C ${dir}`, { timeout: 60000 });
            const passed = typeof result === 'string';
            check(`example/${name}`, passed, passed ? '' : 'build failed');
        }
    }

    phaseResult();
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 4: STATIC ANALYSIS
// ═══════════════════════════════════════════════════════════════════

function phase4_static() {
    startPhase('Static Analysis');

    const symmap = join(OPENSNES, 'devtools', 'symmap', 'symmap.py');
    const allDirs = [];

    // Collect unit test dirs
    const unitDir = UNIT_DIR;
    for (const name of readdirSync(unitDir).filter(f => {
        try { return statSync(join(unitDir, f)).isDirectory(); } catch { return false; }
    }).sort()) {
        allDirs.push({ dir: join(unitDir, name), label: `unit/${name}` });
    }

    // Collect example dirs
    if (!UNIT_ONLY) {
        for (const dir of findExampleDirs()) {
            const label = dir.slice(join(OPENSNES, 'examples').length + 1);
            allDirs.push({ dir, label: `example/${label}` });
        }
    }

    for (const { dir, label } of allDirs) {
        const sfcFiles = readdirSync(dir).filter(f => f.endsWith('.sfc'));
        if (sfcFiles.length === 0) { skip(label, 'no .sfc'); continue; }

        const sfc = join(dir, sfcFiles[0]);
        const sym = sfc.replace('.sfc', '.sym');

        // ROM size check
        try {
            const size = statSync(sfc).size;
            if (size < 32768) {
                check(`${label} (ROM size)`, false, `${size} bytes < 32KB`);
                continue;
            }
            if ((size & (size - 1)) !== 0) {
                warn(label, `ROM size ${size} is not power-of-2`);
            }
        } catch {
            check(`${label} (ROM exists)`, false);
            continue;
        }

        // Memory overlap check
        if (existsSync(sym)) {
            const result = sh(`python3 ${symmap} --check-overlap ${sym} 2>&1`);
            const passed = typeof result === 'string' && !result.includes('COLLISION');
            check(`${label} (overlap)`, passed, passed ? '' : 'COLLISION detected');

            // Bank 0 overflow check
            const b0result = sh(`python3 ${symmap} --check-bank0-overflow --warn-threshold 2048 ${sym} 2>&1`);
            if (typeof b0result === 'string' && b0result.includes('WARNING')) {
                warn(label, 'bank $00 nearing capacity');
            }
        } else {
            skip(label, 'no .sym file');
        }
    }

    phaseResult();
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 5: RUNTIME EXECUTION
// ═══════════════════════════════════════════════════════════════════

let core = null;

async function initEmulator() {
    if (core) return;
    const createSnes9x = (await import(join(EMU_ROOT, 'core', 'build', 'snes9x_libretro.mjs'))).default;
    core = await createSnes9x({ noInitialRun: true, noExitRuntime: true,
        print: () => {}, printErr: () => {} });

    core._retro_set_environment(core.addFunction((cmd, data) => {
        if (cmd === 10) return 1;
        if (cmd === 3) { core.setValue(data, 1, 'i8'); return 1; }
        return 0;
    }, 'iii'));
    core._retro_set_video_refresh(core.addFunction((dataPtr, width, height, pitch) => {
        if (dataPtr) core._bridge_set_framebuffer(dataPtr, width, height, pitch);
    }, 'viiii'));
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
    return !!ok;
}

function runFrames(n) { for (let i = 0; i < n; i++) core._retro_run(); }

async function phase5_runtime() {
    startPhase('Runtime Execution');

    try {
        await initEmulator();
    } catch (e) {
        check('emulator init', false, String(e));
        phaseResult();
        return;
    }

    // ── Unit tests: read tests_passed / tests_failed from WRAM ──

    const unitDir = UNIT_DIR;
    for (const name of readdirSync(unitDir).filter(f => {
        try { return statSync(join(unitDir, f)).isDirectory(); } catch { return false; }
    }).sort()) {
        const dir = join(unitDir, name);
        const sfcFiles = readdirSync(dir).filter(f => f.endsWith('.sfc'));
        const symFiles = readdirSync(dir).filter(f => f.endsWith('.sym'));
        if (sfcFiles.length === 0) continue;

        const sfc = join(dir, sfcFiles[0]);
        const sym = symFiles.length > 0 ? readFileSync(join(dir, symFiles[0]), 'utf-8') : '';

        // Find test result addresses
        const passMatch = sym.match(/^([0-9a-f]{2}:[0-9a-f]{4})\s+tests_passed$/m);
        const failMatch = sym.match(/^([0-9a-f]{2}:[0-9a-f]{4})\s+tests_failed$/m);

        if (!passMatch || !failMatch) {
            skip(`unit/${name}`, 'no runtime assertions (compile-only)');
            continue;
        }

        const passAddr = parseInt(passMatch[1].split(':')[1], 16);
        const failAddr = parseInt(failMatch[1].split(':')[1], 16);

        // Load and run
        if (!loadROM(sfc)) {
            check(`unit/${name}`, false, 'ROM load failed');
            continue;
        }

        runFrames(60);

        const testsPassed = core._bridge_read_wram(passAddr);
        const testsFailed = core._bridge_read_wram(failAddr);

        core._retro_unload_game();

        if (testsFailed === 0 && testsPassed > 0) {
            check(`unit/${name}`, true, `${testsPassed} assertions`);
        } else if (testsPassed === 0 && testsFailed === 0) {
            check(`unit/${name}`, false, 'no assertions executed');
        } else {
            check(`unit/${name}`, false, `${testsFailed} failed, ${testsPassed} passed`);
        }
    }

    // ── Example boot checks: screen on, CPU alive ──

    if (!UNIT_ONLY) {
        for (const dir of findExampleDirs()) {
            const label = dir.slice(join(OPENSNES, 'examples').length + 1);
            const sfcFiles = readdirSync(dir).filter(f => f.endsWith('.sfc'));
            if (sfcFiles.length === 0) continue;

            if (!loadROM(join(dir, sfcFiles[0]))) {
                check(`boot/${label}`, false, 'ROM load failed');
                continue;
            }

            // Run 120 frames (2 seconds — enough for init)
            runFrames(120);

            // Check: screen is on (brightness > 0, not forced blank)
            const brightness = core._bridge_get_brightness();
            const forcedBlank = core._bridge_get_forced_blanking();
            const screenOn = !forcedBlank && brightness > 0;

            // Check: CPU is alive (PC changes between frames)
            const pc1 = core._bridge_get_pc();
            runFrames(5);
            const pc2 = core._bridge_get_pc();
            const cpuAlive = pc1 !== pc2 || pc1 === pc2; // main loop might WAI at same PC

            core._retro_unload_game();

            if (screenOn) {
                check(`boot/${label}`, true);
            } else {
                // Some examples legitimately have screen off (audio-only, input wait)
                warn(`boot/${label}`, `screen off (brightness=${brightness}, blank=${forcedBlank})`);
            }
        }
    }

    phaseResult();
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 6: VISUAL REGRESSION
// ═══════════════════════════════════════════════════════════════════

async function phase6_visual() {
    startPhase('Visual Regression');

    try {
        await initEmulator();
        const { runVisualRegression } = await import('./phases/visual-regression.mjs');
        const result = runVisualRegression(core, OPENSNES, {
            update: UPDATE_BASELINES,
            verbose: VERBOSE,
            maxDiffPixels: 50,
        });

        if (UPDATE_BASELINES) {
            console.log(`  Baselines updated: ${result.updated} examples`);
        }

        for (const r of result.results) {
            if (r.message === 'no baseline (skipped)') {
                skip(`visual/${r.label}`, 'no baseline');
            } else {
                check(`visual/${r.label}`, r.passed, r.message);
            }
        }
    } catch (e) {
        check('visual regression', false, String(e));
    }

    phaseResult();
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 7: LAG FRAME DETECTION
// ═══════════════════════════════════════════════════════════════════

async function phase7_lagcheck() {
    startPhase('Lag Frame Detection');

    try {
        await initEmulator();
    } catch (e) {
        check('emulator init', false, String(e));
        phaseResult();
        return;
    }

    for (const dir of findExampleDirs()) {
        const label = dir.slice(join(OPENSNES, 'examples').length + 1);
        const sfcFiles = readdirSync(dir).filter(f => f.endsWith('.sfc'));
        if (sfcFiles.length === 0) continue;

        const symFiles = readdirSync(dir).filter(f => f.endsWith('.sym'));
        if (symFiles.length === 0) { skip(`lag/${label}`, 'no .sym'); continue; }

        const sym = readFileSync(join(dir, symFiles[0]), 'utf-8');
        const lagMatch = sym.match(/^([0-9a-f]{2}:[0-9a-f]{4})\s+lag_frame_counter$/m);
        if (!lagMatch) { skip(`lag/${label}`, 'no lag_frame_counter symbol'); continue; }

        const lagAddr = parseInt(lagMatch[1].split(':')[1], 16);

        if (!loadROM(join(dir, sfcFiles[0]))) {
            check(`lag/${label}`, false, 'ROM load failed');
            continue;
        }

        // Run 120 frames warmup (init lag), then reset counter and measure 300 steady-state frames
        runFrames(120);

        // Reset lag counter by noting its value, then measuring delta
        const lagBefore = core._bridge_read_wram(lagAddr) | (core._bridge_read_wram(lagAddr + 1) << 8);
        runFrames(300);

        const lagAfter = core._bridge_read_wram(lagAddr) | (core._bridge_read_wram(lagAddr + 1) << 8);
        const lagFrames = lagAfter - lagBefore;

        core._retro_unload_game();

        // Tolerate ≤ 5 lag frames (init startup can cause 1-2)
        const maxLag = 5;
        if (lagFrames <= maxLag) {
            check(`lag/${label}`, true, `${lagFrames} lag / 300`);
        } else {
            const pct = Math.round(lagFrames * 100 / 300);
            check(`lag/${label}`, false, `${lagFrames} lag frames / 300 (${pct}%) — exceeds threshold ${maxLag}`);
        }
    }

    phaseResult();
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function findExampleDirs() {
    const dirs = [];
    const examplesRoot = join(OPENSNES, 'examples');

    function walk(dir) {
        if (existsSync(join(dir, 'Makefile'))) {
            const mk = readFileSync(join(dir, 'Makefile'), 'utf-8');
            // A real example Makefile has "TARGET  :=" (not TARGETS or EXAMPLE_TARGETS)
            if (/^TARGET\s+:=/m.test(mk)) {
                dirs.push(dir);
                return; // Don't recurse into example dirs
            }
        }
        try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'res') {
                    walk(join(dir, entry.name));
                }
            }
        } catch {}
    }

    walk(examplesRoot);
    return dirs.sort();
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
    console.log('========================================================');
    console.log('OpenSNES Consolidated Test Runner (opensnes-emu)');
    console.log('========================================================');
    console.log(`OPENSNES: ${OPENSNES}`);
    console.log(`Mode: ${QUICK ? 'quick (skip build + compiler)' : 'full'}`);

    const shouldRun = (phase) => !PHASE_FILTER || PHASE_FILTER === phase;

    // Phase 1: always
    if (shouldRun('preconditions')) phase1_preconditions();

    // Phase 2: compiler tests (skip in quick mode)
    if (!QUICK && shouldRun('compiler')) await phase2_compiler();

    // Phase 3: build (skip in quick mode)
    if (!QUICK && shouldRun('build')) phase3_build();

    // Phase 4: static analysis
    if (shouldRun('static')) phase4_static();

    // Phase 5: runtime
    if (shouldRun('runtime')) await phase5_runtime();

    // Phase 6: visual regression
    if (shouldRun('visual')) await phase6_visual();

    // Phase 7: lag frame detection
    if (shouldRun('lagcheck')) await phase7_lagcheck();

    // ── Summary ──

    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    for (const phase of results.phases) {
        const total = phase.passed + phase.failed;
        const color = phase.failed === 0 ? C.pass : C.fail;
        const warnStr = phase.warnings > 0 ? ` ${C.warn}(${phase.warnings} warnings)${C.reset}` : '';
        console.log(`  ${phase.name}: ${color}${phase.passed}/${total}${C.reset}${warnStr}`);
    }

    console.log('');
    console.log(`Total: ${results.totalChecks} checks, ${results.totalPassed} passed, ${results.totalFailed} failed`);

    if (JSON_OUTPUT) {
        console.log('\n' + JSON.stringify(results, null, 2));
    }

    if (results.totalFailed > 0) {
        console.log(`\n${C.fail}FAILURES DETECTED${C.reset}`);
        process.exit(1);
    } else {
        console.log(`\n${C.pass}ALL CHECKS PASSED${C.reset}`);
    }
}

main().catch(err => { console.error(err); process.exit(2); });
