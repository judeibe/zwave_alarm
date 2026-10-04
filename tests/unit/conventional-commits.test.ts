import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script shared with CI, has no type declarations
import { parseCommit } from '../../scripts/conventional.mjs';

describe('conventional commits', () => {
  it.each([
    ['fix: stop crash', ['fix: stop crash']],
    ['feat(api): add thing', ['chore: x', 'feat(api): add thing']],
  ])('parses %s', (_label, messages) => {
    expect(parseCommit(messages.at(-1)!)).not.toBeNull();
  });

  it.each(['Merge pull request #3', 'T053: graceful shutdown', 'fix:no space', 'Fix stuff'])('rejects %s', (message) => {
    expect(parseCommit(message)).toBeNull();
  });

  it('detects breaking changes from the bang and from BREAKING CHANGE footers only', () => {
    expect(parseCommit('refactor!: c')?.breaking).toBe(true);
    expect(parseCommit('fix: a\n\nBREAKING CHANGE: drops the old endpoint')?.breaking).toBe(true);
    expect(parseCommit('chore: a\n\nBREAKING-CHANGE: env var renamed')?.breaking).toBe(true);
    expect(parseCommit('fix: a\n\nthis is not a BREAKING CHANGE: really')?.breaking).toBe(false);
    const feat = parseCommit('feat(api): add thing');
    expect(feat?.type).toBe('feat');
    expect(feat?.scope).toBe('api');
    expect(feat?.breaking).toBe(false);
  });
});
