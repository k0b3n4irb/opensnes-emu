/**
 * Headless emulator runner for Node.js.
 *
 * Loads the snes9x WASM module in Node.js without a browser,
 * providing the same DebugEmulator API for MCP server use.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OpenSNESEmulator } from '../debug-bridge/index.js';
import type { Snes9xModule } from '../debug-bridge/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the compiled WASM module (from dist/server/ → ../../core/build/) */
const WASM_MODULE_PATH = join(__dirname, '..', '..', 'core', 'build', 'snes9x_libretro.mjs');

/**
 * Create a headless emulator instance.
 *
 * Loads the snes9x WASM module in Node.js and returns a fully
 * initialized OpenSNESEmulator ready for ROM loading.
 */
export async function createHeadlessEmulator(): Promise<OpenSNESEmulator> {
    // Dynamically import the Emscripten-generated module loader
    let createSnes9x: (opts?: Record<string, unknown>) => Promise<Snes9xModule>;

    try {
        const mod = await import(WASM_MODULE_PATH);
        createSnes9x = mod.default || mod.createSnes9x;
    } catch (err) {
        throw new Error(
            `Failed to load WASM module at ${WASM_MODULE_PATH}. ` +
            `Have you built the core? Run: make -C tools/opensnes-emu/core\n` +
            `Original error: ${err}`
        );
    }

    // Initialize the WASM module
    const core = await createSnes9x({
        // Emscripten module configuration
        noInitialRun: true,
        noExitRuntime: true,

        // Capture stdout/stderr from the emulator
        print: (text: string) => {
            if (process.env.EMU_DEBUG) {
                console.log(`[snes9x] ${text}`);
            }
        },
        printErr: (text: string) => {
            if (process.env.EMU_DEBUG) {
                console.error(`[snes9x] ${text}`);
            }
        },
    }) as Snes9xModule;

    // Create the unified emulator wrapper
    const emu = new OpenSNESEmulator(core);
    await emu.init();

    return emu;
}

/**
 * Verify that the WASM module exists and can be loaded.
 * Returns true if the module is available, false otherwise.
 */
export async function isWASMAvailable(): Promise<boolean> {
    try {
        const wasmPath = WASM_MODULE_PATH.replace('.mjs', '.wasm');
        await readFile(wasmPath);
        return true;
    } catch {
        return false;
    }
}
