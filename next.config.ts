import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  // With output: export, Next uses a custom distDir for the exported site.
  distDir: process.env.NEXT_LOCAL_BUILD === 'true' ? '.local/web' : '.next',
  trailingSlash: true,
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '',
};

export default nextConfig;
