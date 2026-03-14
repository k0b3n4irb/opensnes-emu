/**
 * Core emulator lifecycle management.
 *
 * Wraps the snes9x WASM module with the libretro API,
 * handling ROM loading, frame execution, save states, and reset.
 */

import { readFile } from 'node:fs/promises';
import type { Snes9xModule, ROMInfo } from './types.js';
import { RetroMemory, RetroDevice, RetroJoypadButton } from './types.js';

/** Pixel format for video output: RGB565 (native snes9x libretro output) */
const RETRO_PIXEL_FORMAT_RGB565 = 2;

export class DebugEmulator {
    private core: Snes9xModule;
    private romLoaded: boolean = false;
    private romInfo: ROMInfo | null = null;
    private totalFrames: number = 0;
    private paused: boolean = false;

    /* Framebuffer managed by us (copied in retro_video_refresh callback) */
    private frameWidth: number = 256;
    private frameHeight: number = 224;
    private framePitch: number = 512; // 256 * 2 bytes (RGB565)
    private frameBufferPtr: number = 0;
    private frameBufferRGBA: Uint8Array | null = null;

    /* Input state: buttons held for each pad (0-4) */
    private inputState: number[] = [0, 0, 0, 0, 0];

    /* Callback function pointers (for cleanup) */
    private cbPtrs: number[] = [];

    constructor(core: Snes9xModule) {
        this.core = core;
    }

    /**
     * Initialize the emulator: set up libretro callbacks and call retro_init().
     */
    async init(): Promise<void> {
        this.setupCallbacks();
        this.core._retro_init();

        // Set controller port devices
        this.core._retro_set_controller_port_device(0, RetroDevice.JOYPAD);
        this.core._retro_set_controller_port_device(1, RetroDevice.JOYPAD);
    }

    /**
     * Load a ROM file from disk.
     */
    async loadROM(romPath: string): Promise<ROMInfo> {
        if (this.romLoaded) {
            this.core._retro_unload_game();
            this.romLoaded = false;
        }

        const romData = await readFile(romPath);
        const romSize = romData.length;

        // Allocate WASM memory for the ROM
        const romPtr = this.core._malloc(romSize);
        this.core.HEAPU8.set(romData, romPtr);

        // Build retro_game_info struct:
        // struct retro_game_info { const char *path; const void *data; size_t size; const char *meta; }
        // On WASM (32-bit), each field is 4 bytes → 16 bytes total
        const gameInfoPtr = this.core._malloc(16);

        // path (char*) — NULL, we provide data directly
        this.core.setValue(gameInfoPtr + 0, 0, 'i32');
        // data (void*)
        this.core.setValue(gameInfoPtr + 4, romPtr, 'i32');
        // size (size_t)
        this.core.setValue(gameInfoPtr + 8, romSize, 'i32');
        // meta (char*) — NULL
        this.core.setValue(gameInfoPtr + 12, 0, 'i32');

        const result = this.core._retro_load_game(gameInfoPtr);

        // Free the game_info struct (ROM data stays allocated — snes9x may reference it)
        this.core._free(gameInfoPtr);

        if (!result) {
            this.core._free(romPtr);
            throw new Error(`Failed to load ROM: ${romPath}`);
        }

        this.romLoaded = true;
        this.totalFrames = 0;

        // Allocate framebuffer for video capture
        this.allocateFramebuffer();

        // Initialize the bridge with memory pointers
        this.initBridge();

        // Compute checksum
        const checksum = this.computeChecksum(romData);

        this.romInfo = {
            name: this.extractROMName(romData),
            size: romSize,
            checksum,
            path: romPath,
        };

        return this.romInfo;
    }

    /**
     * Run N frames of emulation.
     */
    runFrames(count: number = 1): { framesRun: number; pc: number; totalFrames: number } {
        if (!this.romLoaded) {
            throw new Error('No ROM loaded');
        }

        let framesRun = 0;
        for (let i = 0; i < count; i++) {
            if (this.paused) break;
            this.core._retro_run();
            this.totalFrames++;
            framesRun++;
        }

        return {
            framesRun,
            pc: this.core._bridge_get_pc(),
            totalFrames: this.totalFrames,
        };
    }

    /**
     * Reset the emulated console.
     */
    reset(): void {
        if (!this.romLoaded) {
            throw new Error('No ROM loaded');
        }
        this.core._retro_reset();
        this.totalFrames = 0;
    }

    pause(): void { this.paused = true; }
    resume(): void { this.paused = false; }
    isPaused(): boolean { return this.paused; }
    isROMLoaded(): boolean { return this.romLoaded; }
    getROMInfo(): ROMInfo | null { return this.romInfo; }
    getTotalFrames(): number { return this.totalFrames; }

