// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      // apps/mobile keeps its own Expo lint setup (`npm run lint -w mobile`).
      'apps/mobile/**',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // Server-side workspaces run on Node 22.
    files: ['apps/api/**', 'services/poller/**', 'packages/flight-provider/**'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The worker's `main.ts` starts the worker on import. Imported from a test, that
    // is a real worker on whatever database `.env` names, inside `npm test`. Static
    // imports and re-exports only; nothing here uses `import()`.
    files: ['services/poller/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.{1,2}/(.*/)?main(\\.[jt]s)?$',
              message: 'main.ts starts the worker on import; move what you need out of it.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
