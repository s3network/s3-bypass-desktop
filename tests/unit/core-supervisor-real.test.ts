/**
 * M2-10 — REAL-binary integration, strategy D-4 (docs/plans/m2-packaging.md
 * board row; docs/qa/m2-test-plan.md §7): the SAME supervisor against the
 * PINNED Xray-core-fedarisha binary staged by `npm run prepare:core`
 * (`core-bin/<target>/xray`, docs/analysis/core-pin.md) instead of
 * tests/fixtures/fake-core.sh. The fake proves the mechanics (M1-14); this
 * file proves the real engine against the real materialized T:
 *
 *   TC-02-21  start: the pinned binary ACCEPTS the materialized T — spawn →
 *             readiness (TCP 127.0.0.1:10808) → `running` within 1 s
 *             (FR-13/FR-20/FR-21), exactly [starting, running];
 *   TC-02-22  the real core's own startup line reaches the log sink line-
 *             based (data-flows (b) step 6) — `started` can only come from
 *             the real binary (fake-core prints READY), the D-4 signature;
 *   TC-02-23  stop: SIGTERM → clean exit → the inbound released the port →
 *             T deleted (FR-16, FR-23);
 *   TC-02-24  crash: an EXTERNAL SIGKILL nobody requested → `crashed` +
 *             E-CORE-001 + T deleted + port released (FR-17, errors.md §6).
 *
 * VENUE (plan §7, DV-53): the FR-15 pre-check and the FR-21 readiness probe
 * hardcode 127.0.0.1:10808, so this file needs that port FREE — the
 * sanctioned venues are CI (authoritative; ci.yml checks + coverage stage
 * the binary with prepare:core) or a VPN-off local window. The documented
 * VPN-on local command EXCLUDES this file (DV-53) — a held port fails this
 * suite LOUDLY (never a silent skip; the e2e port-preflight precedent,
 * DV-31(4)).
 *
 * DV-33 cross-file port barrier: the same lockfile mutex the two fake
 * suites hold — acquire before every test, release only AFTER the
 * port-free barrier, so every handoff is a FREE-port handoff.
 *
 * Fixture: tests/fixtures/configs/valid-client-config.json (fedarisha
 * outbound, example.com/loopback only — boot-checked against the real
 * binary on 2026-10-08 before writing these rows, DV-53).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SOCKS_PORT } from '../../src/shared/constants';
import type { CoreState, StatusSnapshot } from '../../src/shared/status-machine';
import {
  acquirePortLock,
  portBusySkipMessage,
  portHeldExternally,
  type CoreLogLine,
  type CoreSupervisor,
  distinctStates,
  isProcessGone,
  loadCoreSupervisor,
  PORT_LOCK_HOOK_TIMEOUT_MS,
  PORT_LOCK_TIMEOUT_MS,
  probePort,
  releasePortLock,
  waitFor,
  waitForPortFree,
  waitForPortState,
} from '../helpers/core-supervisor-stub';
import { loadLogCollector } from '../helpers/log-collector-stub';
import { readConfigFixture } from '../helpers/profile-validator-stub';

/** Repo root — this file lives at tests/unit/core-supervisor-real.test.ts. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** prepare:core's staging target for THIS host (same map M2-05 packs). */
const STAGED_TARGET: string | null =
  process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'darwin-arm64'
      : 'darwin-x64'
    : process.platform === 'linux'
      ? 'linux-x64'
      : null;

/**
 * The staged pinned binary — loud when absent: a missing binary here means
 * the VENUE did not stage the core, never a reason to skip the assertions.
 */
function realCorePath(): string {
  if (STAGED_TARGET === null) {
    throw new Error(
      `M2-10 D-4: no prepare:core staging target for ${process.platform}/${process.arch} ` +
        '(only darwin x64/arm64 + linux-x64 are mapped — declare it in DV-53 first)',
    );
  }
  const binary = join(REPO_ROOT, 'core-bin', STAGED_TARGET, 'xray');
  if (!existsSync(binary)) {
    throw new Error(
      `staged pinned core missing at ${binary} — run \`npm run prepare:core\` ` +
        '(ci.yml checks + coverage jobs run it before npm test; DV-53)',
    );
  }
  return binary;
}

