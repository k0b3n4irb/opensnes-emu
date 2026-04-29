# Visual Regression Baselines

This directory holds two parallel sets of reference framebuffers:

- **`<label>.bin` + `<label>.meta`** — captured by `phases/visual-regression.mjs`
  via the snes9x WASM core. Covers all 53 examples.
- **`<label>.mesen2.bin`** — captured by `phases/visual-mesen2.mjs` via the
  vendored Mesen2 binary in `--testrunner` mode. Covers the 4 chip-using
  examples (`superfx_*`, `sa1_*`) where snes9x cannot detect the GSU and
  reports "GSU: NOT DETECTED" instead of running the chip code. See the
  "Mesen2 Visual Regression" section below for details.

The two sets are independent: a chip ROM has both a `.bin` (snes9x view —
useful only as a "boots without crashing" check) and a `.mesen2.bin`
(Mesen2 view — the meaningful one).

## Layout

For each example with a `.sfc` ROM, two files exist in `baselines/`:

| File | Format | Content |
|------|--------|---------|
| `<label>.bin` | raw RGBA, no compression | framebuffer captured at frame `frames` |
| `<label>.meta` | JSON | provenance manifest (see below) |

`<label>` is the example path with `/` replaced by `_`, e.g.
`graphics/sprites/dynamic_metasprite` → `graphics_sprites_dynamic_metasprite.bin`.

Storing raw RGBA (instead of PNG) eliminates compression-related drift — a baseline
that compares "exact" today still compares exact tomorrow with a different libpng.

## `.meta` schema

```json
{
  "width": 256,
  "height": 224,
  "frames": 120,
  "rom_sha256": "<64 hex chars>",
  "snes9x_commit": "<7 hex chars or 'unknown'>",
  "captured_at": "2026-04-26T17:51:46.500Z"
}
```

| Field | Purpose |
|-------|---------|
| `width`, `height`, `frames` | sanity check: framebuffer size + warmup frames used |
| `rom_sha256` | **drift signal**: if the current ROM hashes differently, a noisy diff is expected — the example was rebuilt since this baseline was captured |
| `snes9x_commit` | **drift signal**: if `core/snes9x` is at a different commit, rendering differences are expected (different emulator version) |
| `captured_at` | ISO-8601 timestamp; useful when triaging "how stale is this?" |

The runner emits `[WARN]` on `rom_sha256` or `snes9x_commit` mismatch but **does not**
fail the test on those alone. The pixel diff still rules pass/fail. Warnings give a
human reviewer the context to decide between "regen the baseline" and "investigate
the regression".

## Regeneration protocol

Regenerate when:
- An example's expected output legitimately changed (visual fix, refactor that
  shifts timing) and was validated in Mesen2.
- snes9x was bumped to a new commit and the diff is global (small per-pixel drift
  across many examples).

```bash
# 1. Make sure ROMs are fresh
make clean && make

# 2. Regenerate (writes new .bin + .meta for every example)
cd tools/opensnes-emu
node test/run-all-tests.mjs --phase visual --update-baselines

# 3. Verify
node test/run-all-tests.mjs --quick   # should show 53/53 visual

# 4. Validate visually in Mesen2 — DO NOT skip this step
#    For each example whose baseline you regenerated, open the ROM in Mesen2
#    and confirm the rendering is correct. The new baseline is the new
#    reference; if it captures a bug, the bug becomes the truth.

# 5. Commit only the affected baselines (do not blanket-commit all 53 .bin
#    files unless you actually validated all of them)
cd tools/opensnes-emu
git add test/baselines/<label>.bin test/baselines/<label>.meta
git commit -m "test(visual): regenerate <label> baseline (<reason>)"
```

## Tolerance

Default `maxDiffPixels = 50` (set in `run-all-tests.mjs:418`). snes9x emits 1–2
pixel scroll drift per frame on some BG modes — 50px allows for that without
masking real regressions. A diff > 50 means something genuinely changed in the
rendering pipeline.

## Pitfalls

- **Don't update only `.bin` and forget `.meta`** — the runner expects both. Use
  `--update-baselines`, which writes both atomically.
- **Don't commit baselines you didn't validate** — automated `--update-baselines`
  captures whatever the emulator produces, including bugs. Mesen2 (or another
  trusted reference) is required for sign-off.
- **`captured_at` is wall-clock time, not git commit time** — useful as a hint
  but not authoritative. The `rom_sha256` and `snes9x_commit` fields are the
  load-bearing provenance.

## Mesen2 Visual Regression (chip-using ROMs)

snes9x's libretro core does not detect the GSU chip in the SuperFX ROM
headers OpenSNES produces, so for those ROMs the snes9x phase only
validates "boots without crashing" — the GSU code path is never
exercised. Mesen2 detects the chip correctly and runs the GSU / SA-1
examples cleanly, so a second visual phase runs the chip ROMs through
the vendored Mesen2 binary in `--testrunner` mode.

### Setup

The binary is **not** committed (27 MB). Contributors who want
chip-ROM coverage run the install script once:

```bash
tools/opensnes-emu/scripts/install-mesen2.sh
```

It downloads the matching Linux/macOS x64/ARM64 zip from the Mesen2
GitHub releases and unpacks `vendor/Mesen`. Subsequent runs short-
circuit when the cached version matches.

If the binary is missing, the Mesen2 phase reports `[SKIP]` instead
of failing — the rest of the suite still runs.

### Baseline format

| File | Format |
|------|--------|
| `<label>.mesen2.bin` | 8-byte header (`width:u32 LE, height:u32 LE`) + raw RGBA, row-major, A=255 |

The header is necessary because Mesen2 reports the SNES PPU frame size
dynamically (typically 256×239 on NTSC, can change with hi-res /
interlace modes), unlike snes9x which always emits 256×224.

The capture path is driven by a generic Lua script
(`test/scripts/visual-capture.lua`) that takes its parameters via
environment variables (`MESEN_CAPTURE_FRAME`, `MESEN_CAPTURE_OUTPUT`).
The script can't use `emu.takeScreenshot()` because the video decoder
is intentionally not initialised in `--testrunner` mode, so we use
`emu.getScreenBuffer()` and write the framebuffer ourselves. Mesen2
sandboxes the `io` and `os` libraries by default — the phase passes
`--Debug.ScriptWindow.AllowIoOsAccess=true` to unlock them.

### Tolerance

Default `maxDiffPixels = 50`. Per-ROM overrides live in
`ROM_DIFF_OVERRIDES` in `phases/visual-mesen2.mjs`:

| ROM | Tolerance | Reason |
|-----|----------:|--------|
| `graphics/effects/superfx_3d` | 2000 | Continuously animated rotating cube — Mesen2 startup latency varies enough that frame 120 lands at a slightly different rotation between runs (~1°). The phase still catches "GSU NOT DETECTED" regressions clearly even at this tolerance. |

### Regeneration

```bash
cd tools/opensnes-emu
node test/run-all-tests.mjs --phase mesen2 --update-baselines
```

Validate the new baselines visually in Mesen2 (load the ROM in the
GUI, run a few seconds, confirm output) before committing.
