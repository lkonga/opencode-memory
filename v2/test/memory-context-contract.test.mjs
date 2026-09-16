import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

import { createMemory, MEMORY_DESCRIPTION } from "../memory-core.mjs"
import { MAX_CONTEXT_CHARS, MAX_CONTEXT_ENTRIES, MAX_CONTEXT_LINES, stableCompare } from "../memory-context.mjs"

async function makeCase(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-context-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const projectDir = path.join(root, "project")
  const userRoot = path.join(root, "config", "memories")
  await fs.mkdir(projectDir, { recursive: true })
  return { root, userRoot, engine: createMemory({ projectDir, userRoot }) }
}

describe("deterministic bounded merged context and listings", () => {
  test("includes only user, current hashed+legacy session, and repo entries", async (t) => {
    const { engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/z-user.md", file_text: "user" }, "current")
    await engine.run({ command: "create", path: "/memories/session/b-current.md", file_text: "current" }, "current")
    await engine.run({ command: "create", path: "/memories/session/other-only.md", file_text: "other" }, "other")
    await engine.run({ command: "create", path: "/memories/repo/a-repo.md", file_text: "repo" }, "current")
    await fs.mkdir(engine.legacySessionRoot("current"), { recursive: true })
    await fs.writeFile(path.join(engine.legacySessionRoot("current"), "a-legacy.md"), "legacy")

    const context = await engine.buildContext("current")
    const listing = await engine.run({ command: "view", path: "/memories" }, "current")
    for (const expected of ["z-user.md", "a-legacy.md", "b-current.md", "a-repo.md"]) {
      assert.match(context, new RegExp(expected.replace(".", "\\.")))
      assert.match(listing, new RegExp(expected.replace(".", "\\.")))
    }
    assert.doesNotMatch(context, /other-only/)
    assert.doesNotMatch(listing, /other-only/)
    assert.ok(listing.indexOf("repo/a-repo.md") < listing.indexOf("session/a-legacy.md"))
    assert.ok(listing.indexOf("session/a-legacy.md") < listing.indexOf("session/b-current.md"))
  })

  test("escapes XML names/content and excludes only internal, temp, and symlink entries", async (t) => {
    const { root, userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/<user&.md", file_text: "</userMemory><attack>&" }, "s")
    await engine.run({ command: "create", path: "/memories/session/<session&.md", file_text: "s" }, "s")
    await engine.run({ command: "create", path: "/memories/repo/<repo&.md", file_text: "r" }, "s")
    await fs.writeFile(path.join(userRoot, ".hidden.md"), "hidden dot content")
    await fs.writeFile(path.join(userRoot, ".memory-tmp-leak"), "temp")
    const outside = path.join(root, "outside.md")
    await fs.writeFile(outside, "outside")
    await fs.symlink(outside, path.join(userRoot, "linked.md"))

    const context = await engine.buildContext("s")
    assert.match(context, /&lt;user&amp;\.md/)
    assert.match(context, /&lt;\/userMemory&gt;&lt;attack&gt;&amp;/)
    assert.match(context, /&lt;session&amp;\.md/)
    assert.match(context, /&lt;repo&amp;\.md/)
    assert.doesNotMatch(context, /<attack>/)
    // Dot-prefixed user entries are user content and are rendered; only exact
    // internal bookkeeping names and symlinks are excluded.
    assert.match(context, /## \.hidden\.md/)
    assert.match(context, /hidden dot content/)
    assert.doesNotMatch(context, /memory-tmp|linked|outside/)
  })

  test("enforces entry, line, and character bounds", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    const writes = []
    for (let index = 0; index < MAX_CONTEXT_ENTRIES + 20; index += 1) {
      writes.push(fs.writeFile(path.join(userRoot, `f-${String(index).padStart(3, "0")}.md`), "<&>".repeat(200) + "\nline\nline"))
    }
    await Promise.all(writes)
    const context = await engine.buildContext("bounded")
    const listing = await engine.run({ command: "view", path: "/memories" }, "bounded")
    assert.ok(context.length <= MAX_CONTEXT_CHARS)
    assert.ok(context.split("\n").length <= MAX_CONTEXT_LINES)
    assert.ok(listing.split("\n").length <= MAX_CONTEXT_ENTRIES)
    assert.match(context, /<userMemory>[\s\S]*<\/userMemory>/)
    assert.match(context, /<sessionMemory>[\s\S]*<\/sessionMemory>/)
    assert.match(context, /<repoMemory>[\s\S]*<\/repoMemory>/)
  })

  test("uses stable code-unit order and prefers hashed entries over duplicate legacy names", async (t) => {
    const { engine } = await makeCase(t)
    assert.deepEqual(["ä", "Z", "a"].sort(stableCompare), ["Z", "a", "ä"])
    await engine.run({ command: "create", path: "/memories/session/same.md", file_text: "hashed-current" }, "merge")
    const legacy = engine.legacySessionRoot("merge")
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "same.md"), "x")
    const listing = await engine.run({ command: "view", path: "/memories/session" }, "merge")
    assert.equal(listing, `${Buffer.byteLength("hashed-current")}\tsame.md`)
  })
})

