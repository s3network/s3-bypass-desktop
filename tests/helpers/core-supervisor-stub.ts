/**
 * Shared machinery for the M1-14 (RED) supervisor integration batch — stub
 * core binary only (plan R-1: no pinned Xray binary until M2), loopback only,
 * synthetic fixtures (docs/qa/strategy.md §1).
 *
 * Declares the M1-15 contract surface (full text in the header of
 * `tests/unit/core-supervisor.test.ts`): module `src/main/core-supervisor.ts`
 * exporting `createSupervisor(options)` → `start()/stop()/isRunning()`, driven
 * by the existing `src/shared/status-machine.ts` reducer (data-flows §2.3 —
 * the supervisor never duplicates the state list).
 *
 * Loader note: `import(coreSupervisorModule)` takes a NON-LITERAL specifier on
 * purpose — `tests/**` is inside `tsconfig.node.json`'s `include`, so a
 * literal import of the not-yet-existing module would make `npm run typecheck`
 * fail (which must stay exit 0 during RED). At runtime Vitest resolves the
 * relative specifier against this file, so the moment M1-15 creates the module
 * the very same line loads it: absence RED becomes assertion RED with zero
 * test edits (strategy §5.2).
 *
 * This file is a helper, not a suite: `vitest.config.ts` collects only
 * `*.test.ts(x)` under `tests/`.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

import type { OperationResult } from '../../src/shared/ipc';
import type { AppError, CoreState, StatusSnapshot } from '../../src/shared/status-machine';
import { expectHumanError, type WordingRow } from './error-wording';

/** One raw child-output line, delivered line-based (data-flows (b) step 6). */
export interface CoreLogLine {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

/** `createSupervisor` options — all injected, nothing global (plan M1-15). */
export interface SupervisorOptions {
  /** Path to the core executable (the tests point it at `fake-core.sh`). */
  readonly binaryPath: string;
  /** Stored-profile JSON; the supervisor materializes `T` from it (step 3). */
  readonly config: string;
  /** Called on every status-machine transition with the post-transition snapshot. */
  readonly onStateChange: (snapshot: StatusSnapshot) => void;
  /** Receives raw stdout/stderr lines — redaction belongs to the collector (M1-18/19). */
  readonly logSink: (line: CoreLogLine) => void;
}

/** The supervisor instance M1-15 must return from `createSupervisor`. */
export interface CoreSupervisor {
  /** Settles the start sequence: `ok:true` at `running`, documented triple otherwise. */
  start(): Promise<OperationResult>;
  /** Settles at `stopped` (child exited, `T` deleted — FR-16/FR-23). */
  stop(): Promise<OperationResult>;
  /** True while the child process is alive. */
  isRunning(): boolean;
}

/** Module surface QA declares for M1-15 (header-contract style, cf. DV-09/DV-16). */
export interface CoreSupervisorApi {
  createSupervisor(options: SupervisorOptions): CoreSupervisor;
}

/**
 * Non-literal on purpose (see file header): typecheck stays green while
 * `src/main/core-supervisor.ts` does not exist; the runtime resolution is the
 * legitimate *absence RED* reason for this batch (strategy §5.2) — never
 * weaken this path or the tests behind it.
 */
const coreSupervisorModule: string = '../../src/main/core-supervisor';

export async function loadCoreSupervisor(): Promise<CoreSupervisorApi> {
  return (await import(/* @vite-ignore */ coreSupervisorModule)) as CoreSupervisorApi;
}

/** Path to the stub core binary (§9.2 fixture, DV-22). */
export function fakeCorePath(): string {
  return fileURLToPath(new URL('../fixtures/fake-core.sh', import.meta.url));
}

/** Path to the TC-02-05 port occupier (binds and holds 127.0.0.1:10808). */
export function occupyPortPath(): string {
  return fileURLToPath(new URL('../fixtures/occupy-port.mjs', import.meta.url));
}

/** Fixture contract: mode travels on env — the supervisor's argv is `[run, -c, T]`. */
export const FAKE_CORE_ENV_KEYS = [
  'FAKE_CORE_MODE',
  'FAKE_CORE_ARGV_FILE',
  'FAKE_CORE_SIGNAL_FILE',
] as const;

/** Scratch area for one test's argv/signal records (synthetic, removed after). */
export interface Scratch {
  readonly dir: string;
  readonly argvFile: string;
  readonly signalFile: string;
}

const scratchDirs: string[] = [];

export function createScratch(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), 's3bypass-m114-'));
  scratchDirs.push(dir);
  return { dir, argvFile: join(dir, 'argv.log'), signalFile: join(dir, 'signals.log') };
}

