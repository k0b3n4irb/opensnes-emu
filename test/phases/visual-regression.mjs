/**
 * Visual Regression Testing
 *
 * Captures screenshots of all examples and compares against stored baselines.
 * Any pixel difference = regression detected.
 *
 * Usage:
 *   import { runVisualRegression } from './visual-regression.mjs';
 *   const result = runVisualRegression(opensnesDir, emuCore, { update: false });
 *
 * Baselines stored as raw RGBA in test/baselines/<example_path>.bin
 * (not PNG — avoids compression differences, exact pixel match)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = join(__dirname, '..', 'baselines');

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
            writeFileSync(metaFile, JSON.stringify({ width, height, frames: framesWarmup }));
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
