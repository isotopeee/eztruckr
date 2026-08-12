import base from './base.mjs';

export default [
  ...base,
  {
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      // Nest DI relies on decorator metadata and parameter properties.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/interface-name-prefix': 'off',

      // MUST stay off for Nest. A class injected via the constructor appears
      // only in type position, so the rule would rewrite it to `import type`
      // and erase it at compile time — but `emitDecoratorMetadata` needs the
      // runtime value in `design:paramtypes`, so DI would break at boot.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
