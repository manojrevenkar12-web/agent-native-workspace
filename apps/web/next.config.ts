import type { NextConfig } from "next";

const config: NextConfig = {
  reactCompiler: true,
  transpilePackages: ["@anw/sync", "@anw/sheets", "@anw/agent"],
  poweredByHeader: false,
  devIndicators: false,
};

export default config;
