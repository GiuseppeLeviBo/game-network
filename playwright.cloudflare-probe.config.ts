import { defineConfig, devices } from "@playwright/test";

const durationMs = Number(process.env.GAME_NETWORK_PROBE_DURATION_MS ?? 300_000);

export default defineConfig({
  testDir: "./tests/probes",
  timeout: durationMs + 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["line"], ["html", { open: "never", outputFolder: "playwright-report-cloudflare-probe" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

