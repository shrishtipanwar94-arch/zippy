import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat config. Type-aware linting is deliberately off for now — it needs a
 * project reference and slows the run — but `no-explicit-any` is on because the
 * readability contract forbids `any`.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
