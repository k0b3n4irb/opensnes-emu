# OpenSNES Debug Emulator

Browser-based SNES emulator with a debug API, accessible via MCP server for programmatic ROM testing and hardware inspection.

## Architecture

```
Claude Code ←──stdio/JSON-RPC──→ MCP Server (Node.js)
                                      │
                                      ↓
                              snes9x libretro (WASM)
                              + Debug Bridge (C/TS)
                              + Screenshot (PNG)
```

## Quick Start

### Prerequisites

- Node.js 20+
- Emscripten SDK (`emsdk`)

### Build

```bash
# 1. Install Emscripten (one-time)
cd ~/.emsdk && ./emsdk install 3.1.51 && ./emsdk activate 3.1.51
source ~/.emsdk/emsdk_env.sh

# 2. Install dependencies
cd tools/opensnes-emu
npm install

# 3. Build WASM core
make -C core

# 4. Build TypeScript
npm run build:ts
```

### Use with Claude Code (MCP)

Add to your `.claude/settings.json`:

```json
{
    "mcpServers": {
        "opensnes-emu": {
            "command": "node",
            "args": ["tools/opensnes-emu/dist/server/mcp-server.js"]
        }
    }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `emu_load_rom` | Load a .sfc ROM file |
| `emu_run_frames` | Advance N frames |
| `emu_screenshot` | Capture screen as PNG |
| `emu_read_vram` | Read VRAM bytes |
| `emu_read_cgram` | Read palette colors |
| `emu_read_oam` | Read sprite table |
| `emu_read_memory` | Read WRAM bytes |
| `emu_cpu_state` | CPU register snapshot |
| `emu_ppu_state` | PPU configuration |
| `emu_set_input` | Set joypad buttons |
| `emu_reset` | Reset console |
| `emu_save_state` | Save emulator state |
| `emu_load_state` | Load emulator state |
| `emu_status` | Check emulator status |

### Browser UI

```bash
npm run dev:web
# Open http://localhost:3000
```

### Visual Regression Testing

```bash
node dist/test/visual-regression.js \
  --rom examples/games/breakout/breakout.sfc \
  --frames 120 \
  --screenshot-at 60,120 \
  --compare-dir tests/visual/baseline/breakout/ \
  --update-baseline
```

## Project Structure

```
tools/opensnes-emu/
├── core/               # WASM build (snes9x + bridge.c)
├── debug-bridge/       # TypeScript API over WASM core
├── server/             # MCP server + headless runner
├── web/                # Browser frontend
└── test/               # Visual regression tests
```

## Emulator Core

Uses snes9x compiled to WASM via Emscripten. The libretro API provides:
- ROM loading, frame execution, save states
- WRAM/SRAM access

A C bridge (`core/bridge.c`) exposes additional snes9x internals:
- VRAM, CGRAM, OAM direct access
- CPU registers (PC, A, X, Y, SP, DB, PB, P)
- PPU state (BG mode, scroll, INIDISP)
