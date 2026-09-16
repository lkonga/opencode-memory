import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, test } from "node:test"

import { CLEANUP_INTERVAL_MS, RETENTION_MS, createMemory } from "../memory-core.mjs"
import { exists, makeCase } from "./helpers.mjs"

describe("opaque session identities and legacy compatibility", () => {
  test("uses collision-resistant SHA-256 names without exposing the raw ID", async (t) => {
    const { engine } = await makeCase(t)
    const slash = engine.sessionRoot("same/id")
    const question = engine.sessionRoot("same?id")
    assert.notEqual(slash, question)
    assert.equal(path.basename(slash), createHash("sha256").update("same/id").digest("hex"))
    assert.equal(path.basename(question), createHash("sha256").update("same?id").digest("hex"))
    assert.doesNotMatch(slash, /same[/?]id/)
    await engine.run({ command: "create", path: "/memories/session/id.md", file_text: "slash" }, "same/id")
    await engine.run({ command: "create", path: "/memories/session/id.md", file_text: "question" }, "same?id")
    assert.equal(await fs.readFile(path.join(slash, "id.md"), "utf8"), "slash")
    assert.equal(await fs.readFile(path.join(question, "id.md"), "utf8"), "question")
  })

  test("rejects missing, null, and empty session IDs", async (t) => {
    const { engine } = await makeCase(t)
    for (const sessionID of [undefined, null, ""]) {
      assert.match(await engine.run({ command: "create", path: "/memories/session/x.md", file_text: "x" }, sessionID), /non-empty session ID/i)
      assert.throws(() => engine.sessionRoot(sessionID), /non-empty session ID/i)
    }
  })

  test("reads, lists, and injects legacy files while mutation copies to hashed storage", async (t) => {
    const { engine } = await makeCase(t)
    const sessionID = "legacy/id"
    const legacy = engine.legacySessionRoot(sessionID)
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "plan.md"), "old value")
    await fs.chmod(path.join(legacy, "plan.md"), 0o640)

    assert.match(await engine.run({ command: "view", path: "/memories/session/plan.md" }, sessionID), /old value/)
    assert.match(await engine.run({ command: "view", path: "/memories/session" }, sessionID), /plan\.md/)
    assert.match(await engine.buildContext(sessionID), /\/memories\/session\/plan\.md/)
    assert.match(await engine.run({ command: "str_replace", path: "/memories/session/plan.md", old_str: "old", new_str: "new" }, sessionID), /has been edited/)
    assert.equal(await fs.readFile(path.join(engine.sessionRoot(sessionID), "plan.md"), "utf8"), "new value")
    assert.equal((await fs.stat(path.join(engine.sessionRoot(sessionID), "plan.md"))).mode & 0o777, 0o640)
    assert.equal(await exists(path.join(legacy, "plan.md")), false)
  })

  test("atomically binds a colliding legacy directory to its first canonical claimant", async (t) => {
    const { engine } = await makeCase(t)
    const first = "same/id"
    const collider = "same?id"
    assert.equal(engine.legacySessionRoot(first), engine.legacySessionRoot(collider))
    const legacy = engine.legacySessionRoot(first)
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "only.md"), "first claimant")

    assert.match(await engine.run({ command: "view", path: "/memories/session/only.md" }, first), /first claimant/)
    assert.match(await engine.run({ command: "view", path: "/memories/session/only.md" }, collider), /does not exist/i)
    assert.equal((await fs.readFile(path.join(legacy, ".memory-owner"), "utf8")), createHash("sha256").update(first).digest("hex"))
    assert.doesNotMatch(await engine.run({ command: "view", path: "/memories/session" }, first), /memory-owner/)
  })

  test("checks owned legacy destinations and removes delete/rename shadows", async (t) => {
    const { engine } = await makeCase(t)
    const sessionID = "legacy/conflicts"
    const legacy = engine.legacySessionRoot(sessionID)
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "destination.md"), "legacy destination")
    assert.match(await engine.run({ command: "create", path: "/memories/session/destination.md", file_text: "new" }, sessionID), /already exists/i)

    await engine.run({ command: "create", path: "/memories/session/source.md", file_text: "source" }, sessionID)
    assert.match(await engine.run({ command: "rename", old_path: "/memories/session/source.md", new_path: "/memories/session/destination.md" }, sessionID), /already exists/i)

    await engine.run({ command: "create", path: "/memories/session/delete.md", file_text: "canonical" }, sessionID)
    await fs.writeFile(path.join(legacy, "delete.md"), "shadow")
    await engine.run({ command: "view", path: "/memories/session" }, sessionID)
    assert.match(await engine.run({ command: "delete", path: "/memories/session/delete.md" }, sessionID), /Successfully deleted/)
    assert.match(await engine.run({ command: "view", path: "/memories/session/delete.md" }, sessionID), /does not exist/i)

    await engine.run({ command: "create", path: "/memories/session/move.md", file_text: "canonical" }, sessionID)
    await fs.writeFile(path.join(legacy, "move.md"), "shadow")
    assert.equal(await engine.run({ command: "rename", old_path: "/memories/session/move.md", new_path: "/memories/session/moved.md" }, sessionID), "Successfully renamed")
    assert.match(await engine.run({ command: "view", path: "/memories/session/move.md" }, sessionID), /does not exist/i)
  })
})

