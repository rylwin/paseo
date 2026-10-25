import { test, expect } from "../support/fixtures";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openSettings } from "../support/helpers/app";

const codexName = process.platform === "win32" ? "codex.exe" : "codex";
const candidates = (process.env.PATH ?? "")
  .split(path.delimiter)
  .map((entry) => path.join(entry, codexName));
const codexBinary = process.env.CALL_CODEX_BINARY ?? candidates.find((entry) => existsSync(entry));
const fixture =
  process.env.CALL_AUDIO_FIXTURE ?? path.join(tmpdir(), "paseo-conversation-call.wav");
test.use({
  channel: process.env.CALL_TEST_BROWSER_CHANNEL,
  e2eDaemonEnvironment: { PASEO_CONVERSATION_CALLS_CODEX_BINARY: codexBinary ?? "missing-codex" },
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fixture}`],
  },
});
test.setTimeout(150000);

test("denied microphone access stays visible with retry on a compact conversation", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "paseo-call-denied-", git: false });
  try {
    const pi = await workspace.client.createAgent({
      provider: "pi",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.workspaceId,
      title: "Microphone permission target",
    });
    const serverId = await getServerId();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/h/${serverId}/agent/${pi.id}`);
    await page.getByTestId("conversation-call-start").click();
    await expect(page.getByTestId("conversation-call-host")).toContainText(
      "Microphone permission denied",
    );
    await expect(page.getByRole("button", { name: "Call again", exact: true })).toBeEnabled();
    await expect(page.locator("audio[data-testid='conversation-call-audio']")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("conversation-call-compact-error.png") });
  } finally {
    await workspace.cleanup();
  }
});

for (const width of [1280, 390]) {
  test(`phone geometry stays stable while connecting and cancelling at ${width}px`, async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "paseo-call-cancel-", git: false });
    try {
      const pi = await workspace.client.createAgent({
        provider: "pi",
        cwd: workspace.workspaceDirectory,
        workspaceId: workspace.workspaceId,
        title: "Connecting call target",
      });
      const serverId = await getServerId();
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
      });
      await page.goto(`/h/${serverId}/agent/${pi.id}`);
      const phone = page.getByTestId("conversation-call-start");
      await expect(phone).toBeVisible();
      const idleBox = await phone.boundingBox();
      expect(idleBox).not.toBeNull();
      expect(await phone.locator("..").boundingBox()).toEqual(idleBox);
      await expect(page.getByRole("button", { name: /mute microphone/i })).toHaveCount(0);
      await page.mouse.move(0, 0);
      const idleBackground = await phone.evaluate(
        (button) => getComputedStyle(button).backgroundColor,
      );
      await phone.click();
      await page.mouse.move(0, 0);
      await expect
        .poll(() => phone.evaluate((button) => getComputedStyle(button).backgroundColor))
        .not.toBe(idleBackground);
      await expect(phone).toHaveAttribute("aria-pressed", "true");
      await expect(phone).toHaveAccessibleName("Cancel call");
      expect(await phone.boundingBox()).toEqual(idleBox);
      await expect(page.getByRole("button", { name: /mute microphone/i })).toHaveCount(0);
      expect(await phone.locator("..").boundingBox()).toEqual(idleBox);
      await page.screenshot({ path: testInfo.outputPath("call-connecting.png") });
      await page.setViewportSize({ width: 1280, height: 900 });
      await openSettings(page);
      await page.setViewportSize({ width, height: 900 });
      const host = page.getByTestId("conversation-call-host");
      await expect(host.getByRole("button")).toHaveCount(2);
      await expect(page.getByRole("button", { name: /mute microphone/i })).toHaveCount(0);
      await host
        .getByRole("button", { name: "Return to call with Connecting call target" })
        .click();
      await expect(phone).toHaveAccessibleName("Cancel call");
      expect(await phone.boundingBox()).toEqual(idleBox);
      await phone.click();
      await page.mouse.move(0, 0);
      await expect(phone).toHaveAttribute("aria-pressed", "false");
      await phone.blur();
      await phone.hover();
      await page.mouse.move(500, 400);
      await expect
        .poll(() => phone.evaluate((button) => getComputedStyle(button).backgroundColor))
        .toBe(idleBackground);
      await expect(phone).toHaveAccessibleName("Call this Pi agent with GPT-Live");
      expect(await phone.boundingBox()).toEqual(idleBox);
      await expect(page.getByRole("button", { name: /mute microphone/i })).toHaveCount(0);
      await expect(page.getByTestId("conversation-call-host")).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openSettings(page);
      await expect(page.getByTestId("conversation-call-host")).toHaveCount(0);
      await expect(page.locator("audio[data-testid='conversation-call-audio']")).toHaveCount(0);
      const agents = await workspace.client.fetchAgents();
      expect(agents.entries.find((entry) => entry.agent.id === pi.id)?.agent.status).toBe("idle");
    } finally {
      await workspace.cleanup();
    }
  });
}

