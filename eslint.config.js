// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // src/web is unbundled browser JS served as-is (T030) — no Node/TS
    // globals, no build step, so it's out of scope for this project's
    // Node-focused TypeScript lint config.
    ignores: ['dist/', 'node_modules/', 'coverage/', 'src/web/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
);
