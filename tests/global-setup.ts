/**
 * Settles the 10808 question once, before any worker starts.
 *
 * Runs in the main vitest process, so no fixture of ours is up yet — the only
 * possible holder of the port is something outside the suite, which is
 * exactly the condition being tested for. The answer travels to the workers
 * through the environment; see `tests/helpers/port-gate.ts` for why the
 * verdict cannot be computed at file-load time instead.
 */
import { DEFAULT_SOCKS_PORT } from '../src/shared/constants';
import { PORT_GATE_ENV, portBusySkipMessage, portHeldExternally } from './helpers/port-gate';

export default async function setup(): Promise<void> {
  const taken = await portHeldExternally(DEFAULT_SOCKS_PORT);
  process.env[PORT_GATE_ENV] = taken ? '1' : '0';
  if (taken) {
    console.warn(`\n${portBusySkipMessage(DEFAULT_SOCKS_PORT)}\n`);
  }
}