test("normal coding question reaches the captured Pi and returns an actual answer and nonzero audio", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(180000);
  const workspace = await seedWorkspace({ repoPrefix: "paseo-live-call-", git: false });
  try {
    const pi = await workspace.client.createAgent({
      provider: "pi",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.workspaceId,
      title: "Harmless live call target",
    });
    const serverId = await getServerId();
    await page.context().grantPermissions(["microphone"]);
    const rpcTypes: string[] = [];
    const delegationEvents: Array<{
      at: number;
      event: { kind: string; status?: string; text?: string };
    }> = [];
    page.on("websocket", (socket) => {
      socket.on("framesent", (frame) => {
        try {
          const envelope = JSON.parse(String(frame.payload));
          if (envelope.message?.type?.startsWith("conversation.call."))
            rpcTypes.push(envelope.message.type);
        } catch {}
      });
      socket.on("framereceived", (frame) => {
        try {
          const envelope = JSON.parse(String(frame.payload));
          if (envelope.message?.type === "conversation.call.event")
            delegationEvents.push({ at: Date.now(), event: envelope.message.payload.event });
        } catch {}
      });
    });
    await page.goto(`/h/${serverId}/agent/${pi.id}`);
    const phone = page.getByTestId("conversation-call-start");
    await expect(phone).toBeVisible({ timeout: 60000 });
    const viewports = [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ];
    const idleBoxes = new Map<number, Awaited<ReturnType<typeof phone.boundingBox>>>();
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await expect(phone).toBeVisible();
      idleBoxes.set(viewport.width, await phone.boundingBox());
    }
    await page.setViewportSize(viewports[0]);
    await phone.click();
    const host = page.getByTestId("conversation-call-host");
    await expect(phone).toHaveAccessibleName("End call", { timeout: 90000 });
    await expect(phone).toHaveAttribute("aria-pressed", "true");
    await expect(host).toHaveCount(0);
    await expect(page.getByRole("button", { name: /mute microphone/i })).toHaveCount(0);
    const audioPeak = page
      .locator("audio[data-testid='conversation-call-audio']")
      .evaluate(async (audio: HTMLAudioElement) => {
        const context = new AudioContext();
        await context.resume();
        const analyser = context.createAnalyser();
        context.createMediaStreamSource(audio.srcObject as MediaStream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        let peak = 0;
        for (let i = 0; i < 900; i++) {
          analyser.getByteTimeDomainData(samples);
          peak = Math.max(peak, ...samples.map((sample) => Math.abs(sample - 128)));
          if (peak > 3) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await context.close();
        return { peak, at: Date.now() };
      });
    await expect
      .poll(
        () =>
          delegationEvents
            .filter((entry) => entry.event.kind === "delegation")
            .map((entry) => entry.event.text)
            .join("\n"),
        { timeout: 100000 },
      )
      .toContain("Pi replied:");
    const reply = delegationEvents
      .filter((entry) => entry.event.kind === "delegation")
      .map((entry) => entry.event.text)
      .join("\n");
    expect(reply).toMatch(/discriminated|TypeScript|union/i);
    expect(reply).toContain(workspace.workspaceDirectory);
    await expect(page.getByTestId("conversation-call-delegation")).toHaveCount(0);
    await expect(page.getByTestId("conversation-call-transcript")).toHaveCount(0);
    const audio = await audioPeak;
    expect(audio.peak).toBeGreaterThan(3);
    const delegationTimes = delegationEvents
      .filter((entry) => entry.event.kind === "delegation" && entry.event.status === "working")
      .map((entry) => entry.at);
    expect(delegationTimes).toHaveLength(1);
    expect(audio.at).toBeLessThan(delegationTimes[0]);
    expect(rpcTypes).toContain("conversation.call.start.request");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await expect(phone).toBeVisible();
        await expect.poll(() => phone.boundingBox()).toEqual(idleBoxes.get(viewport.width));
        await expect(page.getByRole("button", { name: /mute microphone/i })).toHaveCount(0);
        expect(await phone.locator("..").boundingBox()).toEqual(idleBoxes.get(viewport.width));
        await expect
          .poll(async () => (await phone.boundingBox())?.width ?? 0)
          .toBeGreaterThanOrEqual(44);
        await expect
          .poll(async () => (await phone.boundingBox())?.height ?? 0)
          .toBeGreaterThanOrEqual(44);
        await page.screenshot({
          path: testInfo.outputPath(`call-${colorScheme}-${viewport.width}.png`),
        });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettings(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(host).toContainText("Harmless live call target");
    await expect(host).not.toContainText(pi.id);
    await expect(host.getByRole("button")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /mute microphone/i })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("call-away-mobile-dark.png") });
    await page
      .getByRole("button", { name: "Return to call with Harmless live call target", exact: true })
      .click();
    await expect(phone).toHaveAccessibleName("End call");
    await expect(host).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/h/${serverId}/workspace/`));
    await phone.click();
    await expect(phone).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => phone.boundingBox()).toEqual(idleBoxes.get(390));
    await expect(host).toHaveCount(0);
    await expect(page.locator("audio[data-testid='conversation-call-audio']")).toHaveCount(0);
    const evidence = JSON.stringify({ rpcTypes, delegationEvents, audio }, null, 2);
    const evidenceDir = path.join(tmpdir(), "paseo-conversation-evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "real-call.json"), evidence);
    await testInfo.attach("call-evidence", { body: evidence, contentType: "application/json" });
  } finally {
    await workspace.cleanup();
  }
});
