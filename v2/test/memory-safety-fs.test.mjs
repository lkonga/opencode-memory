import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

import { createMemory, MAX_MEMORY_FILE_BYTES } from "../memory-core.mjs"
import { MAX_CONTEXT_CHARS, MAX_PROMPT_LINES } from "../memory-context.mjs"

const TAIL = "TAIL-SENTINEL-218-ZX9"

async function makeCase(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-safety-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const projectDir = path.join(root, "project")
  const userRoot = path.join(root, "config", "memories")
  await fs.mkdir(projectDir, { recursive: true })
  return { root, projectDir, userRoot, engine: createMemory({ projectDir, userRoot, ...options }) }
}

const exists = (target) => fs.lstat(target).then(() => true, () => false)
const mode = async (target) => (await fs.stat(target)).mode & 0o777

describe("canonical containment and symlink rejection", () => {
  test("rejects traversal plus intermediate and final symlinks", async (t) => {
    const { root, userRoot, engine } = await makeCase(t)
    const outside = path.join(root, "outside")
    await fs.mkdir(userRoot, { recursive: true })
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, "secret.md"), "outside")
    await fs.symlink(outside, path.join(userRoot, "jump"))
    await fs.symlink(path.join(outside, "secret.md"), path.join(userRoot, "alias.md"))

    assert.match(await engine.run({ command: "create", path: "/memories/../escape", file_text: "x" }, "s"), /traversal/i)
    assert.match(await engine.run({ command: "create", path: "/memories/jump/pwn.md", file_text: "x" }, "s"), /symlink/i)
    assert.equal(await exists(path.join(outside, "pwn.md")), false)
    assert.match(await engine.run({ command: "view", path: "/memories/alias.md" }, "s"), /symlink/i)
    assert.match(await engine.run({ command: "delete", path: "/memories/alias.md" }, "s"), /symlink/i)
    assert.equal(await fs.readFile(path.join(outside, "secret.md"), "utf8"), "outside")
  })

  test("detects a practical update race and cleans its atomic temp", async (t) => {
    let race = false
    const { userRoot, engine } = await makeCase(t, {
      beforeCommit: async ({ phase, target }) => {
        if (!race || phase !== "before-verify") return
        const replacement = `${target}.race`
        await fs.writeFile(replacement, await fs.readFile(target))
        await fs.rename(replacement, target)
      },
    })
    await engine.run({ command: "create", path: "/memories/race.md", file_text: "same" }, "s")
    race = true
    assert.match(await engine.run({ command: "str_replace", path: "/memories/race.md", old_str: "same", new_str: "changed" }, "s"), /changed during update/i)
    assert.equal(await fs.readFile(path.join(userRoot, "race.md"), "utf8"), "same")
    assert.equal((await fs.readdir(userRoot)).some((name) => name.startsWith(".memory-tmp-")), false)
  })

  test("rechecks the final target immediately before rename", async (t) => {
    let race = false
    const { root, userRoot, engine } = await makeCase(t, {
      beforeCommit: async ({ phase, target }) => {
        if (!race || phase !== "before-rename") return
        const outside = path.join(root, "outside-final.md")
        await fs.writeFile(outside, "outside")
        await fs.rm(target)
        await fs.symlink(outside, target)
      },
    })
    await engine.run({ command: "create", path: "/memories/final-race.md", file_text: "before" }, "s")
    race = true
    assert.match(await engine.run({ command: "str_replace", path: "/memories/final-race.md", old_str: "before", new_str: "after" }, "s"), /changed during update|unsafe memory path/i)
    assert.equal((await fs.readdir(userRoot)).some((name) => name.startsWith(".memory-tmp-")), false)
  })

  test("delete rejects a file swapped to an outside symlink at the mutation seam", async (t) => {
    let swap = false
    const { root, engine } = await makeCase(t, {
      beforeMutation: async ({ phase, target }) => {
        if (!swap || phase !== "before-remove") return
        const outside = path.join(root, "outside-delete.md")
        await fs.writeFile(outside, "outside")
        await fs.rm(target)
        await fs.symlink(outside, target)
      },
    })
    const outside = path.join(root, "outside-delete.md")
    await engine.run({ command: "create", path: "/memories/delete-race.md", file_text: "inside" }, "s")
    swap = true
    assert.match(await engine.run({ command: "delete", path: "/memories/delete-race.md" }, "s"), /symlink|changed before mutation/i)
    assert.equal(await fs.readFile(outside, "utf8"), "outside")
  })

  test("delete rejects a parent component swapped to an outside symlink", async (t) => {
    let swap = false
    let movedParent
    const { root, userRoot, engine } = await makeCase(t, {
      beforeMutation: async ({ phase, target }) => {
        if (!swap || phase !== "before-remove") return
        const parent = path.dirname(target)
        movedParent = `${parent}-original`
        const outside = path.join(root, "outside-parent")
        await fs.mkdir(outside)
        await fs.writeFile(path.join(outside, path.basename(target)), "outside")
        await fs.rename(parent, movedParent)
        await fs.symlink(outside, parent)
      },
    })
    await engine.run({ command: "create", path: "/memories/nested/victim.md", file_text: "inside" }, "s")
    swap = true
    assert.match(await engine.run({ command: "delete", path: "/memories/nested/victim.md" }, "s"), /symlink|changed before mutation/i)
    assert.equal(await fs.readFile(path.join(root, "outside-parent", "victim.md"), "utf8"), "outside")
    assert.equal(await fs.readFile(path.join(movedParent, "victim.md"), "utf8"), "inside")
    assert.equal(await fs.lstat(path.join(userRoot, "nested")).then((stat) => stat.isSymbolicLink()), true)
  })
})

