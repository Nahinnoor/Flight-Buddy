// Flat config for the Expo app. The repo-root config deliberately ignores
// `apps/mobile/**` and defers to this one, because Expo's preset carries the
// React Native, React Hooks and expo-router rules that the rest of the
// monorepo has no use for.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'expo-env.d.ts'],
  },
  {
    // Pinned rather than "detect": eslint-plugin-react's auto-detection calls
    // `context.getFilename()`, which ESLint 10 removed, so detection throws
    // before any rule runs. Stating the version skips that path entirely.
    settings: { react: { version: '19.2' } },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
]);