export function cleanupScratches(): void {
  for (const dir of scratchDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — a leftover temp dir must not mask the real assertion
    }
  }
}

/** One recorded child invocation: `### pid=<pid>` + one line per argv element. */
export interface Invocation {
  readonly pid: number;
  readonly args: readonly string[];
}

export function readInvocations(argvFile: string): Invocation[] {
  if (!existsSync(argvFile)) return [];
  const out: Array<{ pid: number; args: string[] }> = [];
  let current: { pid: number; args: string[] } | null = null;
  for (const line of readFileSync(argvFile, 'utf8').split('\n')) {
    if (line.startsWith('### pid=')) {
      current = { pid: Number(line.slice('### pid='.length)), args: [] };
      out.push(current);
    } else if (line.startsWith('arg=') && current !== null) {
      current.args.push(line.slice('arg='.length));
    }
  }
  return out;
}

export function readSignals(signalFile: string): string[] {
  if (!existsSync(signalFile)) return [];
  return readFileSync(signalFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Polls `cond` every 10 ms until it holds — the suite's only synchronization
 * primitive: never a fixed sleep as a readiness barrier (fixture spec §9.2).
 * Throws with `what` on timeout so a RED/GREEN failure names its reason.
 */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Emitted states with consecutive duplicates collapsed (§2.3 paths). */
export function distinctStates(snapshots: readonly StatusSnapshot[]): CoreState[] {
  const out: CoreState[] = [];
  for (const snapshot of snapshots) {
    if (out[out.length - 1] !== snapshot.state) out.push(snapshot.state);
  }
  return out;
}

/** True only when the pid is really gone (ESRCH); EPERM means "still exists". */
export function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Best-effort reaper for children a failed test left behind (afterEach safety). */
export async function reapRecordedChildren(argvFiles: readonly string[]): Promise<void> {
  const pids = argvFiles.flatMap((file) =>
    readInvocations(file).map((invocation) => invocation.pid),
  );
  for (const pid of pids) {
    if (!isProcessGone(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // raced with its own exit — nothing to do
      }
    }
  }
}

/** One TCP probe of 127.0.0.1:`port` — true when something accepts the connect. */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const settle = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(500, () => settle(false));
  });
}

/** Polls until the port is listening (`wantListening` true) or free (false). */
export async function waitForPortState(
  port: number,
  wantListening: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    const listening = await probePort(port);
    if (listening === wantListening) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * One bind attempt on 127.0.0.1:`port` — true only when the bind SUCCEEDS,
 * and the probe server is fully closed before resolving. A successful bind is
 * the strongest "free" evidence available: it proves nothing else is listening
 * (so the supervisor's FR-15 connect pre-check would answer "free", never
 * E-IO-003) AND that the next fixture binder (`fake-core.sh`'s node one-liner,
 * `occupy-port.mjs`) can bind. EADDRINUSE (or any refusal) → false.
 */
function bindProbeFree(port: number): Promise<boolean> {
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
      // Bound → free. Close BEFORE resolving so this probe itself never
      // leaks the port into the next step.
      server.close(() => settle(true));
    });
  });
}

/**
 * Waits until 127.0.0.1:`port` is actually free — the suite's port-leak
 * barrier (DV-29). Kills are async at the kernel level: `occupy-port.mjs`
 * dies on SIGKILL asynchronously, and `fake-core.sh`'s binder grandchild may
 * hold the port for up to 1 s after its SIGTERM (`server.close` fallback),
 * i.e. AFTER the shell child already exited and `stop()` resolved. Without
 * this barrier the next test's FR-15 pre-check races the release and answers
 * E-IO-003 where the test correctly expects its own error (observed on slow
 * CI: TC-02-05 → TC-02-10, `E-IO-003` vs `E-CORE-002`).
 *
 * Polling every 25 ms — never a fixed sleep as synchronization (fixture spec
 * §9.2) — bounded by `timeoutMs`; throws with `what` on timeout so a genuine
 * port leak fails the hook/test loudly with its reason instead of silently
 * poisoning the next case. No assertion passes because of this helper: it can
 * only fail earlier and clearer (determinism fix, NOT a weakening — DV-29).
 */