describe("durable private writes", () => {
  test("uses 0700 directories and 0600 exclusive files in every scope", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/user.md", file_text: "u" }, "session")
    await engine.run({ command: "create", path: "/memories/session/session.md", file_text: "s" }, "session")
    await engine.run({ command: "create", path: "/memories/repo/repo.md", file_text: "r" }, "session")

    assert.equal(await mode(userRoot), 0o700)
    assert.equal(await mode(path.join(userRoot, "session")), 0o700)
    assert.equal(await mode(engine.sessionRoot("session")), 0o700)
    assert.equal(await mode(path.join(userRoot, "user.md")), 0o600)
    assert.equal(await mode(path.join(engine.sessionRoot("session"), "session.md")), 0o600)
    assert.equal(await mode(path.join(engine.repoRoot, "repo.md")), 0o600)
  })

  test("preserves a preexisting managed root mode while securing created descendants", async (t) => {
    const { root, userRoot, engine } = await makeCase(t)
    const parent = path.dirname(userRoot)
    await fs.mkdir(userRoot, { recursive: true, mode: 0o755 })
    await fs.chmod(parent, 0o755)
    await fs.chmod(userRoot, 0o755)
    assert.equal(await engine.run({ command: "create", path: "/memories/nested/file.md", file_text: "x" }, "s"), "Successfully created /memories/nested/file.md")
    assert.equal(await mode(userRoot), 0o755)
    assert.equal(await mode(path.join(userRoot, "nested")), 0o700)
    assert.equal(await mode(parent), 0o755)
    assert.equal(path.resolve(parent).startsWith(path.resolve(root)), true)
  })

  test("concurrent creates never clobber", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    const outputs = await Promise.all([
      engine.run({ command: "create", path: "/memories/once.md", file_text: "first" }, "s"),
      engine.run({ command: "create", path: "/memories/once.md", file_text: "second" }, "s"),
    ])
    assert.equal(outputs.filter((value) => value.startsWith("Successfully created")).length, 1)
    assert.equal(outputs.filter((value) => /already exists/.test(value)).length, 1)
    assert.ok(["first", "second"].includes(await fs.readFile(path.join(userRoot, "once.md"), "utf8")))
  })

  test("failed update sanitizes its error, preserves content, and removes every temp", async (t) => {
    let fail = false
    const { userRoot, engine } = await makeCase(t, { beforeCommit: () => { if (fail) throw new Error("injected failure") } })
    await engine.run({ command: "create", path: "/memories/stable.md", file_text: "before" }, "s")
    fail = true
    const output = await engine.run({ command: "str_replace", path: "/memories/stable.md", old_str: "before", new_str: "after" }, "s")
    assert.match(output, /memory operation failed/i)
    assert.doesNotMatch(output, /injected failure/)
    assert.equal(await fs.readFile(path.join(userRoot, "stable.md"), "utf8"), "before")
    assert.deepEqual((await fs.readdir(userRoot)).filter((name) => name.startsWith(".memory-tmp-")), [])
  })

  test("blocks destructive operations on all scope roots", async (t) => {
    const { engine } = await makeCase(t)
    for (const root of ["/memories", "/memories/session", "/memories/repo"]) {
      assert.match(await engine.run({ command: "delete", path: root }, "s"), /scope roots/i)
      assert.match(await engine.run({ command: "rename", old_path: root, new_path: `${root}/moved` }, "s"), /scope roots/i)
    }
  })

  test("rename rejects a source swapped to a symlink immediately before mutation", async (t) => {
    let swap = false
    const { root, userRoot, engine } = await makeCase(t, {
      beforeMutation: async ({ phase, source }) => {
        if (!swap || phase !== "before-rename") return
        const outside = path.join(root, "outside-rename.md")
        await fs.writeFile(outside, "outside")
        await fs.rm(source)
        await fs.symlink(outside, source)
      },
    })
    await engine.run({ command: "create", path: "/memories/source.md", file_text: "source" }, "s")
    swap = true
    const output = await engine.run({ command: "rename", old_path: "/memories/source.md", new_path: "/memories/destination.md" }, "s")
    assert.match(output, /symlink|changed before mutation/i)
    assert.equal(await exists(path.join(userRoot, "destination.md")), false)
  })

  test("successful file rename retains standard content, no-clobber, and 0600 mode", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/source.md", file_text: "source" }, "s")
    await engine.run({ command: "create", path: "/memories/existing.md", file_text: "existing" }, "s")
    assert.match(await engine.run({ command: "rename", old_path: "/memories/source.md", new_path: "/memories/existing.md" }, "s"), /already exists/)
    assert.equal(await fs.readFile(path.join(userRoot, "existing.md"), "utf8"), "existing")
    assert.equal(await engine.run({ command: "rename", old_path: "/memories/source.md", new_path: "/memories/renamed.md" }, "s"), "Successfully renamed")
    assert.equal(await mode(path.join(userRoot, "renamed.md")), 0o600)
  })

  test("rename revalidates a destination created at the mutation seam", async (t) => {
    let createDestination = false
    const { userRoot, engine } = await makeCase(t, {
      beforeMutation: async ({ phase, destination }) => {
        if (!createDestination || phase !== "before-rename") return
        await fs.writeFile(destination, "racer", { mode: 0o600 })
      },
    })
    await engine.run({ command: "create", path: "/memories/source.md", file_text: "source" }, "s")
    createDestination = true
    assert.match(await engine.run({ command: "rename", old_path: "/memories/source.md", new_path: "/memories/destination.md" }, "s"), /already exists/)
    assert.equal(await fs.readFile(path.join(userRoot, "source.md"), "utf8"), "source")
    assert.equal(await fs.readFile(path.join(userRoot, "destination.md"), "utf8"), "racer")
  })

  test("concurrent renames to one destination do not clobber", async (t) => {
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
  })

  test("safe delete preserves standard public content for files and recursive directories", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/file.md", file_text: "file" }, "s")
    assert.equal(await engine.run({ command: "delete", path: "/memories/file.md" }, "s"), "Successfully deleted /memories/file.md")
    await engine.run({ command: "create", path: "/memories/tree/child.md", file_text: "child" }, "s")
    assert.equal(await engine.run({ command: "delete", path: "/memories/tree" }, "s"), "Successfully deleted /memories/tree")
    assert.equal(await exists(path.join(userRoot, "file.md")), false)
    assert.equal(await exists(path.join(userRoot, "tree")), false)
  })
})

