/**
 * Memory inspection API.
 *
 * Read WRAM, VRAM, CGRAM, OAM, and ROM from the emulated SNES.
 */

import type { Snes9xModule, Color, SpriteInfo, TilemapEntry } from './types.js';
import { MemoryRegion } from './types.js';

export class MemoryInspector {
    constructor(private core: Snes9xModule) {}

    // ── Raw Memory Reads ─────────────────────────────────────────

    /**
     * Read bytes from WRAM (up to 128KB).
     */
    readWRAM(address: number, size: number): Uint8Array {
        return this.readRegion(MemoryRegion.WRAM, address, size);
    }

    /**
     * Read bytes from VRAM (up to 64KB).
     */
    readVRAM(address: number, size: number): Uint8Array {
        return this.readRegion(MemoryRegion.VRAM, address, size);
    }

    /**
     * Read all 256 CGRAM colors as raw 16-bit values.
     */
    readCGRAMRaw(): Uint16Array {
        const bytes = this.readRegion(MemoryRegion.CGRAM, 0, 512);
        return new Uint16Array(bytes.buffer, bytes.byteOffset, 256);
    }

    /**
     * Read all 544 bytes of OAM (512 low table + 32 high table).
     */
    readOAMRaw(): Uint8Array {
        return this.readRegion(MemoryRegion.OAM, 0, 544);
    }

    // ── Convenience Accessors ────────────────────────────────────

    /**
     * Read CGRAM as RGB colors.
     */
    readCGRAM(): Color[] {
        const raw = this.readCGRAMRaw();
        const colors: Color[] = [];
        for (let i = 0; i < 256; i++) {
            colors.push(snesColorToRGB(raw[i]));
        }
        return colors;
    }

    /**
     * Read a palette (group of colors) from CGRAM.
     * @param index Palette index (0-15 for 4bpp, 0-7 for 2bpp)
     * @param colorsPerPalette Number of colors per palette (4, 16, or 256)
     */
    readPalette(index: number, colorsPerPalette: 4 | 16 | 256 = 16): Color[] {
        const all = this.readCGRAM();
        const start = index * colorsPerPalette;
        return all.slice(start, start + colorsPerPalette);
    }

    /**
     * Parse OAM into sprite info objects.
     * Returns info for all 128 sprites.
     */
    readOAM(): SpriteInfo[] {
        const raw = this.readOAMRaw();
        const sprites: SpriteInfo[] = [];

        for (let i = 0; i < 128; i++) {
            const base = i * 4;
            const xLow = raw[base + 0];
            const y = raw[base + 1];
            const tileNum = raw[base + 2];
            const attr = raw[base + 3];

            // High table: 2 bits per sprite, 4 sprites per byte
            const highByteIdx = 512 + Math.floor(i / 4);
            const highBitShift = (i % 4) * 2;
            const highBits = (raw[highByteIdx] >> highBitShift) & 0x03;

            const xHigh = highBits & 0x01;
            const sizeFlag = (highBits >> 1) & 0x01;

            // 9-bit signed X
            const x = xHigh ? (xLow - 256) : xLow;

            // Tile number: low 8 bits from OAM + bit 0 of attr (name table select)
            const tile = tileNum | ((attr & 0x01) << 8);

            // Attribute byte: vhoopppc
            const palette = (attr >> 1) & 0x07;
            const priority = (attr >> 4) & 0x03;
            const hFlip = !!(attr & 0x40);
            const vFlip = !!(attr & 0x80);

            // Size depends on OBSEL register — we'll report small/large flag
            // Actual pixel size depends on the OBJ size mode
            const size = sizeFlag ? 'large' as const : 'small' as const;

            sprites.push({
                id: i,
                x,
                y,
                tile,
                palette,
                priority,
                hFlip,
                vFlip,
                size,
                width: sizeFlag ? 32 : 8,  // Default assumption; caller should adjust
                height: sizeFlag ? 32 : 8,
            });
        }

        return sprites;
    }

