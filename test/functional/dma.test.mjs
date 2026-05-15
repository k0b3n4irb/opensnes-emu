/**
 * Functional probe: DMA copy to VRAM.
 *
 * What this proves
 * ----------------
 * `lib/source/dma.asm` correctly routes a C call
 *   dmaCopyVram(u8 *source, u16 vramAddr, u16 size)
 * into a DMA transfer that puts the right bytes at the right VRAM
 * destination. Validates: pointer arg (4 bytes post-A6) is read from
 * the right stack slot, the bank byte ends up in DMA's A1B register,
 * and the destination/length round-trip works end-to-end.
 *
 * Why this exists
 * ---------------
 * dmaCopyVram is the hot path used by basically every example to load
 * tile graphics / tilemaps / palettes. Hand-written ASM (post-A6
 * retrofit in chantier A6.12). A regression here corrupts everything
 * visual at once. The lint check_asm_abi.py covers the structural
 * angle; this probe is the runtime confirmation that the actual VRAM
 * gets what the C call asked for.
 *
 * What we drive
 * -------------
 * `hello_world` calls dmaCopyVram(font_tiles, 0x0000, 144) at boot.
 * After ~5 frames the DMA has run and the first 144 bytes of VRAM
 * should match the first 144 bytes of font_tiles in ROM.
 *
 * Symbol lookups (via the .sym file):
 *   font_tiles  CPU bank 0 offset $9C67, size $90 (144 bytes)
 *
 * The probe reads both the SOURCE (font_tiles in CPU memory) and the
 * DESTINATION (VRAM byte $0000) via mesen2-rpc and compares them. No
 * hardcoded bytes — if the data shape changes, the probe still works.
 *
 * Run
 * ---
 *   node --test test/functional/dma.test.mjs
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
const FONT_TILES_ADDR = 0x9C67;   // CPU bank 0 view (LoROM, ROM mirror)
const COPY_SIZE = 144;            // _sizeof_font_tiles

// dmaCopyVram destination — first arg to the C call is byte $0000 in
// hello_world's main.c (line 134). Mesen2's "vram" space is byte-indexed.
const VRAM_DEST = 0x0000;

test("hello_world boot copies font_tiles to VRAM via dmaCopyVram", async () => {
  const { client, dispose } = await spawnMesenRpc();
  try {
    await client.emu.loadRom(ROM);
    // dmaCopyVram fires once at boot. 5 frames is plenty; using 30 to
    // be defensive against any forced-blank / wait-state hidden in the
    // SDK init path.
    await client.emu.runFrames(30);

    // Read SOURCE from CPU memory. CPU $00:9C67 transparently resolves
    // through Mesen's memory mapper to the right ROM byte.
    const srcHex  = await client.mem.readRange("cpu",  FONT_TILES_ADDR, COPY_SIZE);
    const destHex = await client.mem.readRange("vram", VRAM_DEST,        COPY_SIZE);

    // Both come back as continuous hex strings (no separators, 2 chars per
    // byte). Compare as such — equal length, equal bytes.
    assert.equal(
      srcHex.length, COPY_SIZE * 2,
      `expected ${COPY_SIZE * 2} hex chars from font_tiles read, got ${srcHex.length}`,
    );
    assert.equal(
      destHex.length, COPY_SIZE * 2,
      `expected ${COPY_SIZE * 2} hex chars from VRAM read, got ${destHex.length}`,
    );

    if (srcHex !== destHex) {
      // Produce a diagnostic with the first mismatching byte position
      // and a snippet of context — much more useful than a wall of hex.
      let firstDiff = -1;
      for (let i = 0; i < srcHex.length; i += 2) {
        if (srcHex.slice(i, i+2) !== destHex.slice(i, i+2)) { firstDiff = i / 2; break; }
      }
      const ctx = (s, byteIdx) => {
        const start = Math.max(0, byteIdx - 4) * 2;
        const end   = Math.min(COPY_SIZE, byteIdx + 4) * 2;
        return s.slice(start, end);
      };
      const allZero = /^0+$/.test(destHex);
      const hint = allZero
        ? "VRAM is all zeros — the DMA didn't run at all (likely dmaCopyVram " +
          "read the wrong pointer slot, or hit a forced-blank gate). Check " +
          "lib/source/dma.asm offsets and the lint check_asm_abi.py output."
        : "VRAM has SOME data but it differs from ROM at this offset. The DMA " +
          "ran but probably with the wrong source bank byte (post-A6, the bank " +
          "lives in the high half of the 4-byte pointer at stack offset N+2). " +
          "Check dma.asm's `lda <bank>,s` site against the lint rules.";
      assert.fail(
        `dmaCopyVram(font_tiles, 0x0000, 144) didn't write the right bytes to VRAM.\n` +
        `  First diff at byte ${firstDiff} (of ${COPY_SIZE}):\n` +
        `    ROM[${firstDiff}..]:  ${ctx(srcHex,  firstDiff)}\n` +
        `    VRAM[${firstDiff}..]: ${ctx(destHex, firstDiff)}\n` +
        `  ${hint}`,
      );
    }
  } finally {
    dispose();
  }
});
