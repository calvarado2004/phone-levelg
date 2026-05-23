import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: "http://127.0.0.1:8098",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "ios-sized",
      use: {
        ...devices["iPhone 15"],
        browserName: "chromium"
      }
    },
    {
      name: "android-sized",
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium"
      }
    }
  ],
  webServer: {
    command: "CI=1 HOME=/private/tmp/phone-levelg-expo-home EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_E2E_MODE=1 npx expo export --platform web --output-dir /private/tmp/phone-levelg-web && python3 -m http.server 8098 --bind 127.0.0.1 --directory /private/tmp/phone-levelg-web",
    cwd: "./apps/mobile",
    url: "http://127.0.0.1:8098",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
