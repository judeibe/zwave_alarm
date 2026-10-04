import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script shared with CI, has no type declarations
import { bumpFor, increment, parseCommit } from '../../scripts/conventional.mjs';

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

  it('maps fix to patch, feat to minor and breaking changes to major, highest wins', () => {
    expect(bumpFor(['docs: x', 'chore: y'])).toBe('none');
    expect(bumpFor(['fix: a', 'docs: b'])).toBe('patch');
    expect(bumpFor(['fix: a', 'feat: b'])).toBe('minor');
    expect(bumpFor(['feat: b', 'refactor!: c'])).toBe('major');
    expect(bumpFor(['fix: a\n\nBREAKING CHANGE: drops the old endpoint'])).toBe('major');
    expect(bumpFor(['chore: a\n\nBREAKING-CHANGE: env var renamed'])).toBe('major');
  });

  it('ignores non-conventional messages and does not treat prose as a breaking footer', () => {
    expect(bumpFor(['Merge branch main', 'fix: a\n\nthis is not a BREAKING CHANGE: really'])).toBe('patch');
  });

  it('increments', () => {
    expect(increment('1.4.2', 'major')).toBe('2.0.0');
    expect(increment('1.4.2', 'minor')).toBe('1.5.0');
    expect(increment('1.4.2', 'patch')).toBe('1.4.3');
    expect(increment('1.4.2', 'none')).toBe('1.4.2');
  });
});
