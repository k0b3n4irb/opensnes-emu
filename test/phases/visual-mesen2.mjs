/**
 * Mesen2 Visual Regression — chip-using ROMs only
 *
 * snes9x (the engine behind opensnes-emu) does not detect the GSU chip in
 * our SuperFX ROM headers, so the snes9x-based visual regression phase
 * compares two equally-broken "GSU: NOT DETECTED" frames and passes for
 * meaningless reasons. Mesen2 detects GSU correctly and runs all chip
 * examples cleanly, so we run a *second* visual regression phase via the
 * vendored Mesen2 binary in --testrunner mode for the chip ROMs.
 *
 * Pipeline:
 *   1. Spawn `Mesen --testrunner ROM tools/opensnes-emu/test/scripts/visual-capture.lua`
 *      with `--Debug.ScriptWindow.AllowIoOsAccess=true` so the Lua side can
 *      write its capture file. Frame count + output path are passed to Lua
 *      via environment variables.
 *   2. The Lua script runs N frames, calls emu.getScreenBuffer(), writes a
 *      raw RGBA buffer prefixed with an 8-byte header (width, height u32 LE).
 *   3. We read that buffer and compare it to the baseline at
 *      tools/opensnes-emu/test/baselines/<label>.mesen2.bin.
 *
 * Mesen2 binary lookup order:
 *   1. tools/opensnes-emu/vendor/Mesen      (preferred; vendored copy)
 *   2. ./Mesen, ./mesen, mesen on $PATH     (developer fallback)
 *
 * If no binary is found we return { skipped: true } and the test runner
 * reports the phase as skipped rather than failed, so a contributor without
 * the vendored binary can still run the rest of the suite.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'visual-capture.lua');
const BASELINES_DIR = join(__dirname, '..', 'baselines');
const VENDOR_BIN = join(__dirname, '..', '..', 'vendor', 'Mesen');

/** Hard-coded list of ROMs Mesen2 should validate. Must match findChipRoms output. */
const CHIP_ROM_LABELS = new Set([
    'graphics/effects/superfx_3d',
    'memory/superfx_hello',
    'memory/sa1_hello',
    'memory/sa1_starfield',
]);

/**
 * Per-ROM pixel-diff override.
 *
 * Continuously animated ROMs (like superfx_3d's rotating cube) drift by
 * ~1 frame between Mesen2 runs because of variable startup latency before
 * frame 0 — a 1° rotation difference smears across many pixels. The point
 * of this phase is not pixel-perfect determinism (snes9x already covers
 * that for vanilla LoROM); the point is detecting "GSU actually ran vs
 * GSU NOT DETECTED black screen", which a generous tolerance still catches.
 */
const ROM_DIFF_OVERRIDES = {
    'graphics/effects/superfx_3d': 2000,   // rotating cube — animation drift
};

