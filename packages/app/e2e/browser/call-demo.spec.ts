import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { hideDeveloperToasts } from "../support/developer-ui.mjs";

// This surface is intentionally absent unless Metro was started with the demo flag.
test.skip(process.env.EXPO_PUBLIC_CALL_UI_DEMO !== "1", "Opt-in call UI demo only");

for (const width of [1440, 390]) {
  test(`simulated call controls and local chat at ${width}px`, async ({ page }) => {
    await hideDeveloperToasts(page);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`http://localhost:${process.env.E2E_METRO_PORT}/open-project`);
    await expect(page.getByText("Call UI demo", { exact: true })).toBeVisible();
    await expect(page.getByText("Connecting...", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Toggle simulation scenarios" }).click();
    await page.getByRole("button", { name: "Simulate connected", exact: true }).click();
    await page.getByRole("button", { name: "Toggle simulation scenarios" }).click();
    await expect(page.getByText("Simulated voice activity", { exact: true })).toBeVisible();
    const evidence = path.resolve(__dirname, "../../../..", ".impeccable/review");
    await mkdir(evidence, { recursive: true });
    const viewport = width === 1440 ? "desktop" : "mobile";
    await page.screenshot({ path: path.join(evidence, `${viewport}.png`), fullPage: true });
    await page.getByRole("button", { name: "Mute microphone (simulated)", exact: true }).click();
    await expect(page.getByText("Microphone muted (simulated)", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Minimize call", exact: true }).click();
    await expect(page.getByTestId("call-minimized")).toBeVisible();
    await page
      .getByRole("textbox", { name: "Local demo chat message" })
      .fill("Keep working while I am on the call");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("Keep working while I am on the call", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(evidence, `${viewport}-minimized.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Expand call", exact: true }).click();
    await expect(page.getByText("Microphone muted (simulated)", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Unmute microphone (simulated)", exact: true }).click();
    await expect(page.getByText("Simulated voice activity", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Toggle simulation scenarios" }).click();
    await page.getByRole("button", { name: "Simulate reconnecting", exact: true }).click();
    await expect(page.getByText("Audio paused while reconnecting", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Simulate failed", exact: true }).click();
    await page.getByRole("button", { name: "Toggle simulation scenarios" }).click();
    await expect(page.getByRole("alert")).toContainText("Simulated connection lost");
    await page.screenshot({ path: path.join(evidence, `${viewport}-failed.png`), fullPage: true });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByText("Connecting...", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Hang up call", exact: true }).click();
    await expect(page.getByText("Call ended", { exact: true })).toBeVisible();
    await expect(page.getByText("Pi is working (simulated)", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Call again", exact: true }).click();
    await expect(page.getByText("Connecting...", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Minimize call", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Local demo chat message" })
      .fill("A long local message to check independent chat scrolling. ".repeat(100));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("call-minimized")).toBeInViewport();
    await expect(page.getByRole("textbox", { name: "Local demo chat message" })).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
