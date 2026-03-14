/**
 * OpenSNES Debug Emulator — Browser Frontend
 *
 * Provides a visual debug interface for the SNES emulator.
 * Uses the same debug-bridge API as the MCP server.
 */

import { OpenSNESEmulator } from '../debug-bridge/index.js';
import type { Snes9xModule, Color } from '../debug-bridge/types.js';
import { BUTTON, type ButtonName } from '../debug-bridge/types.js';

// ── DOM Elements ────────────────────────────────────────────────

const romInput = document.getElementById('rom-input') as HTMLInputElement;
const btnRun = document.getElementById('btn-run') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnStep = document.getElementById('btn-step') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const screenCanvas = document.getElementById('screen') as HTMLCanvasElement;
const screenCtx = screenCanvas.getContext('2d')!;

// Debug panels
const cpuStateEl = document.getElementById('cpu-state') as HTMLPreElement;
const ppuStateEl = document.getElementById('ppu-state') as HTMLPreElement;
const paletteGrid = document.getElementById('palette-grid') as HTMLDivElement;
const oamTableBody = document.querySelector('#oam-table tbody') as HTMLTableSectionElement;

// ── State ───────────────────────────────────────────────────────

let emu: OpenSNESEmulator | null = null;
let running = false;
let animFrameId: number | null = null;

// ── Tab switching ───────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panelId = `panel-${(tab as HTMLElement).dataset.panel}`;
        document.getElementById(panelId)?.classList.add('active');
    });
});

// ── ROM Loading ─────────────────────────────────────────────────

romInput.addEventListener('change', async () => {
    const file = romInput.files?.[0];
    if (!file) return;

    statusEl.textContent = 'Loading...';

    try {
        // Load the WASM module if not already loaded
        if (!emu) {
            const mod = await import('../core/build/snes9x_libretro.mjs');
            const createSnes9x = mod.default || mod.createSnes9x;
            const core = await createSnes9x() as Snes9xModule;
            emu = new OpenSNESEmulator(core);
            await emu.init();
        }

        // Read ROM file
        const buffer = await file.arrayBuffer();
        const romData = new Uint8Array(buffer);

        // Write ROM to Emscripten virtual filesystem
        // For browser use, we create a temporary file path
        const tempPath = `/tmp/${file.name}`;

        // Use the File API approach: load via array buffer
        const info = await emu.loadROM(tempPath);

        statusEl.textContent = `ROM: ${info.name} (${(info.size / 1024).toFixed(0)}KB)`;
        btnRun.disabled = false;
        btnPause.disabled = false;
        btnStep.disabled = false;
        btnReset.disabled = false;
    } catch (err) {
        statusEl.textContent = `Error: ${err}`;
        console.error('ROM load error:', err);
    }
});

// ── Controls ────────────────────────────────────────────────────

btnRun.addEventListener('click', () => {
    if (!emu) return;
    running = true;
    statusEl.textContent = 'Running...';
    runLoop();
});

btnPause.addEventListener('click', () => {
    running = false;
    if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    statusEl.textContent = 'Paused';
    updateDebugPanels();
});

btnStep.addEventListener('click', () => {
    if (!emu) return;
    running = false;
    if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    emu.runFrames(1);
    renderFrame();
    updateDebugPanels();
    statusEl.textContent = `Frame: ${emu.emulator.getTotalFrames()}`;
});

btnReset.addEventListener('click', () => {
    if (!emu) return;
    emu.emulator.reset();
    statusEl.textContent = 'Reset';
    updateDebugPanels();
});

// ── Emulation Loop ──────────────────────────────────────────────

function runLoop(): void {
    if (!running || !emu) return;

    emu.runFrames(1);
    renderFrame();

    // Update debug panels at reduced rate (every 10 frames)
    if (emu.emulator.getTotalFrames() % 10 === 0) {
        updateDebugPanels();
    }

    animFrameId = requestAnimationFrame(runLoop);
}

function renderFrame(): void {
    if (!emu) return;

    const fb = emu.emulator.getFrameBufferRGBA();
    if (!fb) return;

    // Create ImageData and draw to canvas (2x scale)
    const imageData = new ImageData(
        new Uint8ClampedArray(fb.data.buffer, fb.data.byteOffset, fb.data.length),
        fb.width,
        fb.height
    );

    // Draw at native resolution first, then scale
    const offscreen = new OffscreenCanvas(fb.width, fb.height);
    const offCtx = offscreen.getContext('2d')!;
    offCtx.putImageData(imageData, 0, 0);

    screenCtx.imageSmoothingEnabled = false;
    screenCtx.drawImage(offscreen, 0, 0, screenCanvas.width, screenCanvas.height);
}

// ── Debug Panel Updates ─────────────────────────────────────────

function updateDebugPanels(): void {
    if (!emu) return;

    // CPU state
    cpuStateEl.textContent = emu.cpu.formatState();

    // PPU state
    ppuStateEl.textContent = emu.ppu.formatState();

    // Update active panel
    const activeTab = document.querySelector('.tab.active') as HTMLElement;
    const panelName = activeTab?.dataset.panel;

    switch (panelName) {
        case 'palette':
            updatePalettePanel();
            break;
        case 'oam':
            updateOAMPanel();
            break;
    }
}

function updatePalettePanel(): void {
    if (!emu) return;

    const colors = emu.memory.readCGRAM();
    paletteGrid.innerHTML = '';

    for (let i = 0; i < 256; i++) {
        const c = colors[i];
        const cell = document.createElement('div');
        cell.className = 'palette-cell';
        cell.style.backgroundColor = `rgb(${c.r}, ${c.g}, ${c.b})`;
        cell.title = `#${i}: rgb(${c.r},${c.g},${c.b}) raw=0x${c.raw.toString(16).padStart(4, '0')}`;
        paletteGrid.appendChild(cell);
    }
}

function updateOAMPanel(): void {
    if (!emu) return;

    const sprites = emu.memory.readOAM().filter(s => s.y !== 0xF0 && s.y < 224);
    oamTableBody.innerHTML = '';

    for (const s of sprites) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${s.id}</td>
            <td>${s.x}</td>
            <td>${s.y}</td>
            <td>0x${s.tile.toString(16).padStart(3, '0')}</td>
            <td>${s.palette}</td>
            <td>${s.priority}</td>
            <td>${s.size}</td>
        `;
        oamTableBody.appendChild(row);
    }
}

// ── Keyboard Input ──────────────────────────────────────────────

const keyMap: Record<string, ButtonName> = {
    'ArrowUp': 'UP',
    'ArrowDown': 'DOWN',
    'ArrowLeft': 'LEFT',
    'ArrowRight': 'RIGHT',
    'KeyZ': 'B',
    'KeyX': 'A',
    'KeyA': 'Y',
    'KeyS': 'X',
    'KeyQ': 'L',
    'KeyW': 'R',
    'Enter': 'START',
    'ShiftRight': 'SELECT',
};

document.addEventListener('keydown', (e) => {
    if (!emu) return;
    const button = keyMap[e.code];
    if (button) {
        e.preventDefault();
        emu.input.pressButton(0, button);
    }
});

document.addEventListener('keyup', (e) => {
    if (!emu) return;
    const button = keyMap[e.code];
    if (button) {
        e.preventDefault();
        emu.input.releaseButton(0, button);
    }
});
