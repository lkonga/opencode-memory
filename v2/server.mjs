/**
 * opencode-memory — V2 plugin entry.
 *
 * Public V2 plugin API only (see /home/lkonga/codes/opencode-v2-scrollfix):
 *   - packages/plugin/src/promise/plugin.ts        Context { tool, session, options, app, ... }
 *   - packages/plugin/src/promise/tool.ts          tool.transform(draft => draft.add(tool))
 *   - packages/plugin/src/promise/session.ts       session.hook("context", event => ...) with mutable event.system
 *   - packages/plugin/src/promise/adapter.ts       exposes `location` and adapts promise plugins
 *
 * The V2 default export contract is `{ id, setup }`
 * (packages/core/src/plugin/supervisor.ts PluginModule schema).
 *
 * Nothing here touches the V1 implementation (../index.ts), V1 config, or V1 state.
 */
import { existsSync, readFileSync } from "fs"
import path from "path"
import {
  createMemory,
  defaultConfigDir,
  errorCode,
  INPUT_SCHEMA,
  MEMORY_DESCRIPTION,
} from "./memory-core.mjs"

export const PLUGIN_ID = "opencode-memory-v2"

const isExecsaAgent = (agent) => typeof agent === "string" && agent.startsWith("execsa")

function readPluginConfig(configDir) {
  try {
    const p = path.join(configDir, "execsa-config.json")
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"))
  } catch {}
  return {}
}

/**
 * @param {object} ctx V2 Plugin.Context
 */
export async function setupMemoryV2(ctx) {
  const options = ctx?.options ?? {}
  const configDir = options.configDir ?? defaultConfigDir(process.env)
  const config = readPluginConfig(configDir)

  const debug = options.debug_logging === true || config.debug_logging === "true"
  const disabledByOptions = options.memory_tool_enabled === false || options.memory_tool_enabled === "false"
  const disabledByConfig = config.memory_tool_enabled === false || config.memory_tool_enabled === "false"
  const enabled = !disabledByOptions && !disabledByConfig
  const log = debug ? (code) => console.error(code) : () => {}

  if (!enabled) {
    log("MEMORY_DISABLED")
    return
  }

  // V2 exposes the current project through `ctx.location.directory`
  // (packages/plugin/src/promise/plugin.ts upstream Context, adapter.ts `location: host.location`).
  const projectDir = options.projectDir ?? ctx?.location?.directory ?? process.cwd()
  const userRoot = options.userRoot ?? path.join(configDir, "memories")

  const memory = createMemory({
    projectDir,
    userRoot,
    log,
    now: options.now,
    beforeCommit: options.beforeCommit,
    beforeMutation: options.beforeMutation,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  })
  memory.startCleanup()
  log("MEMORY_PLUGIN_LOADED")

  const registrations = []

  // ── Register the memory tool ────────────────────────────────────────────────
  registrations.push(
    await ctx.tool.transform((draft) => {
      draft.add({
        name: "memory",
        description: MEMORY_DESCRIPTION,
        input: INPUT_SCHEMA,
        // Expose `memory` directly on the provider's native tool list.
        // Tool.Snapshot partitions on `options.codemode === false`, so this
        // keeps `memory` out of the Code Mode catalog (and therefore callable
        // by name without an `execute` round-trip).
        options: { codemode: false },
        execute: async (input, context) => ({
          content: await memory.run(input ?? {}, context?.sessionID),
        }),
      })
    }),
  )

  // ── Inject memory context into the session system prompt ────────────────────
  // V2 equivalent of V1's `experimental.chat.system.transform`:
  // the session "context" hook receives the mutable `system: Array<SystemPart>`.
  registrations.push(
    await ctx.session.hook("context", async (event) => {
      if (!event || typeof event !== "object") return
      const sessionID = event.sessionID
      if (!sessionID) return
      if (!Array.isArray(event.system)) return
      if (isExecsaAgent(event.agent)) return
      let context
      try {
        context = await memory.buildContext(sessionID)
      } catch (error) {
        log(errorCode(error))
        return
      }
      if (context) event.system.push({ type: "text", text: context })
    }),
  )

  return async () => {
    memory.stopCleanup()
    for (const registration of registrations.reverse()) {
      try {
        await registration?.dispose?.()
      } catch {}
    }
  }
}

export default {
  id: PLUGIN_ID,
  setup: setupMemoryV2,
}
