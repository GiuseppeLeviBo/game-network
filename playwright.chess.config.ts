import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "single-file-chess-network.spec.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
});
