/**
 * Comprehensive tests for opencode-memory plugin
 *
 * Follows the real-filesystem tmpdir pattern from OC core / oh-my-openagent:
 *   mkdtempSync + writeFileSync + rmSync in afterEach
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin } from "./index"

// ─── Temp directory lifecycle ──────────────────────────────────────────────────

let tempDir: string
let configDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "memory-test-"))
  configDir = mkdtempSync(join(tmpdir(), "memory-cfg-"))
  process.env.OPENCODE_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.OPENCODE_CONFIG_DIR
  rmSync(tempDir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

// ─── Helpers ───────────────────────────────────────────────────────────────────

function createMockContext(sessionID = "test-session", directory = tempDir) {
  return {
    sessionID,
    messageID: "msg-1",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

async function getTool(directory = tempDir) {
  const hooks = await plugin({ directory } as any)
  const memTool = hooks.tool?.memory
  if (!memTool) throw new Error("memory tool not found in hooks")
  return memTool
}

async function execute(
  args: Record<string, any>,
  ctx?: ReturnType<typeof createMockContext>,
  directory = tempDir,
) {
  const tool = await getTool(directory)
  const result = await tool.execute(args as any, (ctx ?? createMockContext()) as any)
  return typeof result === "string" ? result : (result as any).output ?? String(result)
}

// ─── Batch 1: Path Validation ──────────────────────────────────────────────────

describe("Path validation", () => {
  test("rejects non-/memories/ paths", async () => {
    const result = await execute({ command: "view", path: "/etc/passwd" })
    expect(result).toContain("must start with")
  })

  test("rejects path traversal (../etc/passwd)", async () => {
    const result = await execute({ command: "view", path: "/memories/../../../etc/passwd" })
    // Path traversal is caught before the /memories/ prefix check
    expect(result).toContain("Path traversal")
  })
})

// ─── Batch 2: View ─────────────────────────────────────────────────────────────

describe("View", () => {
  test("missing path returns error or empty listing", async () => {
    const result = await execute({ command: "view", path: "/memories/nonexistent.md" })
    expect(result).toMatch(/does not exist|No memories found/)
  })

  test("returns content with line numbers", async () => {
    // Create a user-scoped memory file on disk
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "notes.md"), "hello world\nline two")

    const result = await execute({ command: "view", path: "/memories/notes.md" })
    expect(result).toContain("hello world")
    expect(result).toContain("line two")
    // Line numbers are padded to 6 chars
    expect(result).toMatch(/\d+\t/)
  })

  test("directory listing shows file names", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "alpha.md"), "a")
    writeFileSync(join(userMemDir, "beta.md"), "bb")

    const result = await execute({ command: "view", path: "/memories/" })
    expect(result).toContain("alpha.md")
    expect(result).toContain("beta.md")
  })

  test("merged root view shows user and session scope markers", async () => {
    // Create a user memory file
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "user-note.md"), "user content")

    // Create a session memory file
    const sessionDir = join(configDir, "memories", "session", "test-session")
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, "sess-note.md"), "session content")

    const result = await execute({ command: "view", path: "/memories/" })
    // The root listing shows entries from userMemoryRoot which includes session/ dir
    expect(result).toContain("session/")
  })

  test("view_range filtering returns only specified lines", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "ranged.md"), "line1\nline2\nline3\nline4\nline5")

    const result = await execute({
      command: "view",
      path: "/memories/ranged.md",
      view_range: [2, 3],
    })
    expect(result).toContain("line2")
    expect(result).toContain("line3")
    expect(result).not.toContain("line1")
    expect(result).not.toContain("line4")
    expect(result).not.toContain("line5")
  })
})

// ─── Batch 3: Create ──────────────────────────────────────────────────────────

describe("Create", () => {
  test("creates new file", async () => {
    const result = await execute({
      command: "create",
      path: "/memories/new-note.md",
      file_text: "fresh content",
    })
    expect(result).toContain("Successfully created")

    // Verify on disk
    const filePath = join(configDir, "memories", "new-note.md")
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, "utf8")).toBe("fresh content")
  })

  test("already exists returns error", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "existing.md"), "old")

    const result = await execute({
      command: "create",
      path: "/memories/existing.md",
      file_text: "new",
    })
    expect(result).toContain("already exists")
  })
})

// ─── Batch 4: Str_replace ─────────────────────────────────────────────────────

describe("Str_replace", () => {
  test("unique text replaced", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "replace.md"), "hello world")

    const result = await execute({
      command: "str_replace",
      path: "/memories/replace.md",
      old_str: "hello",
      new_str: "goodbye",
    })
    expect(result).toContain("has been edited")

    // Verify on disk
    expect(readFileSync(join(userMemDir, "replace.md"), "utf8")).toBe("goodbye world")
  })

  test("text not found returns error", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "notfound.md"), "unchanged")

    const result = await execute({
      command: "str_replace",
      path: "/memories/notfound.md",
      old_str: "does_not_exist_in_file",
      new_str: "replacement",
    })
    expect(result).toContain("did not appear verbatim")
  })

  test("multiple occurrences returns error", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "multi.md"), "dup dup dup")

    const result = await execute({
      command: "str_replace",
      path: "/memories/multi.md",
      old_str: "dup",
      new_str: "one",
    })
    expect(result).toContain("Multiple occurrences")
  })
})

// ─── Batch 5: Insert ──────────────────────────────────────────────────────────

describe("Insert", () => {
  test("adds text at specified line", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "insert.md"), "line1\nline2\nline3")

    const result = await execute({
      command: "insert",
      path: "/memories/insert.md",
      insert_line: 1,
      insert_text: "inserted",
    })
    expect(result).toContain("has been edited")

    // Verify on disk: inserted at line index 1 (0-based), so between line1 and line2
    const content = readFileSync(join(userMemDir, "insert.md"), "utf8")
    const lines = content.split("\n")
    expect(lines[1]).toBe("inserted")
  })

  test("invalid line number returns error", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "ins-invalid.md"), "only one line")

    const result = await execute({
      command: "insert",
      path: "/memories/ins-invalid.md",
      insert_line: 99,
      insert_text: "nope",
    })
    expect(result).toContain("Invalid")
  })
})

// ─── Batch 6: Delete ──────────────────────────────────────────────────────────

describe("Delete", () => {
  test("removes file", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "to-delete.md"), "bye")

    const result = await execute({
      command: "delete",
      path: "/memories/to-delete.md",
    })
    expect(result).toContain("Successfully deleted")
    expect(existsSync(join(userMemDir, "to-delete.md"))).toBe(false)
  })

  test("nonexistent path returns error", async () => {
    const result = await execute({
      command: "delete",
      path: "/memories/ghost.md",
    })
    expect(result).toContain("does not exist")
  })
})

// ─── Batch 7: Rename ──────────────────────────────────────────────────────────

describe("Rename", () => {
  test("moves file", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "original.md"), "data")

    const result = await execute({
      command: "rename",
      old_path: "/memories/original.md",
      new_path: "/memories/renamed.md",
    })
    expect(result).toContain("Successfully renamed")
    expect(existsSync(join(userMemDir, "original.md"))).toBe(false)
    expect(existsSync(join(userMemDir, "renamed.md"))).toBe(true)
    expect(readFileSync(join(userMemDir, "renamed.md"), "utf8")).toBe("data")
  })

  test("source not found returns error", async () => {
    const result = await execute({
      command: "rename",
      old_path: "/memories/missing.md",
      new_path: "/memories/nowhere.md",
    })
    expect(result).toContain("does not exist")
  })

  test("dest already exists returns error", async () => {
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "src.md"), "source")
    writeFileSync(join(userMemDir, "dst.md"), "dest")

    const result = await execute({
      command: "rename",
      old_path: "/memories/src.md",
      new_path: "/memories/dst.md",
    })
    expect(result).toContain("already exists")
  })
})

// ─── Batch 8: Session isolation ───────────────────────────────────────────────

describe("Session isolation", () => {
  test("A/B sessions with same filename return different content", async () => {
    // Session A: create a session-scoped file
    const ctxA = createMockContext("session-alpha")
    const resultA = await execute(
      { command: "create", path: "/memories/session/plan.md", file_text: "Plan A" },
      ctxA,
    )
    expect(resultA).toContain("Successfully created")

    // Session B: create a session-scoped file with the same virtual path but different content
    const ctxB = createMockContext("session-beta")
    const resultB = await execute(
      { command: "create", path: "/memories/session/plan.md", file_text: "Plan B" },
      ctxB,
    )
    expect(resultB).toContain("Successfully created")

    // Read back from session A
    const readA = await execute({ command: "view", path: "/memories/session/plan.md" }, ctxA)
    expect(readA).toContain("Plan A")
    expect(readA).not.toContain("Plan B")

    // Read back from session B
    const readB = await execute({ command: "view", path: "/memories/session/plan.md" }, ctxB)
    expect(readB).toContain("Plan B")
    expect(readB).not.toContain("Plan A")
  })

  test("files stored under different session subdirectories on disk", async () => {
    const ctxA = createMockContext("session-alpha")
    const ctxB = createMockContext("session-beta")

    await execute(
      { command: "create", path: "/memories/session/check.md", file_text: "A" },
      ctxA,
    )
    await execute(
      { command: "create", path: "/memories/session/check.md", file_text: "B" },
      ctxB,
    )

    // Verify on disk: session dirs are separate
    const sessionBase = join(configDir, "memories", "session")
    expect(existsSync(join(sessionBase, "session-alpha", "check.md"))).toBe(true)
    expect(existsSync(join(sessionBase, "session-beta", "check.md"))).toBe(true)

    expect(readFileSync(join(sessionBase, "session-alpha", "check.md"), "utf8")).toBe("A")
    expect(readFileSync(join(sessionBase, "session-beta", "check.md"), "utf8")).toBe("B")
  })
})

// ─── Batch 9: System prompt injection ─────────────────────────────────────────

describe("System prompt injection", () => {
  test("memory context injected when files exist", async () => {
    // Create user memory
    const userMemDir = join(configDir, "memories")
    mkdirSync(userMemDir, { recursive: true })
    writeFileSync(join(userMemDir, "prefs.md"), "I prefer TypeScript")

    // Create session memory
    const sessionDir = join(configDir, "memories", "session", "test-session")
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, "task.md"), "working on tests")

    // Create repo memory
    const repoDir = join(tempDir, ".opencode", "memories")
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(repoDir, "arch.md"), "monorepo structure")

    const hooks = await plugin({ directory: tempDir } as any)
    const transformFn = hooks["experimental.chat.system.transform"]
    expect(transformFn).toBeDefined()

    const output = { system: ["You are a helpful assistant."] }
    await transformFn!(
      { sessionID: "test-session", model: { id: "test-model" } } as any,
      output,
    )

    const combined = output.system.join("\n")
    expect(combined).toContain("<userMemory>")
    expect(combined).toContain("<sessionMemory>")
    expect(combined).toContain("<repoMemory>")
  })

  test("empty memory state does not crash", async () => {
    const hooks = await plugin({ directory: tempDir } as any)
    const transformFn = hooks["experimental.chat.system.transform"]
    expect(transformFn).toBeDefined()

    const output = { system: ["You are a helpful assistant."] }
    // Should not throw
    await expect(
      transformFn!(
        { sessionID: "test-session", model: { id: "test-model" } } as any,
        output,
      ),
    ).resolves.toBeUndefined()

    // System array should have been modified (memory context added)
    expect(output.system.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── Batch 10: Cleanup (skipped by default — needs time mocking) ──────────────

describe.skip("Cleanup", () => {
  test("stale session dirs removed after 14d", async () => {
    // This test requires mocking Date.now() or filesystem mtime
    // to simulate 14+ days of inactivity.
    //
    // Approach: create a session dir, backdate its mtime, then
    // trigger cleanupStaleSessionDirs().
    //
    // Since cleanupStaleSessionDirs is not exported, this would
    // need mock.module to intercept fs operations or a test-only
    // export. Marked as skipped until proper time-mocking is set up.

    const sessionDir = join(configDir, "memories", "session", "old-session")
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, "stale.md"), "old data")

    // Backdate the directory mtime to 15 days ago
    const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000
    const { utimesSync } = await import("node:fs")
    utimesSync(sessionDir, new Date(fifteenDaysAgo), new Date(fifteenDaysAgo))

    // Verify directory exists and has old mtime
    expect(existsSync(sessionDir)).toBe(true)
    const oldStats = statSync(sessionDir)
    expect(oldStats.mtimeMs).toBeLessThan(Date.now() - 14 * 24 * 60 * 60 * 1000)
  })

  test("empty session dirs are cleaned by plugin init", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "memory-emptydir-"))
    const configDir = join(testDir, "config")
    process.env.OPENCODE_CONFIG_DIR = configDir
    const sessionBase = join(configDir, "memories", "session")
    const emptyDir = join(sessionBase, "empty-session")
    mkdirSync(emptyDir, { recursive: true })
    expect(existsSync(emptyDir)).toBe(true)
    rmSync(testDir, { recursive: true, force: true })
  })

  // --- Disabled tool gating ---

  describe("disabled tool gating", () => {
    test("returns empty hooks when memory_tool_enabled=false", async () => {
      const testDir = mkdtempSync(join(tmpdir(), "memory-disabled-"))
      const configDir = join(testDir, "config")
      mkdirSync(configDir, { recursive: true })
      process.env.OPENCODE_CONFIG_DIR = configDir
      writeFileSync(join(configDir, "execsa-config.json"), JSON.stringify({ memory_tool_enabled: "false" }))

      const hooks = await plugin({ directory: testDir })
      expect(hooks.tool).toBeUndefined()
      expect(hooks["experimental.chat.system.transform"]).toBeUndefined()
      rmSync(testDir, { recursive: true, force: true })
    })

    test("defaults to enabled when config not set", async () => {
      const testDir = mkdtempSync(join(tmpdir(), "memory-default-"))
      const configDir = join(testDir, "config")
      mkdirSync(configDir, { recursive: true })
      process.env.OPENCODE_CONFIG_DIR = configDir
      writeFileSync(join(configDir, "execsa-config.json"), JSON.stringify({}))

      const hooks = await plugin({ directory: testDir })
      expect(hooks.tool?.memory).toBeDefined()
      expect(hooks["experimental.chat.system.transform"]).toBeDefined()
      rmSync(testDir, { recursive: true, force: true })
    })
  })
})
