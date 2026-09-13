/**
 * Expo's ambient types — asset and CSS module declarations, `process.env`
 * typings, and the rest.
 *
 * Expo writes the same reference into `expo-env.d.ts` when a dev server starts,
 * but that file is git-ignored, so on a fresh clone `npm run typecheck` would
 * fail on `import '@/global.css'` until somebody happened to run `expo start`.
 * This file is committed, so the typecheck stands on its own.
 */
/// <reference types="expo/types" />

export {};
