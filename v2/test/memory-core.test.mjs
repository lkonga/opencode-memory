import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"

import { createMemory, INPUT_SCHEMA, validatePath } from "../memory-core.mjs"

// Initialized eagerly at module scope (top-level await) so the state exists
// before any nested `describe` test runs. A file-level `before()` hook is not
// guaranteed to have run first on every Node version.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-core-"))
const projectDir = path.join(root, "project")
const userRoot = path.join(root, "config", "memories")
await fs.mkdir(projectDir, { recursive: true })
const engine = createMemory({ projectDir, userRoot })

after(async () => {
  engine.stopCleanup()
  await fs.rm(root, { recursive: true, force: true })
})

describe("path validation", () => {
  test("rejects traversal and non-memories roots", () => {
    assert.match(validatePath("/memories/../etc/passwd"), /Path traversal/)
    assert.match(validatePath("/etc/passwd"), /must start with \/memories\//)
    assert.match(validatePath("/memories/./x"), /Path traversal/)
    assert.equal(validatePath("/memories/x.md"), undefined)
  })

  test("resolves the three scopes", () => {
    assert.equal(engine.resolvePath("/memories/a.md", "s1").scope, "user")
    assert.equal(engine.resolvePath("/memories/session/a.md", "s1").scope, "session")
    assert.equal(engine.resolvePath("/memories/repo/a.md", "s1").scope, "repo")
    assert.equal(
      engine.resolvePath("/memories/session/a.md", "s1").real,
      path.join(engine.sessionRoot("s1"), "a.md"),
    )
    assert.equal(
      engine.resolvePath("/memories/repo/a.md", "s1").real,
      path.join(projectDir, ".opencode", "memories", "a.md"),
    )
  })
})

describe("read/write seam", () => {
  test("view on an empty user scope lists the repo entry", async () => {
    const out = await engine.run({ command: "view" }, "sess")
    assert.match(out, /repo\//)
  })

  test("create fails on duplicate", async () => {
    assert.equal(
      await engine.run({ command: "create", path: "/memories/notes.md", file_text: "alpha\nbeta\n" }, "sess"),
      "Successfully created /memories/notes.md",
    )
    assert.match(
      await engine.run({ command: "create", path: "/memories/notes.md", file_text: "x" }, "sess"),
      /already exists/,
    )
  })

  test("view returns numbered content and honors view_range", async () => {
    const numbered = await engine.run({ command: "view", path: "/memories/notes.md" }, "sess")
    assert.match(numbered, /1\talpha/)
    assert.match(numbered, /2\tbeta/)
    const ranged = await engine.run({ command: "view", path: "/memories/notes.md", view_range: [2, 2] }, "sess")
    assert.match(ranged, /lines 2-2/)
    assert.doesNotMatch(ranged, /alpha/)
    assert.match(
      await engine.run({ command: "view", path: "/memories/notes.md", view_range: [9, 9] }, "sess"),
      /out of range/,
    )
  })

  test("str_replace is unique-only and reports snippets", async () => {
    const ok = await engine.run(
      { command: "str_replace", path: "/memories/notes.md", old_str: "beta", new_str: "gamma" },
      "sess",
    )
    assert.match(ok, /has been edited/)
    assert.match(ok, /gamma/)
    assert.match(
      await engine.run({ command: "str_replace", path: "/memories/notes.md", old_str: "nope", new_str: "x" }, "sess"),
      /did not appear verbatim/,
    )
    await engine.run({ command: "create", path: "/memories/dupes.md", file_text: "same\nsame\n" }, "sess")
    assert.match(
      await engine.run(
        { command: "str_replace", path: "/memories/dupes.md", old_str: "same", new_str: "other" },
        "sess",
      ),
      /Multiple occurrences/,
    )
  })

  test("insert handles 0, middle and end and rejects out of range", async () => {
    await engine.run({ command: "create", path: "/memories/ins.md", file_text: "a\nb\n" }, "sess")
    await engine.run({ command: "insert", path: "/memories/ins.md", insert_line: 0, insert_text: "top" }, "sess")
    await engine.run({ command: "insert", path: "/memories/ins.md", insert_line: 2, insert_text: "mid" }, "sess")
    await engine.run({ command: "insert", path: "/memories/ins.md", insert_line: 4, insert_text: "end" }, "sess")
    const content = await fs.readFile(path.join(userRoot, "ins.md"), "utf8")
    assert.equal(content, "top\na\nmid\nb\nend\n")
    assert.match(
      await engine.run({ command: "insert", path: "/memories/ins.md", insert_line: 99, insert_text: "x" }, "sess"),
      /Invalid insert_line/,
    )
  })

  test("delete and rename respect scope and existence", async () => {
    await engine.run({ command: "create", path: "/memories/tmp.md", file_text: "one\n" }, "sess")
    assert.equal(await engine.run({ command: "rename", path: "/memories/tmp.md", new_path: "/memories/tmp2.md" }, "sess"), "Successfully renamed")
    assert.match(
      await engine.run({ command: "rename", path: "/memories/tmp2.md", new_path: "/memories/repo/tmp2.md" }, "sess"),
      /Cannot rename across different memory scopes/,
    )
    assert.equal(await engine.run({ command: "delete", path: "/memories/tmp2.md" }, "sess"), "Successfully deleted /memories/tmp2.md")
    assert.match(await engine.run({ command: "delete", path: "/memories/tmp2.md" }, "sess"), /does not exist/)
  })

  test("session scope is isolated per session and survives to disk", async () => {
    await engine.run({ command: "create", path: "/memories/session/s.md", file_text: "s-one" }, "sess-a")
    await engine.run({ command: "create", path: "/memories/session/s.md", file_text: "s-two" }, "sess-b")
    assert.equal(await fs.readFile(path.join(engine.sessionRoot("sess-a"), "s.md"), "utf8"), "s-one")
    assert.equal(await fs.readFile(path.join(engine.sessionRoot("sess-b"), "s.md"), "utf8"), "s-two")
  })

  test("repo scope writes under <project>/.opencode/memories", async () => {
    await engine.run({ command: "create", path: "/memories/repo/build.md", file_text: "npm test\n" }, "sess")
    assert.equal(await fs.readFile(path.join(projectDir, ".opencode", "memories", "build.md"), "utf8"), "npm test\n")
  })

  test("unknown command and traversal are safe failures", async () => {
    assert.match(await engine.run({ command: "nope" }, "sess"), /unknown command/)
    assert.match(
      await engine.run({ command: "create", path: "/memories/../escape.md", file_text: "x" }, "sess"),
      /Path traversal/,
    )
  })
})

describe("system prompt context", () => {
  test("includes user content, session and repo file listings", async () => {
    await engine.run({ command: "create", path: "/memories/pref.md", file_text: "MEMCTX-218-ZX9\n" }, "sess")
    await engine.run({ command: "create", path: "/memories/session/plan.md", file_text: "p\n" }, "sess")
    await engine.run({ command: "create", path: "/memories/repo/arch.md", file_text: "a\n" }, "sess")

    const context = await engine.buildContext("sess")
    assert.match(context, /<userMemory>/)
    assert.match(context, /## pref\.md/)
    assert.match(context, /MEMCTX-218-ZX9/)
    assert.match(context, /<sessionMemory>/)
    assert.match(context, /\/memories\/session\/plan\.md/)
    assert.match(context, /<repoMemory>/)
    assert.match(context, /\/memories\/repo\/arch\.md/)
  })

  test("empty scopes still produce the three markers", async () => {
    const emptyEngine = createMemory({ projectDir: path.join(root, "empty-project"), userRoot: path.join(root, "empty-user") })
    const context = await emptyEngine.buildContext("fresh")
    assert.match(context, /<userMemory>/)
    assert.match(context, /<sessionMemory>/)
    assert.match(context, /<repoMemory>/)
  })

  test("stale cleanup removes empty session dirs", async () => {
    const emptyDir = engine.sessionRoot("ghost")
    await fs.mkdir(emptyDir, { recursive: true })
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
    await fs.utimes(emptyDir, old, old)
    const deleted = engine.cleanupStaleSessionDirs()
    assert.ok(deleted >= 1)
    assert.equal(await fs.stat(emptyDir).then(() => true, () => false), false)
  })
})

describe("input schema", () => {
  test("is a plain object schema exposing the documented commands", () => {
    assert.equal(INPUT_SCHEMA.type, "object")
    assert.deepEqual(INPUT_SCHEMA.required, ["command"])
    assert.deepEqual(INPUT_SCHEMA.properties.command.enum, [
      "view",
      "create",
      "str_replace",
      "insert",
      "delete",
      "rename",
    ])
  })
})

describe("strict runtime argument validation independent of the schema", () => {
  const malformed = "Error: invalid arguments"
  const cases = [
    ["null arguments", null],
    ["missing command", {}],
    ["array arguments", []],
    ["primitive arguments", "view"],
    ["non-string command", { command: 7 }],
    ["numeric path", { command: "view", path: 7 }],
    ["numeric file_text", { command: "create", path: "/memories/a.md", file_text: 5 }],
    ["numeric old_str", { command: "str_replace", path: "/memories/a.md", old_str: 5, new_str: "x" }],
    ["numeric new_str", { command: "str_replace", path: "/memories/a.md", old_str: "a", new_str: 5 }],
    ["numeric insert_text", { command: "insert", path: "/memories/a.md", insert_line: 0, insert_text: 5 }],
    ["string insert_line", { command: "insert", path: "/memories/a.md", insert_line: "1", insert_text: "x" }],
    ["fractional insert_line", { command: "insert", path: "/memories/a.md", insert_line: 1.5, insert_text: "x" }],
    ["NaN insert_line", { command: "insert", path: "/memories/a.md", insert_line: Number.NaN, insert_text: "x" }],
    ["infinite insert_line", { command: "insert", path: "/memories/a.md", insert_line: Number.POSITIVE_INFINITY, insert_text: "x" }],
    ["short view_range", { command: "view", path: "/memories/a.md", view_range: [1] }],
    ["long view_range", { command: "view", path: "/memories/a.md", view_range: [1, 2, 3] }],
    ["non-array view_range", { command: "view", path: "/memories/a.md", view_range: "1,2" }],
    ["fractional view_range", { command: "view", path: "/memories/a.md", view_range: [1.5, 2] }],
    ["NaN view_range", { command: "view", path: "/memories/a.md", view_range: [Number.NaN, 2] }],
    ["infinite view_range", { command: "view", path: "/memories/a.md", view_range: [1, Number.POSITIVE_INFINITY] }],
    ["numeric old_path", { command: "rename", old_path: 3, new_path: "/memories/b.md" }],
    ["numeric new_path", { command: "rename", old_path: "/memories/a.md", new_path: 3 }],
  ]

  test("returns one fixed text and outcome without throwing or coercing", async () => {
    for (const [name, args] of cases) {
      const result = await engine.runCommand(args, "sess")
      assert.equal(result.text, malformed, name)
      assert.equal(result.outcome.content, malformed, name)
      assert.equal(result.outcome.ok, false, name)
      assert.equal(result.outcome.type, "error", name)
      assert.equal(result.outcome.code, "invalid_arguments", name)
      assert.equal(await engine.run(args, "sess"), malformed, name)
    }
  })

  test("keeps the historical unknown-command contract for unknown command strings", async () => {
    assert.equal(await engine.run({ command: "nope" }, "sess"), "Error: unknown command")
    assert.equal(await engine.run({ command: "" }, "sess"), "Error: unknown command")
  })
})

describe("str_replace overlap detection", () => {
  test("reports overlapping occurrences as non-unique and never rewrites", async () => {
    const overlapEngine = createMemory({ projectDir: path.join(root, "overlap-project"), userRoot: path.join(root, "overlap-user") })
    assert.equal(await overlapEngine.run({ command: "create", path: "/memories/aaa.md", file_text: "aaa" }, "s"), "Successfully created /memories/aaa.md")
    assert.match(
      await overlapEngine.run({ command: "str_replace", path: "/memories/aaa.md", old_str: "aa", new_str: "b" }, "s"),
      /Multiple occurrences/,
    )
    assert.equal(await fs.readFile(path.join(root, "overlap-user", "aaa.md"), "utf8"), "aaa")
  })
})
