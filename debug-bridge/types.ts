/**
 * Shared type definitions for the debug bridge.
 */

/** SNES joypad button bitmask values */
export const BUTTON = {
    B:      0x8000,
    Y:      0x4000,
    SELECT: 0x2000,
    START:  0x1000,
    UP:     0x0800,
    DOWN:   0x0400,
    LEFT:   0x0200,
    RIGHT:  0x0100,
    A:      0x0080,
    X:      0x0040,
    L:      0x0020,
    R:      0x0010,
} as const;

export type ButtonName = keyof typeof BUTTON;

/** SNES color (15-bit BGR from CGRAM) */
export interface Color {
    r: number;  // 0-255
    g: number;  // 0-255
    b: number;  // 0-255
    raw: number; // raw 15-bit BGR value
}

/** OAM sprite entry */
export interface SpriteInfo {
    id: number;
    x: number;      // signed 9-bit X position
    y: number;      // 8-bit Y position
    tile: number;   // 9-bit tile number (includes name table select)
    palette: number; // 0-7
    priority: number; // 0-3
    hFlip: boolean;
    vFlip: boolean;
    size: 'small' | 'large';
    width: number;   // in pixels (depends on OBJ size mode)
    height: number;
}

/** Tilemap entry */
export interface TilemapEntry {
    tile: number;     // 10-bit tile number
    palette: number;  // 3-bit palette
    priority: boolean;
    hFlip: boolean;
    vFlip: boolean;
    raw: number;      // raw 16-bit value
}

/** BG layer configuration */
export interface BGInfo {
    tileBaseAddr: number;   // VRAM word address of tile data
    mapBaseAddr: number;    // VRAM word address of tilemap
    scrollX: number;
    scrollY: number;
    tileSize: 8 | 16;      // 8x8 or 16x16
    mapSize: string;        // e.g., "32x32", "64x32"
}

/** CPU register state snapshot */
export interface CPUState {
    pc: number;   // Program Counter (16-bit)
    a: number;    // Accumulator (16-bit)
    x: number;    // X register (16-bit)
    y: number;    // Y register (16-bit)
    sp: number;   // Stack Pointer (16-bit)
    db: number;   // Data Bank (8-bit)
    pb: number;   // Program Bank (8-bit)
    p: number;    // Processor Status (8-bit)
    flags: {
        carry: boolean;
        zero: boolean;
        irqDisable: boolean;
        decimal: boolean;
        indexSize: boolean;  // 1 = 8-bit X/Y
        accumSize: boolean;  // 1 = 8-bit A
        overflow: boolean;
        negative: boolean;
        emulation: boolean;
    };
}

/** PPU state snapshot */
export interface PPUState {
    mode: number;           // BG mode (0-7)
    inidisp: number;        // INIDISP register value
    screenEnabled: boolean;
    brightness: number;     // 0-15
    bgs: BGInfo[];          // BG1-BG4 config
}

/** ROM information */
export interface ROMInfo {
    name: string;
    size: number;
    checksum: string;
    path: string;
}

/** Memory region identifiers for bridge_read_region() */
export enum MemoryRegion {
    WRAM = 0,
    VRAM = 1,
    CGRAM = 2,
    OAM = 3,
}

/** Emscripten module interface for the snes9x WASM core */
export interface Snes9xModule {
    // Emscripten runtime
    ccall: (name: string, returnType: string | null, argTypes: string[], args: unknown[]) => unknown;
    cwrap: (name: string, returnType: string | null, argTypes: string[]) => (...args: unknown[]) => unknown;
    getValue: (ptr: number, type: string) => number;
    setValue: (ptr: number, value: number, type: string) => void;
    HEAPU8: Uint8Array;
    HEAPU16: Uint16Array;
    HEAPU32: Uint32Array;
    _malloc: (size: number) => number;
    _free: (ptr: number) => void;