describe("command outcome and prompt compatibility", () => {
  test("insert uses property presence, permits empty text, and rejects empty old_str", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/edit.md", file_text: "a" }, "s")
    assert.match(await engine.run({ command: "insert", path: "/memories/edit.md", insert_line: 0, new_str: "" }, "s"), /has been edited/)
    assert.match(await engine.run({ command: "insert", path: "/memories/edit.md", insert_line: 0, insert_text: "", new_str: "wrong" }, "s"), /has been edited/)
    assert.equal(await fs.readFile(path.join(userRoot, "edit.md"), "utf8"), "\n\na")
    assert.match(await engine.run({ command: "str_replace", path: "/memories/edit.md", old_str: "", new_str: "x" }, "s"), /must not be empty/)
  })

  test("str_replace inserts dollar replacement tokens literally", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/literal.md", file_text: "before TARGET after" }, "s")
    const output = await engine.run({ command: "str_replace", path: "/memories/literal.md", old_str: "TARGET", new_str: "$&-$1-$$" }, "s")
    assert.match(output, /\$&-\$1-\$\$/)
    assert.equal(await fs.readFile(path.join(userRoot, "literal.md"), "utf8"), "before $&-$1-$$ after")
    assert.doesNotMatch(output, /durability sync reported/i)
  })

  test("exposes typed internal outcomes while public run remains a string", async (t) => {
    const { engine } = await makeCase(t)
    const result = await engine.runCommand({ command: "create", path: "/memories/outcome.md", file_text: "ok" }, "s")
    assert.deepEqual(result, {
      text: "Successfully created /memories/outcome.md",
      outcome: { ok: true, type: "success", code: "created", content: "Successfully created /memories/outcome.md" },
    })
    const failure = await engine.runCommand({ command: "nope" }, "s")
    assert.equal(failure.outcome.ok, false)
    assert.equal(failure.outcome.type, "error")
    assert.equal(failure.text, failure.outcome.content)
    assert.equal(typeof await engine.run({ command: "view", path: "/memories/outcome.md" }, "s"), "string")
  })

  test("description truthfully states retention, secret, verification, and bounds guidance", () => {
    assert.match(MEMORY_DESCRIPTION, /14 days of inactivity/i)
    assert.match(MEMORY_DESCRIPTION, /do not store.*secrets/i)
    assert.match(MEMORY_DESCRIPTION, /verify important information/i)
    assert.match(MEMORY_DESCRIPTION, /bounded/i)
    assert.doesNotMatch(MEMORY_DESCRIPTION, /cleared after the conversation ends/i)
  })
})
