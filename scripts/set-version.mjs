// Sets the one release version everywhere it is recorded: package.json, package-lock.json and the Home
// Assistant integration manifest. Usage: node scripts/set-version.mjs 1.2.3
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
// Text edit, not JSON round-trip, so the hand-formatted manifest keeps its layout.
const manifest = 'ha-integration/custom_components/zwave_alarm/manifest.json';
writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/("version":\s*")[^"]*"/, `$1${version}"`));
console.log(`version set to ${version}`);
