// Conventional Commits 1.0.0 parsing and the SemVer bump it implies:
// BREAKING CHANGE (footer or `!`) -> major, feat -> minor, fix -> patch, anything else -> none.
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

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

export function bumpFor(messages) {
  let bump = 'none';
  for (const message of messages) {
    const commit = parseCommit(message);
    if (!commit) {
      continue;
    }
    const level = commit.breaking ? 'major' : commit.type === 'feat' ? 'minor' : commit.type === 'fix' ? 'patch' : 'none';
    if (RANK[level] > RANK[bump]) {
      bump = level;
    }
  }
  return bump;
}

export function increment(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return version;
}

/** Commit messages in `range` (e.g. v1.0.0..HEAD), merge commits excluded: their text is not a change. */
export function commitMessages(range) {
  const out = execFileSync('git', ['log', '--no-merges', '--format=%B%x1e', range], { encoding: 'utf8' });
  return out.split('\x1e').map((m) => m.trim()).filter(Boolean);
}
