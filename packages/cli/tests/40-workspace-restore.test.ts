#!/usr/bin/env npx tsx

import assert from "node:assert";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

console.log("=== Workspace Restore Command ===\n");

const ctx = await createE2ETestContext({ timeout: 30000 });

try {
  await writeFile(join(ctx.workDir, "notes.txt"), "Keep my local changes\n");
  await mkdir(join(ctx.workDir, "nested"));
  await writeFile(join(ctx.workDir, "nested", "data.bin"), Buffer.from([0, 1, 255]));
  const originalDirectory = await stat(ctx.workDir);

  const created = await ctx.paseo([
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    ctx.workDir,
    "--json",
  ]);
  assert.strictEqual(created.exitCode, 0, created.stderr);
  const { workspaceId } = JSON.parse(created.stdout);
  assert.strictEqual(typeof workspaceId, "string");

  const archived = await ctx.paseo(["workspace", "archive", workspaceId, "--json"]);
  assert.strictEqual(archived.exitCode, 0, archived.stderr);
  const archivedList = await ctx.paseo(["workspace", "ls", "--json"]);
  assert.strictEqual(archivedList.exitCode, 0, archivedList.stderr);
  assert.deepStrictEqual(JSON.parse(archivedList.stdout), []);

  const restored = await ctx.paseo(["workspace", "restore", workspaceId, "--json"]);
  assert.strictEqual(restored.exitCode, 0, restored.stderr);
  assert.deepStrictEqual(JSON.parse(restored.stdout), { workspaceId, status: "restored" });

  const activeList = await ctx.paseo(["workspace", "ls", "--json"]);
  assert.strictEqual(activeList.exitCode, 0, activeList.stderr);
  const workspaces = JSON.parse(activeList.stdout);
  assert.strictEqual(workspaces.length, 1);
  assert.strictEqual(workspaces[0].workspaceId, workspaceId);
  assert.strictEqual(workspaces[0].cwd, ctx.workDir);
  assert.strictEqual((await stat(ctx.workDir)).ino, originalDirectory.ino);
  assert.deepStrictEqual((await readdir(ctx.workDir)).sort(), ["nested", "notes.txt"]);
  assert.strictEqual(
    await readFile(join(ctx.workDir, "notes.txt"), "utf8"),
    "Keep my local changes\n",
  );
  assert.deepStrictEqual(
    await readFile(join(ctx.workDir, "nested", "data.bin")),
    Buffer.from([0, 1, 255]),
  );

  const repeated = await ctx.paseo(["workspace", "restore", workspaceId, "--json"]);
  assert.strictEqual(repeated.exitCode, 0, repeated.stderr);
  assert.deepStrictEqual(JSON.parse(repeated.stdout), { workspaceId, status: "already_active" });
} finally {
  await ctx.stop();
}

console.log("=== Workspace Restore Command Tests Passed ===");