/** Materialized T directories currently under the app temp area (FR-22). */
function coreConfigDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('s3bypass-core-'))
    .map((name) => join(tmpdir(), name));
}

/**
 * The live child pid holding THIS T: `ps` arg scan (no shell — PR-08 style,
 * an args ARRAY). `ww` keeps the full config path visible on both BSD and
 * procps when stdout is a pipe (default args width would truncate).
 */
function pidUsingConfig(configPath: string): number {
  const listing = execFileSync('ps', ['-axwwo', 'pid=,args='], { encoding: 'utf8' });
  for (const line of listing.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.includes(configPath)) continue;
    const pid = Number.parseInt(trimmed.split(/\s+/)[0] ?? '', 10);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) return pid;
  }
  return -1;
}

/** One test's observable surface: state transitions + raw sink lines. */
interface RealRig {
  readonly supervisor: CoreSupervisor;
  readonly snapshots: StatusSnapshot[];
  readonly sink: CoreLogLine[];
  states(): CoreState[];
}

const rigs: RealRig[] = [];

// DV-33 cross-file barrier — identical contract to core-supervisor.test.ts:
// the lock is acquired before every test and released only in the finally
// of afterEach, AFTER the port-free proof below.
beforeEach(async () => {
  await acquirePortLock(
    DEFAULT_SOCKS_PORT,
    PORT_LOCK_TIMEOUT_MS,
    'the DV-33 cross-file lock for 127.0.0.1:10808 (held by the other supervisor suites)',
  );
}, PORT_LOCK_HOOK_TIMEOUT_MS);

afterEach(async () => {
  try {
    // Did THIS test actually own the port? (No = the venue's foreign holder
    // failed the start pre-check — E-IO-003 — and there is nothing of ours
    // to release; waiting would blame the real core for someone else's
    // listener. The VPN-on local venue takes this branch; CI never does.)
    const portWasOurs = rigs.some((rig) => rig.states().includes('running'));
    for (const rig of rigs) {
      try {
        if (rig.supervisor.isRunning()) await rig.supervisor.stop();
      } catch {
        // best effort — a failed cleanup stop must not mask the real failure
      }
    }
    rigs.length = 0;
    // DV-29-style barrier: hand the FREE port to the next file, never a
    // half-closed real core (the real child's sockets close on its own
    // exit event, i.e. after stop() already resolved).
    if (portWasOurs) {
      await waitForPortFree(
        DEFAULT_SOCKS_PORT,
        5000,
        'afterEach cleanup: 127.0.0.1:10808 released by the real core',
      );
    }
  } finally {
    releasePortLock(DEFAULT_SOCKS_PORT);
  }
});

/**
 * Builds a supervisor wired to recorders, pointed at the STAGED PINNED
 * binary and the §9.1 valid-profile fixture — nothing else differs from the
 * fake rigs (the module under test is the same).
 */
async function createRealRig(): Promise<RealRig> {
  const api = await loadCoreSupervisor();
  const snapshots: StatusSnapshot[] = [];
  const sink: CoreLogLine[] = [];
  const supervisor = api.createSupervisor({
    binaryPath: realCorePath(),
    config: readConfigFixture('valid-client-config.json'),
    onStateChange: (snapshot) => {
      snapshots.push(snapshot);
    },
    logSink: (line) => {
      sink.push(line);
    },
  });
  const rig: RealRig = {
    supervisor,
    snapshots,
    sink,
    states: () => distinctStates(snapshots),
  };
  rigs.push(rig);
  return rig;
}

/**
 * Skip these suites when 127.0.0.1:10808 is already taken.
 *
 * mergeLoopbackInbound writes DEFAULT_SOCKS_PORT into the materialized
 * profile whatever the profile itself said, so a suite cannot choose a port
 * of its own. With the application open — the normal state while working on
 * it — every spawn-path case fails for a reason that has nothing to do with
 * the code under test. Two dozen red tests read as a defect; one skip that
 * names its cause does not.
 */
const PORT_TAKEN = await portHeldExternally(DEFAULT_SOCKS_PORT);
if (PORT_TAKEN) {
  // vitest's SuiteOptions carries no skip reason, so it is stated once
  // here instead: the skips below are otherwise unexplained.
  console.warn(portBusySkipMessage(DEFAULT_SOCKS_PORT));
}

