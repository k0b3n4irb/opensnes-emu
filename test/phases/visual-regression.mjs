/**
 * Visual Regression Testing
 *
 * Captures screenshots of all examples and compares against stored baselines.
 * Any pixel difference > tolerance = regression detected.
 *
 * Usage:
 *   import { runVisualRegression } from './visual-regression.mjs';
 *   const result = runVisualRegression(emuCore, opensnesDir, { update: false });
 *
 * Baseline files (per example, in test/baselines/):
 *   <label>.bin   — raw RGBA framebuffer (no compression, exact match)
 *   <label>.meta  — JSON manifest with provenance:
 *     {
 *       "width": 256, "height": 224, "frames": 120,
 *       "rom_sha256": "<hex>",         // SHA-256 of the .sfc captured
 *       "snes9x_commit": "5110899",    // git short SHA of snes9x at capture time
 *       "captured_at": "2026-04-26T18:34:00.000Z"
 *     }
 *
 * Drift signals:
 *   - rom_sha256 mismatch  → ROM was rebuilt; baseline may be stale
 *   - snes9x_commit mismatch → emulator changed; pixel differences expected
 *   Both are reported as warnings, the test still runs.
 *
 * Regenerate a baseline:
 *   node test/run-all-tests.mjs --phase visual --update-baselines
 *   (then commit the .bin/.meta pair after Mesen2 validation)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = join(__dirname, '..', 'baselines');

/**
 * Read snes9x git short SHA from core/snes9x/.git, or 'unknown' if not present.
 * Cached on module load — snes9x doesn't change between captures within a run.
 */
let _snes9xCommit = null;
function getSnes9xCommit() {
    if (_snes9xCommit !== null) return _snes9xCommit;
    try {
        const gitDir = join(__dirname, '..', '..', 'core', 'snes9x', '.git');
        const headPath = join(gitDir, 'HEAD');
        if (!existsSync(headPath)) { _snes9xCommit = 'unknown'; return _snes9xCommit; }
        const head = readFileSync(headPath, 'utf-8').trim();
        if (head.startsWith('ref: ')) {
            const ref = head.slice(5);
            const refPath = join(gitDir, ref);
            if (existsSync(refPath)) {
                _snes9xCommit = readFileSync(refPath, 'utf-8').trim().slice(0, 7);
                return _snes9xCommit;
            }
        } else if (/^[0-9a-f]{40}$/.test(head)) {
            _snes9xCommit = head.slice(0, 7);
            return _snes9xCommit;
        }
    } catch {}
    _snes9xCommit = 'unknown';
    return _snes9xCommit;
}

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * Compare two RGBA buffers pixel by pixel.
 * Returns number of differing pixels.
 */
function pixelDiff(a, b, width, height) {
    if (a.length !== b.length) return width * height; // completely different
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) {
        // Allow tiny tolerance (snes9x frame timing can cause 1-pixel scroll differences)
        const dr = Math.abs(a[i] - b[i]);
        const dg = Math.abs(a[i + 1] - b[i + 1]);
        const db = Math.abs(a[i + 2] - b[i + 2]);
        if (dr > 8 || dg > 8 || db > 8) diff++;
    }
    return diff;
}

/**
 * Find all example directories with .sfc ROMs.
 */
