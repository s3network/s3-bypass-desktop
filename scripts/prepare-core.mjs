#!/usr/bin/env node
/**
 * M2-04 — stage the pinned Xray-core release for packaging
 * (board task M2-04; BRIEF §9; M2 DoD #1: the digests come from the pin
 * record, never from the network response itself).
 *
 * For every bundled asset of `docs/analysis/core-pin.md` this script:
 *   1. reads the release tag and the asset's pinned SHA-256 from the doc
 *      (single source of truth — `expectedShaForAsset` is reused from
 *      `scripts/verify-core-pin.mjs`);
 *   2. downloads
 *      `https://github.com/s3network/s3-bypass-protocol/releases/download/<tag>/<asset>`;
 *   3. verifies the digest — a mismatch aborts with exit 1 (MISMATCH);
 *   4. extracts ALL five members (xray, geoip.dat, geosite.dat, LICENSE,
 *      README.md) into `core-bin/<target>/` where <target> is
 *        Xray-macos-64.zip        → darwin-x64
 *        Xray-macos-arm64-v8a.zip → darwin-arm64
 *        Xray-linux-64.zip        → linux-x64
 *      and chmods 0755 on `xray`.
 *
 * `core-bin/` is gitignored (TC-PKG-04); M2-05 consumes the staging dirs
 * via electron-builder `extraResources` (`core-bin/darwin-${arch}/xray` →
 * `core/darwin/xray`, linux likewise). Requires `unzip` on PATH (macOS and
 * the GitHub ubuntu runners ship it).
 *
 * Usage: `npm run prepare:core`
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanStagingTarget, TARGETS, writeStagingManifest } from './core-staging.mjs';
import { expectedShaForAsset } from './verify-core-pin.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_DOC = join(ROOT, 'docs', 'analysis', 'core-pin.md');
const STAGING = join(ROOT, 'core-bin');
const MANIFESTS = join(STAGING, '.manifests');

/** The five members every release zip carries (staged + manifested, DV-60). */
const MEMBER_NAMES = ['xray', 'geoip.dat', 'geosite.dat', 'LICENSE', 'README.md'];

function die(message) {
  process.stderr.write(`prepare:core FAILED: ${message}\n`);
  process.exit(1);
}

function staged(target, name) {
  return join(STAGING, target, name);
}

async function main() {
  const pinDoc = readFileSync(PIN_DOC, 'utf8');
  const tagMatch = /\| Release tag \|\s*`([^`]+)`\s*\|/.exec(pinDoc);
  if (tagMatch === null) die(`cannot read the release tag row from ${PIN_DOC}`);
  const tag = tagMatch[1];

  const work = mkdtempSync(join(tmpdir(), 'prepare-core-'));
  try {
    for (const [asset, target] of Object.entries(TARGETS)) {
      const expected = expectedShaForAsset(pinDoc, asset);
      if (expected === null) die(`no pinned SHA-256 for ${asset} in ${PIN_DOC}`);

      const url =
        `https://github.com/s3network/s3-bypass-protocol/releases/download/` + `${tag}/${asset}`;
      process.stdout.write(`prepare:core → ${asset} (${target})\n`);
      const response = await fetch(url);
      if (!response.ok) die(`download failed for ${asset}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());

      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected) {
        die(
          `digest for ${asset}\n  expected: ${expected}\n  actual:   ${actual}\n` +
            `  (pin doc: ${PIN_DOC})`,
        );
      }

      const zipPath = join(work, asset);
      writeFileSync(zipPath, bytes);
      // issue #20 fix a: start extraction from an EMPTY target — stale
      // members and stray files cannot survive into the package.
      cleanStagingTarget(STAGING, target);
      mkdirSync(join(STAGING, target), { recursive: true });
      const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', join(STAGING, target)], {
        encoding: 'utf8',
      });
      if (unzip.status !== 0) {
        die(`unzip failed for ${asset} (is unzip on PATH?): ${unzip.stderr ?? ''}`);
      }
      const binary = staged(target, 'xray');
      if (!existsSync(binary)) die(`${asset} staged without its xray binary (${binary})`);
      chmodSync(binary, 0o755);
      // issue #20 fix b: record what the digest-verified zip actually staged
      // (zip sha from the pin doc + per-member digests) — the afterPack gate
      // re-verifies the PACKED bytes against this manifest, offline.
      const members = {};
      for (const name of MEMBER_NAMES) {
        members[name] = createHash('sha256')
          .update(readFileSync(staged(target, name)))
          .digest('hex');
      }
      writeStagingManifest(MANIFESTS, target, {
        asset,
        target,
        zipSha256: expected,
        members,
        stagedAt: new Date().toISOString(),
      });
      process.stdout.write(`prepare:core OK ${asset} → core-bin/${target}/xray\n`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write('prepare:core staged darwin-x64, darwin-arm64, linux-x64\n');
}

await main();
