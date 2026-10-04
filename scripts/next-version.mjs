// Prints the next release as `bump=<none|patch|minor|major>` and `version=<x.y.z>` lines (GITHUB_OUTPUT format),
// from the Conventional Commits since the latest v* tag. With no tag yet, package.json's version is the first
// release as it stands. Usage: node scripts/next-version.mjs [auto|patch|minor|major]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { bumpFor, commitMessages, increment } from './conventional.mjs';

const override = process.argv[2] ?? 'auto';
const current = JSON.parse(readFileSync('package.json', 'utf8')).version;

let lastTag = '';
try {
  lastTag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*.*.*'], { encoding: 'utf8' }).trim();
} catch {
  // no tag yet
}

if (!lastTag) {
  console.log('bump=initial');
  console.log(`version=${current}`);
} else {
  const base = lastTag.slice(1);
  const bump = override === 'auto' ? bumpFor(commitMessages(`${lastTag}..HEAD`)) : override;
  console.log(`bump=${bump}`);
  console.log(`version=${increment(base, bump)}`);
}
