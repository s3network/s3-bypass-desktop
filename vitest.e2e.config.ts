import { defineConfig } from 'vitest/config';

/**
 * E2E/smoke layer (docs/qa/strategy.md §2, L3) — run ONLY via `npm run test:e2e`.
 *
 * Deliberately separate from `vitest.config.ts`: the default include
 * requires the `.test.` infix under `tests/` (i.e. `tests/` + `**` +
 * `/*.test.{ts,tsx}`) and does not match `tests/e2e/*.spec.ts`
 * (strategy §4.1 file naming), so `npx vitest run` (the unit/integration
 * suite) never picks these files up — and this config never touches the
 * unit run. The E2E layer needs what the unit layer must not have:
 *  - long timeouts (Electron launch + the supervisor's 10 s readiness budget),
 *  - no file parallelism (one real app, one fixed port 127.0.0.1:10808).
 *
 * The suite fails loudly in `beforeAll` when 127.0.0.1:10808 is held or the
 * build output is missing — it never skips silently (M1-24 / DV-31).
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    environment: 'node',
    // Same 10808 gate as the unit layer — the e2e specs launch Electron and
    // the supervisor, so they need the verdict recorded before workers start.
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
