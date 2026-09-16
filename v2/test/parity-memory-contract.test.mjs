import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, test } from "node:test"

import { MAX_MEMORY_FILE_BYTES, MAX_SCOPE_ENTRIES, MAX_USER_MEMORY_LINES, MEMORY_DESCRIPTION, OUTCOME_CODES, OUTCOME_ERROR, OUTCOME_SUCCESS } from "../memory-core.mjs"
import { MAX_CONTEXT_CHARS, MAX_PROMPT_LINES } from "../memory-context.mjs"
import { exists, makeCase } from "./helpers.mjs"

describe("V2 command parity", () => {
  test("honors empty insert_text, supports empty new_str fallback, and rejects empty old_str", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/edit.md", file_text: "a" }, "s")
    assert.match(await engine.run({ command: "insert", path: "/memories/edit.md", insert_line: 0, new_str: "" }, "s"), /has been edited/)
    assert.match(await engine.run({ command: "insert", path: "/memories/edit.md", insert_line: 0, insert_text: "", new_str: "wrong" }, "s"), /has been edited/)
    assert.equal(await fs.readFile(path.join(userRoot, "edit.md"), "utf8"), "\n\na")
    assert.match(await engine.run({ command: "str_replace", path: "/memories/edit.md", old_str: "", new_str: "x" }, "s"), /must not be empty/)
  })

  test("returns internal {text,outcome} while public run returns text", async (t) => {
    const { engine } = await makeCase(t)
    const result = await engine.runCommand({ command: "create", path: "/memories/outcome.md", file_text: "ok" }, "s")
    assert.equal(result.text, "Successfully created /memories/outcome.md")
    assert.deepEqual(result.outcome, {
      ok: true,
      type: "success",
      code: "created",
      content: result.text,
    })
    const failure = await engine.runOutcome({ command: "nope" }, "s")
    assert.equal(failure.text, failure.outcome.content)
    assert.equal(failure.outcome.ok, false)
    assert.equal(failure.outcome.type, "error")
    assert.equal(typeof await engine.run({ command: "view", path: "/memories/outcome.md" }, "s"), "string")
    assert.equal(OUTCOME_SUCCESS, "success")
    assert.equal(OUTCOME_ERROR, "error")
    assert.equal(OUTCOME_CODES.CREATED, "created")
  })

  test("sanitizes raw failure inputs and keeps logs code-only", async (t) => {
    const logs = []
    const { engine } = await makeCase(t, { log: (...parts) => logs.push(parts.join(" ")) })
    await engine.run({ command: "create", path: "/memories/safe.md", file_text: "present" }, "s")

    const oldStringPayload = "absent\n/raw/backing/path\u001b[31m"
    const replaceFailure = await engine.run({ command: "str_replace", path: "/memories/safe.md", old_str: oldStringPayload, new_str: "x" }, "s")
    assert.match(replaceFailure, /old_str did not appear verbatim in \/memories\/safe\.md/)
    assert.doesNotMatch(replaceFailure, /absent|raw\/backing|\u001b/)

    const rawPath = "/memories//missing\u0007\nname.md/"
    const pathFailure = await engine.run({ command: "view", path: rawPath }, "s")
    assert.match(pathFailure, /\/memories\/missing\\u0007\\u000aname\.md/)
    assert.equal(pathFailure.includes(rawPath), false)
    assert.doesNotMatch(pathFailure, /[\u0000-\u001f\u007f]/)

    const commandPayload = "unknown\n/raw/backing/path\u001b[31m"
    assert.equal(await engine.run({ command: commandPayload }, "s"), "Error: unknown command")

    const combinedLogs = logs.join("\n")
    assert.doesNotMatch(combinedLogs, /absent|raw\/backing|missing|unknown|\u001b/)
    for (const entry of logs) assert.match(entry, /^[A-Z0-9_]{1,24}$/)
  })

  test("blocks destructive operations on every scope root", async (t) => {
    const { engine } = await makeCase(t)
    for (const root of ["/memories", "/memories/session", "/memories/repo"]) {
      assert.match(await engine.run({ command: "delete", path: root }, "s"), /scope roots/i)
      assert.match(await engine.run({ command: "rename", old_path: root, new_path: `${root}/moved` }, "s"), /scope roots/i)
    }
  })

  test("truthfully describes retention, secrets, verification, and bounds", () => {
    assert.match(MEMORY_DESCRIPTION, /14 days of inactivity/i)
    assert.match(MEMORY_DESCRIPTION, /do not store.*secrets/i)
    assert.match(MEMORY_DESCRIPTION, /verify important information/i)
    assert.match(MEMORY_DESCRIPTION, /bounded/i)
    assert.doesNotMatch(MEMORY_DESCRIPTION, /cleared after the conversation ends/i)
  })

  test("enforces user-line plus overall file-size and count bounds atomically", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    const exactly = Array.from({ length: MAX_USER_MEMORY_LINES }, () => "line").join("\n")
    assert.match(await engine.run({ command: "create", path: "/memories/full.md", file_text: exactly }, "s"), /Successfully created/)
    assert.match(await engine.run({ command: "create", path: "/memories/extra.md", file_text: "extra" }, "s"), /200 total lines/i)
    assert.equal(await exists(path.join(userRoot, "extra.md")), false)
    assert.match(await engine.run({ command: "create", path: "/memories/repo/huge.md", file_text: "x".repeat(MAX_MEMORY_FILE_BYTES + 1) }, "s"), /size limit/i)
    assert.equal(await exists(path.join(engine.repoRoot, "huge.md")), false)
    for (let index = 0; index < MAX_SCOPE_ENTRIES; index += 1) {
      assert.match(await engine.run({ command: "create", path: `/memories/repo/${index}.md`, file_text: "x" }, "s"), /Successfully created/)
    }
    assert.match(await engine.run({ command: "create", path: "/memories/repo/overflow.md", file_text: "x" }, "s"), /scope limit/i)
    assert.equal(await exists(path.join(engine.repoRoot, "overflow.md")), false)
  })

  test("counts overlapping old_str occurrences as non-unique", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await engine.run({ command: "create", path: "/memories/overlap.md", file_text: "aaa" }, "s")
    assert.match(
      await engine.run({ command: "str_replace", path: "/memories/overlap.md", old_str: "aa", new_str: "b" }, "s"),
      /Multiple occurrences/,
    )
    assert.equal(await fs.readFile(path.join(userRoot, "overlap.md"), "utf8"), "aaa")
    assert.match(
      await engine.run({ command: "str_replace", path: "/memories/overlap.md", old_str: "", new_str: "b" }, "s"),
      /must not be empty/,
    )
    assert.equal(await fs.readFile(path.join(userRoot, "overlap.md"), "utf8"), "aaa")
  })
})

