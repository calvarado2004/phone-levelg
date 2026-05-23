import { expect, test } from "@playwright/test";

test("login screen is presentable on mobile viewport", async ({ page }) => {
  await page.goto("/?screen=login");

  await expect(page.getByText("Phone LevelG")).toBeVisible();
  await expect(page.getByPlaceholder("Name")).toBeVisible();
  await expect(page.getByPlaceholder("Invite code")).toBeVisible();
  await expect(page.getByText("Join")).toBeVisible();

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

  await page.getByRole("button").nth(0).click();
  await expect(page.getByText("Encrypted room call")).toBeVisible();

  await expect(page).toHaveScreenshot("chat-screen.png", {
    fullPage: true,
    maxDiffPixelRatio: 0.03
  });
});
