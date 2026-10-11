/**
 * M1-14 (RED) — core supervisor integration tests against a stub core binary.
 *
 * Test plan IDs: TC-02-01, TC-02-02, TC-02-04, TC-02-05, TC-02-06, TC-02-07,
 * TC-02-10, TC-02-11, TC-02-12, TC-02-13, TC-02-14, TC-07-05 (lifecycle half),
 * TC-07-15, TC-NFR3-02 — docs/qa/m1-test-plan.md §2/§7/§8, the M1-14 row in
 * §10, allocations DV-22..DV-24 in §14.
 *
 * Spec sources: docs/analysis/data-flows.md flow (b) §2.1–§2.3 (supervision
 * sequence + state machine); docs/analysis/requirements.md F3 (FR-13..FR-23),
 * PR-08 (spawn with arg arrays, never a shell); docs/analysis/errors.md §0
 * (NFR-5 triple), §2/§3 (E-IO-003/004, E-CORE-001/002), §6 (recovery matrix:
 * child reaped, T deleted); docs/plans/m1-mvp.md M1-14/M1-15 (risk R-1 →
 * stub binary); docs/qa/strategy.md §5.1 (RED reasons), §7 (NFR-3 tolerances).
 *
 * Layer: L2 integration with REAL child processes (strategy §2) — no Electron,
 * no mocks: the supervisor is pinned as PURE node (child_process + injected
 * callbacks, no `electron` import — enforced structurally by TC-02-14's
 * sibling) precisely so this suite runs unmocked in node env on macOS and
 * Linux CI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT FOR M1-15 (declared here — header-contract style, cf. DV-09/DV-16/
 * DV-20; any deviation requires an upstream spec note first, strategy §5.2):
 *
 *  module  : src/main/core-supervisor.ts   — pure node, NO electron import
 *  export  : createSupervisor(options: SupervisorOptions): CoreSupervisor
 *
 *  SupervisorOptions {
 *    binaryPath : string          // core executable (tests: fake-core.sh)
 *    config     : string          // stored-profile JSON — input of
 *                                 // materialization (data-flows (b) step 3)
 *    onStateChange(snapshot: StatusSnapshot): void   // every transition of the
 *                                 // EXISTING src/shared/status-machine.ts
 *                                 // reducer (§2.3) — never a duplicated state
 *                                 // list; NO initial emission: the first
 *                                 // callback is the `stopped → starting` one
 *    logSink(line: CoreLogLine): void  // RAW, line-based child output
 *                                 // { stream: 'stdout'|'stderr', text } —
 *                                 // redaction/buffering belong to M1-18/19
 *  }
 *  CoreSupervisor {
 *    start(): Promise<OperationResult>  // settles the start sequence: resolves
 *                                 // { ok: true } once state === 'running'
 *                                 // (FR-13), or { ok: false, error: AppError }
 *                                 // with the documented errors.md triple when
 *                                 // the sequence fails (FR-14/15/17/20)
 *    stop(): Promise<OperationResult>   // resolves { ok: true } at `stopped`
 *                                 // (child exited, T deleted — FR-16/FR-23)
 *    isRunning(): boolean               // child process currently alive
 *  }
 *
 *  Behavior pinned below (data-flows (b)):
 *  1. start() pre-checks, in order, BEFORE any transition (state stays
 *     `stopped`, nothing spawns, NO emissions):
 *       · binary exists             → else { ok:false, E-IO-004 }  (FR-14)
 *       · port 10808 free           → else { ok:false, E-IO-003 }  (FR-15)
 *       · state ∈ {stopped,crashed} → else { ok:false, E-VAL-017 } (FR-18)
 *  2. state → `starting`; materialize T from `config`: merge the app-owned
 *     inbound (listen 127.0.0.1:10808), resolve relative paths from T's dir
 *     (FR-22), write mode 0600, never log the path (FR-23).
 *  3. spawn(binaryPath, ['run', '-c', T]) — the EXACT documented arg array,
 *     no shell (PR-08, step 4); the child inherits process.env (fixture
 *     contract: FAKE_CORE_* travels on env because argv is [run, -c, T]).
 *  4. readiness = TCP connect 127.0.0.1:10808 (FR-21/A-12) within 10 s
 *     (FR-20): ok → `running`; timeout → kill child, `crashed`, E-CORE-002.
 *  5. child stdout/stderr split line-by-line → logSink (step 6).
 *  6. exit watcher: nonzero exit → `crashed` + E-CORE-001 (cause names the
 *     exit code AND the last core line — here the stub's stderr diagnostic);
 *     requested stop → `stopping` → `stopped`, exit code ignored (A-13).
 *  7. stop(): `stopping` emitted → SIGTERM (2 s budget → SIGKILL, FR-16) →
 *     child exit observed → T deleted → `stopped` emitted.
 *  8. crash paths reap the child and delete T (errors.md §6).
 *
 * Fixture: tests/fixtures/fake-core.sh — modes sleep/ready, chatty, fail/
 * exit-nonzero, silent (§9.2 as shipped, DV-22); argv + signal recording via
 * FAKE_CORE_ARGV_FILE / FAKE_CORE_SIGNAL_FILE; mode via FAKE_CORE_MODE.
 *
 * Environment prerequisite (recorded in §14 DV-24): 127.0.0.1:10808 must be
 * free for the spawn-path cases — FR-15 refuses Start while it is held. The
 * RED run below is unaffected (absence RED fires before any port interaction).
 *
 * Cross-file determinism (§14 DV-33): this file and core-supervisor-hardening
 * .test.ts BOTH bind 127.0.0.1:10808 with REAL children while vitest runs
 * test FILES in parallel workers, so DV-29's barriers (WITHIN this file) are
 * not enough — a lockfile barrier (os.tmpdir()/.port-10808.lock, the
 * file-level `beforeEach`/`afterEach` below) serializes the two suites
 * ACROSS files. Barrier/setup addition only: zero assertions touched.
 *
 * RED status: ABSENCE RED — `src/main/core-supervisor.ts` does not exist; every
 * behavioral case fails through `loadCoreSupervisor()` (dynamic import of a
 * NON-LITERAL specifier so `npm run typecheck` stays exit 0 — see the helper
 * header) and both structural cases through their explicit `existsSync` gate.
 * Strategy §5.2: legitimate first-test-of-a-subsystem failure; do not weaken,
 * skip, or delete.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SOCKS_PORT } from '../../src/shared/constants';
import type { CoreState, StatusSnapshot } from '../../src/shared/status-machine';
import {
  acquirePortLock,
  cleanupScratches,
  type CoreLogLine,
  type CoreSupervisor,
  createScratch,
  distinctStates,
  expectNfr5Triple,
  FAKE_CORE_ENV_KEYS,
  fakeCorePath,
  type Invocation,
  isProcessGone,
  loadCoreSupervisor,
  nfr3BudgetMs,
  occupyPortPath,
  PORT_LOCK_HOOK_TIMEOUT_MS,
  PORT_LOCK_TIMEOUT_MS,
  readInvocations,
  readSignals,
  reapRecordedChildren,
  releasePortLock,
  type Scratch,
  waitFor,
  waitForPortFree,
  waitForPortState,
} from '../helpers/core-supervisor-stub';
import { expectHumanWording } from '../helpers/error-wording';
import { socksPortTakenForRun } from '../helpers/port-gate';
import { readConfigFixture } from '../helpers/profile-validator-stub';
import { tripleText } from '../helpers/secret-store-stub';

const CORE_SUPERVISOR_SOURCE = fileURLToPath(
  new URL('../../src/main/core-supervisor.ts', import.meta.url),
);

/** One test's observable surface: state transitions, sink lines, child records. */
interface Rig {
  readonly supervisor: CoreSupervisor;
  readonly scratch: Scratch;
  readonly snapshots: StatusSnapshot[];
  readonly stamps: Array<{ state: CoreState; at: number }>;
  readonly sink: CoreLogLine[];
  states(): CoreState[];
  invocations(): Invocation[];
  signals(): string[];
}

