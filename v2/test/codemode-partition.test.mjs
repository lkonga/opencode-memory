/**
 * Effective-registry tests for the V2 `memory` tool exposure.
 *
 * `server.mjs` only declares a registration. The *effective* surface the model
 * sees is produced by `Tool.Snapshot` (`packages/core/src/tool.ts`), which
 * partitions the active registrations on `options.codemode`:
 *
 *   direct   = active.filter(tool => tool.options?.codemode === false)
 *              -> native model tool definitions, dispatched by name
 *   codemode = active.filter(tool => tool.options?.codemode !== false)
 *              -> Code Mode catalog entries, reachable only through `execute`
 *
 * `partition()` below mirrors that split (and the `execute` dispatch order in
 * `Tool.Snapshot`) so the assertions run against the effective registry rather
 * than the raw added object. It is a local reimplementation on purpose: the
 * suite imports no V2 checkout, so it stays portable and dependency-free.
 */
import assert from "node:assert/strict"
import { rmSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"

import { MEMORY_DESCRIPTION } from "../memory-core.mjs"
import plugin, { PLUGIN_ID, setupMemoryV2 } from "../server.mjs"

// ── Effective registry mirror (Tool.Snapshot partition) ──────────────────────

const effectiveName = (tool) => tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")

const qualifiedName = (tool) =>
  tool.options?.namespace === undefined
    ? effectiveName(tool)
    : `${tool.options.namespace}.${effectiveName(tool)}`

const definition = (tool) => ({
  name: effectiveName(tool),
  description: tool.description,
  inputSchema: tool.input,
})

/**
 * Mirrors `Tool.Snapshot`: partition active registrations into the direct
 * (native) and Code Mode maps, derive the model-visible definitions and the
 * Code Mode catalog, and expose the same dispatch order.
 */
function partition(tools, { codeModeEnabled = true } = {}) {
  const active = new Map(tools.map((tool) => [effectiveName(tool), tool]))
  const direct = new Map(Array.from(active).filter(([, tool]) => tool.options?.codemode === false))
  const codemode = new Map(Array.from(active).filter(([, tool]) => tool.options?.codemode !== false))
  const codeModeCatalog = Array.from(codemode.values())
    .map((tool) => ({ path: qualifiedName(tool), description: tool.description }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  // `Tool.Snapshot` always defines `execute` while Code Mode is enabled, even
  // when no registration currently routes through it.
  const definitions = [
    ...Array.from(direct.keys())
      .sort()
      .map((name) => definition(direct.get(name))),
    ...(codeModeEnabled ? [definition({ name: "execute" })] : []),
  ]

  const calls = []
  const execute = async (call, context) => {
    calls.push(call.name)
    if (call.name === "execute" && codeModeEnabled)
      return { via: "execute", catalog: codeModeCatalog.map((entry) => entry.path) }
    const tool = direct.get(call.name)
    if (!tool) return { error: `Unknown tool: ${call.name}` }
    return { via: "direct", result: await tool.execute(call.input ?? {}, context) }
  }

  return { direct, codemode, codeModeCatalog, definitions, calls, execute }
}

// ── Fake V2 plugin context (captures every `draft.add`) ──────────────────────

function makeContext({ projectDir, userRoot, ...options } = {}) {
  const state = { tools: [], hookName: undefined, hook: undefined }
  const ctx = {
    options: { projectDir, userRoot, ...options },
    location: { directory: projectDir },
    tool: {
      transform: async (callback) => {
        const draft = { add: (tool) => state.tools.push(tool) }
        callback(draft)
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (name, callback) => {
        state.hookName = name
        state.hook = callback
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, state }
}

// Each case owns its own temp root, created eagerly at call time. Nothing here
// depends on a file-level `before` hook: on some Node versions a top-level
// `before` has not run yet when nested `describe` tests execute, which left the
// shared root undefined.
const tempDirs = []

function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

async function makeCase() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-partition-"))
  tempDirs.push(dir)
  const projectDir = path.join(dir, "project")
  // A private configDir keeps `readPluginConfig` off the machine's real
  // `execsa-config.json`, so the disabled/enabled gate is deterministic.
  const configDir = path.join(dir, "config")
  const userRoot = path.join(configDir, "memories")
  await fs.mkdir(projectDir, { recursive: true })
  await fs.mkdir(userRoot, { recursive: true })
  return { projectDir, configDir, userRoot }
}

// Primary cleanup; the synchronous `exit` handler is the safety net for Node
// versions where the suite `after` hook does not fire for nested describes.
// `splice(0)` keeps both paths idempotent.
after(cleanupTempDirs)
process.on("exit", cleanupTempDirs)

// ── Tests ────────────────────────────────────────────────────────────────────

describe("V2 plugin module contract", () => {
  test("still exposes the `{ id, setup }` default export", () => {
    assert.equal(plugin.id, PLUGIN_ID)
    assert.equal(plugin.setup, setupMemoryV2)
  })
})

describe("Code Mode partition of the `memory` registration", () => {
  test("effective model definitions contain exactly one direct `memory` tool", async () => {
    const { projectDir, configDir, userRoot } = await makeCase()
    const { ctx, state } = makeContext({ projectDir, configDir, userRoot })
    await setupMemoryV2(ctx)

    const effective = partition(state.tools)
    const memoryDefinitions = effective.definitions.filter((entry) => entry.name === "memory")

    assert.equal(memoryDefinitions.length, 1, "exactly one model definition named `memory`")
    assert.equal(effective.direct.size, 1)
    assert.equal(effective.direct.has("memory"), true)
    assert.equal(state.tools[0].options?.codemode, false, "codemode:false is what makes it direct")
    assert.equal(memoryDefinitions[0].description, MEMORY_DESCRIPTION)
    assert.equal(memoryDefinitions[0].inputSchema.type, "object")
  })

  test("Code Mode catalog excludes `memory`", async () => {
    const { projectDir, configDir, userRoot } = await makeCase()
    const { ctx, state } = makeContext({ projectDir, configDir, userRoot })
    await setupMemoryV2(ctx)

    const effective = partition(state.tools)

    assert.equal(effective.codemode.size, 0)
    assert.deepEqual(
      effective.codeModeCatalog.map((entry) => entry.path),
      [],
    )
    assert.equal(
      effective.codeModeCatalog.some((entry) => entry.path === "memory"),
      false,
    )
  })

  test("direct dispatch by name create then view succeeds on the first direct call without execute", async () => {
    const { projectDir, configDir, userRoot } = await makeCase()
    const { ctx, state } = makeContext({ projectDir, configDir, userRoot })
    await setupMemoryV2(ctx)

    const effective = partition(state.tools)

    // Advertised up front: no warm-up / execute round-trip is required to route it.
    assert.deepEqual(effective.definitions.map((entry) => entry.name), ["memory", "execute"])

    const created = await effective.execute(
      { name: "memory", input: { command: "create", path: "/memories/direct.md", file_text: "DIRECT-240\n" } },
      { sessionID: "sess-direct" },
    )
    assert.equal(created.via, "direct")
    assert.equal(created.result.content, "Successfully created /memories/direct.md")
    assert.equal(await fs.readFile(path.join(userRoot, "direct.md"), "utf8"), "DIRECT-240\n")

    const viewed = await effective.execute(
      { name: "memory", input: { command: "view", path: "/memories/direct.md" } },
      { sessionID: "sess-direct" },
    )
    assert.equal(viewed.via, "direct")
    assert.match(viewed.result.content, /DIRECT-240/)

    assert.deepEqual(effective.calls, ["memory", "memory"], "no `execute` round-trip was needed")
  })

  test("registers the memory tool exactly once", async () => {
    const { projectDir, configDir, userRoot } = await makeCase()
    const { ctx, state } = makeContext({ projectDir, configDir, userRoot })
    await setupMemoryV2(ctx)

    assert.equal(state.tools.length, 1, "one tool registration for one exposure")
    assert.equal(state.tools.filter((tool) => tool.name === "memory").length, 1)
    assert.deepEqual(
      partition(state.tools).definitions.filter((entry) => entry.name === "memory").map((entry) => entry.name),
      ["memory"],
    )
  })

  test("context injection hook remains intact alongside the direct registration", async () => {
    const { projectDir, configDir, userRoot } = await makeCase()
    await fs.writeFile(path.join(userRoot, "pref.md"), "PARTITION-CTX-240\n", "utf8")

    const { ctx, state } = makeContext({ projectDir, configDir, userRoot })
    await setupMemoryV2(ctx)

    assert.equal(state.hookName, "context")
    assert.equal(typeof state.hook, "function")

    const event = { sessionID: "sess-partition", system: [{ type: "text", text: "base prompt" }] }
    await state.hook(event)

    assert.equal(event.system.length, 2)
    assert.equal(event.system[0].text, "base prompt")
    assert.match(event.system[1].text, /<userMemory>/)
    assert.match(event.system[1].text, /PARTITION-CTX-240/)

    // The tool side of the same setup is still direct.
    assert.equal(partition(state.tools).direct.has("memory"), true)
  })

  test("disabled config removes memory from every effective surface", async () => {
    const { projectDir, configDir, userRoot } = await makeCase()
    const { ctx, state } = makeContext({ projectDir, configDir, userRoot, memory_tool_enabled: false })
    const cleanup = await setupMemoryV2(ctx)

    assert.equal(cleanup, undefined)
    assert.deepEqual(state.tools, [])
    assert.equal(state.hook, undefined)

    const effective = partition(state.tools)
    assert.equal(effective.direct.size, 0)
    assert.equal(effective.codemode.size, 0)
    assert.equal(
      effective.definitions.some((entry) => entry.name === "memory"),
      false,
    )
    assert.equal(
      effective.codeModeCatalog.some((entry) => entry.path === "memory"),
      false,
    )
  })
})

describe("partition harness control", () => {
  test("separates a codemode:false tool from an omitted-options (Code Mode) tool", () => {
    const noop = async () => ({ content: "" })
    const effective = partition([
      { name: "memory", description: "direct", input: { type: "object" }, options: { codemode: false }, execute: noop },
      { name: "lookup", description: "code mode", input: { type: "object" }, execute: noop },
    ])

    assert.equal(effective.direct.has("memory"), true)
    assert.equal(effective.codemode.has("lookup"), true)
    assert.deepEqual(
      effective.definitions.map((entry) => entry.name),
      ["memory", "execute"],
    )
    assert.deepEqual(
      effective.codeModeCatalog.map((entry) => entry.path),
      ["lookup"],
    )
  })
})
