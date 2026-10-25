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

test("hangup during microphone connection preserves an ended call across navigation", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "paseo-call-cancel-", git: false });
  try {
    const pi = await workspace.client.createAgent({
      provider: "pi",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.workspaceId,
      title: "Connecting call target",
    });
    const serverId = await getServerId();
    await page.context().grantPermissions(["microphone"]);
    await page.goto(`/h/${serverId}/agent/${pi.id}`);
    await page.getByTestId("conversation-call-start").click();
    await page.getByRole("button", { name: "End call", exact: true }).click();
    const host = page.getByTestId("conversation-call-host");
    await expect(host).toContainText("Call ended");
    await openSettings(page);
    await expect(host).toContainText("Call ended");
    await expect(page.locator("audio[data-testid='conversation-call-audio']")).toHaveCount(0);
    const agents = await workspace.client.fetchAgents();
    expect(agents.entries.find((entry) => entry.agent.id === pi.id)?.agent.status).toBe("idle");
  } finally {
    await workspace.cleanup();
  }
});

test("normal coding question reaches the captured Pi and returns an actual answer and nonzero audio", async ({
  page,
}, testInfo) => {
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
    await expect(page.getByTestId("conversation-call-start")).toBeVisible({ timeout: 60000 });
    await page.getByTestId("conversation-call-start").click();
    const host = page.getByTestId("conversation-call-host");
    await expect(host).toContainText("Connected", { timeout: 90000 });
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
    await expect(page.getByTestId("conversation-call-delegation")).toContainText("Pi replied:", {
      timeout: 100000,
    });
    await expect(page.getByTestId("conversation-call-delegation")).toContainText(
      /discriminated|TypeScript|union/i,
    );
    const audio = await audioPeak;
    expect(audio.peak).toBeGreaterThan(3);
    const delegationTimes = delegationEvents
      .filter((entry) => entry.event.kind === "delegation" && entry.event.status === "working")
      .map((entry) => entry.at);
    expect(delegationTimes).toHaveLength(1);
    expect(audio.at).toBeLessThan(delegationTimes[0]);
    expect(rpcTypes).toContain("conversation.call.start.request");
    await page.screenshot({ path: testInfo.outputPath("conversation-call-connected.png") });
    await page.getByRole("button", { name: "Minimize call", exact: true }).click();
    await openSettings(page);
    await expect(host).toContainText("Harmless live call target");
    await page.getByRole("button", { name: "End call", exact: true }).click();
    await expect(host).toContainText("Call ended");
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
