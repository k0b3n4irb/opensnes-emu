# OpenSNES Debug Emulator

SNES debug emulator powered by snes9x (WASM). Single source of truth for all OpenSNES SDK testing.

```
Claude Code ←── MCP (stdio) ──→ opensnes-emu ──→ snes9x (WASM)
                                     │
                                     ├── 14 MCP tools (load, run, screenshot, inspect)
                                     ├── 7-phase test runner (212 checks)
                                     ├── Visual regression (pixel-exact baselines)
                                     ├── Lag frame detection
                                     └── Compiler benchmark
```

## Install

### Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| Node.js | 20+ | MCP server, test runner |
| Emscripten SDK | latest | Compile snes9x to WASM |
| Python 3 | 3.10+ | symmap.py, cyclecount.py |
| OpenSNES SDK | built | `bin/cc65816`, `bin/wla-65816`, library |

### Step 1: Install Emscripten

```bash
cd ~ && git clone https://github.com/emscripten-core/emsdk.git .emsdk
cd .emsdk && ./emsdk install latest && ./emsdk activate latest
source ~/.emsdk/emsdk_env.sh
```

Add to your shell profile:
```bash
echo 'source "$HOME/.emsdk/emsdk_env.sh"' >> ~/.bashrc
```

### Step 2: Install Node dependencies

```bash
cd tools/opensnes-emu
npm install
```

### Step 3: Build the WASM core

```bash
source ~/.emsdk/emsdk_env.sh
make -C core
```

This compiles snes9x + bridge.cpp into `core/build/snes9x_libretro.wasm` (~2.3MB).

### Step 4: Build TypeScript

```bash
npx tsc
```

### Verify

```bash
node test/run-all-tests.mjs --phase preconditions
```

Should show 7/7 PASS.

## Usage

### Test Runner (the main tool)

```bash
# Full suite: preconditions + compiler tests + build + static + runtime + visual + lag
node test/run-all-tests.mjs

# Quick mode: skip build + compiler tests (assumes pre-built ROMs)
node test/run-all-tests.mjs --quick

# Single phase
node test/run-all-tests.mjs --phase compiler
node test/run-all-tests.mjs --phase runtime
node test/run-all-tests.mjs --phase visual
node test/run-all-tests.mjs --phase lagcheck

# Update visual regression baselines
node test/run-all-tests.mjs --phase visual --update-baselines

# Verbose output
node test/run-all-tests.mjs --quick --verbose
```

#### 7 Test Phases

| Phase | Checks | What it does |
|-------|--------|-------------|
| 1. Preconditions | 7 | Verifies toolchain binaries + WASM core exist |
| 2. Compiler Tests | 60 | Compiles test_*.c → validates ASM patterns (JS, no bash) |
| 3. Build | 67 | `make` all unit tests + examples |
| 4. Static Analysis | 67 | symmap overlap, ROM size, bank overflow |
| 5. Runtime Execution | 54 | Loads ROMs in emulator, reads WRAM assertions + boot checks |
| 6. Visual Regression | 42 | Pixel-exact screenshot comparison against baselines |
| 7. Lag Detection | 42 | Measures lag_frame_counter over 300 steady-state frames |

### Compiler Benchmark

```bash
# Compare current compiler vs stored baseline
node test/run-benchmark.mjs

# Update baseline after compiler improvements
node test/run-benchmark.mjs --update

# Also run PVSnesLib benchmark ROM
node test/run-benchmark.mjs --pvsneslib
```

### MCP Server (for Claude Code)

Add to `.mcp.json` at the OpenSNES project root:

```json
{
  "mcpServers": {
    "opensnes-emu": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/tools/opensnes-emu/dist/server/mcp-server.js"]
    }
  }
}
```

Restart Claude Code. The 14 MCP tools become available:

| Tool | Description |
|------|-------------|
| `emu_load_rom` | Load a .sfc ROM file |
| `emu_run_frames` | Advance N frames (1-3600) |
| `emu_screenshot` | Capture screen as PNG (Claude sees the image) |
| `emu_read_vram` | Read VRAM bytes at address |
| `emu_read_cgram` | Read palette colors (RGB) |
| `emu_read_oam` | Read sprite table (128 sprites) |
| `emu_read_memory` | Read WRAM bytes at address |
| `emu_cpu_state` | CPU registers (PC, A, X, Y, SP, DB, PB, flags) |
| `emu_ppu_state` | PPU state (BG mode, scroll, brightness, tile/map addresses) |
| `emu_set_input` | Set joypad buttons ("A,RIGHT,START") |
| `emu_reset` | Reset the console |
| `emu_save_state` | Save emulator state to named slot |
| `emu_load_state` | Load emulator state from named slot |
| `emu_status` | Check WASM/ROM/frame status |

## Project Structure

```
tools/opensnes-emu/
├── core/                     # WASM core
│   ├── snes9x/               # snes9x source (git clone, not submodule)
│   ├── bridge.cpp             # C++ bridge exposing snes9x internals
│   ├── Makefile               # Emscripten build
│   └── build/                 # Output: snes9x_libretro.wasm + .mjs
│
├── debug-bridge/              # TypeScript API over WASM
│   ├── emulator.ts            # ROM loading, frame execution, input
│   ├── memory.ts              # WRAM, VRAM, CGRAM, OAM inspection
│   ├── cpu.ts                 # CPU register access
│   ├── ppu.ts                 # PPU state (BG mode, scroll, brightness)
│   ├── screenshot.ts          # Frame capture → PNG
│   ├── input.ts               # Joypad button simulation
│   └── types.ts               # Shared types
│
├── server/                    # MCP server
│   ├── mcp-server.ts          # 14 MCP tool definitions (stdio transport)
│   └── headless.ts            # Node.js headless emulator runner
│
├── test/                      # Test infrastructure
│   ├── run-all-tests.mjs      # THE single command (7 phases)
│   ├── run-benchmark.mjs      # Compiler cycle count benchmark
│   ├── phases/
│   │   ├── compiler-tests.mjs # 60 compiler tests (JS port of bash)
│   │   └── visual-regression.mjs # Pixel-exact screenshot comparison
│   ├── fixtures/              # Test source files (.c + Makefile)
│   │   ├── compiler/          # 58 test_*.c for compiler validation
│   │   ├── unit/              # 25 unit test modules
│   │   └── benchmark/         # bench_functions.c
│   └── baselines/             # Visual regression reference screenshots
│
├── web/                       # Browser frontend (optional)
│   ├── index.html
│   ├── app.ts
│   └── styles.css
│
├── roms/                      # Reference ROMs for analysis (gitignored)
├── package.json
├── tsconfig.json
└── .mcp.json                  # MCP server config template
```

## Known Limitations

opensnes-emu uses **snes9x** (scanline-accurate, NOT cycle-accurate). Known blind spots vs Mesen2:

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| DMA register persistence | snes9x doesn't model register clobbering between frames | Always validate DMA-heavy changes in Mesen2 |
| HDMA timing edge cases | Some HDMA effects work in snes9x but fail on real hardware | Mesen2 validation for HDMA changes |
| PPU open bus | Write-only register reads may differ | Not testable via emulator |

**When opensnes-emu misses a bug that Mesen2 catches**: document it as a known limitation and improve opensnes-emu if possible.

## Workflow

```
Hypothesis → Code → opensnes-emu test → Screenshot → Ask Mesen2 → Commit
                         ↓ FAIL                          ↓ FAIL
                    Revert + Fix                  Improve opensnes-emu
```

opensnes-emu is the first line of defense. Mesen2 is the final validator. Every bug that opensnes-emu misses is a task to improve it.