describe("bounded reads of externally seeded oversized files", () => {
  test("view stays capped, marks truncation, and never renders the tail", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    await fs.writeFile(path.join(userRoot, "huge.md"), "A".repeat(MAX_MEMORY_FILE_BYTES + 50_000) + `\n${TAIL}`)

    const output = await engine.run({ command: "view", path: "/memories/huge.md" }, "s")
    assert.match(output, /truncated/i)
    assert.ok(output.length <= MAX_MEMORY_FILE_BYTES + 2_000, `view output was ${output.length} chars`)
    assert.doesNotMatch(output, new RegExp(TAIL))
  })

  test("edits reject oversized existing inputs without rewriting the file", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    const target = path.join(userRoot, "huge-edit.md")
    const before = "old".repeat(60_000)
    await fs.writeFile(target, before)

    for (const args of [
      { command: "str_replace", path: "/memories/huge-edit.md", old_str: "old", new_str: "new" },
      { command: "insert", path: "/memories/huge-edit.md", insert_line: 0, insert_text: "top" },
    ]) {
      assert.match(await engine.run(args, "s"), /too large/i)
    }
    assert.equal(await fs.readFile(target, "utf8"), before)
    assert.equal((await fs.readdir(userRoot)).some((name) => name.startsWith(".memory-tmp-")), false)
  })

  test("context reads stay capped before rendering", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    await fs.writeFile(path.join(userRoot, "huge-context.md"), "line\n".repeat(60_000) + TAIL)

    const context = await engine.buildContext("s")
    assert.ok(context.length <= MAX_CONTEXT_CHARS, `context was ${context.length} chars`)
    assert.ok(context.split("\n").length <= MAX_PROMPT_LINES)
    assert.match(context, /<userMemory>/)
    assert.doesNotMatch(context, new RegExp(TAIL))
  })
})
