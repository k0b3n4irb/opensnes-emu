/**
 * Functional probe: bgSetScroll WRAM cache correctness.
 *
 * What this proves
 * ----------------
 * `lib/source/background.c`'s `bgSetScroll(u8 bg, u16 x, u16 y)`
 * correctly writes its arguments to the SDK's per-bg scroll caches
 * `bg_scroll_x[bg]` and `bg_scroll_y[bg]`. These caches are read by
 * the NMI handler to update the SNES BG1HOFS/BG1VOFS write-only PPU
 * registers safely during VBlank.
 *
 * Why this is its own probe
 * -------------------------
 * Scrolling is a hot path. bgSetScroll has 3 args of mixed widths
 * (u8 bg, u16 x, u16 y) — a slightly different ABI shape than the
 * pointer-taking lib functions, so worth probing as its own surface.
 *
 * The BG hardware scroll registers ($210D BG1HOFS, $210E BG1VOFS) are
 * WRITE-ONLY on the real SNES — reading them gives open-bus garbage.
 * The lib's WRAM caches ARE readable, and the assertion that they
 * hold the C-level values is the strongest signal we can get without
 * doing PPU snapshot diffs.
 *
 * What we drive
 * -------------
 * `superfx_3d` calls `bgSetScroll(0, 0, 208)` once at boot — the only
 * example in the SDK that hits bgSetScroll with a non-zero Y immediate.
 * Without a non-zero value, a probe couldn't distinguish "function ran"
 * from "BSS was already zero".
 *
 * Symbol lookups (superfx_3d.sym):
 *   bg_scroll_x  $00:00F6 — array u16[4] (size 8)
 *   bg_scroll_y  $00:00FE — array u16[4] (size 8)
 *
 * Run
 * ---
 *   node --test test/functional/scroll.test.mjs
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
  "../../../../examples/graphics/effects/superfx_3d/superfx_3d.sfc",
);

// Per superfx_3d.sym (these addresses shift per example because SDK static
// data is laid out by the linker after the example's own data; hardcoding
// the lookup for this fixture is fine — a future enhancement could parse
// .sym dynamically).
const BG_SCROLL_X = 0x00F6;   // bg_scroll_x[]  — u16 × 4 = 8 bytes
const BG_SCROLL_Y = 0x00FE;   // bg_scroll_y[]  — u16 × 4 = 8 bytes

// Per superfx_3d/main.c the call is bgSetScroll(0, 0, 208).
const EXPECTED_X = 0;
const EXPECTED_Y = 208;

test("superfx_3d boot calls bgSetScroll(0, 0, 208)", async () => {
  const { client, dispose } = await spawnMesenRpc();
  try {
    await client.emu.loadRom(ROM);
    // Boot path. SuperFX init is heavier; 60 frames is generous.
    await client.emu.runFrames(60);

    // Read u16[bg=0] from each cache. mem.readWord returns little-endian.
    const x0 = await client.mem.readWord("cpu", BG_SCROLL_X + 0);
    const y0 = await client.mem.readWord("cpu", BG_SCROLL_Y + 0);

    assert.equal(
      x0, EXPECTED_X,
      `bg_scroll_x[0] at $${BG_SCROLL_X.toString(16)} should be ${EXPECTED_X}, ` +
      `got ${x0}. bgSetScroll probably read the x arg from the wrong stack slot.`,
    );
    assert.equal(
      y0, EXPECTED_Y,
      `bg_scroll_y[0] at $${BG_SCROLL_Y.toString(16)} should be ${EXPECTED_Y} ` +
      `(0x${EXPECTED_Y.toString(16)}), got ${y0} (0x${y0.toString(16)}). ` +
      `Most likely bgSetScroll read the y arg from the wrong stack slot — ` +
      `cc65816 L-to-R: bg pushed first, then x, then y last (closest to SP).`,
    );

    // Bonus assertion: the other bg slots should still be 0. If bgSetScroll
    // wrote to bg_scroll_y[wrong_index] instead, this might detect it.
    for (let bg = 1; bg < 4; bg++) {
      const yN = await client.mem.readWord("cpu", BG_SCROLL_Y + bg * 2);
      assert.equal(
        yN, 0,
        `bg_scroll_y[${bg}] should be 0 (untouched by bgSetScroll(0, 0, 208)), ` +
        `got ${yN}. bgSetScroll might have used the wrong bg index — its arg ` +
        `slot might be off, making bg=0 in C read as bg=${bg} in the lib.`,
      );
    }
  } finally {
    dispose();
  }
});
