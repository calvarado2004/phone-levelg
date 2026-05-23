import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: "http://127.0.0.1:8082",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "ios-sized",
      use: {
        ...devices["iPhone 15"]
      }
    },
    {
      name: "android-sized",
      use: {
        ...devices["Pixel 7"]
      }
    }
  ],
  webServer: {
    command: "HOME=/private/tmp/phone-levelg-expo-home EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_E2E_MODE=1 npx expo start --web --port 8082 --localhost",
    cwd: "./apps/mobile",
    url: "http://127.0.0.1:8082",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
