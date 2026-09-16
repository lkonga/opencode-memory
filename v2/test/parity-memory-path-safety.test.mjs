import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, test } from "node:test"

import { MAX_SCOPE_BYTES, MAX_USER_MEMORY_LINES, createMemory } from "../memory-core.mjs"
import { exists, makeCase, tempNames } from "./helpers.mjs"

describe("canonical containment and mutation races", () => {
  test("reserves session and repo as case-insensitive first user components", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    for (const reserved of ["Session", "SESSION", "Repo", "rEpO"]) {
      const output = await engine.run({ command: "create", path: `/memories/${reserved}/escape.md`, file_text: "x" }, "s")
      assert.match(output, /unsafe memory path/i)
      assert.equal(await exists(path.join(userRoot, reserved, "escape.md")), false)
    }
  })
  test("rejects traversal plus intermediate and final symlinks without touching outside", async (t) => {
    const { root, userRoot, engine } = await makeCase(t)
    const outside = path.join(root, "outside")
    await fs.mkdir(userRoot, { recursive: true })
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, "secret.md"), "outside")
    await fs.symlink(outside, path.join(userRoot, "jump"))
    await fs.symlink(path.join(outside, "secret.md"), path.join(userRoot, "alias.md"))

    assert.match(await engine.run({ command: "create", path: "/memories/../escape", file_text: "x" }, "s"), /traversal/i)
    assert.match(await engine.run({ command: "create", path: "/memories/jump/pwn.md", file_text: "x" }, "s"), /symlink/i)
    assert.match(await engine.run({ command: "view", path: "/memories/alias.md" }, "s"), /symlink/i)
    assert.match(await engine.run({ command: "delete", path: "/memories/alias.md" }, "s"), /symlink/i)
    assert.equal(await exists(path.join(outside, "pwn.md")), false)
    assert.equal(await fs.readFile(path.join(outside, "secret.md"), "utf8"), "outside")
  })

  test("detects update verification races and removes the atomic temp", async (t) => {
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
    assert.deepEqual(await tempNames(userRoot), [])
  })

  test("rechecks an update target immediately before commit and cleans the temp", async (t) => {
    let race = false
    let outside
    const { root, userRoot, engine } = await makeCase(t, {
      beforeCommit: async ({ phase, target }) => {
        if (!race || phase !== "before-rename") return
        outside = path.join(root, "outside-update.md")
        await fs.writeFile(outside, "outside")
        await fs.rm(target)
        await fs.symlink(outside, target)
      },
    })
    await engine.run({ command: "create", path: "/memories/final.md", file_text: "before" }, "s")
    race = true
    assert.match(await engine.run({ command: "str_replace", path: "/memories/final.md", old_str: "before", new_str: "after" }, "s"), /changed during update|before mutation/i)
    assert.equal(await fs.readFile(outside, "utf8"), "outside")
    assert.deepEqual(await tempNames(userRoot), [])
  })

  test("delete rejects a target swapped to an outside symlink", async (t) => {
    let swap = false
    let outside
    const { root, engine } = await makeCase(t, {
      beforeMutation: async ({ phase, target }) => {
        if (!swap || phase !== "before-remove") return
        outside = path.join(root, "outside-delete.md")
        await fs.writeFile(outside, "outside")
        await fs.rm(target)
        await fs.symlink(outside, target)
      },
    })
    await engine.run({ command: "create", path: "/memories/delete.md", file_text: "inside" }, "s")
    swap = true
    assert.match(await engine.run({ command: "delete", path: "/memories/delete.md" }, "s"), /symlink|changed before mutation/i)
    assert.equal(await fs.readFile(outside, "utf8"), "outside")
  })

  test("rename revalidates both source and destination at the mutation seam", async (t) => {
    let action
    let outside
    const { root, userRoot, engine } = await makeCase(t, {
      beforeMutation: async ({ phase, source, destination }) => {
        if (phase !== "before-rename") return
        if (action === "swap-source") {
          outside = path.join(root, "outside-rename.md")
          await fs.writeFile(outside, "outside")
          await fs.rm(source)
          await fs.symlink(outside, source)
        } else if (action === "create-destination") {
          await fs.writeFile(destination, "racer", { mode: 0o600 })
        }
      },
    })
    await engine.run({ command: "create", path: "/memories/source.md", file_text: "source" }, "s")
    action = "swap-source"
    assert.match(await engine.run({ command: "rename", old_path: "/memories/source.md", new_path: "/memories/dest.md" }, "s"), /symlink|changed before mutation/i)
    assert.equal(await fs.readFile(outside, "utf8"), "outside")
    assert.equal(await exists(path.join(userRoot, "dest.md")), false)

    await fs.rm(path.join(userRoot, "source.md"))
    await engine.run({ command: "create", path: "/memories/source.md", file_text: "source" }, "s")
    action = "create-destination"
    assert.match(await engine.run({ command: "rename", old_path: "/memories/source.md", new_path: "/memories/dest.md" }, "s"), /already exists/i)
    assert.equal(await fs.readFile(path.join(userRoot, "source.md"), "utf8"), "source")
    assert.equal(await fs.readFile(path.join(userRoot, "dest.md"), "utf8"), "racer")
  })

  test("rejects a parent-directory swap and removes moved temps and locks by inode", async (t) => {
    let swap = false
    const { projectDir, userRoot, engine } = await makeCase(t, {
      beforeCommit: async ({ phase, target }) => {
        if (!swap || phase !== "before-rename") return
        swap = false
        const parent = path.dirname(target)
        await fs.rename(parent, `${parent}.moved`)
        await fs.mkdir(parent)
      },
    })
    await engine.run({ command: "create", path: "/memories/parent/note.md", file_text: "before" }, "s")
    swap = true
    const output = await engine.run({ command: "str_replace", path: "/memories/parent/note.md", old_str: "before", new_str: "after" }, "s")
    assert.match(output, /changed during update|before mutation/i)
    assert.equal(await fs.readFile(path.join(userRoot, "parent.moved", "note.md"), "utf8"), "before")
    const names = await fs.readdir(path.join(userRoot, "parent.moved"))
    assert.deepEqual(names.filter((name) => name.startsWith(".memory-tmp-") || name.startsWith(".memory-lock-")), [])
    assert.equal(await exists(path.join(projectDir, ".opencode", "memories")), false)
  })

  test("revalidates a create parent and removes only the created inode after a swap", async (t) => {
    let swap = true
    const { userRoot, engine } = await makeCase(t, {
      beforeCommit: async ({ phase, target }) => {
        if (!swap || phase !== "before-create-verify") return
        swap = false
        const parent = path.dirname(target)
        await fs.rename(parent, `${parent}.moved`)
        await fs.mkdir(parent)
        await fs.writeFile(path.join(parent, "replacement.md"), "replacement")
      },
    })
    const output = await engine.run({ command: "create", path: "/memories/parent/new.md", file_text: "new" }, "s")
    assert.match(output, /changed during update|before mutation/i)
    assert.equal(await exists(path.join(userRoot, "parent.moved", "new.md")), false)
    assert.equal(await fs.readFile(path.join(userRoot, "parent", "replacement.md"), "utf8"), "replacement")
    for (const dir of [path.join(userRoot, "parent"), path.join(userRoot, "parent.moved")]) {
      assert.deepEqual((await fs.readdir(dir)).filter((name) => name.startsWith(".memory-lock-") || name.startsWith(".memory-tmp-")), [])
    }
  })

  test("cross-engine rename locks prevent destination clobbering", async (t) => {
    const { projectDir, userRoot, engine } = await makeCase(t)
    const other = createMemory({ projectDir, userRoot })
    t.after(() => other.stopCleanup())
    await engine.run({ command: "create", path: "/memories/left.md", file_text: "left" }, "s")
    await engine.run({ command: "create", path: "/memories/right.md", file_text: "right" }, "s")
    const results = await Promise.all([
      engine.run({ command: "rename", old_path: "/memories/left.md", new_path: "/memories/winner.md" }, "s"),
      other.run({ command: "rename", old_path: "/memories/right.md", new_path: "/memories/winner.md" }, "s"),
    ])
    assert.equal(results.filter((result) => result === "Successfully renamed").length, 1)
    assert.equal(await exists(path.join(userRoot, "winner.md")), true)
    assert.ok(["left", "right"].includes(await fs.readFile(path.join(userRoot, "winner.md"), "utf8")))
  })
})

