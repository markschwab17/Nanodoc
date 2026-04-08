#!/usr/bin/env node
// scripts/release.mjs
//
// One-shot release helper for Nanodoc. Bumps the version in every file that
// holds it, then (optionally) commits, tags, and pushes — which triggers the
// .github/workflows/release.yml build that produces the macOS + Windows
// installers and a draft GitHub Release.
//
// Files updated:
//   1. package.json                 — top-level "version"
//   2. package-lock.json            — root "version" + packages."".version
//   3. src-tauri/tauri.conf.json    — top-level "version"
//   4. src-tauri/Cargo.toml         — [package] version
//   5. src/pages/Home.tsx           — NANODOC_VERSION constant (drives nanodoc.app download buttons)
//
// Usage:
//   npm run release -- 1.0.1                  # update files only, print next-step git commands
//   npm run release -- 1.0.1 --yes            # update files, commit, tag, push (full automation)
//   npm run release -- 1.0.1 --yes --no-push  # commit and tag locally, skip the push
//
// After --yes pushes the tag, GitHub Actions takes ~25 min to build all three
// targets. When it finishes, open https://github.com/markschwab17/Nanodoc/releases
// and click "Publish release" on the draft. Netlify auto-redeploys nanodoc.app
// from the version bump push, so the website's download buttons update on their own.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const yes = args.includes('--yes');
const noPush = args.includes('--no-push');

if (!version) {
  console.error('usage: npm run release -- <version> [--yes] [--no-push]');
  console.error('  e.g. npm run release -- 1.0.1');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`error: invalid semver "${version}" (expected MAJOR.MINOR.PATCH)`);
  process.exit(1);
}

// ── Edit definitions ────────────────────────────────────────────────────────
// Each entry lists one or more regex replacements to apply. Patterns are
// intentionally narrow so they can't accidentally match a dependency version.
const edits = [
  {
    path: 'package.json',
    // First "version": "x.y.z" in the file is the top-level one (line 4),
    // so a non-global replace targets exactly that field.
    replacements: [
      { from: /("version"\s*:\s*")\d+\.\d+\.\d+(")/, to: `$1${version}$2` },
    ],
  },
  {
    path: 'package-lock.json',
    // The package's own version appears twice and is always preceded by
    // "name": "nanodoc",  — dependency entries never match this pattern.
    replacements: [
      {
        from: /("name"\s*:\s*"nanodoc",\s*"version"\s*:\s*")\d+\.\d+\.\d+(")/g,
        to: `$1${version}$2`,
      },
    ],
  },
  {
    path: 'src-tauri/tauri.conf.json',
    replacements: [
      { from: /("version"\s*:\s*")\d+\.\d+\.\d+(")/, to: `$1${version}$2` },
    ],
  },
  {
    path: 'src-tauri/Cargo.toml',
    // Anchor on `name = "nanodoc"\nversion = "..."` so we never touch a
    // [dependencies] entry by mistake.
    replacements: [
      {
        from: /(name\s*=\s*"nanodoc"\s*\nversion\s*=\s*")\d+\.\d+\.\d+(")/,
        to: `$1${version}$2`,
      },
    ],
  },
  {
    path: 'src/pages/Home.tsx',
    replacements: [
      {
        from: /(const NANODOC_VERSION\s*=\s*")\d+\.\d+\.\d+(")/,
        to: `$1${version}$2`,
      },
    ],
  },
];

// ── Apply edits ─────────────────────────────────────────────────────────────
const changedFiles = [];
for (const edit of edits) {
  const filePath = resolve(repoRoot, edit.path);
  const before = readFileSync(filePath, 'utf8');
  let after = before;
  let matchedAny = false;

  for (const r of edit.replacements) {
    if (!r.from.test(after)) {
      console.error(
        `error: ${edit.path}: pattern ${r.from} did not match. ` +
          `File format may have changed; update scripts/release.mjs.`,
      );
      process.exit(1);
    }
    after = after.replace(r.from, r.to);
    matchedAny = true;
  }

  if (!matchedAny || after === before) {
    console.log(`= ${edit.path} (already at v${version})`);
    continue;
  }

  writeFileSync(filePath, after);
  changedFiles.push(edit.path);
  console.log(`✓ ${edit.path}`);
}

console.log(`\nBumped ${changedFiles.length} file(s) to v${version}`);

if (changedFiles.length === 0) {
  console.log('Nothing to commit. Exiting.');
  process.exit(0);
}

// ── Git operations ──────────────────────────────────────────────────────────
const run = (cmd) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
};

if (!yes) {
  console.log('\nDry-run mode (no --yes). Run these next:');
  console.log(`  git add ${changedFiles.join(' ')}`);
  console.log(`  git commit -m "chore: release v${version}"`);
  console.log(`  git tag -a v${version} -m "Release v${version}"`);
  console.log(`  git push origin main && git push origin v${version}`);
  console.log('\nOr re-run with --yes to do all of the above automatically.');
  process.exit(0);
}

// Refuse to commit if the working tree has unrelated changes — keeps a
// release commit clean even if the user forgot they had something staged.
const dirty = execSync('git status --porcelain', { cwd: repoRoot })
  .toString()
  .split('\n')
  .filter(Boolean)
  .filter((line) => {
    const file = line.slice(3);
    return !changedFiles.includes(file);
  });

if (dirty.length > 0) {
  console.error('\nerror: working tree has unrelated changes:');
  for (const line of dirty) console.error('  ' + line);
  console.error(
    '\nCommit or stash them first, then re-run. (Refusing to bundle them into the release commit.)',
  );
  process.exit(1);
}

run(`git add ${changedFiles.map((f) => `"${f}"`).join(' ')}`);
run(`git commit -m "chore: release v${version}"`);
run(`git tag -a v${version} -m "Release v${version}"`);

if (noPush) {
  console.log(`\nLocal commit and tag created. Push manually with:`);
  console.log(`  git push origin main && git push origin v${version}`);
  process.exit(0);
}

run('git push origin main');
run(`git push origin v${version}`);

console.log(`\n🚀 v${version} pushed.`);
console.log(`   Build progress:    https://github.com/markschwab17/Nanodoc/actions`);
console.log(`   Publish the draft: https://github.com/markschwab17/Nanodoc/releases`);
console.log(`   Netlify will auto-redeploy nanodoc.app from the version bump commit.`);
