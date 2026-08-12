/**
 * Single source of Prettier truth for the whole monorepo.
 * Every package re-exports this via its own .prettierrc.json.
 */

/** @type {import("prettier").Config} */
const config = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  arrowParens: 'always',
  bracketSpacing: true,
  endOfLine: 'lf',
  overrides: [
    {
      files: '*.md',
      options: { proseWrap: 'preserve' },
    },
    {
      files: '*.{yml,yaml}',
      options: { singleQuote: false },
    },
  ],
};

export default config;
