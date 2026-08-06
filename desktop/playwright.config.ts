import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  timeout: 30_000,
  expect: { timeout: 8_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  use: {
    baseURL: "http://127.0.0.1:1424",
    browserName: "chromium",
    colorScheme: "dark",
    deviceScaleFactor: 1,
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1424",
    url: "http://127.0.0.1:1424",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
