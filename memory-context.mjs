/**
 * V1 runtime context helper for the opencode-memory plugin.
 *
 * Semantically identical to the V2 reference (`v2/memory-context.mjs`):
 * merged listings and injected system-prompt context are deterministic,
 * bounded in entries/lines/characters, and XML-escaped.
 */
import { safeEntries, safeRead } from "./memory-safe-fs.mjs"

export const MAX_CONTEXT_ENTRIES = 100
export const MAX_CONTEXT_LINES = 200
export const MAX_CONTEXT_CHARS = 20_000
export const MAX_PROMPT_LINES = MAX_CONTEXT_LINES + 29

export const stableCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0

export function xmlEscape(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\t", "&#9;")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

const MAX_WALK_ENTRIES = MAX_CONTEXT_ENTRIES * 4

function listingEscape(value) {
  return String(value).replace(/[\\\u0000-\u001f\u007f]/g, (character) => {
    if (character === "\\") return "\\\\"
    if (character === "\r") return "\\r"
    if (character === "\n") return "\\n"
    if (character === "\t") return "\\t"
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  })
}

export async function recursiveEntries(root, dir, options = {}) {
  const output = []
  const maxEntries = options.maxEntries ?? MAX_WALK_ENTRIES
  const visit = async (current, prefix, depth) => {
    if (output.length >= maxEntries) return
    let entries
    try {
      entries = (await safeEntries(root, current)).sort((a, b) => stableCompare(a.name, b.name))
    } catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      if (output.length >= maxEntries) break
      if (depth === 0 && options.skipTopLevel?.(entry.name)) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.stat.isDirectory()) {
        output.push({ ...entry, relative, scopeRoot: root })
        await visit(entry.target, relative, depth + 1)
      } else if (entry.stat.isFile()) {
        output.push({ ...entry, relative, scopeRoot: root })
      }
    }
  }
  await visit(dir, "", 0)
  return output.sort((a, b) => stableCompare(a.relative, b.relative)).slice(0, maxEntries)
}

export async function mergedSessionEntries(sessionRoots) {
  const merged = new Map()
  for (const item of sessionRoots) {
    for (const entry of await recursiveEntries(item.scopeRoot, item.dir)) {
      if (!merged.has(entry.relative)) merged.set(entry.relative, entry)
    }
  }
  return [...merged.values()].sort((a, b) => stableCompare(a.relative, b.relative)).slice(0, MAX_WALK_ENTRIES)
}

export async function mergedSessionFiles(sessionRoots) {
  return (await mergedSessionEntries(sessionRoots)).filter((entry) => entry.stat.isFile()).slice(0, MAX_CONTEXT_ENTRIES)
}

function appendBounded(target, values, state, limits) {
  for (const value of values) {
    if (state.lines >= limits.lines || state.chars >= limits.chars) break
    const text = String(value)
    const room = limits.chars - state.chars
    let accepted = text.slice(0, room)
    if (accepted.length < text.length && accepted.lastIndexOf("&") > accepted.lastIndexOf(";")) {
      accepted = accepted.slice(0, accepted.lastIndexOf("&"))
    }
    target.push(accepted)
    state.lines += 1
    state.chars += accepted.length + 1
  }
}

export async function buildMemoryContext({ userRoot, repoRoot, sessionRoots }) {
  const reserved = (name) => ["session", "repo"].includes(name.toLocaleLowerCase("en-US"))
  const userFiles = (await recursiveEntries(userRoot, userRoot, { skipTopLevel: reserved })).filter((entry) => entry.stat.isFile())
  const sessionFiles = await mergedSessionFiles(sessionRoots)
  const repoFiles = (await recursiveEntries(repoRoot, repoRoot)).filter((entry) => entry.stat.isFile())
  const state = { lines: 0, chars: 0 }
  const userLines = []

  for (const file of userFiles.slice(0, MAX_CONTEXT_ENTRIES)) {
    if (state.lines >= MAX_CONTEXT_LINES || state.chars >= 14_000) break
    let content = ""
    try {
      content = (await safeRead(userRoot, file.target)).content
    } catch {
      continue
    }
    // Bound the split before escaping: `safeRead` already caps the bytes, and
    // this caps the number of rendered lines so a huge file cannot blow up the
    // mapping/append step (the row cap matches MAX_CONTEXT_LINES exactly).
    const remaining = Math.max(1, MAX_CONTEXT_LINES - state.lines)
    appendBounded(userLines, [`## ${xmlEscape(file.relative)}`, ...content.split("\n", remaining).map(xmlEscape)], state, { lines: MAX_CONTEXT_LINES, chars: 14_000 })
  }

  const sessionNames = []
  appendBounded(sessionNames, sessionFiles.map((file) => `/memories/session/${xmlEscape(file.relative)}`), { lines: 0, chars: 0 }, { lines: 10, chars: 2_000 })
  const repoNames = []
  appendBounded(repoNames, repoFiles.slice(0, MAX_CONTEXT_ENTRIES).map((file) => `/memories/repo/${xmlEscape(file.relative)}`), { lines: 0, chars: 0 }, { lines: 10, chars: 2_000 })
  const context = ["<userMemory>"]
  if (userLines.length) {
    context.push("The following are persistent user memory notes. Verify important information before relying on it.")
    context.push(...userLines)
  } else {
    context.push("No user preferences or notes saved yet. Use the memory tool to store persistent notes under /memories/.")
  }
  context.push("</userMemory>", "<sessionMemory>")
  if (sessionNames.length) {
    context.push("Current-session memory files (expire after 14 days of inactivity):", ...sessionNames)
  } else {
    context.push("Current session memory is empty.")
  }
  context.push("</sessionMemory>", "<repoMemory>")
  if (repoNames.length) context.push("Current-project memory files:", ...repoNames)
  else context.push("Repository memory is empty.")
  context.push("</repoMemory>")

  return context.join("\n")
}

export async function boundedDirectoryListing(groups, fixedRows = []) {
  const rows = [...fixedRows]
  for (const group of groups) {
    const entries = group.entries ?? await recursiveEntries(group.scopeRoot, group.dir, { skipTopLevel: group.skipTopLevel })
    for (const entry of entries) {
      const key = `${group.prefix}${entry.relative}`
      const suffix = entry.stat.isDirectory() ? "/" : ""
      rows.push({ key, text: `${entry.stat.isDirectory() ? 0 : entry.stat.size}\t${listingEscape(key)}${suffix}` })
    }
  }
  const deduped = new Map()
  for (const row of rows) if (!deduped.has(row.key)) deduped.set(row.key, row.text)
  const sorted = [...deduped].sort(([left], [right]) => stableCompare(left, right)).map(([, text]) => text)
  const output = []
  let chars = 0
  for (const row of sorted.slice(0, MAX_CONTEXT_ENTRIES)) {
    if (chars + row.length + 1 > MAX_CONTEXT_CHARS) break
    output.push(row)
    chars += row.length + 1
  }
  return output.join("\n") || "(empty directory)"
}
