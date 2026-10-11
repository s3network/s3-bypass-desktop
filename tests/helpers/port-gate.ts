/**
 * The 10808 gate — why the port-bound suites skip instead of failing.
 *
 * The core supervisor forces the SOCKS inbound onto DEFAULT_SOCKS_PORT when
 * it materializes the profile: `mergeLoopbackInbound` overwrites `port`
 * whatever the profile itself said. A test therefore cannot pick a port of its
 * own — and with the application running, which is the normal state while
 * working on it, 10808 is taken. Every spawn-path case then fails for a reason
 * that has nothing to do with the code under test, which reads as a broken
 * build. Nothing is broken.
 *
 * So the suites skip, and say why. Letting a suite bind an ephemeral port
 * instead would require the supervisor to stop overwriting the profile's port,
 * which changes what users may configure and the error wording they read — a
 * product decision, deliberately not taken here.
 *
 * ── Why the answer is computed in globalSetup, not at file load ─────────────
 * The first version of this probed the port while each test file was being
 * loaded. That races with the suite's own fixtures: vitest loads files in
 * parallel workers, so one file's child process binds 10808 while a sibling
 * file is still evaluating its top-level `await`, which then sees "held" and
 * skips itself. The symptom was a full run reporting eight skipped tests with
 * the port demonstrably free.
 *
 * `globalSetup` runs in the main process before any worker starts, so nothing
 * of ours can be holding the port yet. It settles the question once and hands
 * the verdict to the workers through the environment.
 */
import { connect, createServer } from 'node:net';

/** Env var carrying the verdict from `globalSetup` into the test workers. */
export const PORT_GATE_ENV = 'S3BYPASS_SOCKS_PORT_TAKEN';

/** True when something answers on 127.0.0.1:`port`. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const settle = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** True when we can bind 127.0.0.1:`port` ourselves. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const settle = (free: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    server.once('error', () => settle(false)); // EADDRINUSE — still held
    server.listen({ port, host: '127.0.0.1' }, () => {
      // Close BEFORE resolving so this probe never itself leaks the port.
      server.close(() => settle(true));
    });
  });
}

/**
 * True when something else is already listening on 127.0.0.1:`port`.
 *
 * Both directions are consulted because they answer different questions: a
 * refused connect and a free port look identical from outside, and only one of
 * them means the port is free.
 */
export async function portHeldExternally(port: number): Promise<boolean> {
  if (await canConnect(port)) return true;
  return !(await canBind(port));
}

/** The reason printed by `globalSetup`; kept here so both sides quote it. */
export function portBusySkipMessage(port: number): string {
  return (
    `127.0.0.1:${port} is held by another process — most likely the S3 Bypass ` +
    'Desktop app, which binds the same port by design (FR-15). Close it and ' +
    're-run. Nothing is broken here; those suites simply cannot use a port of their own.'
  );
}

/**
 * The verdict `globalSetup` recorded for this run.
 *
 * Defaults to `false` when the variable is absent: a missing verdict is an
 * anomaly in the harness, and the honest response is to run the tests and let
 * them speak rather than silently skip them. `npm test` always sets it —
 * vitest runs `globalSetup` for every project.
 */
export function socksPortTakenForRun(): boolean {
  return process.env[PORT_GATE_ENV] === '1';
}
