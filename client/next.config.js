/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep compiled pages in dev server memory longer to avoid recompilation lag
  onDemandEntries: {
    maxInactiveAge: 120 * 1000, // 2 minutes (was 25s — caused constant recompilation)
    pagesBufferLength: 8,       // keep 8 pages in memory (was 2)
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Stub Node.js modules for browser builds.
      // @arcium-hq/client and Solana wallet adapters reference these
      // but don't use them in the browser code paths we invoke.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        path: false,
        os: false,
        stream: false,
        http: false,
        https: false,
        zlib: false,
        child_process: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
