/**
 * PPU state inspection.
 */

import type { Snes9xModule, PPUState, BGInfo } from './types.js';

/** Map BGSize field to human-readable SC size string */
const SC_SIZE_MAP: Record<number, string> = {
    0: '32x32',
    1: '64x32',
    2: '32x64',
    3: '64x64',
};

export class PPUInspector {
    constructor(private core: Snes9xModule) {}

    /**
     * Get a full PPU state snapshot.
     */
    getState(): PPUState {
        const inidisp = this.core._bridge_get_inidisp();
        const mode = this.core._bridge_get_bg_mode();

        const bgs: BGInfo[] = [];
        for (let i = 0; i < 4; i++) {
            const scSize = this.core._bridge_get_bg_size(i);
            bgs.push({
                tileBaseAddr: this.core._bridge_get_bg_tile_base(i),
                mapBaseAddr: this.core._bridge_get_bg_map_base(i),
                scrollX: this.core._bridge_get_bg_scroll_x(i),
                scrollY: this.core._bridge_get_bg_scroll_y(i),
                tileSize: 8, // TODO: expose tile size from PPU struct
                mapSize: SC_SIZE_MAP[scSize] || `unknown(${scSize})`,
            });
        }

        return {
            mode,
            inidisp,
            screenEnabled: !(inidisp & 0x80),
            brightness: inidisp & 0x0F,
            bgs,
        };
    }

    /**
     * Get the BG mode (0-7).
     */
    getMode(): number {
        return this.core._bridge_get_bg_mode();
    }

    /**
     * Check if the screen is enabled (not in forced blank).
     */
    isScreenOn(): boolean {
        return !this.core._bridge_get_forced_blanking();
    }

    /**
     * Get the brightness level (0-15).
     */
    getBrightness(): number {
        return this.core._bridge_get_brightness();
    }

    /**
     * Get BG scroll offsets.
     */
    getScroll(bg: number): { x: number; y: number } {
        return {
            x: this.core._bridge_get_bg_scroll_x(bg),
            y: this.core._bridge_get_bg_scroll_y(bg),
        };
    }

    /**
     * Get OBJ (sprite) configuration.
     */
    getOBJConfig(): { sizeSelect: number; nameBase: number } {
        return {
            sizeSelect: this.core._bridge_get_obj_size_select(),
            nameBase: this.core._bridge_get_obj_name_base(),
        };
    }

    /**
     * Format PPU state as human-readable string.
     */
    formatState(): string {
        const s = this.getState();
        const lines = [
            `Mode: ${s.mode}  Screen: ${s.screenEnabled ? 'ON' : 'OFF'}  Brightness: ${s.brightness}/15`,
        ];
        for (let i = 0; i < 4; i++) {
            const bg = s.bgs[i];
            lines.push(
                `  BG${i + 1}: tiles=0x${bg.tileBaseAddr.toString(16).padStart(4, '0')} ` +
                `map=0x${bg.mapBaseAddr.toString(16).padStart(4, '0')} ` +
                `scroll=(${bg.scrollX}, ${bg.scrollY}) ` +
                `sc=${bg.mapSize}`
            );
        }
        return lines.join('\n');
    }
}
