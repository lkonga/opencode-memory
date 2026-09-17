/**
 * V1 runtime safe-filesystem helper for the opencode-memory plugin.
 *
 * Semantically identical to the V2 reference (`v2/memory-safe-fs.mjs`): every
 * read/write path is canonically contained in its managed scope, symlinked
 * components (including the final component) are rejected, and mutations are
 * durable and no-clobber. `index.ts` never touches the filesystem directly.
 */
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
export const TEMP_PREFIX = ".memory-tmp-"
export const LOCK_PREFIX = ".memory-lock-"
export const OWNER_FILE = ".memory-owner"
export const ACCESS_FILE = ".memory-access"
export const STALE_ARTIFACT_MS = 5 * 60 * 1000

/**
 * Hard ceiling for one bounded read. Callers may request a smaller `maxBytes`;
 * reads never allocate or return more than `maxBytes + 1` bytes (the sentinel
 * byte proves there is more content) and never slurp a whole untrusted file.
 */
export const MAX_READ_BYTES = 100_000

/**
 * Exact internal bookkeeping names. Only these are excluded from virtual
 * listings, directory walking, and limit accounting — every other entry,
 * including user dot-prefixed memories, is user content and counts.
 */
export function isInternalMemoryEntry(name) {
  return (
    name === OWNER_FILE ||
    name === ACCESS_FILE ||
    name.startsWith(TEMP_PREFIX) ||
    name.startsWith(LOCK_PREFIX)
  )
}

function escapeCode(error, fallback) {
  if (error && typeof error === "object" && "code" in error) return error
  const wrapped = new Error(fallback)
  wrapped.code = "EIO"
  return wrapped
}

export function containedPath(root, ...parts) {
  const base = path.resolve(root)
  const target = path.resolve(base, ...parts)
  const rel = path.relative(base, target)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    const error = new Error("Path escapes its memory scope")
    error.code = "EPERM"
    throw error
  }
  return target
}

export async function ensureManagedDir(root, dir = root) {
  const target = containedPath(root, path.relative(path.resolve(root), path.resolve(dir)))
  // Recursive mkdir applies the requested mode only to objects it creates.
  // Existing external parents and an existing scope root retain their modes.
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const rel = path.relative(path.resolve(root), target)
  const paths = [path.resolve(root)]
  if (rel) {
    let current = path.resolve(root)
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part)
      paths.push(current)
    }
  }
  for (const current of paths) {
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      try { await fs.mkdir(current, { mode: 0o700 }) } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError
      }
      stat = await fs.lstat(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      const error = new Error("Symlink or non-directory in managed path")
      error.code = "ELOOP"
      throw error
    }
  }
  return target
}

export async function assertSafePath(root, target, { allowMissing = true } = {}) {
  const safe = containedPath(root, path.relative(path.resolve(root), path.resolve(target)))
  const rootStat = await fs.lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    const error = new Error("Memory scope root must be a real directory")
    error.code = "ELOOP"
    throw error
  }
  const canonicalRoot = await fs.realpath(root)
  const rel = path.relative(path.resolve(root), safe)
  let current = path.resolve(root)
  for (const part of rel ? rel.split(path.sep) : []) {
    current = path.join(current, part)
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing) break
      throw error
    }
    if (stat.isSymbolicLink()) {
      const error = new Error("Symlinks are not allowed in memory paths")
      error.code = "ELOOP"
      throw error
    }
    const canonical = await fs.realpath(current)
    const canonicalRel = path.relative(canonicalRoot, canonical)
    if (canonicalRel === ".." || canonicalRel.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRel)) {
      const error = new Error("Canonical path escapes its memory scope")
      error.code = "EPERM"
      throw error
    }
  }
  return safe
}

