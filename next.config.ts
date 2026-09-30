import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-mode badge overlaps the sidebar profile during prototype demos.
  devIndicators: false,
  experimental: {
    // The project lives in a OneDrive folder; OneDrive locks Turbopack's on-disk cache files,
    // which can crash `next dev`. Keeping the dev cache in memory avoids that.
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
