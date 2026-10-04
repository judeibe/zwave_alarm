// semantic-release: https://semantic-release.org/usage/configuration
// The version comes only from the Conventional Commits since the last vX.Y.Z tag; nothing is bumped by hand.
const preset = 'conventionalcommits'; // understands "type!:" as well as BREAKING CHANGE footers

export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset }],
    ['@semantic-release/release-notes-generator', { preset }],
    // Writes the new version into the files that record it, before the git plugin commits them.
    ['@semantic-release/exec', { prepareCmd: 'node scripts/set-version.mjs ${nextRelease.version}' }],
    [
      '@semantic-release/git',
      { assets: ['package.json', 'package-lock.json'], message: 'chore(release): v${nextRelease.version} [skip ci]' },
    ],
    '@semantic-release/github',
  ],
};
