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
#include "dma.h"

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

/* ── CPU Cycle Counter ────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
int32_t bridge_get_cycles(void) { return CPU.Cycles; }

EMSCRIPTEN_KEEPALIVE
int32_t bridge_get_v_counter(void) { return CPU.V_Counter; }

EMSCRIPTEN_KEEPALIVE
uint8_t bridge_get_wai_state(void) { return CPU.WaitingForInterrupt ? 1 : 0; }

/* ── DMA Channel State ────────────────────────────────────────── */

/**
 * Read DMA channel register.
 * channel: 0-7, reg: offset within channel (matches $43x0-$43xA layout)
 *   0: TransferMode | ReverseTransfer | HDMAIndirectAddressing | AAddressFixed | AAddressDecrement
 *   1: BAddress (B-bus destination)
 *   2: AAddress low
 *   3: AAddress high
 *   4: ABank
 *   5: DMACount/IndirectAddress low
 *   6: DMACount/IndirectAddress high
 *   7: IndirectBank
 *   8: HDMA Address low
 *   9: HDMA Address high
 *   10: HDMA LineCount/Repeat
 */
EMSCRIPTEN_KEEPALIVE
uint8_t bridge_read_dma_reg(uint8_t channel, uint8_t reg) {
    if (channel >= 8) return 0;
    struct SDMA *d = &DMA[channel];
    switch (reg) {
        case 0: {
            uint8_t v = d->TransferMode & 0x07;
            if (d->AAddressFixed)          v |= 0x08;
            if (d->AAddressDecrement)      v |= 0x10;
            if (d->HDMAIndirectAddressing) v |= 0x40;
            if (d->ReverseTransfer)        v |= 0x80;
            return v;
        }
        case 1: return d->BAddress;
        case 2: return (uint8_t)(d->AAddress & 0xFF);
        case 3: return (uint8_t)(d->AAddress >> 8);
        case 4: return d->ABank;
        case 5: return (uint8_t)(d->DMACount_Or_HDMAIndirectAddress & 0xFF);
        case 6: return (uint8_t)(d->DMACount_Or_HDMAIndirectAddress >> 8);
        case 7: return d->IndirectBank;
        case 8: return (uint8_t)(d->Address & 0xFF);
        case 9: return (uint8_t)(d->Address >> 8);
        case 10: return d->LineCount | (d->Repeat ? 0x80 : 0);
        default: return 0;
    }
}

/**
 * Validate DMA channel 7 is configured for OAM transfer.
 * Returns 1 if channel 7 looks correct for OAM DMA, 0 otherwise.
 * This catches the bug where other DMA operations clobber channel 7.
 */
EMSCRIPTEN_KEEPALIVE
uint8_t bridge_validate_oam_dma(void) {
    struct SDMA *d = &DMA[7];
    /* Expected: mode=0 (1-byte), dest=$04 (OAMDATA), bank=$7E */
    if (d->TransferMode != 0) return 0;
    if (d->BAddress != 0x04) return 0;
    if (d->ABank != 0x7E) return 0;
    return 1;
}

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
