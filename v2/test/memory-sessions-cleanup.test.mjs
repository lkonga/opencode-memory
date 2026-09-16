import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

import { CLEANUP_INTERVAL_MS, createMemory, RETENTION_MS } from "../memory-core.mjs"

async function makeCase(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-session-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const projectDir = path.join(root, "project")
  const userRoot = path.join(root, "config", "memories")
  await fs.mkdir(projectDir, { recursive: true })
  return { root, userRoot, engine: createMemory({ projectDir, userRoot, ...options }) }
}

const exists = (target) => fs.lstat(target).then(() => true, () => false)

describe("opaque session identities and legacy compatibility", () => {
  test("hashes identities without sanitized-name collisions", async (t) => {
    const { engine } = await makeCase(t)
    const slash = engine.sessionRoot("same/id")
    const question = engine.sessionRoot("same?id")
    assert.notEqual(slash, question)
    assert.match(path.basename(slash), /^[a-f0-9]{64}$/)
    assert.match(path.basename(question), /^[a-f0-9]{64}$/)
    await engine.run({ command: "create", path: "/memories/session/id.md", file_text: "slash" }, "same/id")
    await engine.run({ command: "create", path: "/memories/session/id.md", file_text: "question" }, "same?id")
    assert.equal(await fs.readFile(path.join(slash, "id.md"), "utf8"), "slash")
    assert.equal(await fs.readFile(path.join(question, "id.md"), "utf8"), "question")
  })

  test("rejects missing, null, and empty session IDs for session scope", async (t) => {
    const { engine } = await makeCase(t)
    for (const sessionID of [undefined, null, ""]) {
      assert.match(await engine.run({ command: "create", path: "/memories/session/x.md", file_text: "x" }, sessionID), /non-empty session ID/i)
      assert.throws(() => engine.sessionRoot(sessionID), /non-empty session ID/i)
    }
  })

  test("dot legacy names never escape their direct session child while hashed sessions work", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(path.join(userRoot, "session"), { recursive: true })
    await fs.writeFile(path.join(userRoot, "user-leak.md"), "USER-LEAK")
    await fs.writeFile(path.join(userRoot, "session", "session-leak.md"), "SESSION-LEAK")

    for (const sessionID of [".", ".."]) {
      assert.equal(engine.legacySessionRoot(sessionID), undefined)
      assert.match(await engine.run({ command: "view", path: "/memories/session/user-leak.md" }, sessionID), /does not exist/i)
      assert.match(await engine.run({ command: "view", path: "/memories/session/session-leak.md" }, sessionID), /does not exist/i)
      const context = await engine.buildContext(sessionID)
      const sessionContext = context.match(/<sessionMemory>([\s\S]*?)<\/sessionMemory>/)?.[1] ?? ""
      assert.doesNotMatch(sessionContext, /USER-LEAK|SESSION-LEAK|user-leak|session-leak/)
      assert.equal(await engine.run({ command: "create", path: "/memories/session/safe.md", file_text: sessionID }, sessionID), "Successfully created /memories/session/safe.md")
      assert.equal(await fs.readFile(path.join(engine.sessionRoot(sessionID), "safe.md"), "utf8"), sessionID)
    }
    assert.equal(await fs.readFile(path.join(userRoot, "user-leak.md"), "utf8"), "USER-LEAK")
    assert.equal(await fs.readFile(path.join(userRoot, "session", "session-leak.md"), "utf8"), "SESSION-LEAK")
  })

  test("reads and lists legacy sanitized directories while updates migrate to hashed storage", async (t) => {
    const { engine } = await makeCase(t)
    const sessionID = "legacy/id"
    const legacy = engine.legacySessionRoot(sessionID)
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "plan.md"), "old value")

    assert.match(await engine.run({ command: "view", path: "/memories/session/plan.md" }, sessionID), /old value/)
    assert.match(await engine.run({ command: "view", path: "/memories/session" }, sessionID), /plan\.md/)
    assert.match(await engine.buildContext(sessionID), /\/memories\/session\/plan\.md/)
    assert.match(await engine.run({ command: "str_replace", path: "/memories/session/plan.md", old_str: "old", new_str: "new" }, sessionID), /has been edited/)
    assert.equal(await fs.readFile(path.join(engine.sessionRoot(sessionID), "plan.md"), "utf8"), "new value")
    assert.equal(await fs.lstat(path.join(legacy, "plan.md")).then(() => true, () => false), false)
  })
})

describe("per-entry retention cleanup", () => {
  test("uses max(atime, mtime, recorded access), removes stale entries and eligible empties", async (t) => {
    let clock = Date.now() + 30 * 24 * 60 * 60 * 1000
    const { userRoot, engine } = await makeCase(t, { now: () => clock })
    const staleSession = "stale"
    const activeSession = "active"
    await engine.run({ command: "create", path: "/memories/session/old.md", file_text: "old" }, staleSession)
    await engine.run({ command: "create", path: "/memories/session/recent.md", file_text: "recent" }, activeSession)
    await engine.run({ command: "create", path: "/memories/session/touched.md", file_text: "touch" }, activeSession)
    clock += RETENTION_MS + 60_000
    const oldDate = new Date(clock - RETENTION_MS - 1_000)
    const recentDate = new Date(clock - RETENTION_MS + 60_000)
    const oldFile = path.join(engine.sessionRoot(staleSession), "old.md")
    const recentFile = path.join(engine.sessionRoot(activeSession), "recent.md")
    const touchedFile = path.join(engine.sessionRoot(activeSession), "touched.md")
    await fs.utimes(oldFile, oldDate, oldDate)
    await fs.utimes(recentFile, recentDate, recentDate)
    await fs.utimes(touchedFile, oldDate, oldDate)
    await engine.run({ command: "view", path: "/memories/session/touched.md" }, activeSession)

    const empty = path.join(userRoot, "session", "eligible-empty")
    await fs.mkdir(empty, { recursive: true })
    await fs.utimes(empty, oldDate, oldDate)
    const deleted = engine.cleanupStaleSessionDirs()

    assert.ok(deleted >= 2)
    assert.equal(await exists(oldFile), false)
    assert.equal(await exists(recentFile), true)
    assert.equal(await exists(touchedFile), true)
    assert.equal(await exists(empty), false)
  })

  test("tolerates entries disappearing before cleanup and runs hourly with unref/disposal", async (t) => {
    const calls = { unref: 0, clear: 0, interval: 0 }
    let callback
    const timer = { unref: () => { calls.unref += 1 } }
    const { engine } = await makeCase(t, {
      setInterval: (fn, interval) => { callback = fn; calls.interval = interval; return timer },
      clearInterval: (value) => { assert.equal(value, timer); calls.clear += 1 },
    })
    const disappearing = engine.sessionRoot("gone")
    await fs.mkdir(disappearing, { recursive: true })
    await fs.rm(disappearing, { recursive: true })
    assert.doesNotThrow(() => engine.cleanupStaleSessionDirs())
    engine.startCleanup()
    engine.startCleanup()
    assert.equal(calls.interval, CLEANUP_INTERVAL_MS)
    assert.equal(calls.unref, 1)
    assert.doesNotThrow(() => callback())
    engine.stopCleanup()
    engine.stopCleanup()
    assert.equal(calls.clear, 1)
  })
})
