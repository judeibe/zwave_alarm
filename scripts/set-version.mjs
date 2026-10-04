// Sets the one release version everywhere it is recorded: package.json and package-lock.json.
// Usage: node scripts/set-version.mjs 1.2.3
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch>');
  process.exit(1);
}

function update(path, edit) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  edit(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
}

update('package.json', (j) => (j.version = version));
update('package-lock.json', (j) => {
  j.version = version;
  j.packages[''].version = version;
});
console.log(`version set to ${version}`);