async function syncParent(file) {
  let handle
  try {
    handle = await fs.open(path.dirname(file), constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

function fsError(code, message) {
  return Object.assign(new Error(message), { code })
}

async function captureDirectory(root, dir) {
  await assertSafePath(root, dir, { allowMissing: false })
  const stat = await fs.lstat(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw fsError("ELOOP", "Unsafe managed directory")
  return { dev: stat.dev, ino: stat.ino, canonical: await fs.realpath(dir) }
}

async function verifyDirectory(root, dir, original) {
  await assertSafePath(root, dir, { allowMissing: false })
  const stat = await fs.lstat(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== original.dev || stat.ino !== original.ino || await fs.realpath(dir) !== original.canonical) {
    throw fsError("ESTALE", "Managed directory changed before mutation")
  }
}

async function verifyInode(target, original, message = "Temporary file changed before mutation") {
  const stat = await fs.lstat(target)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== original.dev || stat.ino !== original.ino) throw fsError("ESTALE", message)
  return stat
}

function lockPath(dir, key) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 24)
  return path.join(dir, `${LOCK_PREFIX}${digest}`)
}

const entryLock = (root, target) => ({ root, dir: path.dirname(target), key: `entry:${path.basename(target)}` })

async function removeIfSameInode(target, original) {
  const current = await fs.lstat(target).catch(() => undefined)
  if (!current || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino) return false
  await fs.unlink(target)
  return true
}

async function removeMatchingInode(root, original, prefix) {
  let visited = 0
  const visit = async (dir) => {
    if (visited++ > 10_000) return false
    let entries
    try {
      await assertSafePath(root, dir, { allowMissing: false })
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { return false }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const target = path.join(dir, entry.name)
      const stat = await fs.lstat(target).catch(() => undefined)
      if (!stat || stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (await visit(target)) return true
      } else if ((!prefix || entry.name.startsWith(prefix)) && stat.dev === original.dev && stat.ino === original.ino) {
        return removeIfSameInode(target, original).catch(() => false)
      }
    }
    return false
  }
  return visit(root)
}

async function acquireLock(root, dir, key) {
  const target = lockPath(dir, key)
  const parentIdentity = await captureDirectory(root, dir)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle
    let createdStat
    try {
      handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
      const stat = await handle.stat()
      createdStat = stat
      await handle.chmod(0o600)
      await handle.writeFile(`${process.pid}\n`, "utf8")
      await handle.sync()
      await verifyDirectory(root, dir, parentIdentity)
      await verifyInode(target, stat, "Mutation lock changed after creation")
      return {
        async release() {
          await handle.close().catch(() => {})
          if (!await removeIfSameInode(target, stat).catch(() => false)) await removeMatchingInode(root, stat, LOCK_PREFIX).catch(() => {})
        },
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if (createdStat && !await removeIfSameInode(target, createdStat).catch(() => false)) {
        await removeMatchingInode(root, createdStat, LOCK_PREFIX).catch(() => {})
      }
      if (error?.code !== "EEXIST") throw error
      const stale = await fs.lstat(target).catch(() => undefined)
      if (!stale || stale.isSymbolicLink() || !stale.isFile()) throw fsError("ELOOP", "Unsafe mutation lock")
      if (Date.now() - stale.mtimeMs <= STALE_ARTIFACT_MS || !await removeIfSameInode(target, stale).catch(() => false)) {
        throw fsError("EBUSY", "Memory path is locked by another writer")
      }
    }
  }
  throw fsError("EBUSY", "Memory path is locked by another writer")
}

async function withLocks(specs, task) {
  const unique = new Map()
  for (const spec of specs) unique.set(`${spec.dir}\0${spec.key}`, spec)
  const ordered = [...unique.values()].sort((a, b) => `${a.dir}\0${a.key}`.localeCompare(`${b.dir}\0${b.key}`))
  const locks = []
  try {
    for (const spec of ordered) locks.push(await acquireLock(spec.root, spec.dir, spec.key))
    return await task()
  } finally {
    for (const lock of locks.reverse()) await lock.release()
  }
}

export async function markAccess(root, target, timestamp) {
  await assertSafePath(root, target, { allowMissing: false })
  const parent = path.dirname(target)
  const parentIdentity = await captureDirectory(root, parent)
  const handle = await fs.open(target, constants.O_RDONLY | NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw fsError("ELOOP", "Unsafe access target")
    await verifyDirectory(root, parent, parentIdentity)
    await handle.utimes(new Date(timestamp), stat.mtime)
    await verifyDirectory(root, parent, parentIdentity)
  } finally {
    await handle.close()
  }
}

export async function claimDirectoryOwner(root, dir, owner) {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw fsError("EINVAL", "Invalid owner claim")
  await assertSafePath(root, dir, { allowMissing: false })
  const stat = await fs.lstat(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw fsError("ELOOP", "Unsafe legacy session directory")
  const ownerPath = path.join(dir, OWNER_FILE)
  return withLocks([entryLock(root, ownerPath)], async () => {
    const parentIdentity = await captureDirectory(root, dir)
    let handle
    let createdStat
    try {
      handle = await fs.open(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
      createdStat = await handle.stat()
      await handle.chmod(0o600)
      await handle.writeFile(owner, "utf8")
      await handle.sync()
      await verifyDirectory(root, dir, parentIdentity)
      await verifyInode(ownerPath, createdStat, "Owner claim changed before commit")
      await handle.close()
      handle = undefined
      await syncParent(ownerPath)
      return true
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error?.code !== "EEXIST") {
        if (createdStat && !await removeIfSameInode(ownerPath, createdStat).catch(() => false)) await removeMatchingInode(root, createdStat).catch(() => {})
        throw error
      }
    }
    try {
      return (await safeRead(root, ownerPath)).content === owner
    } catch (error) {
      if (["ENOENT", "EISDIR", "ELOOP"].includes(error?.code)) return false
      throw error
    }
  })
}

/**
 * Bounded read of a final target. The handle is opened with O_NOFOLLOW, the
 * file is fstat-verified, and at most `maxBytes + 1` bytes are read into a
 * pre-sized buffer, so an oversized or externally seeded memory file can never
 * be slurped whole. `truncated` reports that the sentinel byte was reached.
 */
export async function safeRead(root, target, { maxBytes = MAX_READ_BYTES } = {}) {
  await assertSafePath(root, target, { allowMissing: false })
  const parent = path.dirname(target)
  const parentIdentity = await captureDirectory(root, parent)
  const limit = Number.isInteger(maxBytes) && maxBytes >= 0 ? maxBytes : MAX_READ_BYTES
  const handle = await fs.open(target, constants.O_RDONLY | NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (stat.isSymbolicLink() || !stat.isFile()) {
      const error = new Error("Memory path is not a regular file")
      error.code = "EISDIR"
      throw error
    }
    const size = Number.isFinite(stat.size) && stat.size > 0 ? stat.size : 0
    const want = Math.min(limit + 1, size)
    const buffer = Buffer.allocUnsafe(want)
    let offset = 0
    while (offset < want) {
      const { bytesRead } = await handle.read(buffer, offset, want - offset, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    const truncated = offset > limit
    const content = buffer.subarray(0, truncated ? limit : offset).toString("utf8")
    await verifyDirectory(root, parent, parentIdentity)
    return { content, stat, truncated, bytes: offset }
  } finally {
    await handle.close()
  }
}

export async function exclusiveCreate(root, target, content, beforeCommit) {
  await ensureManagedDir(root, path.dirname(target))
  await assertSafePath(root, target)
  return withLocks([entryLock(root, target)], async () => {
    const parent = path.dirname(target)
    const parentIdentity = await captureDirectory(root, parent)
    let handle
    let createdStat
    let committed = false
    try {
      handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
      createdStat = await handle.stat()
      await handle.chmod(0o600)
      await beforeCommit?.({ phase: "before-create-verify", target })
      await verifyDirectory(root, parent, parentIdentity)
      await verifyInode(target, createdStat, "Created memory file changed before commit")
      await handle.writeFile(content, "utf8")
      await handle.sync()
      await verifyDirectory(root, parent, parentIdentity)
      await verifyInode(target, createdStat, "Created memory file changed before commit")
      await handle.close()
      handle = undefined
      committed = true
      await syncParent(target)
    } catch (error) {
      await handle?.close().catch(() => {})
      if (committed) error.committed = true
      if (createdStat && !committed && !await removeIfSameInode(target, createdStat).catch(() => false)) {
        await removeMatchingInode(root, createdStat).catch(() => {})
      }
      throw escapeCode(error, "Could not create memory file")
    }
  })
}

export async function atomicUpdate(root, target, original, content, beforeCommit, options = {}) {
  await assertSafePath(root, target, { allowMissing: false })
  const parent = path.dirname(target)
  return withLocks([entryLock(root, target)], async () => {
    const parentIdentity = await captureDirectory(root, parent)
    const temp = path.join(parent, `${TEMP_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}`)
    let handle
    let tempStat
    let renamed = false
    try {
      handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, original.stat.mode & 0o777)
      await handle.chmod(original.stat.mode & 0o777)
      tempStat = await handle.stat()
      await handle.writeFile(content, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined
      await beforeCommit?.({ phase: "before-verify", target, temp })
      await verifyDirectory(root, parent, parentIdentity)
      await verifyInode(temp, tempStat)
      const current = await safeRead(root, target, options)
      if (current.truncated) throw fsError("EFBIG", "Memory file exceeds the bounded read limit")
      if (current.stat.dev !== original.stat.dev || current.stat.ino !== original.stat.ino || current.content !== original.content) throw fsError("ESTALE", "Memory file changed during update")
      await beforeCommit?.({ phase: "before-rename", target, temp })
      await verifyDirectory(root, parent, parentIdentity)
      await verifyInode(temp, tempStat)
      const finalStat = await fs.lstat(target)
      if (finalStat.isSymbolicLink() || finalStat.dev !== original.stat.dev || finalStat.ino !== original.stat.ino || finalStat.size !== original.stat.size || finalStat.mtimeMs !== original.stat.mtimeMs) throw fsError("ESTALE", "Memory file changed during update")
      await fs.rename(temp, target)
      renamed = true
      await syncParent(target)
    } catch (error) {
      if (renamed) error.committed = true
      throw error
    } finally {
      await handle?.close().catch(() => {})
      if (tempStat && !renamed && !await removeIfSameInode(temp, tempStat).catch(() => false)) await removeMatchingInode(root, tempStat, TEMP_PREFIX).catch(() => {})
    }
  })
}

export async function atomicCreateFrom(sourceRoot, source, destinationRoot, destination, original, content, beforeCommit, options = {}) {
  await ensureManagedDir(destinationRoot, path.dirname(destination))
  await assertSafePath(destinationRoot, destination)
  const sourceParent = path.dirname(source)
  const destinationParent = path.dirname(destination)
  return withLocks([
    entryLock(sourceRoot, source),
    entryLock(destinationRoot, destination),
  ], async () => {
    const sourceParentIdentity = await captureDirectory(sourceRoot, sourceParent)
    const destinationParentIdentity = await captureDirectory(destinationRoot, destinationParent)
    const temp = path.join(destinationParent, `${TEMP_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}`)
    let handle
    let tempStat
    let linked = false
    try {
      handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, original.stat.mode & 0o777)
      await handle.chmod(original.stat.mode & 0o777)
      tempStat = await handle.stat()
      await handle.writeFile(content, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined
      await beforeCommit?.({ phase: "before-verify", target: source, temp })
      await verifyDirectory(sourceRoot, sourceParent, sourceParentIdentity)
      await verifyDirectory(destinationRoot, destinationParent, destinationParentIdentity)
      await verifyInode(temp, tempStat)
      const current = await safeRead(sourceRoot, source, options)
      if (current.truncated) throw fsError("EFBIG", "Memory file exceeds the bounded read limit")
      if (current.stat.dev !== original.stat.dev || current.stat.ino !== original.stat.ino || current.content !== original.content) throw fsError("ESTALE", "Memory file changed during update")
      await beforeCommit?.({ phase: "before-rename", target: source, temp })
      await verifyDirectory(sourceRoot, sourceParent, sourceParentIdentity)
      await verifyDirectory(destinationRoot, destinationParent, destinationParentIdentity)
      await verifyInode(temp, tempStat)
      const finalStat = await fs.lstat(source)
      if (finalStat.isSymbolicLink() || finalStat.dev !== original.stat.dev || finalStat.ino !== original.stat.ino || finalStat.size !== original.stat.size || finalStat.mtimeMs !== original.stat.mtimeMs) throw fsError("ESTALE", "Memory file changed during update")
      await fs.link(temp, destination)
      linked = true
      await syncParent(destination)
    } catch (error) {
      if (linked) error.committed = true
      throw error
    } finally {
      await handle?.close().catch(() => {})
      if (tempStat && !await removeIfSameInode(temp, tempStat).catch(() => false)) await removeMatchingInode(destinationRoot, tempStat, TEMP_PREFIX).catch(() => {})
    }
  })
}

export async function safeEntries(root, dir) {
  await assertSafePath(root, dir, { allowMissing: false })
  const before = await fs.lstat(dir)
  if (before.isSymbolicLink() || !before.isDirectory()) {
    const error = new Error("Memory listing path must be a real directory")
    error.code = "ELOOP"
    throw error
  }
  const beforeCanonical = await fs.realpath(dir)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    if (isInternalMemoryEntry(entry.name) || entry.isSymbolicLink()) continue
    const target = path.join(dir, entry.name)
    const stat = await fs.lstat(target).catch(() => undefined)
    if (!stat || stat.isSymbolicLink()) continue
    output.push({ name: entry.name, target, stat })
  }
  await assertSafePath(root, dir, { allowMissing: false })
  const after = await fs.lstat(dir)
  const afterCanonical = await fs.realpath(dir)
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    beforeCanonical !== afterCanonical
  ) {
    const error = new Error("Memory directory changed while listing")
    error.code = "ESTALE"
    throw error
  }
  return output
}

export async function safeRename(root, source, destination, original, beforeMutation) {
  const verifySource = async () => {
    await assertSafePath(root, source, { allowMissing: false })
    const stat = await fs.lstat(source)
    if (
      stat.isSymbolicLink() ||
      stat.dev !== original.dev ||
      stat.ino !== original.ino ||
      stat.isFile() !== original.isFile() ||
      stat.isDirectory() !== original.isDirectory()
    ) {
      const error = new Error("Memory rename source changed before mutation")
      error.code = "ESTALE"
      throw error
    }
    return stat
  }
  const verifyDestinationMissing = async () => {
    await assertSafePath(root, destination)
    try {
      await fs.lstat(destination)
    } catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }
    const error = new Error("Memory rename destination already exists")
    error.code = "EEXIST"
    throw error
  }

  const sourceParent = path.dirname(source)
  const destinationParent = path.dirname(destination)
  return withLocks([
    entryLock(root, source),
    entryLock(root, destination),
  ], async () => {
    const sourceParentIdentity = await captureDirectory(root, sourceParent)
    const destinationParentIdentity = await captureDirectory(root, destinationParent)
    await verifySource()
    await verifyDestinationMissing()
    await beforeMutation?.({ phase: "before-rename", source, destination })
    await verifyDirectory(root, sourceParent, sourceParentIdentity)
    await verifyDirectory(root, destinationParent, destinationParentIdentity)
    const finalSource = await verifySource()
    await verifyDestinationMissing()
    let committed = false
    try {
      if (finalSource.isFile()) {
        // link(2) is an atomic no-replace destination claim. Only after the
        // linked inode is verified do we unlink the source name.
        await fs.link(source, destination)
        committed = true
        const linked = await fs.lstat(destination)
        if (linked.dev !== finalSource.dev || linked.ino !== finalSource.ino) throw fsError("ESTALE", "Memory rename destination changed")
        try {
          await fs.unlink(source)
        } catch (error) {
          if (await removeIfSameInode(destination, linked).catch(() => false)) committed = false
          throw error
        }
      } else {
        // Directories cannot be hard-linked. The same-directory wx locks and
        // parent/source revalidation close participating-writer races. Node has
        // no portable renameat2(RENAME_NOREPLACE), so an uncooperative process
        // can still race the final missing check. A crash after rename may leave
        // only the destination, never a partial tree.
        await fs.rename(source, destination)
        committed = true
      }
      await syncParent(destination)
      if (sourceParent !== destinationParent) await syncParent(source)
    } catch (error) {
      if (committed) error.committed = true
      throw error
    }
  })
}

export async function safeRemove(root, target, original, beforeMutation) {
  const verifyTarget = async () => {
    await assertSafePath(root, target, { allowMissing: false })
    const stat = await fs.lstat(target)
    if (
      stat.isSymbolicLink() ||
      (!stat.isFile() && !stat.isDirectory()) ||
      stat.dev !== original.dev ||
      stat.ino !== original.ino ||
      stat.isFile() !== original.isFile() ||
      stat.isDirectory() !== original.isDirectory()
    ) {
      const error = new Error("Memory delete target changed before mutation")
      error.code = "ESTALE"
      throw error
    }
    return stat
  }

  const parent = path.dirname(target)
  return withLocks([entryLock(root, target)], async () => {
    const parentIdentity = await captureDirectory(root, parent)
    await verifyTarget()
    await beforeMutation?.({ phase: "before-remove", target })
    await verifyDirectory(root, parent, parentIdentity)
    const finalTarget = await verifyTarget()
    let removed = false
    try {
      await fs.rm(target, { recursive: finalTarget.isDirectory() })
      removed = true
      await syncParent(target)
    } catch (error) {
      if (removed) error.committed = true
      throw error
    }
  })
}

export async function cleanupStaleArtifacts(root, now = Date.now()) {
  let rootStat
  try {
    rootStat = await fs.lstat(root)
  } catch (error) {
    if (error?.code === "ENOENT") return 0
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0
  let removed = 0
  const visit = async (dir) => {
    const identity = await captureDirectory(root, dir)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(target).catch((error) => { if (!['ENOENT', 'ESTALE'].includes(error?.code)) throw error })
        continue
      }
      if (!entry.name.startsWith(TEMP_PREFIX) && !entry.name.startsWith(LOCK_PREFIX)) continue
      const stat = await fs.lstat(target).catch(() => undefined)
      if (!stat || !stat.isFile() || now - stat.mtimeMs <= STALE_ARTIFACT_MS) continue
      await verifyDirectory(root, dir, identity)
      if (await removeIfSameInode(target, stat).catch(() => false)) removed += 1
    }
    await verifyDirectory(root, dir, identity)
  }
  await visit(root)
  return removed
}

export async function syncDirectory(dir) {
  await syncParent(path.join(dir, "placeholder"))
}
