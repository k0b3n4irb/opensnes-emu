/**
 * Functional probe: HDMA setup via mesen2-rpc.
 *
 * What this proves
 * ----------------
 * The hand-written `lib/source/hdma.asm` functions (hdmaSetup,
 * hdmaSetupBank, hdmaEnable) correctly translate the cc65816 calling
 * convention into the right SNES DMA registers ($43x0–$43x4 and $420C).
 *
 * Why this exists
 * ---------------
 * Chantier A6+A7 widened pointers from 2 to 4 bytes. The A6.12 retrofit
 * updated the lib ASM signatures' stack offsets — but missed two
 * functions (hdmaSetupBank, hdmaSetTable). The bug was invisible in
 * automated tests (269/269 green) and only surfaced when the user
 * pressed A in the `hdma_gradient` example and the gradient didn't
 * appear. See .claude/notes/chantiers/a6_a7_unit_test_diagnostic.md.
 *
 * The static lint (check_asm_abi.py) now catches that bug class at
 * build time. THIS probe is the runtime complement: it verifies the
 * actual DMA register contents after the lib function runs, catching
 * any future regression that ALSO slips past the lint (e.g. a bug in
 * the lib's *call-site*, not its signature; or a register that gets
 * overwritten by something else between setup and enable).
 *
 * What we drive
 * -------------
 * The `gradient_colors` example calls `hdmaSetup` and `hdmaEnable` at
 * boot, no input required. We:
 *   1. Load gradient_colors.sfc
 *   2. Run 60 frames (boot completes)
 *   3. Read DMA channel 6 control registers
 *   4. Assert they hold the values the C call asked for
 *
 * Run
 * ---
 *   node --test test/functional/hdma.test.mjs
 *
 *   # Or directly:
 *   node test/functional/hdma.test.mjs
 *
 * Environment:
 *   MESEN_RPC_BIN     override the mesen2-rpc binary path
 *   MESEN_RPC_PORT    override the TCP port (default 9930)
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { spawnMesenRpc } from "./lib/spawn-mesen.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROM = resolve(
  __dirname,
  "../../../../examples/graphics/effects/gradient_colors/gradient_colors.sfc",
);

// SNES DMA channel 6 register base ($4300 + 6*16 = $4360)
const DMA6_BASE = 0x4360;
const DMA_DMAPx = 0;  // DMA mode at base+0
const DMA_BBADx = 1;  // B-bus address (= low byte of $21NN dest reg)

// $420C HDMAEN is write-only on real SNES — reading it via the debugger
// returns open-bus or last-MMIO-value depending on the emulator. The lib
// tracks the enabled mask in WRAM at `hdma_enabled_state`; read that instead.
// Address from gradient_colors.sym; the symbol is stable across examples.
const HDMA_ENABLED_STATE = 0x0260;

// Expected values from gradient_colors's C call:
//   hdmaSetup(HDMA_CHANNEL_6, HDMA_MODE_2REG_2X, HDMA_DEST_CGADD, hdmaGradientList);
//   hdmaEnable(1 << HDMA_CHANNEL_6);
//
// Per snes/hdma.h:
//   HDMA_MODE_2REG_2X = 0x03
//   HDMA_DEST_CGADD   = 0x21
const EXPECTED_DMAP   = 0x03;
const EXPECTED_BBAD   = 0x21;
const EXPECTED_HDMAEN = 1 << 6;

test("gradient_colors boot configures HDMA channel 6", async () => {
  const { client, dispose } = await spawnMesenRpc();
  try {
    await client.emu.loadRom(ROM);
    // 60 frames = 1 sec at 60Hz; plenty for the unconditional boot setup.
    await client.emu.runFrames(60);

    const dmap   = await client.mem.readByte("cpu", DMA6_BASE + DMA_DMAPx);
    const bbad   = await client.mem.readByte("cpu", DMA6_BASE + DMA_BBADx);
    const hdmaen = await client.mem.readByte("cpu", HDMA_ENABLED_STATE);

    assert.equal(
      dmap, EXPECTED_DMAP,
      `DMA channel 6 DMAP at $${(DMA6_BASE + DMA_DMAPx).toString(16)} ` +
      `should be HDMA_MODE_2REG_2X ($${EXPECTED_DMAP.toString(16).padStart(2,'0')}), ` +
      `got $${dmap.toString(16).padStart(2,'0')}. ` +
      `Likely cause: hdmaSetup() reads its 'mode' arg from the wrong stack slot ` +
      `(check check_asm_abi lint, and recall A6+A7 ABI widened pointers).`,
    );
    assert.equal(
      bbad, EXPECTED_BBAD,
      `DMA channel 6 BBAD at $${(DMA6_BASE + DMA_BBADx).toString(16)} ` +
      `should be HDMA_DEST_CGADD ($${EXPECTED_BBAD.toString(16).padStart(2,'0')}), ` +
      `got $${bbad.toString(16).padStart(2,'0')}.`,
    );
    assert.ok(
      (hdmaen & EXPECTED_HDMAEN) !== 0,
      `hdma_enabled_state at $${HDMA_ENABLED_STATE.toString(16)} should have ` +
      `bit 6 set ($${EXPECTED_HDMAEN.toString(16)}); got ` +
      `$${hdmaen.toString(16).padStart(2,'0')}. If this fails, hdmaEnable() ` +
      `received the wrong channelMask (check its 5,s read is correct).`,
    );
  } finally {
    dispose();
  }
});