/** Locate the Mesen2 binary. Returns absolute path or null. */
function findMesenBinary() {
    if (existsSync(VENDOR_BIN)) return VENDOR_BIN;
    // Fallback: PATH search via `which`, matched against common executable names.
    for (const name of ['Mesen', 'mesen']) {
        const r = spawnSync('which', [name], { encoding: 'utf-8' });
        if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    return null;
}

/** Find chip-using example ROMs with their paths. */
function findChipRoms(opensnesDir) {
    const out = [];
    for (const label of CHIP_ROM_LABELS) {
        // examples/<label>/<basename>.sfc — basename = last path component
        const basename = label.split('/').pop();
        const romPath = join(opensnesDir, 'examples', label, `${basename}.sfc`);
        if (existsSync(romPath)) {
            out.push({ label, path: romPath });
        }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Read the capture file written by the Lua script. */
function readCaptureFile(path) {
    const buf = readFileSync(path);
    if (buf.length < 8) {
        throw new Error(`capture file too short (${buf.length} bytes)`);
    }
    const width = buf.readUInt32LE(0);
    const height = buf.readUInt32LE(4);
    const expected = 8 + width * height * 4;
    if (buf.length !== expected) {
        throw new Error(`capture file size mismatch: header says ${width}x${height} → expect ${expected} bytes, got ${buf.length}`);
    }
    return { width, height, pixels: buf.subarray(8) };
}

/** RGBA pixel-diff with the same tolerance as the snes9x phase. */
function pixelDiff(a, b, width, height) {
    if (a.length !== b.length) return width * height;
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) {
        const dr = Math.abs(a[i] - b[i]);
        const dg = Math.abs(a[i + 1] - b[i + 1]);
        const db = Math.abs(a[i + 2] - b[i + 2]);
        if (dr > 8 || dg > 8 || db > 8) diff++;
    }
    return diff;
}

/**
 * Run the Mesen2 visual regression phase.
 *
 * @param {string} opensnesDir — path to the OpenSNES repo root
 * @param {object} options — { update: bool, framesWarmup: number, maxDiffPixels: number, timeoutSec: number, verbose: bool }
 * @returns {{ skipped?: boolean, total, passed, failed, updated, results }}
 */
export function runMesen2VisualRegression(opensnesDir, options = {}) {
    const {
        update = false,
        framesWarmup = 120,
        maxDiffPixels = 50,
        timeoutSec = 30,
        verbose = false,
    } = options;

    const mesen = findMesenBinary();
    if (!mesen) {
        return {
            skipped: true,
            reason: `Mesen2 binary not found at ${VENDOR_BIN} or on $PATH`,
            total: 0, passed: 0, failed: 0, updated: 0, results: [],
        };
    }

    // Mesen2 is built on Avalonia/Skia and initialises its GUI subsystem
    // before --testrunner is even checked, so it SIGABRTs on a headless
    // host (no DISPLAY). When DISPLAY is missing, prepend `xvfb-run -a`
    // to provide a virtual display. If xvfb-run is not installed either,
    // fall through and let the spawn fail with a useful diagnostic so the
    // user knows to install xvfb.
    let mesenCmd = mesen;
    let mesenArgsPrefix = [];
    if (!process.env.DISPLAY) {
        const w = spawnSync('which', ['xvfb-run'], { encoding: 'utf-8' });
        if (w.status === 0 && w.stdout.trim()) {
            mesenCmd = w.stdout.trim();
            mesenArgsPrefix = ['-a', '--server-args=-screen 0 1024x768x24', mesen];
        }
    }

    const roms = findChipRoms(opensnesDir);
    if (roms.length === 0) {
        return {
            skipped: true,
            reason: 'No chip ROMs found (run `make examples` first)',
            total: 0, passed: 0, failed: 0, updated: 0, results: [],
        };
    }

    mkdirSync(BASELINES_DIR, { recursive: true });
    const tmpDir = mkdtempSync(join(tmpdir(), 'mesen2-vis-'));
    const results = [];
    let passed = 0, failed = 0, updated = 0;

    try {
        for (const { label, path: romPath } of roms) {
            const baselineFile = join(BASELINES_DIR, label.replace(/\//g, '_') + '.mesen2.bin');
            const captureFile = join(tmpDir, label.replace(/\//g, '_') + '.bin');

            // Spawn Mesen2 in testrunner mode
            const env = {
                ...process.env,
                MESEN_CAPTURE_FRAME: String(framesWarmup),
                MESEN_CAPTURE_OUTPUT: captureFile,
            };
            const r = spawnSync(mesenCmd, [
                ...mesenArgsPrefix,
                '--Debug.ScriptWindow.AllowIoOsAccess=true',
                '--testrunner', romPath, SCRIPT_PATH,
            ], { env, timeout: timeoutSec * 1000, encoding: 'utf-8' });

            if (r.status !== 0) {
                results.push({
                    label, passed: false, diffPixels: -1,
                    message: `Mesen2 exited with status ${r.status} (signal=${r.signal ?? 'none'})`,
                });
                failed++;
                continue;
            }

            if (!existsSync(captureFile)) {
                results.push({
                    label, passed: false, diffPixels: -1,
                    message: 'Capture file not written by Lua script',
                });
                failed++;
                continue;
            }

            let capture;
            try {
                capture = readCaptureFile(captureFile);
            } catch (e) {
                results.push({ label, passed: false, diffPixels: -1, message: e.message });
                failed++;
                continue;
            }

            // Update mode — write a fresh baseline
            if (update || !existsSync(baselineFile)) {
                writeFileSync(baselineFile, readFileSync(captureFile));
                results.push({
                    label, passed: true, diffPixels: 0,
                    message: existsSync(baselineFile) && !update
                        ? `New baseline (${capture.width}x${capture.height})`
                        : `Baseline updated (${capture.width}x${capture.height})`,
                });
                updated++;
                passed++;
                continue;
            }

            // Compare
            let baseline;
            try {
                baseline = readCaptureFile(baselineFile);
            } catch (e) {
                results.push({ label, passed: false, diffPixels: -1, message: `bad baseline: ${e.message}` });
                failed++;
                continue;
            }

            if (capture.width !== baseline.width || capture.height !== baseline.height) {
                results.push({
                    label, passed: false, diffPixels: -1,
                    message: `dimension mismatch: baseline ${baseline.width}x${baseline.height} vs capture ${capture.width}x${capture.height}`,
                });
                failed++;
                continue;
            }

            const diff = pixelDiff(capture.pixels, baseline.pixels, capture.width, capture.height);
            const limit = ROM_DIFF_OVERRIDES[label] ?? maxDiffPixels;
            if (diff <= limit) {
                results.push({ label, passed: true, diffPixels: diff, message: `${diff} pixels differ (max: ${limit})` });
                passed++;
            } else {
                results.push({ label, passed: false, diffPixels: diff, message: `${diff} pixels differ (max: ${limit})` });
                failed++;
            }

            if (verbose) {
                console.log(`  Mesen2 ${label}: ${diff} pixels differ`);
            }
        }
    } finally {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }

    return {
        total: roms.length,
        passed, failed, updated,
        results,
    };
}
