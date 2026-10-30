import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Every run starts from a fresh workspace database.
const db = join(mkdtempSync(join(tmpdir(), "anw-e2e-")), "e2e.db");

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3417", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    {
      command: "npx tsx src/main.ts",
      cwd: "../server",
      port: 4417,
      env: { ANW_DEV: "1", ANW_DB: db },
      reuseExistingServer: false,
    },
    { command: "npx next start -p 3417", port: 3417, reuseExistingServer: false },
  ],
});
