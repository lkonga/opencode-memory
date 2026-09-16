import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, test } from "node:test"

import { MAX_CONTEXT_CHARS, MAX_CONTEXT_ENTRIES, MAX_CONTEXT_LINES, MAX_PROMPT_LINES, stableCompare } from "../memory-context.mjs"
import { makeCase } from "./helpers.mjs"

describe("deterministic bounded merged listings", () => {
  test("shows only user, current hashed+legacy session, and repo files with dedupe and sort", async (t) => {
    const { engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/z-user.md", file_text: "user" }, "current")
    await engine.run({ command: "create", path: "/memories/session/b-current.md", file_text: "current" }, "current")
    await engine.run({ command: "create", path: "/memories/session/same.md", file_text: "hashed" }, "current")
    await engine.run({ command: "create", path: "/memories/session/other-only.md", file_text: "other" }, "other")
    await engine.run({ command: "create", path: "/memories/repo/a-repo.md", file_text: "repo" }, "current")
    const legacy = engine.legacySessionRoot("current")
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "a-legacy.md"), "legacy")
    await fs.writeFile(path.join(legacy, "same.md"), "legacy duplicate")

    const listing = await engine.run({ command: "view", path: "/memories" }, "current")
    for (const expected of ["z-user.md", "session/a-legacy.md", "session/b-current.md", "session/same.md", "repo/a-repo.md"]) {
      assert.match(listing, new RegExp(expected.replace(".", "\\.")))
    }
    assert.doesNotMatch(listing, /other-only/)
    assert.equal(listing.match(/session\/same\.md/g)?.length, 1)
    assert.match(listing, /^6\tsession\/same\.md$/m)
    assert.ok(listing.indexOf("repo/a-repo.md") < listing.indexOf("session/a-legacy.md"))
    assert.ok(listing.indexOf("session/a-legacy.md") < listing.indexOf("session/b-current.md"))
    assert.ok(listing.indexOf("session/same.md") < listing.indexOf("z-user.md"))
    assert.deepEqual(["ä", "Z", "a"].sort(stableCompare), ["Z", "a", "ä"])
  })

  test("bounds merged root listings by entries and characters", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    await Promise.all(Array.from({ length: MAX_CONTEXT_ENTRIES + 20 }, (_, index) =>
      fs.writeFile(path.join(userRoot, `f-${String(index).padStart(3, "0")}-${"x".repeat(180)}.md`), "x")))
    const listing = await engine.run({ command: "view", path: "/memories" }, "bounded")
    assert.ok(listing.split("\n").length <= MAX_CONTEXT_ENTRIES)
    assert.ok(listing.length <= MAX_CONTEXT_CHARS)
  })

  test("counts dot-prefixed user entries toward listing limits and hides only internal names", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    await Promise.all(Array.from({ length: MAX_CONTEXT_ENTRIES + 10 }, (_, index) =>
      fs.writeFile(path.join(userRoot, `.dot-${String(index).padStart(3, "0")}.md`), "x")))
    await fs.writeFile(path.join(userRoot, ".memory-tmp-internal"), "internal")
    await fs.writeFile(path.join(userRoot, ".memory-lock-internal"), "internal")
    const listing = await engine.run({ command: "view", path: "/memories" }, "bounded-dots")
    assert.match(listing, /\.dot-000\.md/)
    assert.ok(listing.split("\n").length <= MAX_CONTEXT_ENTRIES)
    assert.doesNotMatch(listing, /memory-(?:tmp|lock)/)
  })

  test("recursively lists directories and hides control files and session identities", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    const sessionID = "private/raw-id"
    await engine.run({ command: "create", path: "/memories/nested/deeper/user.md", file_text: "u" }, sessionID)
    await engine.run({ command: "create", path: "/memories/session/nested/session.md", file_text: "s" }, sessionID)
    await engine.run({ command: "create", path: "/memories/repo/nested/repo.md", file_text: "r" }, sessionID)
    await fs.writeFile(path.join(userRoot, ".memory-lock-hidden"), "hidden")
    const listing = await engine.run({ command: "view", path: "/memories" }, sessionID)
    assert.match(listing, /nested\//)
    assert.match(listing, /nested\/deeper\/user\.md/)
    assert.match(listing, /session\/nested\/session\.md/)
    assert.match(listing, /repo\/nested\/repo\.md/)
    assert.doesNotMatch(listing, /memory-(?:lock|tmp|owner|access)|private|raw-id|[a-f0-9]{64}/)
    assert.match(listing, /^0\trepo\/$/m)
    assert.match(listing, /^0\tsession\/$/m)
  })
})

