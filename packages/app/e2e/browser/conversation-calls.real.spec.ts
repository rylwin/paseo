import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openSettings } from "../support/helpers/app";

test.use({ channel: process.env.CALL_TEST_BROWSER_CHANNEL });
test.setTimeout(120000);

test("normal Pi conversation offers calling; an unsupported host shows recovery without replacing chat", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "paseo-conversation-call-", git: false });
  try {
    const pi = await workspace.client.createAgent({
      provider: "pi",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.workspaceId,
      title: "Harmless call target",
    });
    const serverId = await getServerId();
    await page.goto(`/h/${serverId}/agent/${pi.id}`);
    await expect(page.getByTestId("conversation-call-start")).toBeVisible({ timeout: 60000 });
    await page.getByTestId("conversation-call-start").click();
    const host = page.getByTestId("conversation-call-host");
    await expect(host).toContainText("Update the host");
    await expect(host).toContainText("Harmless call target");
    await expect(page.locator("audio[data-testid='conversation-call-audio']")).toHaveCount(0);
    await page.getByRole("button", { name: "Minimize call", exact: true }).click();
    await openSettings(page);
    await expect(host).toContainText("Harmless call target");
    await page.getByRole("button", { name: "Dismiss call", exact: true }).click();
    await expect(host).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
