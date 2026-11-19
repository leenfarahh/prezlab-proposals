import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Proposals are served at /prezlab/<link-name>/ so relative asset paths
  // (images, css) inside the original HTML resolve correctly. Keep the trailing slash.
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  // Hide the "N" badge in development. Compile and runtime errors still show.
  devIndicators: false,
};

export default nextConfig;