describe("safe bounded prompt context", () => {
  test("escapes names/content, preserves section order, and excludes only internal and unsafe entries", async (t) => {
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
    // Dot-prefixed user entries are user content and are rendered; only exact
    // internal bookkeeping names and symlinks are excluded.
    assert.match(context, /## \.hidden\.md/)
    assert.match(context, /hidden dot content/)
    assert.doesNotMatch(context, /<attack>|memory-tmp|linked|outside/)
    assert.ok(context.indexOf("<userMemory>") < context.indexOf("<sessionMemory>"))
    assert.ok(context.indexOf("<sessionMemory>") < context.indexOf("<repoMemory>"))
  })

  test("enforces prompt entry, line, and character bounds", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    await Promise.all(Array.from({ length: MAX_CONTEXT_ENTRIES + 20 }, (_, index) =>
      fs.writeFile(path.join(userRoot, `f-${String(index).padStart(3, "0")}.md`), "<&>".repeat(200) + "\nline\nline")))
    const context = await engine.buildContext("bounded")
    assert.ok(context.length <= MAX_CONTEXT_CHARS)
    assert.ok(context.split("\n").length <= MAX_PROMPT_LINES)
    assert.match(context, /<userMemory>[\s\S]*<\/userMemory>/)
    assert.match(context, /<sessionMemory>[\s\S]*<\/sessionMemory>/)
    assert.match(context, /<repoMemory>[\s\S]*<\/repoMemory>/)
  })

  test("retains the documented 200-line user-memory allowance", async (t) => {
    const { engine } = await makeCase(t)
    const lines = Array.from({ length: MAX_CONTEXT_LINES - 1 }, (_, index) => `line-${index}`)
    await engine.run({ command: "create", path: "/memories/allowance.md", file_text: lines.join("\n") }, "bounded")
    const context = await engine.buildContext("bounded")
    const userSection = context.slice(context.indexOf("<userMemory>"), context.indexOf("</userMemory>"))
    assert.match(userSection, /line-198/)
    assert.ok(userSection.trimEnd().split("\n").length <= MAX_CONTEXT_LINES + 2)
    assert.ok(context.split("\n").length <= MAX_PROMPT_LINES)
    assert.ok(context.length <= MAX_CONTEXT_CHARS)
  })

  test("discovers nested prompt files without exposing current or other session IDs", async (t) => {
    const { engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/nested/user.md", file_text: "nested user" }, "current/private")
    await engine.run({ command: "create", path: "/memories/session/nested/current.md", file_text: "current" }, "current/private")
    await engine.run({ command: "create", path: "/memories/session/other.md", file_text: "other" }, "other/private")
    await engine.run({ command: "create", path: "/memories/repo/nested/repo.md", file_text: "repo" }, "current/private")
    const context = await engine.buildContext("current/private")
    assert.match(context, /## nested\/user\.md/)
    assert.match(context, /\/memories\/session\/nested\/current\.md/)
    assert.match(context, /\/memories\/repo\/nested\/repo\.md/)
    assert.doesNotMatch(context, /other\.md|current\/private|other\/private|[a-f0-9]{64}/)
  })
})