describe("user dot entries count as user content", () => {
  test("lists, reads, and injects dot-prefixed entries while hiding exact internal names", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    assert.equal(
      await engine.run({ command: "create", path: "/memories/.notes.md", file_text: "DOT-CONTENT-218\n" }, "s"),
      "Successfully created /memories/.notes.md",
    )
    await fs.writeFile(path.join(userRoot, ".memory-owner"), "internal-owner")
    await fs.writeFile(path.join(userRoot, ".memory-tmp-leak"), "internal-temp")
    await fs.writeFile(path.join(userRoot, ".memory-access"), "internal-access")
    await fs.mkdir(path.join(userRoot, ".memory-lock-dir"))
    await fs.writeFile(path.join(userRoot, ".memory-lock-dir", "nested.md"), "internal-lock")

    const listing = await engine.run({ command: "view", path: "/memories" }, "s")
    assert.match(listing, /^\d+\t\.notes\.md$/m)
    assert.doesNotMatch(listing, /memory-(?:owner|access|tmp|lock)/)

    // Direct, bounded read of a dot-prefixed user memory.
    assert.match(await engine.run({ command: "view", path: "/memories/.notes.md" }, "s"), /DOT-CONTENT-218/)
    const context = await engine.buildContext("s")
    assert.match(context, /## \.notes\.md/)
    assert.match(context, /DOT-CONTENT-218/)
    assert.doesNotMatch(context, /internal-(?:owner|temp|access|lock)/)

    // Reserved internal names stay unwritable and unrenamable.
    for (const reserved of [".memory-owner", ".memory-access", ".memory-tmp-x", ".memory-lock-x"]) {
      assert.match(await engine.run({ command: "create", path: `/memories/${reserved}`, file_text: "x" }, "s"), /Invalid path/)
    }
    assert.match(
      await engine.run({ command: "rename", old_path: "/memories/.notes.md", new_path: "/memories/.memory-access" }, "s"),
      /Invalid path/,
    )
    assert.equal(await fs.readFile(path.join(userRoot, ".notes.md"), "utf8"), "DOT-CONTENT-218\n")
  })

  test("accounts dot-prefixed files in the byte and line scope limits", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    await fs.writeFile(path.join(userRoot, ".bulk.md"), "x".repeat(MAX_SCOPE_BYTES - 10_000))
    assert.match(
      await engine.run({ command: "create", path: "/memories/extra.md", file_text: "y".repeat(20_000) }, "s"),
      /scope limit/i,
    )
    assert.equal(await exists(path.join(userRoot, "extra.md")), false)

    await fs.rm(path.join(userRoot, ".bulk.md"))
    await fs.writeFile(path.join(userRoot, ".lines.md"), Array.from({ length: MAX_USER_MEMORY_LINES }, () => "l").join("\n"))
    assert.match(
      await engine.run({ command: "create", path: "/memories/extra.md", file_text: "z" }, "s"),
      new RegExp(`${MAX_USER_MEMORY_LINES} total lines`, "i"),
    )
    assert.equal(await exists(path.join(userRoot, "extra.md")), false)
  })
})
