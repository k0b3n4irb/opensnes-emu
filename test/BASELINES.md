# Visual Regression Baselines

This directory holds the reference framebuffers used by `phases/visual-regression.mjs`.

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
