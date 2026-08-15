import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Required for the slim runtime stage in Dockerfile.
  output: 'standalone',
  // Workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ['@eztruckr/types'],
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

  /**
   * `@swc/helpers`, in full, because the tracer copies half of it.
   *
   * Next's own runtime require-hook loads `@swc/helpers/_/_interop_require_*`,
   * whose `exports` map answers `esm/*.js` under the `module-sync` and `import`
   * conditions and `cjs/*.cjs` under `default`. File tracing follows the CJS
   * condition and copies only `cjs/`; Node then resolves `module-sync` at run
   * time and finds nothing. The standalone server dies at its first require
   * with MODULE_NOT_FOUND — a build that succeeds and an image that cannot
   * boot, which is why this was only ever going to be caught by starting it.
   *
   * Appeared with Next 16. Try removing it on the next upgrade: if
   * `.next/standalone/.../@swc/helpers/esm` exists without this, it is fixed.
   */
  outputFileTracingIncludes: {
    '**': ['../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**'],
  },
};

export default nextConfig;
