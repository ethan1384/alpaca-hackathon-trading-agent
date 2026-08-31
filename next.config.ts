import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@alpacahq/alpaca-trade-api", "ws", "@msgpack/msgpack"],
};

export default nextConfig;