    /**
     * Save emulator state to a buffer.
     */
    saveState(): Uint8Array {
        if (!this.romLoaded) throw new Error('No ROM loaded');

        const size = this.core._retro_serialize_size();
        const ptr = this.core._malloc(size);
        const result = this.core._retro_serialize(ptr, size);

        if (!result) {
            this.core._free(ptr);
            throw new Error('Failed to save state');
        }

        const state = new Uint8Array(size);
        state.set(this.core.HEAPU8.subarray(ptr, ptr + size));
        this.core._free(ptr);
        return state;
    }

    /**
     * Load emulator state from a buffer.
     */
    loadState(data: Uint8Array): void {
        if (!this.romLoaded) throw new Error('No ROM loaded');

        const ptr = this.core._malloc(data.length);
        this.core.HEAPU8.set(data, ptr);
        const result = this.core._retro_unserialize(ptr, data.length);
        this.core._free(ptr);

        if (!result) {
            throw new Error('Failed to load state');
        }
    }

    /**
     * Set joypad button state for a player.
     */
    setInput(pad: number, buttons: number): void {
        if (pad >= 0 && pad < 5) {
            this.inputState[pad] = buttons;
        }
    }

    /**
     * Press a named button on a pad.
     */
    pressButton(pad: number, button: number): void {
        if (pad >= 0 && pad < 5) {
            this.inputState[pad] |= button;
        }
    }

    /**
     * Release a named button on a pad.
     */
    releaseButton(pad: number, button: number): void {
        if (pad >= 0 && pad < 5) {
            this.inputState[pad] &= ~button;
        }
    }

    /**
     * Release all buttons on a pad.
     */
    releaseAll(pad: number): void {
        if (pad >= 0 && pad < 5) {
            this.inputState[pad] = 0;
        }
    }

    /**
     * Get the current RGBA framebuffer (256×224 or 512×448).
     * Returns null if no frame has been rendered yet.
     */
    getFrameBufferRGBA(): { data: Uint8Array; width: number; height: number } | null {
        if (!this.frameBufferRGBA) return null;
        return {
            data: this.frameBufferRGBA,
            width: this.frameWidth,
            height: this.frameHeight,
        };
    }

    /**
     * Get the raw WASM module for advanced access.
     */
    getCore(): Snes9xModule {
        return this.core;
    }

    /**
     * Clean up resources.
     */
    destroy(): void {
        if (this.romLoaded) {
            this.core._retro_unload_game();
        }
        this.core._retro_deinit();

        if (this.frameBufferPtr) {
            this.core._free(this.frameBufferPtr);
        }

        // Remove registered callbacks
        for (const ptr of this.cbPtrs) {
            this.core.removeFunction(ptr);
        }
        this.cbPtrs = [];
    }

    // ── Private ──────────────────────────────────────────────────

    private setupCallbacks(): void {
        // Environment callback
        const envCb = this.core.addFunction(
            (cmd: number, data: number): number => {
                return this.handleEnvironment(cmd, data) ? 1 : 0;
            },
            'iii'
        );
        this.cbPtrs.push(envCb as number);
        this.core._retro_set_environment(envCb as number);

        // Video refresh callback
        const videoCb = this.core.addFunction(
            (dataPtr: number, width: number, height: number, pitch: number): void => {
                this.handleVideoRefresh(dataPtr, width, height, pitch);
            },
            'viiii'
        );
        this.cbPtrs.push(videoCb as number);
        this.core._retro_set_video_refresh(videoCb as number);

        // Audio sample callback (individual samples — we ignore these)
        const audioSampleCb = this.core.addFunction(
            (_left: number, _right: number): void => {},
            'vii'
        );
        this.cbPtrs.push(audioSampleCb as number);
        this.core._retro_set_audio_sample(audioSampleCb as number);

        // Audio sample batch callback (batched — we ignore audio)
        const audioBatchCb = this.core.addFunction(
            (_data: number, _frames: number): number => {
                return _frames as number;
            },
            'iii'
        );
        this.cbPtrs.push(audioBatchCb as number);
        this.core._retro_set_audio_sample_batch(audioBatchCb as number);

        // Input poll callback
        const inputPollCb = this.core.addFunction(
            (): void => {},
            'v'
        );
        this.cbPtrs.push(inputPollCb as number);
        this.core._retro_set_input_poll(inputPollCb as number);

        // Input state callback
        const inputStateCb = this.core.addFunction(
            (port: number, device: number, index: number, id: number): number => {
                return this.handleInputState(port, device, index, id);
            },
            'iiiii'
        );
        this.cbPtrs.push(inputStateCb as number);
        this.core._retro_set_input_state(inputStateCb as number);
    }

