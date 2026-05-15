/**
 * Functional probe: OAM (sprite) shadow buffer correctness.
 *
 * What this proves
 * ----------------
 * The hand-written `lib/source/sprite_oamset.asm` correctly translates
 * a C `oamSet(id, x, y, tile, palette, priority, flags)` call into the
 * 4-byte OAM entry layout the SNES PPU expects, written to the WRAM
 * shadow buffer at $7E:0300.
 *
 * Why this exists
 * ---------------
 * `oamSet` doesn't push PHP — its arg base is 4,s, NOT 5,s. The static
 * lint check_asm_abi.py auto-detects this. But if a future refactor
 * adds a `php` (or a phb/phd/phx/phy), the offset semantics flip
 * silently. A probe that asserts on the resulting OAM bytes catches
 * that class of bug regardless of how the prologue is shaped.
 *
 * What we drive
 * -------------
 * The `simple_sprite` example calls `oamSet(0, 112, 96, 0x0010, 0, 3, 0)`
 * at boot. After NMI runs, the shadow buffer's first entry should hold:
 *   $7E:0300  X low      = 112   (0x70)
 *   $7E:0301  Y          = 96    (0x60)
 *   $7E:0302  tile low   = 0x10
 *   $7E:0303  attributes = priority(3)<<4 | palette(0)<<1 | tile_bit8(0)
 *                        = 0x30
 *
 * mesen2-rpc's "wram" space addresses bank $7E directly — offset 0x300
 * targets $7E:0300.
 *
 * Run
 * ---
 *   node --test test/functional/oam.test.mjs
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
  "../../../../examples/graphics/sprites/simple_sprite/simple_sprite.sfc",
);

// OAM shadow buffer at $7E:0300. Each sprite entry is 4 bytes:
//   +0  X low
//   +1  Y
//   +2  tile low (bits 0..7)
//   +3  attributes (vflip | hflip | priority[2] | palette[3] | tile_bit8)
const OAM_BUFFER = 0x0300;
const SPRITE0_X     = OAM_BUFFER + 0;
const SPRITE0_Y     = OAM_BUFFER + 1;
const SPRITE0_TILE  = OAM_BUFFER + 2;
const SPRITE0_ATTR  = OAM_BUFFER + 3;

// Per the simple_sprite C call:
//   oamSet(0, 112, 96, 0x0010, 0, 3, 0)
//          id, x,   y,  tile,  pal, pri, flags
//
// Y is decremented by 1 in the lib to compensate for the SNES PPU's
// sprite Y+1 scanline quirk (see commits 87a0ae2 / fcde09d). The user
// asks for Y=96 → stored Y=95 → rendered on scanline 96.
const EXPECTED_X    = 112;
const EXPECTED_Y    = 95;  /* 96 user-asked - 1 (Y+1 quirk compensation) */
const EXPECTED_TILE = 0x10;
// attributes byte: bit 0 = tile_bit8 (= 0 since tile 0x10 fits in 8 bits),
//                  bits 1-3 = palette (0), bits 4-5 = priority (3),
//                  bit 6 = hflip (0), bit 7 = vflip (0)
const EXPECTED_ATTR = (3 << 4) | (0 << 1) | 0;  // 0x30

test("simple_sprite boot writes sprite 0 to OAM shadow buffer", async () => {
  const { client, dispose } = await spawnMesenRpc();
  try {
    await client.emu.loadRom(ROM);
    // 60 frames gives boot + several NMI ticks to ensure the OAM DMA path
    // has had time to settle. The shadow buffer at $7E:0300 is written by
    // oamSet() at boot (synchronously); NMI then DMAs it to PPU OAM.
    await client.emu.runFrames(60);

    const x    = await client.mem.readByte("wram", SPRITE0_X);
    const y    = await client.mem.readByte("wram", SPRITE0_Y);
    const tile = await client.mem.readByte("wram", SPRITE0_TILE);
    const attr = await client.mem.readByte("wram", SPRITE0_ATTR);

    assert.equal(
      x, EXPECTED_X,
      `OAM sprite 0 X at $7E:${SPRITE0_X.toString(16)} should be ${EXPECTED_X} ` +
      `(0x${EXPECTED_X.toString(16)}), got ${x} (0x${x.toString(16)}). ` +
      `oamSet's x arg was probably read from the wrong stack slot.`,
    );
    assert.equal(
      y, EXPECTED_Y,
      `OAM sprite 0 Y at $7E:${SPRITE0_Y.toString(16)} should be ${EXPECTED_Y} ` +
      `(0x${EXPECTED_Y.toString(16)}), got ${y} (0x${y.toString(16)}).`,
    );
    assert.equal(
      tile, EXPECTED_TILE,
      `OAM sprite 0 tile at $7E:${SPRITE0_TILE.toString(16)} should be ` +
      `0x${EXPECTED_TILE.toString(16).padStart(2,'0')}, got 0x${tile.toString(16).padStart(2,'0')}.`,
    );
    assert.equal(
      attr & 0x3E, EXPECTED_ATTR,
      `OAM sprite 0 attributes at $7E:${SPRITE0_ATTR.toString(16)}: priority/palette ` +
      `bits should be 0x${EXPECTED_ATTR.toString(16).padStart(2,'0')}, ` +
      `got 0x${attr.toString(16).padStart(2,'0')} (masked priority/palette: ` +
      `0x${(attr & 0x3E).toString(16).padStart(2,'0')}). ` +
      `Flip-bit drift is acceptable; priority/palette drift means oamSet wrote ` +
      `the wrong attribute byte.`,
    );
  } finally {
    dispose();
  }
});
