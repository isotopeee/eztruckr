import base from './base.mjs';

export default [
  ...base,
  {
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },
];