describe("14-day per-entry cleanup", () => {
  test("uses max(atime, mtime, recorded access) and removes eligible empty directories", async (t) => {
    let clock = Date.now() + 30 * 24 * 60 * 60 * 1000
    const { userRoot, engine } = await makeCase(t, { now: () => clock })
    await engine.run({ command: "create", path: "/memories/session/old.md", file_text: "old" }, "stale")
    await engine.run({ command: "create", path: "/memories/session/recent.md", file_text: "recent" }, "active")
    await engine.run({ command: "create", path: "/memories/session/touched.md", file_text: "touch" }, "active")
    clock += RETENTION_MS + 60_000
    const oldDate = new Date(clock - RETENTION_MS - 1_000)
    const recentDate = new Date(clock - RETENTION_MS + 60_000)
    const oldFile = path.join(engine.sessionRoot("stale"), "old.md")
    const recentFile = path.join(engine.sessionRoot("active"), "recent.md")
    const touchedFile = path.join(engine.sessionRoot("active"), "touched.md")
    await fs.utimes(oldFile, oldDate, oldDate)
    await fs.utimes(recentFile, recentDate, recentDate)
    await fs.utimes(touchedFile, oldDate, oldDate)
    await engine.run({ command: "view", path: "/memories/session/touched.md" }, "active")
    const empty = path.join(userRoot, "session", "eligible-empty")
    await fs.mkdir(empty, { recursive: true })
    await fs.utimes(empty, oldDate, oldDate)

    assert.ok(engine.cleanupStaleSessionDirs() >= 2)
    assert.equal(await exists(oldFile), false)
    assert.equal(await exists(recentFile), true)
    assert.equal(await exists(touchedFile), true)
    assert.equal(await exists(empty), false)
  })

  test("tolerates vanishing directories and supports unref plus idempotent stop", async (t) => {
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

  test("persists exact access freshness across restart and cleans nested session files only", async (t) => {
    let clock = Date.now() + 40 * 24 * 60 * 60 * 1000
    const { projectDir, userRoot, engine } = await makeCase(t, { now: () => clock })
    await engine.run({ command: "create", path: "/memories/session/nested/stale.md", file_text: "stale" }, "restart")
    await engine.run({ command: "create", path: "/memories/session/nested/fresh.md", file_text: "fresh" }, "restart")
    await engine.run({ command: "create", path: "/memories/session/sibling.md", file_text: "stale sibling" }, "restart")
    await engine.run({ command: "create", path: "/memories/user.md", file_text: "user" }, "restart")
    await engine.run({ command: "create", path: "/memories/repo/repo.md", file_text: "repo" }, "restart")
    clock += RETENTION_MS + 60_000
    const old = new Date(clock - RETENTION_MS - 10_000)
    const session = engine.sessionRoot("restart")
    for (const target of [
      path.join(session, "nested", "stale.md"), path.join(session, "nested", "fresh.md"), path.join(session, "sibling.md"),
      path.join(userRoot, "user.md"), path.join(engine.repoRoot, "repo.md"),
    ]) await fs.utimes(target, old, old)
    await engine.run({ command: "view", path: "/memories/session/nested/fresh.md" }, "restart")
    const ledgerPath = path.join(session, ".memory-access")
    const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"))
    assert.equal(ledger["nested/fresh.md"], clock)
    await fs.utimes(path.join(session, "nested", "fresh.md"), old, old)

    const restarted = createMemory({ projectDir, userRoot, now: () => clock })
    t.after(() => restarted.stopCleanup())
    restarted.cleanupStaleSessionDirs()
    assert.equal(await exists(path.join(session, "nested", "stale.md")), false)
    assert.equal(await exists(path.join(session, "sibling.md")), false)
    assert.equal(await exists(path.join(session, "nested", "fresh.md")), true)
    assert.equal(await exists(path.join(session, "nested")), true)
    assert.equal(await exists(path.join(userRoot, "user.md")), true)
    assert.equal(await exists(path.join(engine.repoRoot, "repo.md")), true)
  })
})

describe("best-effort access ledger", () => {
  test("committed create, update, insert, and rename succeed despite ledger failures", async (t) => {
    const logs = []
    const { engine } = await makeCase(t, {
      log: (code) => logs.push(code),
      recordSessionAccess: async () => {
        const error = new Error("ledger unavailable at /raw/backing/path")
        error.code = "EIO"
        throw error
      },
    })
    const session = engine.sessionRoot("s")
    assert.equal(
      await engine.run({ command: "create", path: "/memories/session/a.md", file_text: "one" }, "s"),
      "Successfully created /memories/session/a.md",
    )
    assert.match(await engine.run({ command: "str_replace", path: "/memories/session/a.md", old_str: "one", new_str: "two" }, "s"), /has been edited/)
    assert.match(await engine.run({ command: "insert", path: "/memories/session/a.md", insert_line: 0, insert_text: "top" }, "s"), /has been edited/)
    assert.equal(
      await engine.run({ command: "rename", old_path: "/memories/session/a.md", new_path: "/memories/session/b.md" }, "s"),
      "Successfully renamed",
    )
    assert.equal(await fs.readFile(path.join(session, "b.md"), "utf8"), "top\ntwo")
    assert.equal(await exists(path.join(session, "a.md")), false)

    // Reads and context still work with the ledger failing.
    assert.match(await engine.run({ command: "view", path: "/memories/session/b.md" }, "s"), /top/)
    assert.match(await engine.buildContext("s"), /\/memories\/session\/b\.md/)

    assert.ok(logs.includes("EIO"))
    assert.ok(logs.every((entry) => /^[A-Z0-9_]{1,24}$/.test(entry)))
    assert.doesNotMatch(logs.join("\n"), /ledger unavailable|raw\/backing|session\//)
  })

  test("an unreadable ledger cannot fail a read or a committed mutation", async (t) => {
    const { engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/session/first.md", file_text: "first" }, "s")
    const session = engine.sessionRoot("s")
    await fs.rm(path.join(session, ".memory-access"), { force: true })
    await fs.mkdir(path.join(session, ".memory-access"))

    assert.match(await engine.run({ command: "view", path: "/memories/session/first.md" }, "s"), /first/)
    assert.equal(
      await engine.run({ command: "create", path: "/memories/session/second.md", file_text: "second" }, "s"),
      "Successfully created /memories/session/second.md",
    )
    assert.equal(await fs.readFile(path.join(session, "second.md"), "utf8"), "second")
    assert.match(await engine.buildContext("s"), /\/memories\/session\/first\.md/)
  })
})
