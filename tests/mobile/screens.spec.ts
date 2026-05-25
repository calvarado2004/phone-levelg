import { expect, test } from "@playwright/test";

test("login screen is presentable on mobile viewport", async ({ page }) => {
  await page.goto("/?screen=login");

  await expect(page.getByText("Phone LevelG")).toBeVisible();
  await expect(page.getByPlaceholder("Google email")).toBeVisible();
  await expect(page.getByPlaceholder("Display name")).toBeVisible();
  await expect(page.getByPlaceholder("Server URL")).toBeVisible();
  await expect(page.getByPlaceholder("Server secret")).toBeVisible();
  await expect(page.getByText("Connect")).toBeVisible();

  await expect(page).toHaveScreenshot("login-screen.png", {
    fullPage: true,
    maxDiffPixelRatio: 0.03
  });
});

test("chat screen renders messages, emoji row, and call actions", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Home")).toBeVisible();
  await expect(page.getByText("Dinner is ready in 10 👍")).toBeVisible();
  await expect(page.getByText("On my way 🎉")).toBeVisible();
  await expect(page.getByText("😂")).toBeVisible();

  await page.getByLabel("Start voice call in Home").click();
  await expect(page.getByText("Calling Home")).toBeVisible();
  await expect(page.getByText("Connected")).toBeVisible();

  await expect(page).toHaveScreenshot("chat-screen.png", {
    fullPage: true,
    maxDiffPixelRatio: 0.03
  });
});

test("incoming call screen can be answered", async ({ page }) => {
  await page.goto("/?screen=incoming");

  await expect(page.getByText("Incoming video call")).toBeVisible();
  await expect(page.getByText("Phone LevelG")).toBeVisible();
  await expect(page.getByLabel("Decline incoming call")).toBeVisible();
  await expect(page.getByLabel("Answer incoming call")).toBeVisible();

  await expect(page).toHaveScreenshot("incoming-call-screen.png", {
    fullPage: true,
    maxDiffPixelRatio: 0.03
  });

  await page.getByLabel("Answer incoming call").click();
  await expect(page.getByText("Calling Ana")).toBeVisible();
  await expect(page.getByText("Connected")).toBeVisible();
});
