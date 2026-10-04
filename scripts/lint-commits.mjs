// Fails when a commit in the range is not a Conventional Commit. Usage: node scripts/lint-commits.mjs <base>..<head>
import { commitMessages, parseCommit } from './conventional.mjs';

const bad = commitMessages(process.argv[2]).filter((message) => !parseCommit(message));
if (bad.length > 0) {
  for (const message of bad) {
    console.error(`not a Conventional Commit: ${message.split('\n')[0]}`);
  }
  console.error('Expected "<type>[(scope)][!]: <description>", see https://www.conventionalcommits.org/en/v1.0.0/');
  process.exit(1);
}
