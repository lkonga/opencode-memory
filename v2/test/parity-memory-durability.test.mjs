import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, test } from "node:test"

import { exists, makeCase, mode, tempNames } from "./helpers.mjs"

describe("private durable no-clobber writes", () => {
  test("uses 0700 directories and 0600 files without changing an external parent", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    const parent = path.dirname(userRoot)
    await fs.mkdir(userRoot, { recursive: true, mode: 0o755 })
    await fs.chmod(parent, 0o755)
    await fs.chmod(userRoot, 0o755)

    await engine.run({ command: "create", path: "/memories/nested/user.md", file_text: "u" }, "session")
    await engine.run({ command: "create", path: "/memories/session/session.md", file_text: "s" }, "session")
    await engine.run({ command: "create", path: "/memories/repo/repo.md", file_text: "r" }, "session")

    assert.equal(await mode(parent), 0o755)
    assert.equal(await mode(userRoot), 0o755)
    assert.equal(await mode(path.join(userRoot, "nested")), 0o700)
    assert.equal(await mode(engine.sessionRoot("session")), 0o700)
    assert.equal(await mode(path.join(userRoot, "nested", "user.md")), 0o600)
    assert.equal(await mode(path.join(engine.sessionRoot("session"), "session.md")), 0o600)
    assert.equal(await mode(path.join(engine.repoRoot, "repo.md")), 0o600)
  })

  test("view/context have no root side effects and mutations preserve existing object modes", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    assert.equal(await exists(userRoot), false)
    assert.equal(await exists(engine.repoRoot), false)
    await engine.run({ command: "view", path: "/memories" }, "session")
    await engine.buildContext("session")
    assert.equal(await exists(userRoot), false)
    assert.equal(await exists(engine.repoRoot), false)

    await fs.mkdir(path.join(userRoot, "existing"), { recursive: true, mode: 0o755 })
    await fs.chmod(userRoot, 0o751)
    await fs.chmod(path.join(userRoot, "existing"), 0o755)
    await fs.writeFile(path.join(userRoot, "existing", "note.md"), "before", { mode: 0o640 })
    await engine.run({ command: "str_replace", path: "/memories/existing/note.md", old_str: "before", new_str: "after" }, "session")
    assert.equal(await mode(userRoot), 0o751)
    assert.equal(await mode(path.join(userRoot, "existing")), 0o755)
    assert.equal(await mode(path.join(userRoot, "existing", "note.md")), 0o640)
  })

  test("concurrent creates choose one winner without clobbering", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    const outputs = await Promise.all([
      engine.run({ command: "create", path: "/memories/once.md", file_text: "first" }, "s"),
      engine.run({ command: "create", path: "/memories/once.md", file_text: "second" }, "s"),
    ])
    assert.equal(outputs.filter((value) => value.startsWith("Successfully created")).length, 1)
    assert.equal(outputs.filter((value) => /already exists/.test(value)).length, 1)
    assert.ok(["first", "second"].includes(await fs.readFile(path.join(userRoot, "once.md"), "utf8")))
  })

  test("an atomic update failure preserves the original and removes temps", async (t) => {
    let fail = false
    const logs = []
    const { userRoot, engine } = await makeCase(t, {
      beforeCommit: () => { if (fail) throw new Error("injected failure /raw/backing/path") },
      log: (...parts) => logs.push(parts.join(" ")),
    })
    await engine.run({ command: "create", path: "/memories/stable.md", file_text: "before" }, "s")
    fail = true
    const output = await engine.run({ command: "str_replace", path: "/memories/stable.md", old_str: "before", new_str: "after" }, "s")
    assert.match(output, /memory operation failed.*\/memories\/stable\.md/i)
    assert.doesNotMatch(output, /injected failure|raw\/backing\/path|memory-v1-test/)
    assert.equal(await fs.readFile(path.join(userRoot, "stable.md"), "utf8"), "before")
    assert.deepEqual(await tempNames(userRoot), [])
    assert.deepEqual(logs, ["EIO"])
  })

  test("concurrent renames to one destination never clobber", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/left.md", file_text: "left" }, "s")
    await engine.run({ command: "create", path: "/memories/right.md", file_text: "right" }, "s")
    const results = await Promise.all([
      engine.run({ command: "rename", old_path: "/memories/left.md", new_path: "/memories/winner.md" }, "s"),
      engine.run({ command: "rename", old_path: "/memories/right.md", new_path: "/memories/winner.md" }, "s"),
    ])
    assert.equal(results.filter((result) => result === "Successfully renamed").length, 1)
    assert.equal(results.filter((result) => /already exists/.test(result)).length, 1)
    assert.ok(["left", "right"].includes(await fs.readFile(path.join(userRoot, "winner.md"), "utf8")))
    assert.equal(await mode(path.join(userRoot, "winner.md")), 0o600)
  })

  test("reads hide but retain stale residue while mutation and cleanupAll remove it in every scope", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/user.md", file_text: "u" }, "s")
    await engine.run({ command: "create", path: "/memories/session/session.md", file_text: "s" }, "s")
    await engine.run({ command: "create", path: "/memories/repo/repo.md", file_text: "r" }, "s")
    const residue = [
      path.join(userRoot, ".memory-tmp-old"),
      path.join(engine.sessionRoot("s"), ".memory-lock-old"),
      path.join(engine.repoRoot, ".memory-tmp-old"),
    ]
    const old = new Date(Date.now() - 10 * 60 * 1000)
    for (const target of residue) {
      await fs.writeFile(target, "old")
      await fs.utimes(target, old, old)
    }
    const listing = await engine.run({ command: "view", path: "/memories" }, "s")
    assert.doesNotMatch(listing, /memory-(tmp|lock)/)
    const context = await engine.buildContext("s")
    assert.doesNotMatch(context, /memory-(tmp|lock)/)
    for (const target of residue) assert.equal(await exists(target), true)

    await engine.run({ command: "create", path: "/memories/cleanup-trigger.md", file_text: "x" }, "s")
    for (const target of residue) assert.equal(await exists(target), false)

    for (const target of residue) {
      await fs.writeFile(target, "old")
      await fs.utimes(target, old, old)
    }
    await engine.cleanupAll()
    for (const target of residue) assert.equal(await exists(target), false)
  })
})
