/**
 * Input Sequence Testing
 *
 * Scripted input sequences to test game logic:
 * press buttons, run frames, verify state changes.
 *
 * Usage:
 *   import { runInputSequences } from './input-sequences.mjs';
 *   runInputSequences(core, opensnesDir, { verbose: true });
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BUTTON = {
    B: 0x8000, Y: 0x4000, SELECT: 0x2000, START: 0x1000,
    UP: 0x0800, DOWN: 0x0400, LEFT: 0x0200, RIGHT: 0x0100,
    A: 0x0080, X: 0x0040, L: 0x0020, R: 0x0010,
};

/**
 * Run a scripted input sequence on a ROM.
 *
 * @param {object} core - initialized snes9x WASM core
 * @param {string} romPath - path to .sfc file
 * @param {string} symPath - path to .sym file
 * @param {Array} steps - sequence of {input, frames, check} objects
 * @returns {{ passed: boolean, message: string }}
 */
function runSequence(core, romPath, symPath, steps) {
    const rom = readFileSync(romPath);
    const ptr = core._malloc(rom.length);
    core.HEAPU8.set(rom, ptr);
    const info = core._malloc(16);
    core.setValue(info, 0, 'i32');
    core.setValue(info + 4, ptr, 'i32');
    core.setValue(info + 8, rom.length, 'i32');
    core.setValue(info + 12, 0, 'i32');

    if (!core._retro_load_game(info)) {
        core._free(info); core._free(ptr);
        return { passed: false, message: 'ROM load failed' };
    }
    core._free(info);

    // Parse sym file for address lookups
    const sym = existsSync(symPath) ? readFileSync(symPath, 'utf-8') : '';
    function resolveAddr(name) {
        const m = sym.match(new RegExp(`^([0-9a-f]{2}:[0-9a-f]{4})\\s+${name}$`, 'm'));
        return m ? parseInt(m[1].split(':')[1], 16) : null;
    }

    // Input state
    let currentInput = 0;

    // Set input callback
    // (the core was already initialized with an input_state callback in run-all-tests.mjs)
    // We modify the pad state by writing to a global that the callback reads
    // For now, we use bridge_read_wram to check pad_keys directly

    let failMessage = null;

    for (const step of steps) {
        // Set input
        if (step.input !== undefined) {
            currentInput = 0;
            if (typeof step.input === 'string') {
                for (const btn of step.input.split(',').map(s => s.trim().toUpperCase())) {
                    if (BUTTON[btn]) currentInput |= BUTTON[btn];
                }
            } else {
                currentInput = step.input;
            }
        }

        // Run frames (input is not actually injected since we use a no-op callback)
        // TODO: Need to wire input injection into the shared core
        const frames = step.frames || 1;
        for (let i = 0; i < frames; i++) core._retro_run();

        // Check conditions
        if (step.check) {
            for (const [checkName, checkFn] of Object.entries(step.check)) {
                const result = checkFn(core, resolveAddr);
                if (!result.passed) {
                    failMessage = `Step "${checkName}": ${result.message}`;
                    break;
                }
            }
            if (failMessage) break;
        }
    }

    core._retro_unload_game();
    return failMessage
        ? { passed: false, message: failMessage }
        : { passed: true, message: 'all steps passed' };
}

/**
 * Pre-defined test sequences for examples.
 */
const SEQUENCES = {
    'games/breakout': {
        description: 'Breakout boots and renders correctly',
        steps: [
            { frames: 120 }, // warmup
            {
                check: {
                    'screen on': (core) => ({
                        passed: core._bridge_get_brightness() > 0,
                        message: 'screen is off'
                    }),
                    'mode 1': (core) => ({
                        passed: core._bridge_get_bg_mode() === 1,
                        message: `expected mode 1, got ${core._bridge_get_bg_mode()}`
                    }),
                    'OAM has sprites': (core) => {
                        // Check sprite 1 (ball) is visible
                        const y = core._bridge_read_oam(1 * 4 + 1);
                        return { passed: y < 224, message: `ball sprite Y=${y} (off-screen)` };
                    },
                }
            },
        ],
    },

    'games/tetris': {
        description: 'Tetris boots to title screen',
        steps: [
            { frames: 60 }, // warmup
            {
                check: {
                    'screen on': (core) => ({
                        passed: core._bridge_get_brightness() > 0,
                        message: 'screen is off'
                    }),
                    'BG3 active': (core) => {
                        // BG3 is used for text overlay (PRESS START)
                        const mapBase = core._bridge_get_bg_map_base(2);
                        return { passed: mapBase > 0, message: 'BG3 map not configured' };
                    },
                }
            },
        ],
    },

    'graphics/backgrounds/mode0': {
        description: 'Mode 0 renders 4 layers with correct palettes',
        steps: [
            { frames: 60 },
            {
                check: {
                    'mode 0': (core) => ({
                        passed: core._bridge_get_bg_mode() === 0,
                        message: `expected mode 0, got ${core._bridge_get_bg_mode()}`
                    }),
                    'BG1 palette not empty': (core) => {
                        // CGRAM 0 should not be black (it's the transparent color)
                        const c1 = core._bridge_read_cgram(1);
                        return { passed: c1 !== 0, message: 'CGRAM[1] is black — palette not loaded' };
                    },
                    'BG2 palette bank': (core) => {
                        // CGRAM 32 should have BG2's palette (not black)
                        const c32 = core._bridge_read_cgram(32);
                        return { passed: c32 !== 0, message: 'CGRAM[32] is black — BG2 palette missing (Mode 0 banking bug)' };
                    },
                }
            },
        ],
    },

    'graphics/effects/window': {
        description: 'Window HDMA renders triangle',
        steps: [
            { frames: 60 },
            {
                check: {
                    'screen on': (core) => ({
                        passed: core._bridge_get_brightness() > 0,
                        message: 'screen is off'
                    }),
                    'DMA ch7 OK': (core) => ({
                        passed: core._bridge_validate_oam_dma() === 1,
                        message: 'DMA channel 7 clobbered'
                    }),
                }
            },
        ],
    },
};

/**
 * Run all input sequence tests.
 */
export function runInputSequences(core, opensnesDir, options = {}) {
    const { verbose = false } = options;
    const results = [];
    let passed = 0, failed = 0;

    for (const [exPath, seq] of Object.entries(SEQUENCES)) {
        const dir = join(opensnesDir, 'examples', exPath);
        const sfcFiles = readdirSync(dir).filter(f => f.endsWith('.sfc'));
        const symFiles = readdirSync(dir).filter(f => f.endsWith('.sym'));
        if (sfcFiles.length === 0) continue;

        const romPath = join(dir, sfcFiles[0]);
        const symPath = symFiles.length > 0 ? join(dir, symFiles[0]) : '';

        const result = runSequence(core, romPath, symPath, seq.steps);
        results.push({ name: exPath, ...result });

        if (result.passed) {
            passed++;
            if (verbose) console.log(`  [PASS] seq/${exPath} — ${seq.description}`);
        } else {
            failed++;
            console.log(`  [FAIL] seq/${exPath} — ${result.message}`);
        }
    }

    return { total: results.length, passed, failed, results };
}
