import { test, expect, devices } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

// The real provider path uses synthetic speech, never a physical microphone.
const fixture =
  process.env.CALL_AUDIO_FIXTURE ?? path.join(tmpdir(), "paseo-call-browser-fixture.wav");
test.use({
  channel: process.env.CALL_TEST_BROWSER_CHANNEL,
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fixture}`],
  },
});
test.setTimeout(120000);
const preview = process.env.CALL_PREVIEW_URL ?? "http://localhost:8788";
const tokenPath = path.resolve(__dirname, "../../../..", ".dev/call-preview-token");

test("static preview stays mounted on desktop and mobile for 35 seconds", async ({ browser }) => {
  const profiles = [null, devices["iPhone 13"], devices["Pixel 7"]];
  const contexts = await Promise.all(
    profiles.map((device) =>
      browser.newContext(
        device
          ? {
              userAgent: device.userAgent,
              viewport: device.viewport,
              deviceScaleFactor: device.deviceScaleFactor,
              isMobile: true,
              hasTouch: true,
              permissions: [],
            }
          : { permissions: [] },
      ),
    ),
  );
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const documents = pages.map(() => 0);
    const devSockets: string[] = [];
    await Promise.all(
      pages.map(async (page, index) => {
        page.on("request", (request) => {
          if (request.resourceType() === "document") documents[index]++;
        });
        page.on("websocket", (socket) => {
          const pathname = new URL(socket.url()).pathname;
          if (pathname === "/hot" || pathname === "/message") devSockets.push(pathname);
        });
        const response = await page.goto(`${preview}/open-project?preview=stable-static-2`);
        expect(response?.headers()["x-paseo-call-preview"]).toBe("static");
        await expect(page.getByText("GPT-Live call", { exact: true })).toBeVisible({
          timeout: 30000,
        });
      }),
    );
    await pages[0].waitForTimeout(35000);
    expect(documents).toEqual([1, 1, 1]);
    expect(devSockets).toEqual([]);
    for (const page of pages) {
      await expect(page.getByText("GPT-Live call", { exact: true })).toBeVisible();
      await page
        .getByRole("textbox", { name: "Trial access token" })
        .fill((await readFile(tokenPath, "utf8")).trim());
      await page.getByRole("button", { name: "Start call", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Microphone permission denied");
      await expect(page.getByRole("button", { name: "Start call", exact: true })).toBeEnabled();
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("denied microphone permission stays visible and permits retry", async ({ browser }) => {
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await page.goto(`${preview}/open-project`);
  await expect(page.getByText("GPT-Live call", { exact: true })).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("textbox", { name: "Trial access token" })
    .fill((await readFile(tokenPath, "utf8")).trim());
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Microphone permission denied");
  await expect(page.getByRole("button", { name: "Start call", exact: true })).toBeEnabled();
  await context.close();
});

test("invalid access token ends microphone and offers retry", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  await page.goto(`${preview}/open-project`);
  await expect(page.getByText("GPT-Live call", { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole("textbox", { name: "Trial access token" }).fill("wrong-token");
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Trial access denied or expired", {
    timeout: 20000,
  });
  await expect(page.getByText(/Microphone off/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start call", exact: true })).toBeEnabled();
  expect(
    await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.srcObject === null),
  ).toBe(true);
  await context.close();
});

test("ending during connection cannot become connected later", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  await page.goto(`${preview}/open-project`);
  await expect(page.getByText("GPT-Live call", { exact: true })).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("textbox", { name: "Trial access token" })
    .fill((await readFile(tokenPath, "utf8")).trim());
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await page.getByRole("button", { name: "End call", exact: true }).click();
  await expect(page.getByText("Call ended", { exact: true })).toBeVisible();
  await page.waitForTimeout(10000);
  await expect(page.getByText("Call ended", { exact: true })).toBeVisible();
  expect(
    await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.srcObject === null),
  ).toBe(true);
  await context.close();
});

test("natural coding question reaches bound Pi and returns its fresh answer and audio", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(`${preview}/open-project`);
  await expect(page.getByText("GPT-Live call", { exact: true })).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("textbox", { name: "Trial access token" })
    .fill((await readFile(tokenPath, "utf8")).trim());
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 75000 });
  const audioEvidence = page.locator("audio").evaluate(async (audio: HTMLAudioElement) => {
    const audioContext = new AudioContext();
    await audioContext.resume();
    const analyser = audioContext.createAnalyser();
    audioContext.createMediaStreamSource(audio.srcObject as MediaStream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      analyser.getByteTimeDomainData(samples);
      peak = Math.max(peak, ...samples.map((sample) => Math.abs(sample - 128)));
      if (peak > 3) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await audioContext.close();
    return peak;
  });
  const reply = page.getByText(/^Pi replied:/);
  await expect(reply).toContainText("/tmp/paseo-call-prototype-20260719", { timeout: 90000 });
  await expect(reply).toContainText(/auth|token|origin/i);
  const audioPeak = await audioEvidence;
  expect(audioPeak).toBeGreaterThan(3);
  await expect
    .poll(() =>
      page
        .locator("audio")
        .evaluate((audio: HTMLAudioElement) => !audio.paused && audio.currentTime > 0),
    )
    .toBe(true);
  await testInfo.attach("live-call-evidence", {
    body: JSON.stringify({
      audioPeak,
      piReply: await reply.textContent(),
      browserPlayback: "playing",
    }),
    contentType: "application/json",
  });
  await page.getByRole("button", { name: "Mute microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unmute microphone", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Minimize call", exact: true }).click();
  await expect(page.getByRole("button", { name: "End call", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("live-call-mobile.png") });
  await page.getByRole("button", { name: "End call", exact: true }).click();
  await expect(page.getByText("Call ended", { exact: true })).toBeVisible();
  expect(
    await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.srcObject === null),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});
