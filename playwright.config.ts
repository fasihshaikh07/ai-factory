// Browser test for `factory ui` (npm run test:ui). Not part of `npm test`, which stays fast and offline.
// The server is tests/ui/serve.ts: sample runs in a throwaway FACTORY_HOME, a stub executor.
import { defineConfig } from "@playwright/test";

const PORT = 4399;
export default defineConfig({
  testDir: "tests/ui",
  testMatch: /.*\.pw\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
  webServer: {
    command: `npx tsx tests/ui/serve.ts`,
    env: { UI_PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/app.css`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
  },
});
