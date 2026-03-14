/**
 * OpenSNES Debug Emulator — C Bridge
 *
 * Exposes snes9x internal state (VRAM, CGRAM, OAM, CPU/PPU registers)
 * beyond what the libretro API provides. Compiled together with the
 * snes9x libretro core into a single WASM module.
 *
 * This file includes snes9x headers directly and accesses the global
 * PPU, Memory, and Registers structs — no pointer initialization needed.
 */

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include <stdint.h>
#include <string.h>

/*
 * snes9x uses its own type system (uint8, uint16, uint32, bool8).
 * Include the port header first to get these definitions.
 */
#include "port.h"
#include "snes9x.h"
#include "65c816.h"
#include "ppu.h"
#include "memmap.h"

/*
 * These are the snes9x global variables we access:
 *   - PPU (struct SPPU)      : PPU state (CGRAM, OAM, BGMode, scroll, etc.)
 *   - Memory (struct SMemory) : ROM/VRAM/WRAM
 *   - Registers (struct SRegisters) : CPU registers (A, X, Y, SP, PC, P, DB)
 *
 * They are declared extern in the snes9x headers above.
 */

extern "C" {

/* Framebuffer from the last rendered frame (set by JS video callback) */
static uint8_t *s_framebuffer = NULL;
static int      s_fb_width    = 256;
static int      s_fb_height   = 224;
static int      s_fb_pitch    = 0;

/**
 * Store the framebuffer pointer from retro_video_refresh callback.
 */
EMSCRIPTEN_KEEPALIVE
void bridge_set_framebuffer(uint8_t *fb, int width, int height, int pitch) {
    s_framebuffer = fb;
    s_fb_width    = width;
    s_fb_height   = height;
    s_fb_pitch    = pitch;
}

/* ── VRAM Access ──────────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
uint8_t *bridge_get_vram(void) { return Memory.VRAM; }

EMSCRIPTEN_KEEPALIVE
uint32_t bridge_get_vram_size(void) { return 0x10000; }

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_read_vram(uint32_t addr) {
    if (addr >= 0x10000) return 0;
    return Memory.VRAM[addr];
}

/* ── CGRAM (Palette) Access ───────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
uint8_t *bridge_get_cgram(void) { return (uint8_t *)PPU.CGDATA; }

EMSCRIPTEN_KEEPALIVE
uint32_t bridge_get_cgram_size(void) { return 512; }

EMSCRIPTEN_KEEPALIVE
uint16_t bridge_read_cgram(uint32_t index) {
    if (index >= 256) return 0;
    return PPU.CGDATA[index];
}

/* ── OAM Access ───────────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
uint8_t *bridge_get_oam(void) { return PPU.OAMData; }

EMSCRIPTEN_KEEPALIVE
uint32_t bridge_get_oam_size(void) { return 544; }

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_read_oam(uint32_t addr) {
    if (addr >= 544) return 0;
    return PPU.OAMData[addr];
}

/* ── WRAM Access ──────────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
uint8_t *bridge_get_wram(void) { return Memory.RAM; }

EMSCRIPTEN_KEEPALIVE
uint32_t bridge_get_wram_size(void) { return 0x20000; }

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_read_wram(uint32_t addr) {
    if (addr >= 0x20000) return 0;
    return Memory.RAM[addr];
}

/* ── CPU Register Access ──────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE uint16_t bridge_get_pc(void)  { return Registers.PCw; }
EMSCRIPTEN_KEEPALIVE uint16_t bridge_get_a(void)   { return Registers.A.W; }
EMSCRIPTEN_KEEPALIVE uint16_t bridge_get_x(void)   { return Registers.X.W; }
EMSCRIPTEN_KEEPALIVE uint16_t bridge_get_y(void)   { return Registers.Y.W; }
EMSCRIPTEN_KEEPALIVE uint16_t bridge_get_sp(void)  { return Registers.S.W; }
EMSCRIPTEN_KEEPALIVE uint8_t  bridge_get_db(void)  { return Registers.DB; }
EMSCRIPTEN_KEEPALIVE uint8_t  bridge_get_pb(void)  { return Registers.PB; }
EMSCRIPTEN_KEEPALIVE uint8_t  bridge_get_p(void)   { return Registers.PL; }

/* ── PPU State Access ─────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_get_bg_mode(void) { return PPU.BGMode; }

EMSCRIPTEN_KEEPALIVE
uint16_t bridge_get_bg_scroll_x(int bg) {
    if (bg < 0 || bg > 3) return 0;
    return PPU.BG[bg].HOffset;
}

EMSCRIPTEN_KEEPALIVE
uint16_t bridge_get_bg_scroll_y(int bg) {
    if (bg < 0 || bg > 3) return 0;
    return PPU.BG[bg].VOffset;
}

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_get_inidisp(void) {
    /* ForcedBlanking (bit 7) | Brightness (bits 0-3) */
    return (PPU.ForcedBlanking ? 0x80 : 0) | (PPU.Brightness & 0x0F);
}

EMSCRIPTEN_KEEPALIVE
uint16_t bridge_get_bg_tile_base(int bg) {
    if (bg < 0 || bg > 3) return 0;
    return PPU.BG[bg].NameBase;
}

EMSCRIPTEN_KEEPALIVE
uint16_t bridge_get_bg_map_base(int bg) {
    if (bg < 0 || bg > 3) return 0;
    return PPU.BG[bg].SCBase;
}

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_get_bg_size(int bg) {
    if (bg < 0 || bg > 3) return 0;
    return PPU.BG[bg].BGSize;
}

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_get_obj_size_select(void) { return PPU.OBJSizeSelect; }

EMSCRIPTEN_KEEPALIVE
uint16_t bridge_get_obj_name_base(void) { return PPU.OBJNameBase; }

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_get_brightness(void) { return PPU.Brightness; }

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_get_forced_blanking(void) { return PPU.ForcedBlanking; }

EMSCRIPTEN_KEEPALIVE
uint16_t bridge_get_screen_height(void) { return PPU.ScreenHeight; }

/* ── Framebuffer Access ───────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
uint8_t *bridge_get_framebuffer(void) { return s_framebuffer; }

EMSCRIPTEN_KEEPALIVE
int bridge_get_fb_width(void)  { return s_fb_width; }

EMSCRIPTEN_KEEPALIVE
int bridge_get_fb_height(void) { return s_fb_height; }

EMSCRIPTEN_KEEPALIVE
int bridge_get_fb_pitch(void)  { return s_fb_pitch; }

/* ── Utility ──────────────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
int bridge_is_initialized(void) { return 1; /* Always ready — we access globals directly */ }

/**
 * Copy a region of memory into a caller-provided buffer.
 * Useful for bulk reads from JS without per-byte overhead.
 *
 * Regions: 0=WRAM, 1=VRAM, 2=CGRAM, 3=OAM
 */
EMSCRIPTEN_KEEPALIVE
int bridge_read_region(int region, uint32_t offset, uint8_t *dest, uint32_t size) {
    uint8_t *src = NULL;
    uint32_t max_size = 0;

    switch (region) {
        case 0: src = Memory.RAM;            max_size = 0x20000; break;
        case 1: src = Memory.VRAM;           max_size = 0x10000; break;
        case 2: src = (uint8_t*)PPU.CGDATA;  max_size = 512;     break;
        case 3: src = PPU.OAMData;           max_size = 544;     break;
        default: return -1;
    }

    if (offset >= max_size) return -1;
    if (offset + size > max_size) size = max_size - offset;

    memcpy(dest, src + offset, size);
    return (int)size;
}

} /* extern "C" */
