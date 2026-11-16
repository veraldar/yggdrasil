import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // scripts/release.sh builds with NEXT_OUTPUT=standalone: the release ships .next/standalone (only the
  // node_modules the server needs) instead of the whole dev tree. Everyday builds are unchanged.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
};

export default nextConfig;
