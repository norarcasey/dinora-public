import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The two rules that matter are the bans on `as` and `!`. Everything an app reads is untyped
 * until proven otherwise — a response, a stored row, a file — and a cast is how that data gets
 * into the type system while still being whatever it was. Narrow at runtime or parse with a
 * schema (`packages/core/src/parse.ts`); the compiler cannot help with either once it has been
 * told the answer.
 *
 * Type-aware (`recommendedTypeChecked`) because `no-floating-promises` and the `no-unsafe-*`
 * family need types to see anything at all. Noradar's config, not Nora Bene's: the latter is
 * untyped `recommended`, has neither ban, and carried ~28 casts when audited on 23 Sep 2026.
 */
export default defineConfig(
  // `.claude/worktrees` holds other sessions' checkouts of this repository. ESLint reads no
  // .gitignore, so without this `eslint .` lints their half-finished edits as part of this
  // one: measured 24 Sep 2026, a nested worktree's `as` failed the main checkout's lint.
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.claude/worktrees/**',
      '.vercel/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // A file that only re-exports makes every import reach the whole module graph. Import
      // from the file that defines the thing.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportAllDeclaration',
          message: 'No barrel files: import from the file that defines it.',
        },
      ],
    },
  },
  {
    // The core is the layer that can be tested exhaustively without a browser, and it stays
    // that way only if nothing is allowed in. Globals are already a compile error there (its
    // tsconfig has no DOM and no ambient types); this catches the imports.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', 'react/*', 'node:*', '@supabase/*', 'idb'],
              message:
                'packages/core imports no React, no Node built-ins, no database client and no browser API.',
            },
          ],
        },
      ],
    },
  },
  {
    // What runs on Vercel is compiled file by file and ships only what it can trace, so a
    // workspace package name — whose exports point at .ts source — is not found at runtime.
    // A relative path into packages/core works, because the root tsconfig rewrites `.ts`
    // specifiers. Both measured with `vercel build` (SKL-03).
    files: ['api/**/*.ts', 'middleware.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dinora/*'],
              message:
                'A deployed function cannot resolve a workspace package. Import by relative path: ../packages/core/src/<file>.ts',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // Tests build fixtures and assert on shapes; a narrowing throw in every one would bury
    // the assertion. They still may not cast.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // JavaScript has no types to check. Type-aware rules report every line of it as unsafe,
    // which is true and useless.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
