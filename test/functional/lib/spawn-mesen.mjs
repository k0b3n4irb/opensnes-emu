/**
 * Shared harness for functional probes.
 *
 * Spawns a mesen2-rpc instance (the headless Mesen2 fork at
 * github.com/k0b3n4irb/mesen2-rpc), waits for it to bind its TCP port,
 * connects a Mesen2Client, and returns both so the probe can drive the
 * emulator. Tears the spawn down on shutdown so we don't leak processes.
 *
 * Probes import this and write small `describe`-shaped scenarios. See
 * hdma.test.mjs for the canonical example.
 *
 * Environment overrides:
 *   MESEN_RPC_BIN     path to the Mesen binary    (default: ../Mesen2/bin/.../Mesen)
 *   MESEN_RPC_CLIENT  path to dist/index.js       (default: ../Mesen2/clients/typescript/dist/index.js)
 *   MESEN_RPC_PORT    TCP port to use             (default: 9930 — out of the way of dev servers)
 *
 * Failure modes:
 *   - Binary missing → throws with a clear "build mesen2-rpc first" message.
 *   - Port collision → throws after the bind timeout.
 *   - Mesen crash mid-probe → the next RPC call rejects with "transport not connected".
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as net from "node:net";

const HOME = process.env.HOME ?? "/home/kobenairb";
const DEFAULT_BIN = `${HOME}/workspace/Mesen2/bin/linux-arm64/Release/Mesen`;
const DEFAULT_CLIENT = `${HOME}/workspace/Mesen2/clients/typescript/dist/index.js`;

const BIN = process.env.MESEN_RPC_BIN ?? DEFAULT_BIN;
const CLIENT_PATH = process.env.MESEN_RPC_CLIENT ?? DEFAULT_CLIENT;
const PORT = parseInt(process.env.MESEN_RPC_PORT ?? "9930", 10);

async function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const s = net.createConnection(port, host);
      s.once("connect", () => { s.end(); resolve(true); });
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`mesen-rpc did not bind ${host}:${port} within ${timeoutMs}ms`);
}

/**
 * Spawn a mesen2-rpc on the configured port, connect a Mesen2Client,
 * and return { client, dispose }. Always call dispose() in a finally{}.
 */
export async function spawnMesenRpc() {
  if (!existsSync(BIN)) {
    throw new Error(
      `mesen2-rpc binary not found at ${BIN}.\n` +
      `Build it first:  cd ../../Mesen2 && make\n` +
      `Or set MESEN_RPC_BIN to a working build.`,
    );
  }
  if (!existsSync(CLIENT_PATH)) {
    throw new Error(
      `Mesen2Client not found at ${CLIENT_PATH}.\n` +
      `Build the client:  cd ../../Mesen2/clients/typescript && npm run build`,
    );
  }

  // Lazy import so a missing CLIENT_PATH gives the friendly error above
  // instead of an unhelpful ESM resolution failure.
  const { Mesen2Client } = await import(CLIENT_PATH);

  const child = spawn(BIN, [`--rpc-server=${PORT}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", chunk => {
    // Bubble stderr through prefixed so it's clear what's coming from the emu
    process.stderr.write(`[mesen-rpc] ${chunk.toString().trimEnd()}\n`);
  });

  // Bail early if the spawn died before binding.
  let died = false;
  child.on("exit", () => { died = true; });
  try {
    await waitForPort(PORT, "127.0.0.1", 5000);
  } catch (e) {
    if (died) throw new Error("mesen-rpc exited during startup");
    throw e;
  }

  const client = new Mesen2Client({ port: PORT });
  await client.connect();

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { client.close(); } catch { /* ignore */ }
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 500);
  };

  // Catch unexpected process exits so we don't strand the child.
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
  process.once("beforeExit", dispose);

  return { client, dispose };
}
