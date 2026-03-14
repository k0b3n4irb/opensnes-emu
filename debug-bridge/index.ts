/**
 * OpenSNES Debug Emulator — Unified API
 *
 * Combines all debug bridge components into a single entry point.
 */

export { DebugEmulator } from './emulator.js';
export { MemoryInspector, snesColorToRGB } from './memory.js';
export { CPUInspector } from './cpu.js';
export { PPUInspector } from './ppu.js';
export { ScreenCapture } from './screenshot.js';
export { InputController } from './input.js';
export * from './types.js';

import { DebugEmulator } from './emulator.js';
import { MemoryInspector } from './memory.js';
import { CPUInspector } from './cpu.js';
import { PPUInspector } from './ppu.js';
import { ScreenCapture } from './screenshot.js';
import { InputController } from './input.js';
import type { Snes9xModule } from './types.js';

/**
 * Complete debug emulator with all inspection capabilities.
 */
export class OpenSNESEmulator {
    public readonly emulator: DebugEmulator;
    public readonly memory: MemoryInspector;
    public readonly cpu: CPUInspector;
    public readonly ppu: PPUInspector;
    public readonly screenshot: ScreenCapture;
    public readonly input: InputController;

    constructor(core: Snes9xModule) {
        this.emulator = new DebugEmulator(core);
        this.memory = new MemoryInspector(core);
        this.cpu = new CPUInspector(core);
        this.ppu = new PPUInspector(core);
        this.screenshot = new ScreenCapture(this.emulator);
        this.input = new InputController(this.emulator);
    }

    /**
     * Initialize the emulator.
     */
    async init(): Promise<void> {
        await this.emulator.init();
    }

    /**
     * Load a ROM and return info.
     */
    async loadROM(path: string): Promise<{ name: string; size: number; checksum: string }> {
        const info = await this.emulator.loadROM(path);
        return { name: info.name, size: info.size, checksum: info.checksum };
    }

    /**
     * Run frames and return status.
     */
    runFrames(count: number = 1): { framesRun: number; pc: number; totalFrames: number } {
        return this.emulator.runFrames(count);
    }

    /**
     * Clean up all resources.
     */
    destroy(): void {
        this.emulator.destroy();
    }
}