    // Libretro API
    _retro_api_version: () => number;
    _retro_init: () => void;
    _retro_deinit: () => void;
    _retro_set_environment: (cb: number) => void;
    _retro_set_video_refresh: (cb: number) => void;
    _retro_set_audio_sample: (cb: number) => void;
    _retro_set_audio_sample_batch: (cb: number) => void;
    _retro_set_input_poll: (cb: number) => void;
    _retro_set_input_state: (cb: number) => void;
    _retro_get_system_info: (info: number) => void;
    _retro_get_system_av_info: (info: number) => void;
    _retro_load_game: (gameInfo: number) => number;
    _retro_unload_game: () => void;
    _retro_run: () => void;
    _retro_reset: () => void;
    _retro_serialize_size: () => number;
    _retro_serialize: (data: number, size: number) => number;
    _retro_unserialize: (data: number, size: number) => number;
    _retro_get_memory_data: (id: number) => number;
    _retro_get_memory_size: (id: number) => number;
    _retro_get_region: () => number;
    _retro_set_controller_port_device: (port: number, device: number) => void;

    // Bridge functions
    _bridge_set_framebuffer: (fb: number, width: number, height: number, pitch: number) => void;
    _bridge_get_vram: () => number;
    _bridge_get_vram_size: () => number;
    _bridge_read_vram: (addr: number) => number;
    _bridge_get_cgram: () => number;
    _bridge_get_cgram_size: () => number;
    _bridge_read_cgram: (index: number) => number;
    _bridge_get_oam: () => number;
    _bridge_get_oam_size: () => number;
    _bridge_read_oam: (addr: number) => number;
    _bridge_get_wram: () => number;
    _bridge_get_wram_size: () => number;
    _bridge_read_wram: (addr: number) => number;
    _bridge_get_pc: () => number;
    _bridge_get_a: () => number;
    _bridge_get_x: () => number;
    _bridge_get_y: () => number;
    _bridge_get_sp: () => number;
    _bridge_get_db: () => number;
    _bridge_get_pb: () => number;
    _bridge_get_p: () => number;
    _bridge_get_bg_mode: () => number;
    _bridge_get_bg_scroll_x: (bg: number) => number;
    _bridge_get_bg_scroll_y: (bg: number) => number;
    _bridge_get_inidisp: () => number;
    _bridge_get_bg_tile_base: (bg: number) => number;
    _bridge_get_bg_map_base: (bg: number) => number;
    _bridge_get_bg_size: (bg: number) => number;
    _bridge_get_obj_size_select: () => number;
    _bridge_get_obj_name_base: () => number;
    _bridge_get_brightness: () => number;
    _bridge_get_forced_blanking: () => number;
    _bridge_get_screen_height: () => number;
    _bridge_get_framebuffer: () => number;
    _bridge_get_fb_width: () => number;
    _bridge_get_fb_height: () => number;
    _bridge_get_fb_pitch: () => number;
    _bridge_is_initialized: () => number;
    _bridge_read_region: (region: number, offset: number, dest: number, size: number) => number;

    // Emscripten callback management
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    addFunction: (fn: Function, sig: string) => number;
    removeFunction: (ptr: number) => void;
}

/** Libretro memory IDs */
export enum RetroMemory {
    SAVE_RAM    = 0,
    RTC         = 1,
    SYSTEM_RAM  = 2,
    VIDEO_RAM   = 3,
}

/** Libretro device types */
export enum RetroDevice {
    NONE    = 0,
    JOYPAD  = 1,
    MOUSE   = 2,
    KEYBOARD = 3,
    LIGHTGUN = 4,
    ANALOG  = 5,
}

/** Libretro joypad button IDs (for retro_input_state callback) */
export enum RetroJoypadButton {
    B      = 0,
    Y      = 1,
    SELECT = 2,
    START  = 3,
    UP     = 4,
    DOWN   = 5,
    LEFT   = 6,
    RIGHT  = 7,
    A      = 8,
    X      = 9,
    L      = 10,
    R      = 11,
}
