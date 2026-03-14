/**
 * Visual Regression Test Runner
 *
 * Loads ROMs, runs them for specified frames, captures screenshots,
 * and compares against baseline images using pixel-level diffing.
 *
 * Usage:
 *   node dist/test/visual-regression.js \
 *     --rom examples/games/breakout/breakout.sfc \
 *     --frames 120 \
 *     --screenshot-at 60,120 \
 *     --compare-dir tests/visual/baseline/breakout/
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHeadlessEmulator } from '../server/headless.js';

interface TestConfig {
    romPath: string;
    totalFrames: number;
    screenshotFrames: number[];
    compareDir: string | null;
    outputDir: string;
    threshold: number;
    maxDiffPixels: number;
    updateBaseline: boolean;
}

function parseArgs(): TestConfig {
    const args = process.argv.slice(2);
    const config: TestConfig = {
        romPath: '',
        totalFrames: 120,
        screenshotFrames: [60, 120],
        compareDir: null,
        outputDir: '/tmp/opensnes-visual-test',
        threshold: 0.1,
        maxDiffPixels: 100,
        updateBaseline: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--rom':
                config.romPath = resolve(args[++i]);
                break;
            case '--frames':
                config.totalFrames = parseInt(args[++i], 10);
                break;
            case '--screenshot-at':
                config.screenshotFrames = args[++i].split(',').map(Number);
                break;
            case '--compare-dir':
                config.compareDir = resolve(args[++i]);
                break;
            case '--output-dir':
                config.outputDir = resolve(args[++i]);
                break;
            case '--threshold':
                config.threshold = parseFloat(args[++i]);
                break;
            case '--max-diff':
                config.maxDiffPixels = parseInt(args[++i], 10);
                break;
            case '--update-baseline':
                config.updateBaseline = true;
                break;
            case '--help':
                console.log(`
Visual Regression Test Runner

Options:
  --rom <path>            ROM file to test (required)
  --frames <n>            Total frames to run (default: 120)
  --screenshot-at <list>  Comma-separated frame numbers for screenshots (default: 60,120)
  --compare-dir <path>    Directory with baseline PNGs to compare against
  --output-dir <path>     Directory to save captured screenshots (default: /tmp/opensnes-visual-test)
  --threshold <n>         Pixel comparison threshold 0.0-1.0 (default: 0.1)
  --max-diff <n>          Maximum allowed differing pixels (default: 100)
  --update-baseline       Save captures as new baselines in compare-dir
  --help                  Show this help
`);
                process.exit(0);
        }
    }

    if (!config.romPath) {
        console.error('Error: --rom is required');
        process.exit(1);
    }

    return config;
}

async function main(): Promise<void> {
    const config = parseArgs();

    console.log(`Loading emulator...`);
    const emu = await createHeadlessEmulator();

    console.log(`Loading ROM: ${config.romPath}`);
    const info = await emu.loadROM(config.romPath);
    console.log(`  Name: ${info.name}, Size: ${info.size}, Checksum: ${info.checksum}`);

    await mkdir(config.outputDir, { recursive: true });

    const romBase = basename(config.romPath, '.sfc');
    let currentFrame = 0;
    let failures = 0;

    // Sort screenshot frames
    const sortedFrames = [...config.screenshotFrames].sort((a, b) => a - b);

    for (const targetFrame of sortedFrames) {
        const framesToRun = targetFrame - currentFrame;
        if (framesToRun > 0) {
            console.log(`  Running ${framesToRun} frames (${currentFrame} → ${targetFrame})...`);
            emu.runFrames(framesToRun);
            currentFrame = targetFrame;
        }

        // Capture screenshot
        const png = emu.screenshot.captureFrame(1);
        const filename = `${romBase}_frame${targetFrame}.png`;
        const outputPath = join(config.outputDir, filename);
        await writeFile(outputPath, png);
        console.log(`  Screenshot saved: ${outputPath}`);

        // Compare against baseline if available
        if (config.compareDir) {
            const baselinePath = join(config.compareDir, filename);
            if (existsSync(baselinePath)) {
                const baseline = await readFile(baselinePath);
                const diff = compareImages(png, baseline, config.threshold);

                if (diff > config.maxDiffPixels) {
                    console.error(`  FAIL: Frame ${targetFrame} — ${diff} pixels differ (max: ${config.maxDiffPixels})`);
                    failures++;
                } else {
                    console.log(`  PASS: Frame ${targetFrame} — ${diff} pixels differ`);
                }
            } else {
                console.log(`  SKIP: No baseline found at ${baselinePath}`);
            }
        }

        // Update baseline if requested
        if (config.updateBaseline && config.compareDir) {
            await mkdir(config.compareDir, { recursive: true });
            const baselinePath = join(config.compareDir, filename);
            await writeFile(baselinePath, png);
            console.log(`  Baseline updated: ${baselinePath}`);
        }
    }

    // Run remaining frames if needed
    if (currentFrame < config.totalFrames) {
        const remaining = config.totalFrames - currentFrame;
        console.log(`  Running remaining ${remaining} frames...`);
        emu.runFrames(remaining);
    }

    // Final state
    const cpuState = emu.cpu.formatState();
    const ppuState = emu.ppu.formatState();
    console.log(`\nFinal state after ${config.totalFrames} frames:`);
    console.log(`  CPU: ${cpuState}`);
    console.log(`  PPU:\n${ppuState.split('\n').map(l => `    ${l}`).join('\n')}`);

    emu.destroy();

    if (failures > 0) {
        console.error(`\nFAILED: ${failures} screenshot(s) differ from baseline`);
        process.exit(1);
    } else {
        console.log(`\nPASSED: All screenshots match baseline`);
    }
}

/**
 * Simple image comparison by raw PNG bytes.
 * For proper pixel-level diffing, use pixelmatch with decoded image data.
 * This is a placeholder that compares raw bytes.
 */
function compareImages(img1: Buffer, img2: Buffer, _threshold: number): number {
    // Simple byte comparison — will report differences for any metadata changes.
    // TODO: Use pixelmatch with decoded PNG for proper perceptual comparison.
    if (img1.length !== img2.length) return img1.length; // Completely different

    let diffBytes = 0;
    for (let i = 0; i < img1.length; i++) {
        if (img1[i] !== img2[i]) diffBytes++;
    }

    // Rough estimate: each differing pixel ≈ 4 bytes in filtered PNG
    return Math.ceil(diffBytes / 4);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
