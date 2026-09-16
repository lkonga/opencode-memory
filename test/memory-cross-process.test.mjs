import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { createMemory } from "../memory-core.mjs"

const worker = fileURLToPath(new URL("./memory-worker.mjs", import.meta.url))
const moduleUrl = new URL("../memory-core.mjs", import.meta.url).href
const exists = (target) => fs.lstat(target).then(() => true, () => false)

function runChild(payload) {
  const child = spawn(process.execPath, [worker, JSON.stringify(payload)], { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const done = new Promise((resolve, reject) => child.once("error", reject).once("exit", (code) => {
    if (code !== 0) reject(new Error(`worker failed (${code}): ${stderr}`))
    else resolve(JSON.parse(stdout))
  }))
  return { child, done }
}

async function waitFor(target, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await exists(target)) return
    if (child.exitCode !== null) throw new Error("worker exited before acquiring its lock")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("timed out waiting for cross-process lock")
}

test("same-directory update and rename serialize through a real cross-process wx lock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-process-lock-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const projectDir = path.join(root, "project")
  const userRoot = path.join(root, "config", "memories")
  const ready = path.join(root, "ready")
  const gate = path.join(root, "gate")
  await fs.mkdir(projectDir, { recursive: true })
  const engine = createMemory({ projectDir, userRoot })
  await engine.run({ command: "create", path: "/memories/source.md", file_text: "before" }, "s")

  const common = { module: moduleUrl, projectDir, userRoot, sessionID: "s" }
  const updater = runChild({
    ...common,
    pause: true,
    ready,
    gate,
    args: { command: "str_replace", path: "/memories/source.md", old_str: "before", new_str: "after" },
  })
  await waitFor(ready, updater.child)
  const renamer = runChild({
    ...common,
    args: { command: "rename", old_path: "/memories/source.md", new_path: "/memories/destination.md" },
  })
  const renameResult = await renamer.done
  await fs.writeFile(gate, "go")
  const updateResult = await updater.done

  assert.equal(updateResult.outcome.ok, true)
  assert.equal(renameResult.outcome.code, "conflict")
  assert.equal(await fs.readFile(path.join(userRoot, "source.md"), "utf8"), "after")
  assert.equal(await exists(path.join(userRoot, "destination.md")), false)
  assert.deepEqual((await fs.readdir(userRoot)).filter((name) => name.startsWith(".memory-tmp-") || name.startsWith(".memory-lock-")), [])
})