describe("strict runtime argument validation", () => {
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

  test("returns one fixed text and outcome without throwing, coercing, or writing", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    for (const [name, args] of cases) {
      const result = await engine.runCommand(args, "s")
      assert.equal(result.text, malformed, name)
      assert.equal(result.outcome.content, malformed, name)
      assert.equal(result.outcome.ok, false, name)
      assert.equal(result.outcome.type, "error", name)
      assert.equal(result.outcome.code, "invalid_arguments", name)
      assert.equal(await engine.run(args, "s"), malformed, name)
      assert.equal(await exists(path.join(userRoot, "a.md")), false, name)
    }
  })

  test("keeps the historical unknown-command contract for unknown command strings", async (t) => {
    const { engine } = await makeCase(t)
    assert.equal(await engine.run({ command: "nope" }, "s"), "Error: unknown command")
    assert.equal(await engine.run({ command: "" }, "s"), "Error: unknown command")
  })

  test("still accepts every valid command shape unchanged", async (t) => {
    const { engine } = await makeCase(t)
    assert.equal(await engine.run({ command: "create", path: "/memories/ok.md", file_text: "one\ntwo\n" }, "s"), "Successfully created /memories/ok.md")
    assert.match(await engine.run({ command: "view", path: "/memories/ok.md", view_range: [1, 2] }, "s"), /lines 1-2/)
    assert.match(await engine.run({ command: "str_replace", path: "/memories/ok.md", old_str: "one", new_str: "1" }, "s"), /has been edited/)
    assert.match(await engine.run({ command: "insert", path: "/memories/ok.md", insert_line: 0, insert_text: "top" }, "s"), /has been edited/)
    assert.equal(await engine.run({ command: "rename", path: "/memories/ok.md", new_path: "/memories/ok2.md" }, "s"), "Successfully renamed")
    assert.equal(await engine.run({ command: "delete", path: "/memories/ok2.md" }, "s"), "Successfully deleted /memories/ok2.md")
    assert.match(await engine.run({ command: "view" }, "s"), /repo\//)
  })
})