describe.skipIf(PORT_TAKEN)('real-binary integration — strategy D-4 (M2-10, TC-02-21..24)', () => {
  it('coreReal.start.validProfileBootsPinnedBinaryRunningWithin1s', async () => {
    const rig = await createRealRig();
    const t0 = Date.now();
    const started = await rig.supervisor.start();
    const elapsedMs = Date.now() - t0;

    expect(
      started.ok,
      'D-4: the PINNED fedarisha binary must accept the materialized T — the ' +
        'fixture profile boots the real engine (fake-core never proved this)',
    ).toBe(true);
    expect(
      elapsedMs,
      'FR-13/FR-21: spawn → readiness → running settles within 1 s',
    ).toBeLessThanOrEqual(1000);
    expect(rig.states(), 'exactly [starting, running] — no extra emissions').toEqual([
      'starting',
      'running',
    ]);
    expect(rig.supervisor.isRunning(), 'the real child is alive at running').toBe(true);
    expect(
      await probePort(DEFAULT_SOCKS_PORT),
      'the real SOCKS inbound accepts the FR-21 readiness connect',
    ).toBe(true);

    const stopped = await rig.supervisor.stop();
    expect(stopped.ok, 'cleanup stop for this case').toBe(true);
  });

  it('coreReal.start.realCoreStartupLinesReachLogSink', async () => {
    const rig = await createRealRig();
    const started = await rig.supervisor.start();
    expect(started.ok, 'precondition: running').toBe(true);

    await waitFor(
      () => rig.sink.some((line) => line.text.includes('started')),
      3000,
      'the real core "started" line through the line-based sink (data-flows (b) step 6)',
    );
    expect(
      rig.sink.some((line) => line.stream === 'stdout' || line.stream === 'stderr'),
      'every sink line carries its stream tag',
    ).toBe(true);
    expect(
      rig.sink.filter((line) => line.text.includes('started')).length,
      'D-4 signature: only the real binary prints "started" (fake-core prints READY)',
    ).toBeGreaterThan(0);

    const stopped = await rig.supervisor.stop();
    expect(stopped.ok, 'cleanup stop for this case').toBe(true);
  });

  it('coreReal.stop.terminatesRealCoreReleasesPortAndDeletesT', async () => {
    const before = new Set(coreConfigDirs());
    const rig = await createRealRig();
    expect((await rig.supervisor.start()).ok, 'precondition: running').toBe(true);

    const created = coreConfigDirs().filter((dir) => !before.has(dir));
    expect(created.length, 'exactly ONE materialized T while running (FR-22)').toBe(1);
    const tDir = created[0];
    if (tDir === undefined) throw new Error('unreachable: assertion above failed');

    const stopped = await rig.supervisor.stop();
    expect(stopped.ok, 'FR-16/A-13: a requested stop settles ok').toBe(true);
    expect(rig.states(), 'starting → running → stopping → stopped').toEqual([
      'starting',
      'running',
      'stopping',
      'stopped',
    ]);
    expect(rig.supervisor.isRunning(), 'the child exited').toBe(false);
    expect(
      await waitForPortState(DEFAULT_SOCKS_PORT, false, 3000),
      'FR-16: the real inbound released 127.0.0.1:10808 after SIGTERM',
    ).toBe(true);
    expect(existsSync(tDir), 'FR-23: T deleted on stop').toBe(false);
  });

  it('coreReal.crash.externalSigkillGoesCoreCrashedAndReapsT', async () => {
    // LAST case on purpose: it leaves the state at `crashed` and the
    // supervisor instance spent (cleanup below only stops a LIVE child).
    const before = new Set(coreConfigDirs());
    const rig = await createRealRig();
    expect((await rig.supervisor.start()).ok, 'precondition: running').toBe(true);

    const created = coreConfigDirs().filter((dir) => !before.has(dir));
    expect(created.length, 'exactly ONE materialized T while running (FR-22)').toBe(1);
    const tDir = created[0];
    if (tDir === undefined) throw new Error('unreachable: assertion above failed');
    const pid = pidUsingConfig(tDir);
    expect(pid, 'the spawned real child must be findable to kill (ps arg scan)').toBeGreaterThan(1);
    expect(isProcessGone(pid), 'precondition: the child is alive').toBe(false);

    process.kill(pid, 'SIGKILL'); // nothing requested it — the FR-17 path
    await waitFor(
      () => rig.states().includes('crashed'),
      5000,
      'the external SIGKILL settles the status machine at crashed (FR-17)',
    );
    const last = rig.snapshots[rig.snapshots.length - 1];
    expect(last?.state, 'final state').toBe('crashed');
    expect(last?.lastError?.code, 'errors.md §6 / FR-17: E-CORE-001 names the exit fact').toBe(
      'E-CORE-001',
    );
    expect(rig.supervisor.isRunning(), 'the child was reaped').toBe(false);
    await waitFor(() => !existsSync(tDir), 3000, 'errors.md §6: T deleted on the crash exit path');
    expect(
      await waitForPortState(DEFAULT_SOCKS_PORT, false, 3000),
      'the dead child released 127.0.0.1:10808',
    ).toBe(true);
  });
});