    private handleEnvironment(cmd: number, data: number): boolean {
        switch (cmd) {
            case 10: // RETRO_ENVIRONMENT_SET_PIXEL_FORMAT
                // snes9x requests RGB565 — we accept it
                return true;

            case 3:  // RETRO_ENVIRONMENT_GET_CAN_DUPE
                // Yes, we can handle duplicated frames
                if (data) this.core.setValue(data, 1, 'i8');
                return true;

            case 16: // RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY
                // Not needed for headless use
                return false;

            case 31: // RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY
                return false;

            default:
                return false;
        }
    }

    private handleVideoRefresh(dataPtr: number, width: number, height: number, pitch: number): void {
        if (dataPtr === 0) return; // Duplicated frame (NULL)

        this.frameWidth = width;
        this.frameHeight = height;
        this.framePitch = pitch;

        // Convert RGB565 to RGBA
        const pixelCount = width * height;
        if (!this.frameBufferRGBA || this.frameBufferRGBA.length !== pixelCount * 4) {
            this.frameBufferRGBA = new Uint8Array(pixelCount * 4);
        }

        const src16 = this.core.HEAPU16;
        const dst = this.frameBufferRGBA;
        const pitchPixels = pitch / 2; // pitch is in bytes, RGB565 = 2 bytes/pixel

        for (let y = 0; y < height; y++) {
            const srcRow = (dataPtr / 2) + y * pitchPixels;
            const dstRow = y * width * 4;
            for (let x = 0; x < width; x++) {
                const pixel = src16[srcRow + x];
                // RGB565: RRRRRGGGGGGBBBBB
                const r = ((pixel >> 11) & 0x1F) << 3;
                const g = ((pixel >> 5) & 0x3F) << 2;
                const b = (pixel & 0x1F) << 3;
                const dstIdx = dstRow + x * 4;
                dst[dstIdx + 0] = r | (r >> 5);
                dst[dstIdx + 1] = g | (g >> 6);
                dst[dstIdx + 2] = b | (b >> 5);
                dst[dstIdx + 3] = 255;
            }
        }

        // Update the bridge framebuffer pointer
        this.core._bridge_set_framebuffer(dataPtr, width, height, pitch);
    }

    private handleInputState(port: number, _device: number, _index: number, id: number): number {
        if (port < 0 || port >= 5) return 0;
        const buttons = this.inputState[port];

        // Map libretro joypad ID to SNES button bit
        const mask = this.retroIdToSNESMask(id);
        return (buttons & mask) ? 1 : 0;
    }

    private retroIdToSNESMask(id: number): number {
        switch (id) {
            case RetroJoypadButton.B:      return 0x8000;
            case RetroJoypadButton.Y:      return 0x4000;
            case RetroJoypadButton.SELECT: return 0x2000;
            case RetroJoypadButton.START:  return 0x1000;
            case RetroJoypadButton.UP:     return 0x0800;
            case RetroJoypadButton.DOWN:   return 0x0400;
            case RetroJoypadButton.LEFT:   return 0x0200;
            case RetroJoypadButton.RIGHT:  return 0x0100;
            case RetroJoypadButton.A:      return 0x0080;
            case RetroJoypadButton.X:      return 0x0040;
            case RetroJoypadButton.L:      return 0x0020;
            case RetroJoypadButton.R:      return 0x0010;
            default: return 0;
        }
    }

    private allocateFramebuffer(): void {
        // Max SNES resolution: 512×478 (interlaced hi-res)
        const maxSize = 512 * 478 * 2; // RGB565
        if (this.frameBufferPtr) {
            this.core._free(this.frameBufferPtr);
        }
        this.frameBufferPtr = this.core._malloc(maxSize);
    }

    private initBridge(): void {
        // Bridge accesses snes9x globals (PPU, Memory, Registers) directly —
        // no pointer initialization needed from JS side.
        // Just verify the bridge is compiled in.
        if (!this.core._bridge_is_initialized()) {
            console.warn('Bridge not initialized — hardware inspection will be unavailable');
        }
    }

    private extractROMName(data: Uint8Array): string {
        // SNES ROM header: name is at offset $FFC0 (LoROM) or $7FC0 (LoROM mirror)
        // Try $FFC0 first (standard LoROM position in a headerless ROM)
        let offset = 0x7FC0;
        if (data.length > 0x10000) {
            offset = 0xFFC0;
        }

        // Check if there's a 512-byte copier header
        if (data.length % 1024 === 512) {
            offset += 512;
        }

        if (offset + 21 > data.length) return 'Unknown';

        const nameBytes = data.subarray(offset, offset + 21);
        return String.fromCharCode(...nameBytes).replace(/[\x00-\x1F\x7F-\xFF]/g, ' ').trim();
    }

    private computeChecksum(data: Uint8Array): string {
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum = (sum + data[i]) & 0xFFFF;
        }
        return sum.toString(16).padStart(4, '0');
    }
}
