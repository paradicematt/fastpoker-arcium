/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep compiled pages in dev server memory longer to avoid recompilation lag
  onDemandEntries: {
    maxInactiveAge: 120 * 1000, // 2 minutes (was 25s — caused constant recompilation)
    pagesBufferLength: 8,       // keep 8 pages in memory (was 2)
  },
};

module.exports = nextConfig;
