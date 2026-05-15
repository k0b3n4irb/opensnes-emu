/**
 * Functional probe: dmaCopyCGram to palette memory.
 *
 * What this proves
 * ----------------
 * `lib/source/dma.asm`'s `dmaCopyCGram(u8 *source, u8 cgramAddr, u16 size)`
 * correctly transfers from ROM/WRAM source to CGRAM (the SNES palette
 * memory). Same ABI shape as dmaCopyVram — 1 pointer arg + 2 small
 * args — so it exercises the post-A6 4-byte pointer path identically.
 *
 * Why this is its own probe
 * -------------------------
 * dmaCopyVram and dmaCopyCGram look nearly identical in C but live as
 * SEPARATE hand-written ASM functions in dma.asm. A retrofit that
 * fixes one and forgets the other (chantier A6.12-style mistake) would
 * silently break palette uploads. The hdma case from this week
 * (c5689f5) was exactly that pattern. Probing both protects the pair.
 *
 * What we drive
 * -------------
 * hello_world calls `dmaCopyCGram(bg_palette, 0, 4)` at boot. The 4
 * bytes at ROM symbol bg_palette must end up at CGRAM byte offset 0.
 * (Address 0 is a CGRAM index in COLORS, not bytes — but mesen2-rpc
 * exposes CGRAM as flat byte memory, so we read 4 raw bytes from
 * cgram offset 0.)
 *
 * Run
 * ---
 *   node --test test/functional/cgram.test.mjs
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
  "../../../../examples/text/hello_world/hello_world.sfc",
);

// Per hello_world.sym:
const BG_PALETTE_ADDR = 0xA355;   // CPU bank 0 view of bg_palette
const COPY_SIZE = 4;              // _sizeof_bg_palette = 4 bytes = 2 colors

// dmaCopyCGram destination — 0 = first color (CGRAM index 0).
const CGRAM_DEST = 0x0000;

test("hello_world boot copies bg_palette to CGRAM via dmaCopyCGram", async () => {
  const { client, dispose } = await spawnMesenRpc();
  try {
    await client.emu.loadRom(ROM);
    await client.emu.runFrames(30);

    const srcHex  = await client.mem.readRange("cpu",   BG_PALETTE_ADDR, COPY_SIZE);
    const destHex = await client.mem.readRange("cgram", CGRAM_DEST,      COPY_SIZE);

    assert.equal(
      srcHex.length, COPY_SIZE * 2,
      `expected ${COPY_SIZE * 2} hex chars from bg_palette read, got ${srcHex.length}`,
    );
    assert.equal(
      destHex.length, COPY_SIZE * 2,
      `expected ${COPY_SIZE * 2} hex chars from CGRAM read, got ${destHex.length}`,
    );

    if (srcHex !== destHex) {
      const allZero = /^0+$/.test(destHex);
      const hint = allZero
        ? "CGRAM is all zeros — dmaCopyCGram didn't run. Likely wrong " +
          "source pointer slot (check dma.asm's 4-byte pointer reads)."
        : "CGRAM has SOME data but it differs from ROM. The DMA ran with " +
          "the wrong source bank byte. Check dma.asm's bank-byte stack slot " +
          "(post-A6, lives at low_off + 2 of the 4-byte pointer arg).";
      assert.fail(
        `dmaCopyCGram(bg_palette, 0, 4) didn't write the right bytes.\n` +
        `  ROM[bg_palette]: ${srcHex}\n` +
        `  CGRAM[0..3]:     ${destHex}\n` +
        `  ${hint}`,
      );
    }
  } finally {
    dispose();
  }
});