function findExampleROMs(opensnesDir) {
    const roms = [];
    const examplesRoot = join(opensnesDir, 'examples');

    function walk(dir) {
        if (existsSync(join(dir, 'Makefile'))) {
            const mk = readFileSync(join(dir, 'Makefile'), 'utf-8');
            if (/^TARGET\s+:=/m.test(mk)) {
                const sfcFiles = readdirSync(dir).filter(f => f.endsWith('.sfc'));
                if (sfcFiles.length > 0) {
                    const label = dir.slice(examplesRoot.length + 1);
                    roms.push({ path: join(dir, sfcFiles[0]), label });
                }
                return;
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
    return roms.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Run visual regression tests.
 *
 * @param {object} core - initialized snes9x WASM core
 * @param {string} opensnesDir - path to opensnes root
 * @param {object} options - { update: bool, framesWarmup: number, maxDiffPixels: number, verbose: bool }
 * @returns {{ total, passed, failed, updated, results: [{label, passed, diffPixels, message}] }}
 */
export function runVisualRegression(core, opensnesDir, options = {}) {
    const {
        update = false,
        framesWarmup = 120,
        maxDiffPixels = 50,
        verbose = false,
    } = options;

    const roms = findExampleROMs(opensnesDir);
    const results = [];
    let passed = 0, failed = 0, updated = 0, skipped = 0;

    mkdirSync(BASELINES_DIR, { recursive: true });

    for (const { path: romPath, label } of roms) {
        const baselineFile = join(BASELINES_DIR, label.replace(/\//g, '_') + '.bin');
        const metaFile = baselineFile.replace('.bin', '.meta');

        // Load ROM
        const rom = readFileSync(romPath);
        const ptr = core._malloc(rom.length);
        core.HEAPU8.set(rom, ptr);
        const info = core._malloc(16);
        core.setValue(info, 0, 'i32');
        core.setValue(info + 4, ptr, 'i32');
        core.setValue(info + 8, rom.length, 'i32');
        core.setValue(info + 12, 0, 'i32');

        if (!core._retro_load_game(info)) {
            core._free(info);
            core._free(ptr);
            results.push({ label, passed: false, diffPixels: -1, message: 'ROM load failed' });
            failed++;
            continue;
        }
        core._free(info);

        // Run warmup frames
        for (let i = 0; i < framesWarmup; i++) core._retro_run();

        // Capture frame — read RGB565 framebuffer and convert to RGBA
        const width = core._bridge_get_fb_width();
        const height = core._bridge_get_fb_height();
        const fbPtr = core._bridge_get_framebuffer();
        const pitch = core._bridge_get_fb_pitch();

        if (!fbPtr || width === 0 || height === 0) {
            core._retro_unload_game();
            results.push({ label, passed: false, diffPixels: -1, message: 'No framebuffer' });
            failed++;
            continue;
        }

        // Convert RGB565 to RGBA
        const rgba = new Uint8Array(width * height * 4);
        const pitchPixels = pitch / 2;
        for (let y = 0; y < height; y++) {
            const srcRow = (fbPtr / 2) + y * pitchPixels;
            for (let x = 0; x < width; x++) {
                const pixel = core.HEAPU16[srcRow + x];
                const r = ((pixel >> 11) & 0x1F) << 3;
                const g = ((pixel >> 5) & 0x3F) << 2;
                const b = (pixel & 0x1F) << 3;
                const idx = (y * width + x) * 4;
                rgba[idx] = r | (r >> 5);
                rgba[idx + 1] = g | (g >> 6);
                rgba[idx + 2] = b | (b >> 5);
                rgba[idx + 3] = 255;
            }
        }

        core._retro_unload_game();

        // Update mode: save current as baseline
        if (update) {
            writeFileSync(baselineFile, Buffer.from(rgba.buffer));
            writeFileSync(metaFile, JSON.stringify({
                width,
                height,
                frames: framesWarmup,
                rom_sha256: sha256Hex(rom),
                snes9x_commit: getSnes9xCommit(),
                captured_at: new Date().toISOString(),
            }));
            updated++;
            if (verbose) console.log(`  [UPDATE] ${label} (${width}x${height})`);
            results.push({ label, passed: true, diffPixels: 0, message: 'baseline updated' });
            passed++;
            continue;
        }

        // Compare mode: diff against baseline
        if (!existsSync(baselineFile)) {
            skipped++;
            if (verbose) console.log(`  [SKIP] ${label} — no baseline`);
            results.push({ label, passed: true, diffPixels: 0, message: 'no baseline (skipped)' });
            passed++;
            continue;
        }

        // Drift detection: warn if baseline metadata names a different snes9x or rom.
        // This doesn't change pass/fail — just surfaces "your reference image was
        // captured under different conditions" so a noisy diff has visible context.
        if (existsSync(metaFile)) {
            try {
                const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
                const currentSnes9x = getSnes9xCommit();
                if (meta.snes9x_commit && meta.snes9x_commit !== currentSnes9x) {
                    console.warn(`  [WARN] ${label}: baseline captured against snes9x ${meta.snes9x_commit}, currently ${currentSnes9x}`);
                }
                if (meta.rom_sha256) {
                    const currentRomSha = sha256Hex(rom);
                    if (meta.rom_sha256 !== currentRomSha) {
                        console.warn(`  [WARN] ${label}: ROM changed since baseline (${meta.rom_sha256.slice(0, 7)} → ${currentRomSha.slice(0, 7)})`);
                    }
                }
            } catch {} // tolerate legacy/minimal .meta files (no warning fields)
        }

        const baseline = new Uint8Array(readFileSync(baselineFile));
        const diff = pixelDiff(rgba, baseline, width, height);

        if (diff <= maxDiffPixels) {
            passed++;
            results.push({ label, passed: true, diffPixels: diff, message: diff === 0 ? 'exact match' : `${diff} pixels differ (within tolerance)` });
            if (verbose) console.log(`  [PASS] ${label}${diff > 0 ? ` (${diff} px diff)` : ''}`);
        } else {
            failed++;
            results.push({ label, passed: false, diffPixels: diff, message: `${diff} pixels differ (max: ${maxDiffPixels})` });
            console.log(`  [FAIL] ${label} — ${diff} pixels differ`);
        }
    }

    return { total: roms.length, passed, failed, updated, skipped, results };
}