describe.skipIf(PORT_TAKEN)('real-core redaction pipeline (issue #24, DV-63) — TC-06-27', () => {
  it('coreReal.redaction.pipeline.bootLinesKeepListenSignal', async () => {
    // TC-06-27 — issue #24: the REAL core's own boot output through the
    // collector's single entry point — the Logs-panel symptom (119/119
    // [REDACTED] with a real profile) reproduced and pinned on REAL output:
    // the listen line must SURVIVE with host:port intact (signal), the
    // materialized config path must be MASKED (not passed through), and no
    // configured canary/INTERNAL value may appear anywhere in the buffer.
    const rig = await createRealRig();
    expect((await rig.supervisor.start()).ok, 'precondition: running').toBe(true);
    await waitFor(
      () => rig.sink.some((line) => line.text.includes('started')),
      3000,
      'the real core boot lines reached the sink (D-4 signature)',
    );

    const config = JSON.parse(readConfigFixture('valid-client-config.json')) as {
      outbounds?: Array<{ settings?: { storage?: Record<string, string> } }>;
    };
    const storage = config.outbounds?.[0]?.settings?.storage ?? {};
    expect(Object.keys(storage).length, 'fixture sanity: type + 5 INTERNAL + 4 canaries').toBe(10);
    // `type: "s3"` is structural config, not a secret — assert absence for
    // the meaningful values only (4 canaries + 5 INTERNAL), never for
    // 2-char fragments that could collide with unrelated output.
    const configuredValues = Object.values(storage).filter((value) => value.length >= 6);
    expect(configuredValues.length, 'fixture sanity: canaries + INTERNAL values').toBe(9);

    // The sink delivers RAW lines (FR-47: the collector is the single entry
    // point) — push them exactly as index.ts does, INCLUDING its wiring:
    // the redaction context is extracted from the config document.
    const collectorApi = await loadLogCollector();
    expect(
      typeof collectorApi.redactionContextFromConfig,
      'contract (issue #24/DV-63): the module exports redactionContextFromConfig',
    ).toBe('function');
    const collector = collectorApi.createLogCollector({
      maxLines: 100,
      redactionContext: collectorApi.redactionContextFromConfig(config),
    });
    for (const line of rig.sink) collector.push(line);
    const dump = collector
      .get()
      .lines.map((line) => line.text)
      .join('\n');

    expect(
      dump,
      'issue #24: the listen signal must SURVIVE redaction — host:port is PUBLIC (§8.4)',
    ).toContain('listening TCP on 127.0.0.1:10808');
    expect(dump, 'issue #24: the config-read line keeps its scaffolding').toContain(
      'Reading config',
    );
    expect(
      dump,
      'masking asserted, not just absence — the materialized config path was masked (§8.4)',
    ).toContain('[REDACTED');
    for (const value of configuredValues) {
      expect(
        dump.includes(value),
        `NFR-2/issue #24: configured value "${value}" must have 0 occurrences in the real-output buffer`,
      ).toBe(false);
    }

    const stopped = await rig.supervisor.stop();
    expect(stopped.ok, 'cleanup stop for this case').toBe(true);
  });
});