const rigs: Rig[] = [];
const scratchArgvFiles: string[] = [];
let occupant: ChildProcess | null = null;

const ENV_ORIGINAL = Object.fromEntries(
  FAKE_CORE_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;

function restoreFakeEnv(): void {
  for (const key of FAKE_CORE_ENV_KEYS) {
    const value = ENV_ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// DV-33 cross-file port barrier (m1-test-plan §14): this file and
// core-supervisor-hardening.test.ts both spawn REAL children (and
// occupy-port.mjs) on 127.0.0.1:10808 while vitest runs test FILES in
// parallel workers — DV-29's waitForPortFree serializes only WITHIN a file.
// Acquire the lockfile mutex before every test here; it is released at the
// END of the afterEach below (after the DV-29 port-free barrier), so every
// handoff to the other suite is a FREE-port handoff. Failure is loud and
// named — never a silent skip, never an assertion change (DV-33).
beforeEach(async () => {
  await acquirePortLock(
    DEFAULT_SOCKS_PORT,
    PORT_LOCK_TIMEOUT_MS,
    'the DV-33 cross-file lock for 127.0.0.1:10808 (held by the other supervisor suite)',
  );
}, PORT_LOCK_HOOK_TIMEOUT_MS);

afterEach(async () => {
  try {
    for (const rig of rigs) {
      try {
        if (rig.supervisor.isRunning()) await rig.supervisor.stop();
      } catch {
        // best effort — a failed cleanup stop must not mask the real failure
      }
    }
    rigs.length = 0;
    if (occupant !== null) {
      occupant.kill('SIGKILL');
      occupant = null;
    }
    await reapRecordedChildren(scratchArgvFiles);
    scratchArgvFiles.length = 0;
    // DV-29 port barrier: every holder released above is released ASYNCHRONOUSLY
    // at the kernel level — the SIGKILLed occupy-port.mjs, the SIGKILLed shell,
    // and especially the fake-core binder GRANDCHILD (up to 1 s of server.close
    // fallback after its SIGTERM, i.e. after stop() already resolved). Wait until
    // 127.0.0.1:10808 is actually free so no test can inherit a held port and
    // fail its FR-15 pre-check with a foreign E-IO-003 (CI run 37594647160:
    // TC-02-05 → TC-02-10). Polling, never a fixed sleep; bounded — a real leak
    // fails here loudly instead of poisoning the next case.
    await waitForPortFree(
      DEFAULT_SOCKS_PORT,
      5000,
      'afterEach cleanup: 127.0.0.1:10808 released by the finished test',
    );
    restoreFakeEnv();
    cleanupScratches();
  } finally {
    // DV-33: release only AFTER the barrier above proved 127.0.0.1:10808 free
    // (or after a genuine leak already failed this hook loudly) — in `finally`
    // so a failing test can never wedge the other suite on a forgotten lock.
    releasePortLock(DEFAULT_SOCKS_PORT);
  }
});

/**
 * Builds a supervisor wired to recorders instead of Electron: every emitted
 * `StatusSnapshot`, a timestamp per emission (NFR-3 measurements), and every
 * raw sink line. The mode travels on env (the argv is spec-fixed to
 * [run, -c, T]); synchronization is polling via `waitFor` — never a fixed
 * sleep as a readiness barrier.
 */
async function createRig(
  scenario: { mode?: string; config?: string; binaryPath?: string } = {},
): Promise<Rig> {
  const scratch = createScratch();
  scratchArgvFiles.push(scratch.argvFile);
  process.env.FAKE_CORE_MODE = scenario.mode ?? 'sleep';
  process.env.FAKE_CORE_ARGV_FILE = scratch.argvFile;
  process.env.FAKE_CORE_SIGNAL_FILE = scratch.signalFile;

  const api = await loadCoreSupervisor(); // ABSENCE RED stops here (strategy §5.1)
  if (typeof api.createSupervisor !== 'function') {
    throw new Error(
      'src/main/core-supervisor.ts must export createSupervisor(options) — ' +
        'M1-15 GREEN implements the M1-14 contract',
    );
  }

  const snapshots: StatusSnapshot[] = [];
  const stamps: Array<{ state: CoreState; at: number }> = [];
  const sink: CoreLogLine[] = [];
  const supervisor = api.createSupervisor({
    binaryPath: scenario.binaryPath ?? fakeCorePath(),
    config: scenario.config ?? readConfigFixture('valid-client-config.json'),
    onStateChange: (snapshot) => {
      snapshots.push(snapshot);
      stamps.push({ state: snapshot.state, at: Date.now() });
    },
    logSink: (line) => {
      sink.push(line);
    },
  });

  const rig: Rig = {
    supervisor,
    scratch,
    snapshots,
    stamps,
    sink,
    states: () => distinctStates(snapshots),
    invocations: () => readInvocations(scratch.argvFile),
    signals: () => readSignals(scratch.signalFile),
  };
  rigs.push(rig);
  return rig;
}

/** The materialized config path T, recovered from the child's recorded argv. */
function materializedConfigPath(rig: Rig): string {
  const invocation = rig.invocations()[0];
  if (invocation === undefined) {
    throw new Error('no child invocation recorded — spawn never happened (flow (b) step 4)');
  }
  const cIndex = invocation.args.indexOf('-c');
  const path = cIndex === -1 ? undefined : invocation.args[cIndex + 1];
  if (path === undefined) {
    throw new Error(
      `argv is not the documented [run, -c, T] array (flow (b) step 4, PR-08): ` +
        JSON.stringify(invocation.args),
    );
  }
  return path;
}

function readMaterialized(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** The fedarisha outbound's `settings.storage` block of a parsed config. */
function fedarishaStorage(config: Record<string, unknown>): Record<string, unknown> {
  const outbounds = config['outbounds'];
  const proxy = Array.isArray(outbounds)
    ? (outbounds.find((entry) => (entry as Record<string, unknown>)['protocol'] === 'fedarisha') as
        Record<string, unknown> | undefined)
    : undefined;
  const storage = (proxy?.['settings'] as Record<string, unknown> | undefined)?.['storage'];
  if (typeof storage !== 'object' || storage === null) {
    throw new Error('materialized config lost the fedarisha storage block');
  }
  return storage as Record<string, unknown>;
}

function firstPid(rig: Rig): number {
  const invocation = rig.invocations()[0];
  if (invocation === undefined) {
    throw new Error('no child invocation recorded — spawn never happened');
  }
  return invocation.pid;
}

/**
 * Skip these suites when 127.0.0.1:10808 is already taken by something
 * outside the suite — most often the running application.
 *
 * mergeLoopbackInbound writes DEFAULT_SOCKS_PORT into the materialized
 * profile whatever the profile itself said, so a suite cannot choose a port
 * of its own. With the app open — the normal state while working on it —
 * every spawn-path case fails for a reason unrelated to the code under test.
 * Two dozen red tests read as a defect; a skip that names its cause does not.
 *
 * The verdict itself is computed in tests/global-setup.ts, before any worker
 * exists, and arrives here through the environment. Probing at this point
 * instead would race the suite's own fixtures.
 */
const PORT_TAKEN = socksPortTakenForRun();

describe.skipIf(PORT_TAKEN)(
  'supervisor — spawn → running (FR-13, FR-21; data-flows (b) steps 2–5)',
  () => {
    it('supervisor.start.validProfileSpawnsCoreRunningWithin1s', async () => {
      const rig = await createRig();
      // DV-29 defensive barrier: the spawn path needs a genuinely free
      // 127.0.0.1:10808 (FR-15) — a leak from anywhere before this test must
      // surface HERE with a named reason, not as a confusing E-IO-003 start().
      await waitForPortFree(
        DEFAULT_SOCKS_PORT,
        5000,
        'TC-02-01: 127.0.0.1:10808 free before start()',
      );
      const startedAt = Date.now();
      const result = await rig.supervisor.start();
      const elapsed = Date.now() - startedAt;

      expect(
        result.ok,
        `TC-02-01/FR-13: start() must settle ok:true at running — got ${JSON.stringify(result)}`,
      ).toBe(true);
      expect(
        rig.states(),
        'TC-02-01/§2.3: the emitted path must be stopped → starting → running, in that order',
      ).toEqual(['starting', 'running']);
      expect(
        rig.supervisor.isRunning(),
        'TC-02-01: the core child must be alive while running',
      ).toBe(true);
      const last = rig.snapshots[rig.snapshots.length - 1];
      expect(
        last?.lastError ?? null,
        '§2.3: lastError is cleared only on the successful transition to running',
      ).toBeNull();
      expect(
        elapsed,
        `TC-02-01/FR-13/NFR-3: ` +
          `running within ${nfr3BudgetMs()} ms of the start call (strategy §7 tolerance)`,
      ).toBeLessThanOrEqual(nfr3BudgetMs());
    }, 15_000);

    it('supervisor.spawn.argvRunWithConfigPathAndMergedLoopbackInbound', async () => {
      // The profile deliberately has NO inbound: the loopback SOCKS listener
      // must be merged by the supervisor's materialization (flow (b) step 3).
      const profile = JSON.parse(readConfigFixture('valid-client-config.json')) as Record<
        string,
        unknown
      >;
      delete profile['inbounds'];
      const rig = await createRig({ config: JSON.stringify(profile) });

      const result = await rig.supervisor.start();
      expect(
        result.ok,
        `TC-02-12: start() must settle ok:true at running — got ${JSON.stringify(result)}`,
      ).toBe(true);

      const invocations = rig.invocations();
      expect(invocations.length, 'TC-02-12/FR-18: exactly one child invocation').toBe(1);
      const invocation = invocations[0];
      if (invocation === undefined) throw new Error('unreachable: assertion above failed');

      expect(
        invocation.args.slice(0, 2),
        'TC-02-12/flow (b) step 4 + PR-08: the documented argv prefix [run, -c, …]',
      ).toEqual(['run', '-c']);
      expect(
        invocation.args.length,
        'TC-02-12: the arg array is exactly [run, -c, T] — no shell string, no extra tokens',
      ).toBe(3);

      const tPath = materializedConfigPath(rig);
      expect(existsSync(tPath), 'TC-02-12/step 3: T must be materialized before spawn').toBe(true);

      const materialized = readMaterialized(tPath);
      const inbounds = materialized['inbounds'];
      const socks = Array.isArray(inbounds)
        ? (inbounds.find((entry) => (entry as Record<string, unknown>)['protocol'] === 'socks') as
            Record<string, unknown> | undefined)
        : undefined;
      expect(
        socks,
        'TC-02-12/step 3: the app-owned SOCKS inbound must be merged into T even though ' +
          'the profile carried none',
      ).toBeDefined();
      expect(socks?.['listen'], 'loopback-only inbound (BR-V-09, flow (b) step 3)').toBe(
        '127.0.0.1',
      );
      expect(
        socks?.['port'],
        'TC-02-12: the merged inbound must listen on DEFAULT_SOCKS_PORT (10808)',
      ).toBe(DEFAULT_SOCKS_PORT);

      await rig.supervisor.stop();
    }, 15_000);

    it('supervisor.config.sessionsDirPassesThroughVerbatim', async () => {
      // The §9.1 canary config carries the relative sessionsDir "sessions".
      // FR-22 (amended, issue #23): sessionsDir is the fedarisha session-rendezvous
      // S3 key prefix, NOT a filesystem path — materialization passes it through
      // verbatim; rewriting it to an absolute local path breaks the relay handshake.
      const rig = await createRig();
      const result = await rig.supervisor.start();
      expect(result.ok, `TC-02-11: start failed — ${JSON.stringify(result)}`).toBe(true);

      const tPath = materializedConfigPath(rig);
      const storage = fedarishaStorage(readMaterialized(tPath));
      expect(
        storage['sessionsDir'],
        'TC-02-11/FR-22 (amended, issue #23): sessionsDir must pass through materialization ' +
          'verbatim (relative relay prefix), never rewritten to an absolute local path',
      ).toBe('sessions');

      await rig.supervisor.stop();
    }, 15_000);

    it('secretStorage.coreConfigFile.mode0600DeletedOnStop', async () => {
      const rig = await createRig();
      const result = await rig.supervisor.start();
      expect(result.ok, `TC-07-05: start failed — ${JSON.stringify(result)}`).toBe(true);

      const tPath = materializedConfigPath(rig);
      const mode = statSync(tPath).mode & 0o777;
      expect(mode, `TC-07-05/FR-23: T must be written mode 0600 — got 0${mode.toString(8)}`).toBe(
        0o600,
      );

      await rig.supervisor.stop();
      expect(existsSync(tPath), 'TC-07-05/FR-23: T must be deleted on stop').toBe(false);
    }, 15_000);

    it('secretStorage.coreConfigPath.neverAppearsInLogs', async () => {
      const rig = await createRig();
      const result = await rig.supervisor.start();
      expect(result.ok, `TC-07-15: start failed — ${JSON.stringify(result)}`).toBe(true);
      const tPath = materializedConfigPath(rig);

      await rig.supervisor.stop();

      const surfaced = [
        ...rig.sink.map((line) => line.text),
        ...rig.snapshots.map((snapshot) =>
          snapshot.lastError === null ? '' : tripleText(snapshot.lastError),
        ),
      ];
      expect(
        surfaced.some((text) => text.includes(tPath)),
        'TC-07-15/FR-23/NFR-1: the materialized config path must never appear in log ' +
          'lines or lastError',
      ).toBe(false);
    }, 15_000);

    it('supervisor.start.doubleClick.singleChildProcess', async () => {
      const rig = await createRig();
      const result = await rig.supervisor.start();
      expect(result.ok, `TC-02-07: first start failed — ${JSON.stringify(result)}`).toBe(true);
      const before = rig.invocations().length;

      const second = await rig.supervisor.start();
      expect(
        second.ok,
        'TC-02-07/FR-18: a second Start while running must be rejected by the state machine',
      ).toBe(false);
      if (!second.ok) {
        expect(
          second.error.code,
          'TC-02-07/FR-18: the rejection carries the status machine’s invalid-transition ' +
            'code (E-VAL-017 since M3-A — was mislabelled E-VAL-015, errors.md §1 amendment)',
        ).toBe('E-VAL-017');
        expectHumanWording('TC-02-07 (errors.md §1, E-VAL-017)', second.error);
      }

      // Poll for the absence of a second spawn rather than sleeping and hoping.
      await waitFor(
        () => rig.invocations().length > before,
        400,
        'a second child spawn (FR-18: must never happen)',
      ).catch(() => {
        // timeout is the desired outcome — exactly one child, asserted below
      });
      expect(rig.invocations().length, 'TC-02-07/FR-18: exactly ONE child process').toBe(before);
      expect(
        rig.states(),
        'TC-02-07: the rejected start must not emit a second starting transition',
      ).toEqual(['starting', 'running']);

      await rig.supervisor.stop();
    }, 15_000);
  },
);

describe.skipIf(PORT_TAKEN)('supervisor — stop (FR-16, A-13; data-flows (b) steps 7–8)', () => {
  it('supervisor.stop.terminatesChildPortFreeNoOrphan', async () => {
    const rig = await createRig();
    const startResult = await rig.supervisor.start();
    expect(startResult.ok, `TC-02-02: start failed — ${JSON.stringify(startResult)}`).toBe(true);
    const pid = firstPid(rig);

    const result = await rig.supervisor.stop();
    expect(
      result.ok,
      `TC-02-02/FR-16: stop() must settle ok:true at stopped — ${JSON.stringify(result)}`,
    ).toBe(true);
    expect(
      rig.states(),
      'TC-02-02/§2.3: the emitted path must be running → stopping → stopped',
    ).toEqual(['starting', 'running', 'stopping', 'stopped']);

    await waitFor(
      () => rig.signals().includes('TERM'),
      2000,
      'the stub to record a delivered SIGTERM (FR-16)',
    );
    expect(
      isProcessGone(pid),
      `TC-02-02/FR-16 + errors §6: child ${pid} must be reaped — no zombie remains`,
    ).toBe(true);
    expect(rig.supervisor.isRunning(), 'TC-02-02: isRunning() false after stop').toBe(false);
    expect(
      await waitForPortState(DEFAULT_SOCKS_PORT, false, 2000),
      'TC-02-02/FR-16: port 10808 must stop listening within 2 s of stop',
    ).toBe(true);
  }, 15_000);

  it('supervisor.statusReflectedWithin1sOfProcessEvent', async () => {
    const rig = await createRig();

    const startCallAt = Date.now();
    const startResult = await rig.supervisor.start();
    expect(startResult.ok, `TC-NFR3-02: start failed — ${JSON.stringify(startResult)}`).toBe(true);
    const runningStamp = rig.stamps.find((stamp) => stamp.state === 'running');
    if (runningStamp === undefined) {
      throw new Error('TC-NFR3-02: start() settled without emitting running');
    }
    expect(
      runningStamp.at - startCallAt,
      `TC-NFR3-02/NFR-3: start reflected within ${nfr3BudgetMs()} ms (measured from the ` +
        'API call — a superset of the spec’s "from the process event")',
    ).toBeLessThanOrEqual(nfr3BudgetMs());

    const stopCallAt = Date.now();
    const stopResult = await rig.supervisor.stop();
    expect(stopResult.ok, `TC-NFR3-02: stop failed — ${JSON.stringify(stopResult)}`).toBe(true);
    const stoppedStamps = rig.stamps.filter((stamp) => stamp.state === 'stopped');
    const lastStopped = stoppedStamps[stoppedStamps.length - 1];
    if (lastStopped === undefined) {
      throw new Error('TC-NFR3-02: stop() settled without emitting stopped');
    }
    expect(
      lastStopped.at - stopCallAt,
      `TC-NFR3-02/NFR-3: stop reflected within ${nfr3BudgetMs()} ms`,
    ).toBeLessThanOrEqual(nfr3BudgetMs());
  }, 15_000);
});

describe.skipIf(PORT_TAKEN)('supervisor — crash (FR-17, errors.md §3/§6)', () => {
  it('supervisor.crash.nonzeroExit.goesCoreCrashedWithExitCode', async () => {
    const rig = await createRig({ mode: 'fail' });
    const result = await rig.supervisor.start();

    expect(result.ok, 'TC-02-06/FR-17: a nonzero child exit must settle start() as a failure').toBe(
      false,
    );
    if (result.ok) throw new Error('unreachable: assertion above failed');
    const error = result.error;

    expectNfr5Triple(
      error,
      {
        code: 'E-CORE-001',
        trigger: 'fake-core.sh --mode=fail (stderr diagnostic, then exit 3)',
        title: 'The tunnel stopped unexpectedly',
        cause: 'The tunnel engine exited with code',
        nextStep: 'Click Start to try again',
      },
      'TC-02-06 (errors.md §3, E-CORE-001)',
    );
    expectHumanWording('TC-02-06 (errors.md §3, E-CORE-001)', error);
    expect(error.cause, 'TC-02-06/FR-17: the cause must name the actual exit code 3').toMatch(
      /exited with code 3\b/,
    );
    expect(
      error.cause,
      'TC-02-06/FR-17: lastError must carry the stub’s stderr diagnostic as the last core line',
    ).toContain('simulated fatal storage failure');

    const states = rig.states();
    expect(states[0], 'TC-02-06: the crash path starts at starting').toBe('starting');
    expect(states[states.length - 1], 'TC-02-06/§2.3: the path ends at crashed').toBe('crashed');
    for (const state of states) {
      expect(
        ['starting', 'running', 'crashed'],
        `TC-02-06/§2.3: crash enters only from starting or running — got ${states.join(' → ')}`,
      ).toContain(state);
    }
    const last = rig.snapshots[rig.snapshots.length - 1];
    expect(last?.state, 'TC-02-06: the final emitted snapshot is crashed').toBe('crashed');
    expect(
      last?.lastError?.code,
      'TC-02-06/§2.3: the crashed snapshot carries lastError (M1-16 exposes exactly this)',
    ).toBe('E-CORE-001');

    expect(
      isProcessGone(firstPid(rig)),
      'TC-02-06/errors §6: the crashed child must be reaped — no zombie',
    ).toBe(true);
    const tPath = materializedConfigPath(rig);
    expect(existsSync(tPath), 'TC-02-06/errors §6: T must be deleted on crash').toBe(false);
    expect(rig.supervisor.isRunning(), 'TC-02-06: nothing is running after a crash').toBe(false);
  }, 15_000);

  it('supervisor.output.stdoutAndStderrForwardedLineBasedToLogSink', async () => {
    const rig = await createRig({ mode: 'chatty' });
    const result = await rig.supervisor.start();
    expect(result.ok, `TC-02-13: start failed — ${JSON.stringify(result)}`).toBe(true);

    const hasLine = (stream: 'stdout' | 'stderr', text: string): boolean =>
      rig.sink.some((line) => line.stream === stream && line.text === text);
    await waitFor(
      () =>
        hasLine('stdout', 'READY') &&
        hasLine('stdout', 'fake-core: stdout line 2') &&
        hasLine('stderr', 'fake-core: stderr line 2'),
      5000,
      'every chatty line to reach the log sink (flow (b) step 6)',
    );

    const expected: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [
      { stream: 'stdout', text: 'READY' },
      { stream: 'stdout', text: 'fake-core: stdout line 1' },
      { stream: 'stdout', text: 'fake-core: stdout line 2' },
      { stream: 'stderr', text: 'fake-core: stderr line 1' },
      { stream: 'stderr', text: 'fake-core: stderr line 2' },
    ];
    for (const want of expected) {
      expect(
        hasLine(want.stream, want.text),
        `TC-02-13/data-flows (b) step 6: the sink must receive ${want.stream} line ` +
          `${JSON.stringify(want.text)} as its own entry — got ` +
          JSON.stringify(rig.sink.map((line) => `${line.stream}:${line.text}`)),
      ).toBe(true);
    }
    expect(
      rig.sink.every((line) => !line.text.includes('\n')),
      'TC-02-13: line-based forwarding — one sink entry per output line, never a raw chunk',
    ).toBe(true);

    await rig.supervisor.stop();
  }, 15_000);
});

describe.skipIf(PORT_TAKEN)('supervisor — start failures (FR-14, FR-15, FR-20)', () => {
  it('supervisor.start.binaryMissing.noSpawnClearIntegrityError', async () => {
    const missingDir = createScratch(); // only its path is used — nothing is written
    const rig = await createRig({ binaryPath: join(missingDir.dir, 'no-such-core-binary') });

    const result = await rig.supervisor.start();
    expect(result.ok, 'TC-02-04/FR-14: a missing binary must refuse Start').toBe(false);
    if (result.ok) throw new Error('unreachable: assertion above failed');
    expectNfr5Triple(
      result.error,
      {
        code: 'E-IO-004',
        trigger: 'binaryPath points at a file that does not exist',
        title: 'Core binary check failed',
        cause: 'was not found in the app installation',
        nextStep: 'Reinstall the app.',
      },
      'TC-02-04 (errors.md §2, E-IO-004)',
    );
    expectHumanWording('TC-02-04 (errors.md §2, E-IO-004)', result.error);
    expect(
      rig.snapshots,
      'TC-02-04/FR-14: the pre-check runs BEFORE any transition — state stays stopped, ' +
        'so nothing is emitted',
    ).toEqual([]);
    expect(rig.supervisor.isRunning(), 'TC-02-04: nothing is running').toBe(false);
    expect(rig.invocations(), 'TC-02-04/FR-14: NOTHING spawns on a failed binary check').toEqual(
      [],
    );
  }, 15_000);

  it('supervisor.start.port10808Occupied.failsNamingPortOrAnnouncesNewPort', async () => {
    const rig = await createRig(); // module load first: absence RED precedes any port work

    // DV-29: the fixture precondition is that OUR occupier holds the port —
    // if a leaked holder were already on 10808, occupy-port.mjs would just
    // log "already held" and this test would pass for the wrong reason.
    await waitForPortFree(
      DEFAULT_SOCKS_PORT,
      5000,
      'TC-02-05: 127.0.0.1:10808 free before the fixture occupier binds',
    );
    occupant = spawn('node', [occupyPortPath()], { stdio: 'ignore' });
    expect(
      await waitForPortState(DEFAULT_SOCKS_PORT, true, 5000),
      'fixture precondition: 127.0.0.1:10808 must be held before start()',
    ).toBe(true);

    const result = await rig.supervisor.start();
    expect(
      result.ok,
      'TC-02-05/FR-15: Start while 10808 is occupied must fail — never a silent different ' +
        `port (Q-03 pending; FR-15 as written) — got ${JSON.stringify(result)}`,
    ).toBe(false);
    if (result.ok) throw new Error('unreachable: assertion above failed');
    expectNfr5Triple(
      result.error,
      {
        code: 'E-IO-003',
        trigger: 'another process already holds 127.0.0.1:10808 at Start',
        title: 'Local port 10808 is busy',
        cause: 'Another program is already using',
        nextStep: 'Quit that program, then click Start.',
      },
      'TC-02-05 (errors.md §2, E-IO-003)',
    );
    expectHumanWording('TC-02-05 (errors.md §2, E-IO-003)', result.error);
    expect(
      `${result.error.title} ${result.error.cause} ${result.error.nextStep}`,
      'TC-02-05/FR-15: the message must name port 10808',
    ).toContain(String(DEFAULT_SOCKS_PORT));
    expect(
      rig.snapshots,
      'TC-02-05/FR-15: the port pre-check runs BEFORE any transition — state stays stopped',
    ).toEqual([]);
    expect(rig.invocations(), 'TC-02-05/FR-15: nothing spawns while the port is held').toEqual([]);
  }, 15_000);

  it('supervisor.start.silentCoreNeverReady.timeoutSurfacesReadableError', async () => {
    const rig = await createRig({ mode: 'silent' });
    // DV-29 defensive barrier (the CI flake, run 37594647160): the preceding
    // TC-02-05 kill of occupy-port.mjs may not have released 127.0.0.1:10808
    // yet on a slow runner — then this test's FR-15 pre-check would answer
    // E-IO-003 where FR-20 requires the readiness timeout E-CORE-002. Wait
    // for the port to be REALLY free before start(); assertions unchanged.
    await waitForPortFree(
      DEFAULT_SOCKS_PORT,
      5000,
      'TC-02-10: 127.0.0.1:10808 free before start()',
    );
    const startedAt = Date.now();
    const result = await rig.supervisor.start();
    const elapsed = Date.now() - startedAt;

    expect(result.ok, 'TC-02-10/FR-20: a never-ready core must settle start() as a failure').toBe(
      false,
    );
    if (result.ok) throw new Error('unreachable: assertion above failed');
    expectNfr5Triple(
      result.error,
      {
        code: 'E-CORE-002',
        trigger: 'fake-core.sh --mode=silent — never binds, never signals readiness',
        title: 'The tunnel did not start in time',
        cause: 'The tunnel engine did not become ready within',
        nextStep: 'Click Start again',
      },
      'TC-02-10 (errors.md §3, E-CORE-002)',
    );
    expectHumanWording('TC-02-10 (errors.md §3, E-CORE-002)', result.error);
    expect(
      elapsed,
      'TC-02-10/FR-20 + A-11: the readiness threshold is 10 s — failing earlier is a ' +
        'different bug',
    ).toBeGreaterThanOrEqual(9_000);
    expect(
      elapsed,
      'TC-02-10/FR-20: timeout + kill must settle well before the test budget',
    ).toBeLessThanOrEqual(15_000);

    const states = rig.states();
    expect(states[0], 'TC-02-10: the timeout path starts at starting').toBe('starting');
    expect(states[states.length - 1], 'TC-02-10/§2.3: the timeout ends at crashed').toBe('crashed');
    const last = rig.snapshots[rig.snapshots.length - 1];
    expect(last?.lastError?.code, 'TC-02-10/FR-20: lastError is E-CORE-002').toBe('E-CORE-002');
    expect(
      isProcessGone(firstPid(rig)),
      'TC-02-10/FR-20: the never-ready child must be killed and reaped',
    ).toBe(true);
    const tPath = materializedConfigPath(rig);
    expect(existsSync(tPath), 'TC-02-10/errors §6: T must be deleted after the timeout').toBe(
      false,
    );
  }, 30_000);

  it('supervisor.start.configWriteFails.documentedEio006NeverSpawns', async () => {
    // TC-POL-02 (M3-A): E-IO-006 had NO wording pin anywhere (audit B-1).
    // Trigger: a read-only temp area — mkdtempSync inside materializeConfig
    // fails with EACCES, the caller maps it to the documented triple
    // (errors.md §2, FR-23 defensive entry) without surfacing the raw
    // reason; state stays stopped and NOTHING spawns.
    const rig = await createRig(); // module load first: absence RED precedes any FS work
    const ro = createScratch();
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = ro.dir;
    chmodSync(ro.dir, 0o555);
    try {
      const result = await rig.supervisor.start();
      expect(result.ok, 'TC-POL-02/FR-23: an unwritable temp area must refuse Start').toBe(false);
      if (result.ok) throw new Error('unreachable: assertion above failed');
      expect(result.error.code, 'TC-POL-02 (errors.md §2, E-IO-006)').toBe('E-IO-006');
      expectHumanWording('TC-POL-02 (errors.md §2, E-IO-006)', result.error);
      expect(rig.invocations(), 'TC-POL-02/FR-23: nothing spawns when T cannot be written').toEqual(
        [],
      );
      expect(rig.supervisor.isRunning(), 'TC-POL-02: nothing is running after the refusal').toBe(
        false,
      );
    } finally {
      chmodSync(ro.dir, 0o755);
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
  }, 15_000);

  it('supervisor.start.binaryNotExecutable.settlesDocumentedEcore003', async () => {
    // TC-POL-02 (M3-A): E-CORE-003 had NO wording pin anywhere (audit B-2 —
    // its nextStep also cited the internal `E-PLAT-005` code, which the M3-A
    // FORBIDDEN hardening rejects). Trigger: the binary EXISTS (passes the
    // FR-14 pre-check, which is a plain existsSync) but is not executable —
    // spawn settles EACCES and the flow maps it to the documented triple
    // (data-flows (b) step 4, errors.md §3).
    const dir = createScratch();
    const binaryPath = join(dir.dir, 'not-executable-core');
    writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
    chmodSync(binaryPath, 0o644);
    const rig = await createRig({ binaryPath });

    const result = await rig.supervisor.start();
    expect(
      result.ok,
      'TC-POL-02/data-flows (b) step 4: a failed spawn must settle Start as a failure',
    ).toBe(false);
    if (result.ok) throw new Error('unreachable: assertion above failed');
    expect(result.error.code, 'TC-POL-02 (errors.md §3, E-CORE-003)').toBe('E-CORE-003');
    expectHumanWording('TC-POL-02 (errors.md §3, E-CORE-003)', result.error);
    const states = rig.states();
    expect(
      states[states.length - 1],
      'TC-POL-02/§2.3: a launch failure ends at crashed (recovery matrix §6)',
    ).toBe('crashed');
  }, 15_000);
});

describe.skipIf(PORT_TAKEN)('supervisor — structural guards (PR-08, plan M1-15 purity)', () => {
  it('supervisor.boundary.moduleSourceUsesNoShellExecutionPrimitives', () => {
    // TC-02-14 (source-scan style of TC-01-15): the supervisor must drive the
    // core with spawn + an argument array and must never reach for a shell.
    expect(
      existsSync(CORE_SUPERVISOR_SOURCE),
      'src/main/core-supervisor.ts must exist — M1-15 GREEN implements the M1-14 contract',
    ).toBe(true);

    const source = stripComments(readFileSync(CORE_SUPERVISOR_SOURCE, 'utf8'));

    expect(
      /\bspawn\s*\(/.test(source),
      'TC-02-14/PR-08 + data-flows (b) step 4: the supervisor spawns the core child',
    ).toBe(true);

    const forbidden: Array<{ label: string; why: string; pattern: RegExp }> = [
      {
        label: 'exec(',
        why: 'PR-08: never a shell string for the core child',
        pattern: /(?<![.\w])exec\s*\(/,
      },
      {
        label: 'execSync(',
        why: 'PR-08: never a shell string, and never a blocking one',
        pattern: /(?<![.\w])execSync\s*\(/,
      },
      {
        label: 'shell: true',
        why: 'spawn must never opt into a shell (PR-08, injection guard)',
        pattern: /shell\s*:\s*true/,
      },
    ];
    for (const rule of forbidden) {
      expect(
        rule.pattern.test(source),
        `TC-02-14/PR-08: src/main/core-supervisor.ts must not use ${rule.label} — ${rule.why}`,
      ).toBe(false);
    }

    expect(source, 'TC-02-14: the M1-15 contract exports createSupervisor by name').toMatch(
      /export\s+(?:async\s+)?function\s+createSupervisor|export\s+const\s+createSupervisor|export\s*\{[^}]*\bcreateSupervisor\b/,
    );
  });

  it('supervisor.boundary.moduleImportsNoElectronOnlyNodePrimitives', () => {
    // Sibling of TC-02-14 (DV-03 convention): the supervisor is PURE node —
    // callbacks are injected, Electron belongs to M1-17's wiring — so the L2
    // suite runs unmocked (plan M1-15, strategy §2).
    expect(
      existsSync(CORE_SUPERVISOR_SOURCE),
      'src/main/core-supervisor.ts must exist — M1-15 GREEN implements the M1-14 contract',
    ).toBe(true);

    const source = stripComments(readFileSync(CORE_SUPERVISOR_SOURCE, 'utf8'));

    const specifiers = [
      ...source.matchAll(
        /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g,
      ),
    ].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
    for (const specifier of specifiers) {
      expect(
        specifier === 'electron' || specifier.startsWith('electron/'),
        `TC-02-14: the supervisor must not import '${specifier}' — pure node, ` +
          'electron wiring belongs to M1-17',
      ).toBe(false);
    }

    for (const primitive of [
      'electron',
      'ipcMain',
      'contextBridge',
      'BrowserWindow',
      'webContents',
    ]) {
      expect(
        source.includes(primitive),
        `TC-02-14: src/main/core-supervisor.ts must not reference '${primitive}' — ` +
          'state and log output travel through the injected callbacks only',
      ).toBe(false);
    }

    expect(
      specifiers.some(
        (specifier) => specifier === 'child_process' || specifier === 'node:child_process',
      ),
      'TC-02-14/PR-08: the supervisor must drive the child through node:child_process',
    ).toBe(true);
  });
});

/** `//`/`/* *\/` comments removed before structural scanning (cf. TC-01-15). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe.skipIf(PORT_TAKEN)('pre-M3 fix batch #22 — M1-25 lows S5-8 / S5-15 (issue #22)', () => {
  it('supervisor.lineReader.bufferCapForcesSegmentFlush', async () => {
    // TC-02-28 — S5-8 (issue #22): `attachLineReader` grew its buffer with
    // every chunk and only ever emitted on '\n' — a child line without a
    // newline grew the MAIN process buffer unbounded (the collector's
    // 4096-char cap applies only AFTER a line completes). Fixture mode
    // `gibberish` streams 20 x 8320 'x' bytes with NO newline; the reader
    // must force-flush 64 KB segments through the (redaction-first)
    // emitLine WHILE the child is still alive, and deliver the remainder
    // on end — capped, never lost.
    const rig = await createRig({ mode: 'gibberish' });
    const result = await rig.supervisor.start();
    expect(result.ok, 'fixture sanity: the gibberish child reaches running').toBe(true);

    const segments = () =>
      rig.sink.filter((line) => line.stream === 'stdout' && line.text.length === 65_536);
    await waitFor(
      () => segments().length >= 2,
      4_000,
      'TC-02-28/S5-8: the capped reader force-flushes 64 KB segments while the child streams',
    );
    expect(
      segments().every((line) => /^x+$/.test(line.text)),
      'each forced segment is verbatim child data (the rig sink sits pre-redaction)',
    ).toBe(true);

    await rig.supervisor.stop();
    const total = rig.sink
      .filter((line) => line.stream === 'stdout' && /^x+$/.test(line.text))
      .reduce((count, line) => count + line.text.length, 0);
    expect(total, 'S5-8: the cap must not LOSE data — end flushes the remainder').toBe(20 * 8320);
  }, 15_000);

  it('supervisor.stop.lastResortSettlesWhenGrandchildHoldsStdio', async () => {
    // TC-02-29 — S5-15 (issue #22): fixture mode `hold-stdio` ignores
    // SIGTERM, binds the probe port via a binder that dies with its
    // parent, and leaves a `(sleep 20)` grandchild HOLDING the stdio
    // pipes — after the SIGKILL escalation 'close' cannot fire for 20 s,
    // so `exited` never settles inside the stop budget and stop() hung
    // forever. It must settle through the last-resort bound (fail-open
    // after the best-effort kill); the eventual real 'close' is a no-op.
    const rig = await createRig({ mode: 'hold-stdio' });
    try {
      const started = await rig.supervisor.start();
      expect(started.ok, 'fixture sanity: hold-stdio reaches running (binder binds)').toBe(true);

      const startedAt = Date.now();
      const result = await Promise.race([
        rig.supervisor.stop(),
        new Promise<'hung'>((resolve) => {
          setTimeout(() => resolve('hung'), 12_000);
        }),
      ]);
      const elapsed = Date.now() - startedAt;

      expect(
        result !== 'hung' && result.ok,
        'TC-02-29/S5-15: stop() must settle through the last-resort bound — a ' +
          'grandchild-held stdio cannot strand the stop',
      ).toBe(true);
      expect(rig.states(), 'the forced exit path emits stopped').toContain('stopped');
      expect(elapsed, 'it really waited out SIGTERM (2 s) + the grace window').toBeGreaterThan(
        4_500,
      );
      expect(elapsed, 'and settled at the bound (~7 s), not later').toBeLessThan(10_500);
    } finally {
      // RED hygiene (DV-62): with the fix absent stop() hangs on the held
      // stdio; reaping the `(sleep 20)` grandchild closes the pipes so the
      // real 'close' fires and the DV-33 rig hooks can complete. In GREEN
      // this is a harmless no-op (the child is already gone).
      spawnSync('pkill', ['-f', '^sleep 20$']);
    }
  }, 20_000);
});
