# Functional probes via mesen2-rpc

Runtime behavioral assertions driven by the autonomous mesen2-rpc
infrastructure (the headless Mesen2 fork at
[github.com/k0b3n4irb/mesen2-rpc](https://github.com/k0b3n4irb/mesen2-rpc)).
Complement to the static lint at `devtools/check_asm_abi.py`.

## What this catches

Where the static lint catches **structural** bugs (ASM signature ↔ C
declaration disagrees), these probes catch **behavioral** ones: code
that compiles fine but does the wrong thing at runtime. Typical
targets:

- Lib functions wiring SNES registers from C args (e.g. `hdmaSetup` →
  DMA channel registers): verify the right registers got the right
  values after the C call.
- State that builds up over time (game logic, NMI handlers, audio
  pipeline): boot N frames, snapshot, advance more frames, verify
  invariants.
- Side effects that visual regression can't see ("the OAM has 12
  sprites" vs. "the screenshot matches a baseline").

## Prerequisites

A working mesen2-rpc binary. From this repo's parent directory:

```sh
git clone git@github.com:k0b3n4irb/mesen2-rpc ../Mesen2  # or use existing
cd ../Mesen2 && make
cd clients/typescript && npm install && npm run build
```

The probes auto-discover both via `MESEN_RPC_BIN` and `MESEN_RPC_CLIENT`
env vars (defaults assume `../../Mesen2` layout).

## Run

```sh
node --test tools/opensnes-emu/test/functional/*.test.mjs
```

Single probe:

```sh
node --test tools/opensnes-emu/test/functional/hdma.test.mjs
```

The harness auto-spawns a fresh `mesen-rpc` on TCP port 9930 per run,
connects via the typed `Mesen2Client`, runs the assertions, and tears
down the spawn on exit (SIGTERM + SIGKILL fallback). No manual server
management.

## Architecture

```
test/functional/
├── lib/
│   └── spawn-mesen.mjs       Shared harness — spawn + connect + dispose
├── hdma.test.mjs             HDMA register-level verification
├── ...                       (add new probes here)
└── README.md                 This file
```

A probe is a `node:test` script. It calls `spawnMesenRpc()` to get
`{ client, dispose }`, then drives the emulator (`client.emu.loadRom`,
`runFrames`, etc.) and asserts via `client.mem.readByte` / `cpu.state`
/ etc. The full Mesen2Client surface (27 methods) is documented at
[clients/typescript/README.md](https://github.com/k0b3n4irb/mesen2-rpc/tree/dev/rpc-server/clients/typescript).

## Authoring guide

When writing a new probe, ask:

1. **What property am I asserting?** Be specific. "HDMA channel 6 is
   configured for `HDMA_MODE_2REG_2X` with CGADD destination" is a
   good assertion. "The screen looks right" is a visual regression
   job, not a probe.
2. **Where in the example flow does that property become true?**
   Usually a fixed number of frames after boot (consoleInit + setMode
   + lib call + setScreenOn). If the property requires input, you'll
   currently need a fixture ROM that triggers the call unconditionally
   (mesen2-rpc doesn't yet have input injection).
3. **Where do I read the property's resulting state?**
   - Hardware registers: `client.mem.readByte("cpu", 0x43XX)`
   - WRAM caches that mirror write-only registers: read from the lib's
     RAM symbol (e.g. `hdma_enabled_state` mirrors `$420C HDMAEN`).
     Sym files at `examples/.../*.sym` carry the addresses.
4. **What is the failure diagnostic?** Build the assertion message to
   name the likely cause. Future-you reading a CI failure shouldn't
   need to step back through the source — the message should say
   "this register has the wrong value because X / look at Y".

## Patterns to avoid

- **Don't probe pixel state.** Visual regression already covers that
  via `opensnes-emu --quick`. Probes are for non-visual properties.
- **Don't depend on memory addresses that aren't in the lib's sym
  files.** WRAM layout drifts; pin probes to symbol names you can
  re-resolve.
- **Don't reuse global state across probes.** Each probe spawns a
  fresh emu; rely on `loadRom` + `runFrames` to reach the state you
  need.

## When this DOESN'T apply

- For per-pixel rendering correctness → `opensnes-emu` visual
  regression.
- For "no compiled ROM crashes" → `opensnes-emu` Runtime Execution
  phase.
- For static signature ↔ ASM offset drift → `devtools/check_asm_abi.py`.

## Related

- `.claude/notes/chantiers/mesen2_rpc_mvp_validated.md` — mesen2-rpc
  Phase 5 acceptance demo (the autonomous-debug infrastructure these
  probes build on)
- `lib/source/hdma.asm` recent commit `c5689f5` — the bug this
  category of test exists to prevent regressing.
- `devtools/check_asm_abi.py` — the static-lint counterpart.
