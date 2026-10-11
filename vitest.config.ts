import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Runs once in the main process, BEFORE any worker starts. It settles
    // whether 127.0.0.1:10808 is held by something outside the suite, which
    // the port-bound suites need to know before they can decide to skip.
    // Computing that at file-load time instead races with the suites' own
    // fixtures — see tests/helpers/port-gate.ts.
    globalSetup: ['tests/global-setup.ts'],
    coverage: {
      // M1-27b batch D (D-11, issue #18 / TC-DOC-11): the strategy §6 gate
      // is now MECHANICAL — `npm run test:coverage` enforces "≥ 80 % lines
      // on src/**" (the M1-27 evidence metric). LINES ONLY: strategy §6
      // specifies lines; branches/functions/statements are deliberately
      // not invented as gates (DV-37). include lists code files only —
      // src/renderer/index.html is not parseable JS and contributes 0
      // lines anyway (v8 would only log a PARSE_ERROR for it). Thresholds evaluate only under
      // `--coverage`, so plain `npm test` and CI stay unaffected; the CI
      // coverage job itself is a documented M2 deferral (G-05, acceptance-
      // m1-27.md). Expect a LOUD fail below threshold — e.g. the local
      // VPN-distorted 65.64 % subset (G-05) until the authoritative
      // VPN-off-window run.
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      thresholds: {
        lines: 80,
      },
    },
  },
});
