import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Required for the slim runtime stage in Dockerfile.
  output: 'standalone',
  // Workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ['@eztruckr/types'],
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
};

export default nextConfig;
