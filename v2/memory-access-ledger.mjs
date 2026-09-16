import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import path from "node:path"

import { ACCESS_FILE, assertSafePath, atomicUpdate, exclusiveCreate, markAccess, safeRead } from "./memory-safe-fs.mjs"

export { ACCESS_FILE }
const MAX_LEDGER_BYTES = 128_000
const MAX_LEDGER_ENTRIES = 512

function relativeKey(sessionDir, target) {
  const relative = path.relative(path.resolve(sessionDir), path.resolve(target))
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error("Access target escapes its session")
    error.code = "EPERM"
    throw error
  }
  return (relative || ".").split(path.sep).join("/")
}

function parsedLedger(content) {
  if (Buffer.byteLength(content, "utf8") > MAX_LEDGER_BYTES) return Object.create(null)
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Object.create(null)
    const entries = Object.entries(parsed)
      .filter(([key, value]) => typeof key === "string" && key.length <= 1_024 && Number.isFinite(value) && value >= 0)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return Object.fromEntries(entries)
  } catch {
    return Object.create(null)
  }
}

function boundedLedger(ledger, key, timestamp) {
  const entries = Object.entries({ ...ledger, [key]: timestamp })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => rightValue - leftValue || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
    .slice(0, MAX_LEDGER_ENTRIES)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return `${JSON.stringify(Object.fromEntries(entries))}\n`
}

export async function recordSessionAccess(root, sessionDir, target, timestamp) {
  await assertSafePath(root, sessionDir, { allowMissing: false })
  await assertSafePath(root, target, { allowMissing: false })
  const key = relativeKey(sessionDir, target)
  await markAccess(root, target, timestamp)
  const ledgerPath = path.join(sessionDir, ACCESS_FILE)

  for (let attempt = 0; attempt < 20; attempt += 1) {
    let original
    try {
      original = await safeRead(root, ledgerPath, { maxBytes: MAX_LEDGER_BYTES })
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    const content = boundedLedger(original ? parsedLedger(original.content) : {}, key, timestamp)
    try {
      if (original) await atomicUpdate(root, ledgerPath, original, content, undefined, { maxBytes: MAX_LEDGER_BYTES })
      else await exclusiveCreate(root, ledgerPath, content)
      return
    } catch (error) {
      if (!["EBUSY", "EEXIST", "ESTALE", "ENOENT"].includes(error?.code) || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

export function readAccessLedgerSync(root, sessionDir) {
  const ledgerPath = path.join(sessionDir, ACCESS_FILE)
  let handle
  try {
    const rootStat = lstatSync(root)
    const parentStat = lstatSync(sessionDir)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || parentStat.isSymbolicLink() || !parentStat.isDirectory()) return Object.create(null)
    const canonicalRoot = realpathSync(root)
    const canonicalParent = realpathSync(sessionDir)
    const parentRelative = path.relative(canonicalRoot, canonicalParent)
    if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) return Object.create(null)
    const relative = path.relative(path.resolve(root), path.resolve(ledgerPath))
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return Object.create(null)
    handle = openSync(ledgerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(handle)
    const namedStat = lstatSync(ledgerPath)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LEDGER_BYTES || namedStat.isSymbolicLink() || stat.dev !== namedStat.dev || stat.ino !== namedStat.ino) return Object.create(null)
    const buffer = Buffer.alloc(stat.size)
    const bytesRead = readSync(handle, buffer, 0, stat.size, 0)
    const content = buffer.subarray(0, bytesRead).toString("utf8")
    const afterParent = lstatSync(sessionDir)
    if (afterParent.isSymbolicLink() || afterParent.dev !== parentStat.dev || afterParent.ino !== parentStat.ino || realpathSync(sessionDir) !== canonicalParent) return Object.create(null)
    return parsedLedger(content)
  } catch {
    return Object.create(null)
  } finally {
    if (handle !== undefined) try { closeSync(handle) } catch {}
  }
}