describe("bounded reads of externally seeded oversized files", () => {
  const tail = "TAIL-SENTINEL-218-ZX9"

  test("view and context stay capped while edits reject without modifying the file", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    const single = path.join(userRoot, "huge.md")
    await fs.writeFile(single, "A".repeat(MAX_MEMORY_FILE_BYTES + 50_000) + `\n${tail}`)
    await fs.writeFile(path.join(userRoot, "huge-lines.md"), "line\n".repeat(60_000) + tail)

    const view = await engine.run({ command: "view", path: "/memories/huge.md" }, "s")
    assert.match(view, /truncated/i)
    assert.ok(view.length <= MAX_MEMORY_FILE_BYTES + 2_000)
    assert.doesNotMatch(view, new RegExp(tail))

    const context = await engine.buildContext("s")
    assert.ok(context.length <= MAX_CONTEXT_CHARS)
    assert.ok(context.split("\n").length <= MAX_PROMPT_LINES)
    assert.doesNotMatch(context, new RegExp(tail))

    for (const args of [
      { command: "str_replace", path: "/memories/huge.md", old_str: "A", new_str: "B" },
      { command: "insert", path: "/memories/huge.md", insert_line: 0, insert_text: "top" },
    ]) {
      assert.match(await engine.run(args, "s"), /too large/i)
    }
    assert.equal((await fs.stat(single)).size, MAX_MEMORY_FILE_BYTES + 50_000 + 1 + tail.length)
    assert.equal((await fs.readdir(userRoot)).some((name) => name.startsWith(".memory-tmp-")), false)
  })
})

describe("dot-prefixed user memories are directly readable and fully counted", () => {
  const dotTail = "DOT-TAIL-SENTINEL-218-ZX9"

  test("views an existing dot file directly and bounds an externally seeded oversized dot file", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    assert.equal(
      await engine.run({ command: "create", path: "/memories/.visible.md", file_text: "DOT-DIRECT-218\n" }, "s"),
      "Successfully created /memories/.visible.md",
    )

    const direct = await engine.run({ command: "view", path: "/memories/.visible.md" }, "s")
    assert.match(direct, /Here's the content of \/memories\/\.visible\.md with line numbers:/)
    assert.match(direct, /DOT-DIRECT-218/)
    assert.doesNotMatch(direct, /truncated/i)

    const oversized = path.join(userRoot, ".oversized.md")
    const body = "A".repeat(MAX_MEMORY_FILE_BYTES + 40_000)
    await fs.writeFile(oversized, `${body}\n${dotTail}`)
    const bounded = await engine.run({ command: "view", path: "/memories/.oversized.md" }, "s")
    assert.match(bounded, /Here's the content of \/memories\/\.oversized\.md with line numbers:/)
    assert.match(bounded, /truncated/i)
    assert.ok(bounded.length <= MAX_MEMORY_FILE_BYTES + 2_000, `view output was ${bounded.length} chars`)
    assert.doesNotMatch(bounded, new RegExp(dotTail))
    assert.equal((await fs.stat(oversized)).size, body.length + 1 + dotTail.length)
  })

  test("counts externally seeded dot files toward the entry-count mutation bound", async (t) => {
    const { userRoot, engine } = await makeCase(t)
    await fs.mkdir(userRoot, { recursive: true })
    await Promise.all(Array.from({ length: MAX_SCOPE_ENTRIES - 1 }, (_, index) =>
      fs.writeFile(path.join(userRoot, `.seeded-${String(index).padStart(3, "0")}.md`), "x")))

    // Control: the last entry the bound allows is accepted with dot files counted.
    assert.match(await engine.run({ command: "create", path: "/memories/fill.md", file_text: "x" }, "s"), /Successfully created/)
    const output = await engine.run({ command: "create", path: "/memories/overflow.md", file_text: "x" }, "s")
    assert.match(output, /scope limit/i)
    assert.equal(await exists(path.join(userRoot, "overflow.md")), false)
    assert.equal((await fs.readdir(userRoot)).filter((name) => !name.startsWith(".memory-")).length, MAX_SCOPE_ENTRIES)
    assert.equal((await fs.readdir(userRoot)).some((name) => name.startsWith(".memory-tmp-")), false)
  })
})