    /**
     * Read a tilemap from VRAM.
     * @param vramWordAddr VRAM word address of the tilemap
     * @param width Tilemap width in tiles (32 or 64)
     * @param height Tilemap height in tiles (32 or 64)
     */
    readTilemap(vramWordAddr: number, width: 32 | 64 = 32, height: 32 | 64 = 32): TilemapEntry[] {
        const byteAddr = vramWordAddr * 2;
        const entryCount = width * height;
        const bytes = this.readVRAM(byteAddr, entryCount * 2);
        const words = new Uint16Array(bytes.buffer, bytes.byteOffset, entryCount);

        const entries: TilemapEntry[] = [];
        for (let i = 0; i < entryCount; i++) {
            const raw = words[i];
            entries.push({
                tile: raw & 0x03FF,
                palette: (raw >> 10) & 0x07,
                priority: !!(raw & 0x2000),
                hFlip: !!(raw & 0x4000),
                vFlip: !!(raw & 0x8000),
                raw,
            });
        }
        return entries;
    }

    /**
     * Read a tile's pixel data from VRAM.
     * Returns palette indices for each pixel (row-major).
     * @param vramByteAddr VRAM byte address of the tile
     * @param bpp Bits per pixel (2, 4, or 8)
     * @returns Array of palette indices, 64 entries (8×8 tile)
     */
    readTile(vramByteAddr: number, bpp: 2 | 4 | 8 = 4): number[] {
        const bytesPerTile = bpp * 8; // 2bpp=16, 4bpp=32, 8bpp=64
        const tileData = this.readVRAM(vramByteAddr, bytesPerTile);
        const pixels: number[] = new Array(64).fill(0);

        for (let row = 0; row < 8; row++) {
            for (let bit = 0; bit < 8; bit++) {
                let colorIndex = 0;

                // Bitplane 0-1 (interleaved in first 16 bytes)
                if (bpp >= 2) {
                    const b0 = (tileData[row * 2 + 0] >> (7 - bit)) & 1;
                    const b1 = (tileData[row * 2 + 1] >> (7 - bit)) & 1;
                    colorIndex = b0 | (b1 << 1);
                }

                // Bitplane 2-3 (interleaved in next 16 bytes)
                if (bpp >= 4) {
                    const b2 = (tileData[16 + row * 2 + 0] >> (7 - bit)) & 1;
                    const b3 = (tileData[16 + row * 2 + 1] >> (7 - bit)) & 1;
                    colorIndex |= (b2 << 2) | (b3 << 3);
                }

                // Bitplane 4-7 (8bpp only, in next 32 bytes)
                if (bpp >= 8) {
                    const b4 = (tileData[32 + row * 2 + 0] >> (7 - bit)) & 1;
                    const b5 = (tileData[32 + row * 2 + 1] >> (7 - bit)) & 1;
                    const b6 = (tileData[48 + row * 2 + 0] >> (7 - bit)) & 1;
                    const b7 = (tileData[48 + row * 2 + 1] >> (7 - bit)) & 1;
                    colorIndex |= (b4 << 4) | (b5 << 5) | (b6 << 6) | (b7 << 7);
                }

                pixels[row * 8 + bit] = colorIndex;
            }
        }

        return pixels;
    }

    // ── Private ──────────────────────────────────────────────────

    private readRegion(region: MemoryRegion, offset: number, size: number): Uint8Array {
        const destPtr = this.core._malloc(size);
        const bytesRead = this.core._bridge_read_region(region, offset, destPtr, size);

        if (bytesRead < 0) {
            this.core._free(destPtr);
            throw new Error(`Failed to read ${MemoryRegion[region]} at offset ${offset}`);
        }

        const result = new Uint8Array(bytesRead);
        result.set(this.core.HEAPU8.subarray(destPtr, destPtr + bytesRead));
        this.core._free(destPtr);
        return result;
    }
}

/**
 * Convert a 15-bit SNES BGR color to RGB.
 */
export function snesColorToRGB(bgr15: number): Color {
    const r5 = bgr15 & 0x1F;
    const g5 = (bgr15 >> 5) & 0x1F;
    const b5 = (bgr15 >> 10) & 0x1F;
    return {
        r: (r5 << 3) | (r5 >> 2),
        g: (g5 << 3) | (g5 >> 2),
        b: (b5 << 3) | (b5 >> 2),
        raw: bgr15,
    };
}