export async function waitForPortFree(
  port: number,
  timeoutMs: number,
  what = `127.0.0.1:${port} to be released`,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await bindProbeFree(port)) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DV-33 — CROSS-file port-owner lock (the DV-29 successor for the ACROSS-file
// race). DV-29's `waitForPortFree` serializes only WITHIN one test file, but
// vitest runs test FILES in parallel workers: `tests/unit/core-supervisor
// .test.ts` and `tests/unit/core-supervisor-hardening.test.ts` BOTH spawn real
// children (and `occupy-port.mjs`) on 127.0.0.1:10808, so a hardening-case
// spawn can lose the bind race to a supervisor-case spawn and surface as an
// EADDRINUSE re-spawn retry (a second child invocation in TC-02-12, D3) or a
// foreign `E-IO-003`/`E-CORE-00x`. Both suites acquire this lock in their
// file-level `beforeEach` and release it at the END of their file-level
// `afterEach`, AFTER the DV-29 port-free barrier — so every lock handoff is a
// FREE-port handoff. All waits are POLL-bounded and jittered (15–24 ms — never
// a fixed sleep). Additive barrier only: no assertion in either file is
// touched; the lock can only fail earlier and clearer (DV-29 rule).
//
// Locking semantics:
//  · acquire   — `writeFileSync(path, pid, { flag: 'wx' })` is O_EXCL-atomic
//    across processes, on EEXIST poll until the holder releases, bounded by
//    `timeoutMs`, then throw naming `what` + the current owner (fail loud —
//    never proceed without the lock). Idempotent per module instance.
//  · release   — unlink only when THIS module instance holds the lock (in-
//    memory flag) and the bytes on disk are still our own pid line; runs in
//    `afterEach`'s `finally`, so a failing test/cleanup can never wedge the
//    other suite on a forgotten lock. Idempotent.
//  · stale takeover — the lock is stale when (a) its pid no longer exists
//    (ESRCH: crashed worker), (b) it names OUR pid but not this module
//    instance (leftover of an EARLIER file in the same vitest worker — module
//    isolation resets the in-memory flag, the pid does not), or (c) its age
//    exceeds the stale bound (pid-reuse / corrupt-content guard; unparsable
//    content gets a short grace so a half-written atomic create is never
//    stolen). The bytes are re-read immediately before `unlink` so a fresh
//    lock created in the meantime is respected (TOCTOU window ≈ microseconds).
// ─────────────────────────────────────────────────────────────────────────────

/** Lock-file path for one port (os.tmpdir()-scoped, shared across processes). */
export function portLockPath(port: number): string {
  return join(tmpdir(), `.port-${port}.lock`);
}

/**
 * Acquisition bound: must outlast the longest legitimate hold — one test
 * (≤ 30 s budget) plus its `afterEach` (≤ 10 s hook) — with a wide margin for
 * queuing behind the other suite's tests and for concurrent runs.
 */
export const PORT_LOCK_TIMEOUT_MS = 120_000;

/** `beforeEach` hook timeout for the acquisition (must exceed the bound above). */
export const PORT_LOCK_HOOK_TIMEOUT_MS = PORT_LOCK_TIMEOUT_MS + 30_000;

/** A live holder cannot legitimately hold longer than test+hook — older = stale. */
const PORT_LOCK_STALE_MS = 180_000;

/** Unparsable content younger than this may be an in-flight atomic create. */
const PORT_LOCK_GRACE_MS = 10_000;

/** Poll cadence while waiting: 15–24 ms jittered — never a fixed sleep. */
const PORT_LOCK_POLL_MIN_MS = 15;
const PORT_LOCK_POLL_JITTER_MS = 10;

/** Ports whose lock THIS module instance (this test file) currently owns. */
const portLocksHeld = new Set<number>();

interface PortLockSnapshot {
  /** File bytes as read — the identity used to keep takeover windows tiny. */
  readonly raw: string;
  /** Parsed holder pid, or null when the content is unreadable/corrupt. */
  readonly pid: number | null;
  readonly ageMs: number;
}

/** Reads the lock file; null when absent (or raced away). Never throws. */
function readPortLock(port: number): PortLockSnapshot | null {
  const path = portLockPath(port);
  try {
    const raw = readFileSync(path, 'utf8');
    const ageMs = Date.now() - statSync(path).mtimeMs;
    const pid = Number(raw.trim());
    return { raw, pid: Number.isInteger(pid) && pid > 0 ? pid : null, ageMs };
  } catch {
    return null;
  }
}

/** True only when a process with this pid exists (EPERM = exists, not ours). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The three stale rules — see the DV-33 header block above. */
function isStaleLock(snapshot: PortLockSnapshot, port: number): boolean {
  if (snapshot.pid === process.pid && !portLocksHeld.has(port)) return true; // leftover in this worker
  if (snapshot.pid !== null && !processExists(snapshot.pid)) return true; // holder crashed/exited
  if (snapshot.ageMs > PORT_LOCK_STALE_MS) return true; // pid-reuse / corrupt-content guard
  if (snapshot.pid === null && snapshot.ageMs > PORT_LOCK_GRACE_MS) return true; // unreadable leftover
  return false;
}

/**
 * Cross-file mutex for tests that spawn a real child on 127.0.0.1:`port`.
 * Poll-bounded: throws with `what` (+ the current owner) on timeout so a
 * genuine deadlock fails loudly with its reason instead of hanging a hook.
 */
export async function acquirePortLock(
  port: number,
  timeoutMs: number,
  what: string,
): Promise<void> {
  if (portLocksHeld.has(port)) return; // idempotent — one owner per module instance
  const path = portLockPath(port);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: 'wx' });
      portLocksHeld.add(port);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = readPortLock(port);
    let retryNow = false;
    if (held !== null && isStaleLock(held, port)) {
      // Re-read right before unlink: only remove the lock if its bytes are
      // still the ones judged stale — a fresh lock created meanwhile is
      // respected, never clobbered.
      const still = readPortLock(port);
      if (still !== null && still.raw === held.raw) {
        try {
          unlinkSync(path);
          retryNow = true;
        } catch (error) {
          // ENOENT → already gone, retry at once; anything else → bounded wait.
          retryNow = (error as NodeJS.ErrnoException).code === 'ENOENT';
        }
      }
    }
    if (Date.now() >= deadline) {
      const owner = readPortLock(port);
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${what} — lock ${path} owned by ` +
          `pid ${owner?.pid ?? 'unreadable'}`,
      );
    }
    if (retryNow) continue;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        PORT_LOCK_POLL_MIN_MS + Math.floor(Math.random() * PORT_LOCK_POLL_JITTER_MS),
      ),
    );
  }
}

/**
 * Releases the lock this module instance acquired (idempotent). Unlinks only
 * when the bytes on disk are still our own pid line — a lock a stale-taker
 * replaced is left alone; an unlink failure is reclaimed later through the
 * dead-pid rule (the pid dies with the worker).
 */
export function releasePortLock(port: number): void {
  if (!portLocksHeld.has(port)) return;
  portLocksHeld.delete(port);
  const path = portLockPath(port);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // already released (or never persisted)
  }
  if (raw !== `${process.pid}\n`) return; // replaced meanwhile — leave the new owner's lock
  try {
    unlinkSync(path);
  } catch {
    // best effort — the dead-pid stale rule reclaims it if this pid never dies cleanly
  }
}

/**
 * NFR-3 tolerance for "reflected within 1 s" (docs/qa/strategy.md §7):
 * 1000 ms locally, 3000 ms under CI — measured from the API call, which is a
 * superset of the spec's "from the process event" and therefore stricter.
 */
export function nfr3BudgetMs(): number {
  return process.env.CI === undefined ? 1000 : 3000;
}

/** Rows for the shared NFR-5 contract (errors.md §0) asserted by this batch. */
export type WordingFields = Pick<WordingRow, 'code' | 'trigger' | 'title' | 'cause' | 'nextStep'>;

/**
 * Runs the shared `expectHumanError` contract (strategy §7) over a triple the
 * supervisor produced — the M1-14 growth of the TC-NFR5-01 wording table
 * (rows live beside their supervisor trigger, see §14 DV-24).
 */
export function expectNfr5Triple(error: AppError, row: WordingFields, context: string): void {
  expectHumanError({ id: context, ...row, run: async () => error }, error);
  expect(error.code, `${context}: the triple must carry a documented errors.md code (§0)`).toMatch(
    /^E-(VAL|IO|CORE|PLAT|STOR)-\d{3}$/,
  );
}
