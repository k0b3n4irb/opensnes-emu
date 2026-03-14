/**
 * OpenSNES Debug Emulator — MCP Server
 *
 * Provides MCP tools for Claude Code to interact with the SNES emulator:
 * load ROMs, run frames, capture screenshots, inspect hardware state.
 *
 * Transport: stdio (launched by Claude Code as a child process)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { createHeadlessEmulator, isWASMAvailable } from './headless.js';
import type { OpenSNESEmulator } from '../debug-bridge/index.js';
import { InputController } from '../debug-bridge/input.js';
import type { ButtonName } from '../debug-bridge/types.js';
import { BUTTON } from '../debug-bridge/types.js';

// ── Global emulator instance ────────────────────────────────────

let emu: OpenSNESEmulator | null = null;

async function getEmulator(): Promise<OpenSNESEmulator> {
    if (!emu) {
        emu = await createHeadlessEmulator();
    }
    return emu;
}

// ── MCP Server Setup ────────────────────────────────────────────

const server = new McpServer({
    name: 'opensnes-emu',
    version: '0.1.0',
});

// ── Tool: emu_load_rom ──────────────────────────────────────────

server.tool(
    'emu_load_rom',
    'Load a .sfc ROM file into the emulator',
    {
        path: z.string().describe('Path to the .sfc ROM file (absolute or relative to CWD)'),
    },
    async ({ path: romPath }) => {
        try {
            const absPath = resolve(romPath);
            if (!existsSync(absPath)) {
                return { content: [{ type: 'text', text: `ROM not found: ${absPath}` }], isError: true };
            }

            const e = await getEmulator();
            const info = await e.loadROM(absPath);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        romName: info.name,
                        size: info.size,
                        checksum: info.checksum,
                        file: basename(absPath),
                    }, null, 2),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_run_frames ────────────────────────────────────────

server.tool(
    'emu_run_frames',
    'Advance emulation by N frames (default: 1). Returns PC and frame count.',
    {
        count: z.number().int().min(1).max(3600).default(1)
            .describe('Number of frames to run (1-3600, default 1)'),
    },
    async ({ count }) => {
        try {
            const e = await getEmulator();
            const result = e.runFrames(count);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        framesRun: result.framesRun,
                        pc: `0x${result.pc.toString(16).padStart(4, '0')}`,
                        totalFrames: result.totalFrames,
                    }, null, 2),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_screenshot ────────────────────────────────────────

server.tool(
    'emu_screenshot',
    'Capture the current emulator screen as a PNG image',
    {
        scale: z.number().int().min(1).max(4).default(1)
            .describe('Scale factor (1=256×224, 2=512×448)'),
    },
    async ({ scale }) => {
        try {
            const e = await getEmulator();
            const png = e.screenshot.captureFrame(scale);
            return {
                content: [{
                    type: 'image',
                    data: png.toString('base64'),
                    mimeType: 'image/png',
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_read_vram ─────────────────────────────────────────

server.tool(
    'emu_read_vram',
    'Read bytes from VRAM at a given address',
    {
        address: z.number().int().min(0).max(0xFFFF)
            .describe('VRAM byte address (0x0000-0xFFFF)'),
        size: z.number().int().min(1).max(1024).default(32)
            .describe('Number of bytes to read (max 1024)'),
    },
    async ({ address, size }) => {
        try {
            const e = await getEmulator();
            const data = e.memory.readVRAM(address, size);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        address: `0x${address.toString(16).padStart(4, '0')}`,
                        size: data.length,
                        hex: formatHex(data),
                    }, null, 2),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_read_cgram ────────────────────────────────────────

server.tool(
    'emu_read_cgram',
    'Read all 256 palette colors from CGRAM',
    {
        paletteIndex: z.number().int().min(0).max(15).optional()
            .describe('Optional: read only one 16-color palette (0-15)'),
    },
    async ({ paletteIndex }) => {
        try {
            const e = await getEmulator();
            let colors;
            if (paletteIndex !== undefined) {
                colors = e.memory.readPalette(paletteIndex, 16);
            } else {
                colors = e.memory.readCGRAM();
            }
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        paletteIndex: paletteIndex ?? 'all',
                        count: colors.length,
                        colors: colors.map((c, i) => ({
                            index: paletteIndex !== undefined ? paletteIndex * 16 + i : i,
                            r: c.r, g: c.g, b: c.b,
                            hex: `#${c.r.toString(16).padStart(2, '0')}${c.g.toString(16).padStart(2, '0')}${c.b.toString(16).padStart(2, '0')}`,
                            raw: `0x${c.raw.toString(16).padStart(4, '0')}`,
                        })),
                    }, null, 2),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_read_oam ──────────────────────────────────────────

server.tool(
    'emu_read_oam',
    'Read the OAM sprite table (128 sprites)',
    {
        activeOnly: z.boolean().default(true)
            .describe('If true, only return sprites that are visible on screen'),
    },
    async ({ activeOnly }) => {
        try {
            const e = await getEmulator();
            let sprites = e.memory.readOAM();

            if (activeOnly) {
                // Filter to sprites that are on-screen (Y != 0xF0 which is off-screen convention)
                sprites = sprites.filter(s => s.y !== 0xF0 && s.y < 224);
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        count: sprites.length,
                        sprites: sprites.map(s => ({
                            id: s.id,
                            x: s.x,
                            y: s.y,
                            tile: `0x${s.tile.toString(16).padStart(3, '0')}`,
                            palette: s.palette,
                            priority: s.priority,
                            hFlip: s.hFlip,
                            vFlip: s.vFlip,
                            size: s.size,
                        })),
                    }, null, 2),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_read_memory ───────────────────────────────────────

server.tool(
    'emu_read_memory',
    'Read bytes from WRAM (system RAM, 128KB)',
    {
        address: z.number().int().min(0).max(0x1FFFF)
            .describe('WRAM address (0x0000-0x1FFFF)'),
        size: z.number().int().min(1).max(1024).default(32)
            .describe('Number of bytes to read (max 1024)'),
    },
    async ({ address, size }) => {
        try {
            const e = await getEmulator();
            const data = e.memory.readWRAM(address, size);

            // Also show as 16-bit values for convenience
            const values16: string[] = [];
            for (let i = 0; i + 1 < data.length; i += 2) {
                values16.push(`0x${(data[i] | (data[i + 1] << 8)).toString(16).padStart(4, '0')}`);
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        address: `0x${address.toString(16).padStart(5, '0')}`,
                        size: data.length,
                        hex: formatHex(data),
                        values16,
                    }, null, 2),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_cpu_state ─────────────────────────────────────────

server.tool(
    'emu_cpu_state',
    'Get CPU register state (PC, A, X, Y, SP, DB, PB, flags)',
    {},
    async () => {
        try {
            const e = await getEmulator();
            const state = e.cpu.getState();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        pc: `0x${state.pc.toString(16).padStart(4, '0')}`,
                        a: `0x${state.a.toString(16).padStart(4, '0')}`,
                        x: `0x${state.x.toString(16).padStart(4, '0')}`,
                        y: `0x${state.y.toString(16).padStart(4, '0')}`,
                        sp: `0x${state.sp.toString(16).padStart(4, '0')}`,
                        db: `0x${state.db.toString(16).padStart(2, '0')}`,
                        pb: `0x${state.pb.toString(16).padStart(2, '0')}`,
                        p: `0x${state.p.toString(16).padStart(2, '0')}`,
                        flags: state.flags,
                        formatted: e.cpu.formatState(),
                    }, null, 2),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_ppu_state ─────────────────────────────────────────

server.tool(
    'emu_ppu_state',
    'Get PPU state (BG mode, scroll positions, screen on/off, brightness)',
    {},
    async () => {
        try {
            const e = await getEmulator();
            const state = e.ppu.getState();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        mode: state.mode,
                        screenEnabled: state.screenEnabled,
                        brightness: state.brightness,
                        inidisp: `0x${state.inidisp.toString(16).padStart(2, '0')}`,
                        bgs: state.bgs.map((bg, i) => ({
                            name: `BG${i + 1}`,
                            scrollX: bg.scrollX,
                            scrollY: bg.scrollY,
                            tileSize: bg.tileSize,
                        })),
                        formatted: e.ppu.formatState(),
                    }, null, 2),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_set_input ─────────────────────────────────────────

server.tool(
    'emu_set_input',
    'Set joypad button state. Buttons: A, B, X, Y, L, R, UP, DOWN, LEFT, RIGHT, START, SELECT',
    {
        pad: z.number().int().min(0).max(4).default(0)
            .describe('Controller port (0-4, default 0)'),
        buttons: z.string()
            .describe('Comma-separated button names to hold (e.g., "A,RIGHT,START"). Empty string releases all.'),
    },
    async ({ pad, buttons }) => {
        try {
            const e = await getEmulator();

            if (!buttons || buttons.trim() === '') {
                e.input.releaseAll(pad);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ pad, buttons: 'none', bitmask: '0x0000' }) }],
                };
            }

            const mask = InputController.parseButtonString(buttons);
            e.input.setButtons(pad, mask);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        pad,
                        buttons: buttons.toUpperCase(),
                        bitmask: `0x${mask.toString(16).padStart(4, '0')}`,
                    }),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_reset ─────────────────────────────────────────────

server.tool(
    'emu_reset',
    'Reset the emulated SNES console',
    {},
    async () => {
        try {
            const e = await getEmulator();
            e.emulator.reset();
            return {
                content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Console reset' }) }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_save_state / emu_load_state ───────────────────────

let savedStates: Map<string, Uint8Array> = new Map();

server.tool(
    'emu_save_state',
    'Save the current emulator state to a named slot',
    {
        name: z.string().default('default')
            .describe('Name for the save state slot'),
    },
    async ({ name }) => {
        try {
            const e = await getEmulator();
            const state = e.emulator.saveState();
            savedStates.set(name, state);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        slot: name,
                        size: state.length,
                        slots: Array.from(savedStates.keys()),
                    }),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

server.tool(
    'emu_load_state',
    'Load a previously saved emulator state',
    {
        name: z.string().default('default')
            .describe('Name of the save state slot to load'),
    },
    async ({ name }) => {
        try {
            const state = savedStates.get(name);
            if (!state) {
                return {
                    content: [{
                        type: 'text',
                        text: `No save state found in slot "${name}". Available: ${Array.from(savedStates.keys()).join(', ') || 'none'}`,
                    }],
                    isError: true,
                };
            }

            const e = await getEmulator();
            e.emulator.loadState(state);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ success: true, slot: name, message: 'State loaded' }),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Tool: emu_status ────────────────────────────────────────────

server.tool(
    'emu_status',
    'Check emulator status: is WASM loaded? Is a ROM loaded? Frame count?',
    {},
    async () => {
        try {
            const wasmReady = await isWASMAvailable();
            const emuReady = emu !== null;
            const romLoaded = emuReady && emu!.emulator.isROMLoaded();

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        wasmAvailable: wasmReady,
                        emulatorInitialized: emuReady,
                        romLoaded,
                        romInfo: romLoaded ? emu!.emulator.getROMInfo() : null,
                        totalFrames: romLoaded ? emu!.emulator.getTotalFrames() : 0,
                        savedStateSlots: Array.from(savedStates.keys()),
                    }, null, 2),
                }],
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
);

// ── Helpers ─────────────────────────────────────────────────────

function formatHex(data: Uint8Array): string {
    const lines: string[] = [];
    for (let i = 0; i < data.length; i += 16) {
        const bytes = Array.from(data.subarray(i, Math.min(i + 16, data.length)));
        const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = bytes.map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('');
        lines.push(`${i.toString(16).padStart(4, '0')}: ${hex.padEnd(48)} ${ascii}`);
    }
    return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[opensnes-emu] MCP server started (stdio transport)');
}

main().catch((err) => {
    console.error('[opensnes-emu] Fatal error:', err);
    process.exit(1);
});
