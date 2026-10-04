// Parses Conventional Commits 1.0.0 headers and lists commit messages for the commit-lint CI job.
// Versioning is done by semantic-release (release.config.mjs).
import { execFileSync } from 'node:child_process';

const HEADER = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<bang>!)?: (?<description>\S.*)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: \S/m;

/** Returns { type, scope, breaking, description } or null when the message is not conventional. */
export function parseCommit(message) {
  const [header, ...rest] = message.trim().split('\n');
  const match = HEADER.exec(header);
  if (!match) {
    return null;
  }
  const { type, scope, bang, description } = match.groups;
  return {
    type: type.toLowerCase(),
    scope,
    description,
    breaking: bang === '!' || BREAKING_FOOTER.test(rest.join('\n')),
  };
}

/** Commit messages in `range` (e.g. v1.0.0..HEAD), merge commits excluded: their text is not a change. */
export function commitMessages(range) {
  const out = execFileSync('git', ['log', '--no-merges', '--format=%B%x1e', range], { encoding: 'utf8' });
  return out.split('\x1e').map((m) => m.trim()).filter(Boolean);
}
