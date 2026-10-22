// LayerFS backends for the magpie tools plugin.
//
// Two backends sit behind one small surface (provision, checkpoint, fork,
// history, resolve, status):
//
// - native: the real LayerFS, through the `@layerfs/sdk` JavaScript SDK
//   (Ephemeral-AI-Lab/layerfs, sdk/js). The SDK is not published to npm; it
//   ships in a layerfs checkout and needs its native binding plus a mounted
//   LayerFS store volume. It is OFF unless the user opts in, and when it is
//   on, every SDK call runs in a child process (native-worker.mjs): the
//   plugin host process never imports the SDK and never has LAYERFS_*
//   variables written into its shared environment.
// - sim: a local content-addressed store that implements the same model
//   LayerFS is built on — immutable blobs named by their SHA-256, branches
//   as manifest pointers, checkpoints as deduplicated manifests — so the
//   plugin runs and can be tested anywhere. Forking a branch copies no
//   file bytes; a checkpoint stores only the blobs the store has not seen.
//
// Environment:
//   MAGPIE_LAYERFS_BACKEND  auto (default) | native | sim
//   MAGPIE_LAYERFS_HOME     state root for both backends (default ~/.magpie-layerfs)
//   MAGPIE_LAYERFS_NATIVE   1 opts in to the native backend (or the
//                           plugin's "native" option in magpie)
//   LAYERFS_SDK_PATH        path to the SDK entry (sdk/js/src/index.js)
//   LAYERFS_STORE_PATH      native only, optional: the store file
//                           (<volume>/global/store.sqlite) anchoring the
//                           LayerFS volume; per-project stores live under
//                           <volume>/<project>/. Default: a volume under
//                           MAGPIE_LAYERFS_HOME/native/vol.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, statSync, writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, parse, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const BINDING = ".layerfs.json"

// Workspace-local scratch: two directories at the workspace root that
// are never checkpointed and never published. provision creates them,
// exec points TMPDIR and XDG_CACHE_HOME at them so toolchains keep
// their temporary files and caches inside the workspace instead of
// the host's real /tmp, and every checkpoint scan skips both names —
// their content lives and dies with the workspace directory itself.
const SCRATCH_DIRS = [".tmp", ".cache"]
const scanSkip = () => new Set([BINDING, ...SCRATCH_DIRS])
function ensureScratch(dir) {
  for (const name of SCRATCH_DIRS) mkdirPrivate(join(dir, name))
}

// ---- names -------------------------------------------------------------------

// Project names follow the SDK's rule: 1-63 chars of lowercase ASCII letters,
// digits, `_`, `-`, `.`, starting and ending alphanumeric.
export function checkProject(name) {
  if (typeof name !== "string" || !/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(name))
    throw new Error(`project is a LayerFS project name: 1-63 chars of a-z 0-9 _ - ., starting and ending with a letter or digit; got ${JSON.stringify(name)}`)
  return name
}

export function checkBranch(name) {
  if (typeof name !== "string" || !name || name.length > 100 || name.split("/").some((s) => !s || s === "." || s === ".." || !/^[A-Za-z0-9_.-]+$/.test(s)))
    throw new Error(`branch is a name like main or feat/x; got ${JSON.stringify(name)}`)
  return name
}

// A path inside a workspace: relative, and it must stay in.
export function checkInnerPath(p) {
  if (typeof p !== "string" || !p) throw new Error("path is a non-empty relative path")
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "")
  if (norm.startsWith("/") || norm.split("/").some((s) => s === ".."))
    throw new Error(`path must stay inside the workspace; got ${JSON.stringify(p)}`)
  return norm
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")
const nowIso = () => new Date().toISOString()

// ---- on-disk names -------------------------------------------------------------
// A branch name maps to ONE flat file (its head record) and one workspace
// directory segment. Every character outside [a-z0-9._-] is percent-
// encoded, so the mapping is injective AND case-injective: feat/x and
// feat__x are different branches with different files (feat%2Fx.json vs
// feat__x.json), and Main and main stay different on a case-insensitive
// volume too (branches/%4Dain.json vs branches/main.json). Every branch
// — slash branches included — sits at the top level, where listBranches
// reads. (Pre-0.7.1 encoders left some collisions: 0.7.0 encoded only
// "%" and "/", so uppercase branches shared files on case-insensitive
// volumes; pre-0.7 layouts are not migrated — see the README's notes.)
export function encodeBranchName(branch) {
  let out = ""
  for (const ch of branch)
    out += /[a-z0-9._-]/.test(ch)
      ? ch
      : "%" + ch.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")
  return out
}
export function decodeBranchName(stem) {
  return stem.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
}

// Workspaces live one directory per project — workspaces/<project>/
// <encoded branch> — because a flat `${project}--${branch}` name is
// not injective when both sides may contain "--" (project a branch
// b--c vs project a--b branch c). Project names cannot contain "/",
// so the per-project directory cannot collide. Counting workspaces
// means summing the branch directories across the project ones.
function countWorkspaces(workspacesDir) {
  if (!existsSync(workspacesDir)) return 0
  let n = 0
  for (const e of readdirSync(workspacesDir, { withFileTypes: true }))
    if (e.isDirectory()) n += readdirSync(join(workspacesDir, e.name)).length
  return n
}

// ---- private writes --------------------------------------------------------------
// The store can hold anything a source tree held, so it is created
// private: directories 0700, record files 0600, whatever the umask
// says. writeFileMode chmods after writing because writeFileSync's
// mode only applies when a file is created and is umask-masked anyway.
function writeFileMode(path, data, mode = 0o600) {
  writeFileSync(path, data, { mode })
  chmodSync(path, mode)
}
function writeJson(path, obj, pretty = false) {
  writeFileMode(path, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj))
}
function mkdirPrivate(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

// ---- importing a source tree ------------------------------------------------------
// An import sweeps a whole directory into the store, so it is the one
// place a tree the user did not mean to share can leak. The caller must
// pass the source explicitly (there is no default — magpie's
// ctx.directory is its config directory, not a working directory, and
// it holds plugin-auth.json: every signed-in plugin's token). The
// config directory, the classic credential stores, the home directory
// and the filesystem root are refused outright — as source, as a
// parent of the source, or inside it.
// The guard compares REAL paths, not spellings. A string comparison
// of resolve()d paths is bypassed two ways (round-2 review, item 1):
// a symlink pointing at a refused directory (readdirSync follows the
// root link), and a case-variant spelling on a case-insensitive
// volume ("~/.Config/Magpie", "~/.AWS"). So both sides are
// canonicalized with realpathSync and case-folded before comparing.
// A refused root that does not exist is canonicalized through its
// nearest existing ancestor — it can still be named by a case
// variant or reached through a symlinked parent, and canonicalizing
// it must never be what throws.
function canonicalForCompare(p) {
  let cur = resolve(p)
  const tail = []
  for (;;) {
    try { return join(realpathSync(cur), ...tail).toLowerCase() } catch { /* not there: walk up */ }
    const parent = dirname(cur)
    if (parent === cur) return resolve(p).toLowerCase()
    tail.unshift(cur.slice(parent.length + 1))
    cur = parent
  }
}

export function checkSourceDir(sourceDir, { configDir, storeRoot } = {}) {
  if (typeof sourceDir !== "string" || !sourceDir)
    throw new Error("source is required: the directory to import when the project is first created — pass the directory the user chose for this project")
  const given = resolve(sourceDir)
  if (!existsSync(given) || !statSync(given).isDirectory())
    throw new Error(`source is not a directory: ${sourceDir}`)
  const src = canonicalForCompare(given) // real path, case-folded: the guard's currency
  const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
  const refuses = [
    [join(homedir(), ".config", "magpie"), "magpie's config directory, which holds plugin credentials (plugin-auth.json)"],
    [join(homedir(), ".ssh"), "the SSH directory"],
    [join(homedir(), ".aws"), "the AWS directory"],
    [join(homedir(), ".gnupg"), "the GnuPG directory"],
  ]
  if (configDir) refuses.unshift([configDir, "magpie's config directory, which holds plugin credentials (plugin-auth.json)"])
  for (const [dir, what] of refuses)
    if (overlaps(src, canonicalForCompare(dir)))
      throw new Error(`refusing to import ${given}: it is, contains, or sits inside ${what}`)
  if (src === canonicalForCompare(homedir()) || src === canonicalForCompare(parse(given).root))
    throw new Error(`refusing to import ${given}: importing a home directory or a filesystem root would sweep far more than one project into the store — pass the project's own directory`)
  if (storeRoot && overlaps(src, canonicalForCompare(storeRoot)))
    throw new Error(`refusing to import ${given}: it overlaps the plugin's own store`)
  return given
}

// Secret-shaped paths never enter the store from an import: VCS
// internals, env files, private keys, credential stores. Matching is
// per path segment, so docs/.env.example is caught just like .env.
const KEY_FILE = /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\..*)?$/
export function isSecretPath(rel) {
  return rel.split("/").some((seg) =>
    seg === ".git" || seg === ".ssh" || seg === ".aws" || seg === ".gnupg" ||
    seg === ".netrc" || seg === ".env" || seg.startsWith(".env.") ||
    KEY_FILE.test(seg) || /\.(pem|key)$/i.test(seg))
}

// An import is bounded, so pointing it at the wrong tree fails loudly
// instead of sweeping a disk into the store.
export const IMPORT_MAX_FILES = 20000
export const IMPORT_MAX_BYTES = 512 * 1024 * 1024
function checkImportLimits(files) {
  let bytes = 0
  for (const f of files) bytes += f.size
  if (files.length > IMPORT_MAX_FILES)
    throw new Error(`source holds ${files.length} files, over the import limit of ${IMPORT_MAX_FILES} — pass the project's own directory, not a parent of it`)
  if (bytes > IMPORT_MAX_BYTES)
    throw new Error(`source holds ${bytes} bytes, over the import limit of ${IMPORT_MAX_BYTES} — pass the project's own directory, not a parent of it`)
}

// Files of a source tree with the secret-shaped ones set aside.
// Symlinks are not followed (scanTree's rule, kept): a link's target
// stays outside the import.
function walkSourceFiles(dir) {
  const files = [], skipped = []
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (isSecretPath(r)) { skipped.push(r); continue }
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full, r)
      else if (e.isFile()) {
        const st = statSync(full)
        files.push({ rel: r, full, size: st.size, mode: st.mode & 0o777 })
      }
    }
  }
  walk(dir, "")
  return { files, skipped }
}

// The sim backend's import scan: a manifest { rel: { sha, size, mode } }
// plus the list of secret-shaped paths left out, reported to the caller.
export function scanImportTree(dir) {
  const { files, skipped } = walkSourceFiles(dir)
  checkImportLimits(files)
  const manifest = {}
  for (const f of files) {
    const buf = readFileSync(f.full)
    manifest[f.rel] = { sha: sha256(buf), size: buf.length, mode: f.mode }
  }
  return { manifest, skipped }
}

// The native backend's pre-flight: the engine performs the import
// itself and cannot skip, so the plugin can only count and refuse.
export function scanSourceForImport(dir) {
  const { files, skipped } = walkSourceFiles(dir)
  checkImportLimits(files)
  return { files: files.length, skipped }
}

// Walk a directory into a manifest: { "rel/path": { sha, size, mode } }.
// The mode rides along so a file keeps its permissions through the
// store: a 0600 file is stored and materialized as 0600, never widened
// to the umask's default.
function scanTree(dir, skip = new Set()) {
  const out = {}
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (skip.has(r)) continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full, r)
      else if (e.isFile()) {
        const buf = readFileSync(full)
        out[r] = { sha: sha256(buf), size: buf.length, mode: statSync(full).mode & 0o777 }
      }
    }
  }
  walk(dir, "")
  return out
}

function manifestBytes(manifest) {
  let n = 0
  for (const f of Object.values(manifest)) n += f.size
  return n
}

function sameManifest(a, b) {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => b[k] && b[k].sha === a[k].sha)
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more bytes]` : s)

// Run a shell command in dir, capturing bounded output. Resolves with
// { code, stdout, stderr, timedOut }; never rejects on a non-zero exit —
// the caller reports the code, as a shell would. The child inherits
// the host environment except TMPDIR and XDG_CACHE_HOME, which point
// at the workspace's scratch directories (created first, so workspaces
// provisioned before they existed get them too): temporary files and
// caches stay inside the workspace instead of leaking to the host /tmp.
//
// The process plumbing is deliberate (round-2 review, item 6): stdin
// is closed, so a command that reads it gets EOF instead of waiting
// out the timeout; the child leads its own process group (detached),
// so a timeout kills the whole tree, not just /bin/sh; and the caller
// resolves on 'exit' plus a short drain, not on 'close' — a background
// child holding the stdout pipe open must not hold the call open.
function runShell(command, dir, timeoutMs) {
  return new Promise((resolvePromise) => {
    ensureScratch(dir)
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: join(dir, ".tmp"), XDG_CACHE_HOME: join(dir, ".cache") },
    })
    let out = "", err = "", timedOut = false, settled = false
    let timer = null
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout: clip(out, 8192), stderr: clip(err, 8192), timedOut })
    }
    timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, "SIGKILL") } // the whole group
      catch { try { child.kill("SIGKILL") } catch { /* already gone */ } }
      // 'exit' follows the group kill; this is only a backstop
      setTimeout(() => finish(-1), 250).unref()
    }, timeoutMs)
    child.stdout.on("data", (d) => { if (out.length < 65536) out += d })
    child.stderr.on("data", (d) => { if (err.length < 65536) err += d })
    child.on("error", (e) => { err += String(e); finish(-1) })
    child.on("exit", (code) => { setTimeout(() => finish(code), 25).unref() })
  })
}

// ---- sim backend ---------------------------------------------------------------

export class SimBackend {
  kind = "sim"

  constructor(root) {
    this.root = root || process.env.MAGPIE_LAYERFS_HOME || join(homedir(), ".magpie-layerfs")
    this.objectsDir = join(this.root, "store", "objects")
    this.projectsDir = join(this.root, "projects")
    this.workspacesDir = join(this.root, "workspaces")
    for (const d of [this.root, this.objectsDir, this.projectsDir, this.workspacesDir]) mkdirPrivate(d)
    // Seed the byte accounting before anything writes, so the bumps
    // below stay exact (a walk taken after a write would count it twice)
    if (!this.readAccounting())
      writeJson(this.accountingPath(), { storedBytes: this.storedBytesWalk(), logicalBytes: this.logicalBytesWalk() })
  }

  // -- store primitives
  blobPath(sha) { return join(this.objectsDir, sha.slice(0, 2), sha) }
  hasBlob(sha) { return existsSync(this.blobPath(sha)) }
  putBlob(buf, mode = 0o644) {
    const sha = sha256(buf)
    const p = this.blobPath(sha)
    if (!existsSync(p)) {
      mkdirPrivate(dirname(p))
      writeFileMode(p, buf, mode)
      this.bumpAccounting({ storedDelta: buf.length })
      return { sha, fresh: buf.length }
    }
    return { sha, fresh: 0 }
  }
  // Byte accounting, kept incrementally in a small record so status
  // never walks the whole store: putBlob and makeCommit bump it as
  // they write. storedBytes is the bytes the store actually occupies:
  // blob bytes PLUS the commit records (each holds its checkpoint's
  // full manifest — for a wide tree that is the larger half, and it
  // was not counted before 0.7.1; round-2 review, item 7). A missing
  // record (a pre-0.7 store) is rebuilt by one walk and then
  // maintained; a pre-0.7.1 record undercounts until it is rebuilt.
  accountingPath() { return join(this.root, "accounting.json") }
  readAccounting() {
    try { return JSON.parse(readFileSync(this.accountingPath(), "utf8")) } catch { return null }
  }
  bumpAccounting({ storedDelta = 0, logicalDelta = 0 } = {}) {
    if (!storedDelta && !logicalDelta) return
    const a = this.readAccounting() ?? { storedBytes: this.storedBytesWalk(), logicalBytes: this.logicalBytesWalk() }
    a.storedBytes += storedDelta
    a.logicalBytes += logicalDelta
    writeJson(this.accountingPath(), a)
  }
  storedBytes() {
    const a = this.readAccounting()
    if (a && Number.isFinite(a.storedBytes)) return a.storedBytes
    const n = this.storedBytesWalk()
    writeJson(this.accountingPath(), { storedBytes: n, logicalBytes: this.logicalBytesWalk() })
    return n
  }
  storedBytesWalk() {
    let n = 0
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name)
        if (e.isDirectory()) walk(full)
        else n += statSync(full).size
      }
    }
    walk(this.objectsDir)
    // the commit records count too: each carries a full manifest
    if (existsSync(this.projectsDir))
      for (const name of readdirSync(this.projectsDir)) {
        const cdir = join(this.projectDir(name), "commits")
        if (existsSync(cdir))
          for (const f of readdirSync(cdir)) n += statSync(join(cdir, f)).size
      }
    return n
  }
  logicalBytesWalk() {
    let n = 0
    if (!existsSync(this.projectsDir)) return 0
    for (const name of readdirSync(this.projectsDir)) {
      const cdir = join(this.projectDir(name), "commits")
      if (!existsSync(cdir)) continue
      for (const f of readdirSync(cdir)) n += JSON.parse(readFileSync(join(cdir, f), "utf8")).logicalBytes
    }
    return n
  }
  // Store every blob of a manifest that the store has not seen; returns the
  // number of genuinely new bytes written.
  storeManifestFiles(baseDir, manifest) {
    let fresh = 0
    for (const [rel, f] of Object.entries(manifest)) {
      if (!this.hasBlob(f.sha)) fresh += this.putBlob(readFileSync(join(baseDir, ...rel.split("/"))), f.mode ?? 0o644).fresh
    }
    return fresh
  }

  // -- project / branch / commit records
  projectDir(project) { return join(this.projectsDir, project) }
  projectExists(project) { return existsSync(join(this.projectDir(project), "project.json")) }
  commitPath(project, id) { return join(this.projectDir(project), "commits", `${id}.json`) }
  readCommit(project, id) { return JSON.parse(readFileSync(this.commitPath(project, id), "utf8")) }
  writeCommit(project, commit) {
    mkdirPrivate(join(this.projectDir(project), "commits"))
    writeJson(this.commitPath(project, commit.id), commit, true)
    return statSync(this.commitPath(project, commit.id)).size
  }
  branchHeadPath(project, branch) { return join(this.projectDir(project), "branches", `${encodeBranchName(branch)}.json`) }
  branchExists(project, branch) { return existsSync(this.branchHeadPath(project, branch)) }
  head(project, branch) {
    if (!this.branchExists(project, branch)) throw new Error(`no branch ${branch} in project ${project}`)
    return JSON.parse(readFileSync(this.branchHeadPath(project, branch), "utf8")).commit
  }
  setHead(project, branch, commitId) {
    mkdirPrivate(dirname(this.branchHeadPath(project, branch)))
    writeJson(this.branchHeadPath(project, branch), { commit: commitId })
  }
  listBranches(project) {
    const dir = join(this.projectDir(project), "branches")
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => decodeBranchName(f.slice(0, -5))).sort()
  }

  makeCommit(project, branch, parent, manifest, message, newBytes, delta = { added: 0, modified: 0, deleted: 0 }) {
    const seed = JSON.stringify({ parent, branch, message, manifest }) + nowIso() + Math.random()
    const id = sha256(Buffer.from(seed)).slice(0, 12)
    const commit = {
      id, branch, parent, message, time: nowIso(),
      manifest, files: Object.keys(manifest).length,
      logicalBytes: manifestBytes(manifest), newBytes, delta,
    }
    const recordBytes = this.writeCommit(project, commit)
    this.bumpAccounting({ logicalDelta: commit.logicalBytes, storedDelta: recordBytes })
    this.setHead(project, branch, id)
    return commit
  }

  // An append-only event log (provision / fork / checkpoint), the raw
  // material for the trajectory the magpie page replays.
  recordEvent(event) {
    const path = join(this.root, "events.json")
    let events = []
    try { events = JSON.parse(readFileSync(path, "utf8")) } catch { /* first event */ }
    events.push({ t: nowIso(), ...event })
    if (events.length > 500) events = events.slice(-500)
    writeFileMode(path, JSON.stringify(events))
  }
  readEvents() {
    try { return JSON.parse(readFileSync(join(this.root, "events.json"), "utf8")) } catch { return [] }
  }

  async ensureProject(project, sourceDir) {
    if (this.projectExists(project)) return { created: false }
    mkdirPrivate(this.projectDir(project))
    writeJson(join(this.projectDir(project), "project.json"),
      { name: project, created: nowIso(), backend: "sim" }, true)
    let manifest = {}
    let newBytes = 0
    let skipped = []
    let src = null
    if (sourceDir) {
      src = checkSourceDir(sourceDir, { storeRoot: this.root })
      const scan = scanImportTree(src)
      manifest = scan.manifest
      skipped = scan.skipped
      newBytes = this.storeManifestFiles(src, manifest)
    }
    const commit = this.makeCommit(project, "main", null, manifest,
      src ? `Import ${src}` : "Empty project", newBytes,
      { added: Object.keys(manifest).length, modified: 0, deleted: 0 })
    return { created: true, commit: commit.id, skipped }
  }

  workspaceDir(project, branch) { return join(this.workspacesDir, project, encodeBranchName(branch)) }

  async provision(project, branch = "main", sourceDir) {
    const created = await this.ensureProject(project, sourceDir)
    if (!this.branchExists(project, branch)) throw new Error(`no branch ${branch} in project ${project}`)
    const headId = this.head(project, branch)
    const dir = this.workspaceDir(project, branch)
    if (existsSync(join(dir, BINDING))) {
      const binding = JSON.parse(readFileSync(join(dir, BINDING), "utf8"))
      return {
        path: dir, project, branch, backend: this.kind,
        commit: binding.baseCommit, reused: true, stale: binding.baseCommit !== headId,
      }
    }
    const commit = this.readCommit(project, headId)
    mkdirPrivate(dir)
    ensureScratch(dir)
    for (const [rel, f] of Object.entries(commit.manifest)) {
      const out = join(dir, ...rel.split("/"))
      mkdirSync(dirname(out), { recursive: true })
      copyFileSync(this.blobPath(f.sha), out)
      chmodSync(out, f.mode ?? 0o644) // the manifest's mode, not the blob's or the umask's
    }
    writeJson(join(dir, BINDING), { project, branch, baseCommit: headId }, true)
    this.recordEvent({ kind: "provision", project, branch, path: dir, commit: headId })
    return {
      path: dir, project, branch, backend: this.kind, commit: headId,
      reused: false, files: commit.files, logicalBytes: commit.logicalBytes,
      ...(created.created ? { projectCreated: true } : {}),
      ...(created.skipped?.length ? {
        importSkipped: created.skipped.length,
        skippedSecrets: created.skipped.slice(0, 5),
      } : {}),
    }
  }

  async checkpoint(project, branch = "main", message = "") {
    const dir = this.workspaceDir(project, branch)
    if (!existsSync(join(dir, BINDING))) throw new Error(`no workspace for ${project}/${branch}; provision it first`)
    const parent = this.head(project, branch)
    const prev = this.readCommit(project, parent)
    const manifest = scanTree(dir, scanSkip())
    const newBytes = this.storeManifestFiles(dir, manifest)
    let added = 0, modified = 0, deleted = 0
    for (const [rel, f] of Object.entries(manifest)) {
      if (!prev.manifest[rel]) added++
      else if (prev.manifest[rel].sha !== f.sha) modified++
    }
    for (const rel of Object.keys(prev.manifest)) if (!manifest[rel]) deleted++
    const commit = this.makeCommit(project, branch, parent, manifest, message || "Checkpoint", newBytes, { added, modified, deleted })
    this.recordEvent({ kind: "checkpoint", project, branch, commit: commit.id, message: commit.message })
    writeJson(join(dir, BINDING), { project, branch, baseCommit: commit.id }, true)
    const stored = this.storedBytes()
    return {
      commit: commit.id, parent, branch, message: commit.message,
      added, modified, deleted, files: commit.files,
      logicalBytes: commit.logicalBytes, newBytes,
      storedBytes: stored, savedBytes: commit.logicalBytes - newBytes,
    }
  }

  async fork(project, branch, from = "main") {
    if (!this.projectExists(project)) throw new Error(`no project ${project}`)
    if (this.branchExists(project, branch)) throw new Error(`branch ${branch} already exists in project ${project}`)
    const headId = this.head(project, from)
    this.setHead(project, branch, headId)
    this.recordEvent({ kind: "fork", project, branch, from, commit: headId })
    return { project, branch, from, commit: headId, copiedBytes: 0 }
  }

  // Publish a branch's head as main's new Layer. The guard is the lesson
  // of a real dsh run, where publishing from a stale branch replaced
  // main and dropped it from 238 tests to 38: by default main must be
  // an ancestor of the branch head, so publishing can only ever move
  // main forward. force says "I know main has commits this branch never
  // saw" — the result then reports what was overwritten.
  async publish(project, branch, { force = false } = {}) {
    checkProject(project); checkBranch(branch)
    if (branch === "main") throw new Error("publish names a branch other than main; main is what gets published to")
    const branchHead = this.head(project, branch)
    const mainHead = this.head(project, "main")
    const layers = this.readEvents().filter((e) => e.kind === "publish" && e.project === project).length
    if (branchHead === mainHead)
      return { project, branch, layer: layers, commit: branchHead, alreadyPublished: true, overwrote: false }
    const chain = new Set()
    let id = branchHead
    while (id) { chain.add(id); id = this.readCommit(project, id).parent }
    const fastForward = chain.has(mainHead)
    if (!fastForward && !force)
      throw new Error(`main has moved since ${branch} forked: main is at ${mainHead}, which is not in ${branch}'s history. Publishing would drop main's newer checkpoints. Fork a fresh branch from main, or pass force: true to overwrite deliberately.`)
    this.setHead(project, "main", branchHead)
    const layer = layers + 1
    this.recordEvent({ kind: "publish", project, branch, commit: branchHead, layer, overwrote: !fastForward })
    return { project, branch, layer, commit: branchHead, previousMain: mainHead, overwrote: !fastForward }
  }

  // Run a command in the branch's workspace and checkpoint whatever it
  // changed as one commit — the dsh shape, where every bash call is
  // mount, run, commit. A command that changes nothing commits nothing;
  // a failing command's changes are still checkpointed (they are
  // history, and history can be rewound), with its exit code reported.
  async exec(project, branch = "main", command, message = "", timeoutMs = 50000) {
    checkProject(project); checkBranch(branch)
    if (typeof command !== "string" || !command.trim()) throw new Error("command is a non-empty string")
    const dir = this.workspaceDir(project, branch)
    if (!existsSync(join(dir, BINDING))) throw new Error(`no workspace for ${project}/${branch}; provision it first`)
    const prev = this.readCommit(project, this.head(project, branch))
    const r = await runShell(command, dir, Math.min(Math.max(100, timeoutMs || 50000), 55000))
    const manifest = scanTree(dir, scanSkip())
    const changed = !sameManifest(prev.manifest, manifest)
    let commit = null
    if (changed) {
      const c = await this.checkpoint(project, branch, message || `exec: ${command.trim().slice(0, 60)}`)
      commit = c.commit
    }
    return {
      project, branch, exitCode: r.code, ...(r.timedOut ? { timedOut: true } : {}),
      stdout: r.stdout, stderr: r.stderr, changed, commit,
    }
  }

  async history(project, branch = "main", limit = 20) {
    let id = this.head(project, branch)
    const out = []
    while (id && out.length < limit) {
      const c = this.readCommit(project, id)
      out.push({
        commit: c.id, message: c.message, time: c.time,
        files: c.files, logicalBytes: c.logicalBytes, newBytes: c.newBytes,
      })
      id = c.parent
    }
    return { project, branch, commits: out }
  }

  // One project's slice of the recorded trajectory, oldest first per
  // branch. Commits carry their delta and byte accounting.
  async trajectoryProject(name) {
    if (!this.projectExists(name)) return null
    const branches = []
    for (const branch of this.listBranches(name)) {
      // the branch's OWN checkpoints: walk its whole chain (a publish
      // may have moved main's head onto another branch's work) and
      // keep only the commits made on this branch — ancestors belong
      // to the bough they were committed on
      const commits = []
      let id = this.head(name, branch)
      while (id) {
        const c = this.readCommit(name, id)
        if (c.branch === branch) {
          commits.push({
            id: c.id, parent: c.parent, message: c.message, time: c.time,
            files: c.files, logicalBytes: c.logicalBytes, newBytes: c.newBytes,
            delta: c.delta ?? { added: 0, modified: 0, deleted: 0 },
          })
        }
        id = c.parent
      }
      branches.push({ name: branch, commits: commits.reverse() })
    }
    return { name, branches }
  }

  // The whole recorded trajectory: what the magpie page replays.
  async trajectory() {
    const projects = []
    if (existsSync(this.projectsDir)) {
      for (const name of readdirSync(this.projectsDir).sort()) {
        const slice = await this.trajectoryProject(name)
        if (slice) projects.push(slice)
      }
    }
    const st = await this.status()
    return {
      generatedAt: nowIso(), backend: this.kind, projects,
      events: this.readEvents(),
      totals: {
        logicalBytes: st.logicalBytes, storedBytes: st.storedBytes,
        savedBytes: st.savedBytes, dedupRatio: st.dedupRatio, workspaces: st.workspaces,
      },
    }
  }

  // The recorded trajectory is built ON DEMAND by trajectory() and
  // by nothing else. An earlier version also kept a trajectory.json
  // in the store refreshed after every tool call — even scoped to
  // one project that re-walked the branch's whole chain, so the cost
  // of every call grew with the history, for a file the page cannot
  // read (its bridge serves a fixed host list) and nothing else did
  // (round-2 review, item 3). Removed in 0.7.1: no tool call creates
  // or updates a trajectory.json anymore. The page keeps its bundled
  // sample until the host can serve plugin data to a page.

  async resolve(project, branch = "main", inner = "") {
    const headId = this.head(project, branch)
    const dir = this.workspaceDir(project, branch)
    if (!existsSync(join(dir, BINDING)))
      return { path: null, project, branch, commit: headId, provisioned: false, hint: "call provision to materialize this workspace" }
    const out = { path: inner ? join(dir, ...inner.split("/")) : dir, project, branch, commit: headId, provisioned: true }
    if (inner) {
      const commit = this.readCommit(project, headId)
      const f = commit.manifest[inner]
      if (f) { out.sha = f.sha; out.size = f.size; out.inHead = true }
      else out.inHead = existsSync(out.path)
    }
    return out
  }

  async status() {
    const projects = []
    if (existsSync(this.projectsDir)) {
      for (const name of readdirSync(this.projectsDir).sort()) {
        if (!this.projectExists(name)) continue
        const branches = this.listBranches(name)
        const cdir = join(this.projectDir(name), "commits")
        const commits = existsSync(cdir) ? readdirSync(cdir).length : 0
        projects.push({ name, branches, commits })
      }
    }
    const stored = this.storedBytes()
    const a = this.readAccounting()
    const logical = a && Number.isFinite(a.logicalBytes) ? a.logicalBytes : this.logicalBytesWalk()
    const workspaces = countWorkspaces(this.workspacesDir)
    return {
      backend: this.kind, root: this.root, projects, workspaces,
      logicalBytes: logical, storedBytes: stored,
      savedBytes: Math.max(0, logical - stored),
      dedupRatio: stored ? +(logical / stored).toFixed(2) : 1,
    }
  }
}

// ---- native backend --------------------------------------------------------------
//
// The real LayerFS, adapted to what the SDK actually does
// (verified against a locally built binding, layerfs 1.0.0, 2026-10-22):
//
// - Store calls (project/branch/fs) run in the worker process against a global
//   SQLite store per project; project entries live at LAYERFS_HOME/<name>,
//   each project's store at <volume>/<project>/global/store.sqlite, where
//   <volume> is derived from LAYERFS_STORE_PATH. The store's filesystem
//   must carry SQLite locks (ext4, xfs or btrfs; tmpfs is refused).
// - project.init imports a source tree as main's first Layer. A source on
//   overlayfs is refused by the engine with an opaque Project(InvalidInput)
//   (reported upstream); other filesystems import fine.
// - workspace.* calls (mount/exec/commit) need a deployment (Docker,
//   LAYERFS_IMAGE, a daemon) that a magpie host does not have, so this
//   backend works in checkout mode instead: provision materializes a
//   branch into a local directory through fs.list/fs.read, and checkpoint
//   diffs that directory against the branch and lands the changes as ONE
//   fs.apply commit — the same shape as a workspace commit, through the
//   store surface.
// - Binary files cannot round-trip through the fs surface: fs.write and
//   fs.apply accept bytes (Buffer/Uint8Array; fs.apply's refusal of
//   non-string content was fixed upstream in layerfs PR #416), but
//   fs.read still refuses binary content (error code Binary; upstream
//   issue #417), so a checkout cannot materialize binaries and a
//   checkpoint cannot diff them. This backend therefore still skips
//   binary files on the native path, pending #417: a checkout lists the
//   binary files it could not materialize, and a checkpoint lists the
//   binary files it could not commit, instead of silently dropping
//   them. Binaries that must enter a project arrive via the initial
//   import.
// - One process holds one open store per project name (refcounted by
//   the binding; the last client closes it), and a client captures
//   LAYERFS_HOME and its storePath at construction. That process is
//   the worker (native-worker.mjs), a child this backend spawns: the
//   plugin host process never imports the SDK and never has LAYERFS_*
//   written into its shared environment — the worker gets its own env
//   and keeps one client per project there.
// - Publish is a Layer operation: branch.publish(branch, head) appends
//   the branch tip's tree as main's next Layer. The plugin guards it the
//   same way as the sim backend: the branch must have forked from main's
//   current top Layer, or the caller must force.

const isTextBuf = (buf) => !buf.includes(0) && Buffer.from(buf.toString("utf8"), "utf8").equals(buf)

export class NativeBackend {
  kind = "native"

  constructor(root) {
    this.root = root || process.env.MAGPIE_LAYERFS_HOME || join(homedir(), ".magpie-layerfs")
    this.nativeRoot = join(this.root, "native")
    this.homeDir = join(this.nativeRoot, "home") // LAYERFS_HOME for the SDK (in the worker)
    const envStore = process.env.LAYERFS_STORE_PATH
    this.volDir = envStore ? dirname(dirname(envStore)) : join(this.nativeRoot, "vol")
    this.storePathEnv = envStore || join(this.volDir, "global", "store.sqlite")
    this.workspacesDir = join(this.nativeRoot, "workspaces")
    this.stateDir = join(this.nativeRoot, "projects")
    this._worker = null // { child, buf } once spawned
    this._workerSeq = 0
    this._workerPending = new Map()
    // The engine refuses a LAYERFS_HOME (and store directories) that are
    // not private to the user: "must be owned by this user and private" —
    // mkdirPrivate gives every directory here 0700.
    for (const d of [this.nativeRoot, this.homeDir, this.volDir, join(this.volDir, "global"), this.workspacesDir, this.stateDir])
      mkdirPrivate(d)
  }

  // -- the worker: every SDK call happens in native-worker.mjs, a child
  // process spawned lazily on the first call. The host process holding
  // every plugin's credentials never imports the SDK (an import there
  // would run arbitrary code with its rights), and LAYERFS_HOME /
  // LAYERFS_STORE_PATH are set only in the child's own environment.
  workerStart() {
    if (this._worker) return this._worker
    const entry = process.env.LAYERFS_SDK_PATH
    if (!entry) throw new Error(
      "native backend needs LAYERFS_SDK_PATH pointing at a layerfs checkout's sdk/js/src/index.js " +
      "(the @layerfs/sdk package is not on npm; it ships with Ephemeral-AI-Lab/layerfs), " +
      "with its native binding built (sdk/js/native/layerfs.node; see the layerfs repo's build-native script)")
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "native-worker.mjs")
    const env = { ...process.env }
    delete env.LAYERFS_HOME
    delete env.LAYERFS_STORE_PATH
    Object.assign(env, {
      LAYERFS_SDK_PATH: entry,
      LAYERFS_WORKER_HOME: this.homeDir,
      LAYERFS_WORKER_VOL: this.volDir,
      LAYERFS_WORKER_STORE: this.storePathEnv,
    })
    const child = spawn(process.execPath, [workerPath], { env, stdio: ["pipe", "pipe", "inherit"] })
    const w = { child, buf: "" }
    child.stdout.on("data", (d) => {
      w.buf += d
      let i
      while ((i = w.buf.indexOf("\n")) >= 0) {
        const line = w.buf.slice(0, i)
        w.buf = w.buf.slice(i + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        const p = this._workerPending.get(msg.id)
        if (!p) continue
        this._workerPending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else {
          const e = new Error(msg.error?.message || "native worker error")
          if (msg.error?.code) e.code = msg.error.code
          p.reject(e)
        }
      }
    })
    const fail = (e) => {
      for (const p of this._workerPending.values()) p.reject(e)
      this._workerPending.clear()
      if (this._worker === w) this._worker = null
    }
    child.on("error", fail)
    child.on("exit", (code) => fail(new Error(`native worker exited (code ${code})`)))
    // the worker must not hold the host process open on its own
    child.unref()
    child.stdin.unref?.()
    child.stdout.unref?.()
    this._worker = w
    return w
  }

  async rpc(op, params = {}) {
    const w = this.workerStart()
    const id = ++this._workerSeq
    const done = new Promise((res, rej) => this._workerPending.set(id, { resolve: res, reject: rej }))
    w.child.stdin.write(JSON.stringify({ id, op, ...params }) + "\n")
    return done
  }

  // Stop the worker, if one is running. The plugin host lives on; a
  // test (or a host shutting the plugin down) calls this so no child
  // is left holding the store open.
  async close() {
    const w = this._worker
    this._worker = null
    for (const p of this._workerPending.values()) p.reject(new Error("native backend closed"))
    this._workerPending.clear()
    if (w) { try { w.child.kill() } catch { /* already gone */ } }
  }

  // Loads the SDK in the worker — surfaces the configuration errors,
  // if any, without importing anything here.
  async workerInfo() { return this.rpc("sdkInfo") }

  // -- plugin-side records (import layer, publishes): the engine keeps
  // layers, not a publish log, so the plugin records its own publishes.
  statePath(project) { return join(this.stateDir, `${project}.json`) }
  readState(project) {
    try { return JSON.parse(readFileSync(this.statePath(project), "utf8")) }
    catch { return { importLayer: null, publishes: [] } }
  }
  writeState(project, state) {
    mkdirPrivate(this.stateDir)
    writeJson(this.statePath(project), state, true)
  }

  workspaceDir(project, branch) { return join(this.workspacesDir, project, encodeBranchName(branch)) }
  readBinding(dir) {
    try { return JSON.parse(readFileSync(join(dir, BINDING), "utf8")) } catch { return null }
  }

  // -- SDK reads, all through the worker (the pagination and the tree
  // walk run on the worker side; only the results cross over)
  async branchMap(project) {
    return new Map(await this.rpc("branchMap", { project }))
  }

  // Newest first, as the SDK returns them; a branch with no commits (a
  // fresh main is a Layer stack, not a commit chain) reads as empty.
  async commits(project, branch, limit = 1000) {
    try {
      return await this.rpc("commits", { project, branch, limit })
    } catch (e) {
      if (e?.code === "NoSuchBranch") return []
      throw e
    }
  }

  // The branch's tree: Map "/rel/path" -> { type, size }.
  async remoteTree(project, branch) {
    return new Map(await this.rpc("tree", { project, branch }))
  }

  // Full text of a store file; null when the file is binary (the fs
  // surface refuses those with code Binary).
  async readText(project, branch, path) {
    const r = await this.rpc("readText", { project, branch, path })
    return r.text
  }

  async ensureProject(project, sourceDir) {
    const existing = await this.branchMap(project).catch(() => new Map())
    if (existing.size) return { created: false }
    if (!sourceDir) throw new Error(
      `project ${project} is not initialized in LayerFS yet; provision it once with a source directory to import`)
    const src = checkSourceDir(sourceDir, { storeRoot: this.root })
    // The engine imports the tree itself and cannot skip files, so a
    // source holding secret-shaped files is refused up front — the sim
    // backend skips them; here the only safe answer is no.
    const pre = scanSourceForImport(src)
    if (pre.skipped.length) throw new Error(
      `refusing to import ${src} through the native backend: it holds files that must not enter the store ` +
      `(${pre.skipped.slice(0, 5).join(", ")}${pre.skipped.length > 5 ? `, and ${pre.skipped.length - 5} more` : ""}). ` +
      `The LayerFS engine imports a source tree whole and cannot skip them the way the sim backend does. ` +
      `Move them out of the source directory and retry.`)
    let result
    try {
      result = await this.rpc("init", { project, sourceDir: src })
    } catch (e) {
      if (e?.code === "Exists") return { created: false }
      if (e?.code === "Failed" && /InvalidInput/.test(String(e?.message ?? ""))) throw new Error(
        `LayerFS refused to import ${src}: the engine rejects this source directory ` +
        `(known upstream: a source tree on overlayfs fails with Project(InvalidInput) and no further detail). ` +
        `Import from a plain ext4/xfs/btrfs or tmpfs directory instead. Raw error: ${String(e.message).slice(0, 200)}`)
      throw e
    }
    const state = this.readState(project)
    state.importLayer = result.layer
    this.writeState(project, state)
    return { created: true }
  }

  // Materialize a branch into its checkout directory through the fs
  // surface. Binary files cannot be read back (see the header), so they
  // are named in the binding and the result, never silently dropped.
  // The directory is never wiped: files are written over what is there,
  // the way the sim backend materializes, so a stray directory with no
  // binding loses nothing either.
  async materialize(project, branch, head) {
    const dir = this.workspaceDir(project, branch)
    const tree = await this.remoteTree(project, branch)
    const skippedBinary = []
    mkdirPrivate(dir)
    ensureScratch(dir)
    let files = 0
    for (const [path, entry] of [...tree].sort()) {
      const local = join(dir, ...path.split("/").filter(Boolean))
      if (entry.type === "dir") { mkdirSync(local, { recursive: true }); continue }
      if (entry.type !== "file") { skippedBinary.push(path.slice(1)); continue }
      const text = await this.readText(project, branch, path)
      if (text === null) { skippedBinary.push(path.slice(1)); continue }
      mkdirSync(dirname(local), { recursive: true })
      writeFileSync(local, text)
      files++
    }
    writeJson(join(dir, BINDING), { project, branch, backend: "native", mode: "checkout", head, skippedBinary }, true)
    return { dir, files, skippedBinary }
  }

  async provision(project, branch = "main", sourceDir) {
    checkProject(project); checkBranch(branch)
    const { created } = await this.ensureProject(project, sourceDir)
    const branches = await this.branchMap(project)
    const info = branches.get(branch)
    if (!info) throw new Error(`no branch ${branch} in project ${project}; fork it first`)
    const dir = this.workspaceDir(project, branch)
    const binding = this.readBinding(dir)
    if (binding && binding.mode === "checkout") {
      if (binding.head === info.head)
        return {
          path: dir, project, branch, backend: this.kind, mode: "checkout",
          commit: info.head, reused: true, stale: false, skippedBinary: binding.skippedBinary ?? [],
        }
      // The branch moved since this checkout (a publish, or a checkpoint
      // from another workspace). The files here may hold uncheckpointed
      // work, so — exactly as the sim backend does — they are kept and
      // the staleness is reported, never wiped. (Pre-0.7.0 this path
      // re-materialized with rmSync and silently lost those edits.)
      return {
        path: dir, project, branch, backend: this.kind, mode: "checkout",
        commit: binding.head, currentHead: info.head, reused: true, stale: true,
        skippedBinary: binding.skippedBinary ?? [],
        note: "the branch has moved since this workspace was checked out; its files were left untouched — checkpoint to commit the work here onto the branch, or remove the workspace directory to check out fresh",
      }
    }
    const m = await this.materialize(project, branch, info.head)
    return {
      path: dir, project, branch, backend: this.kind, mode: "checkout",
      commit: info.head, reused: false, stale: false, files: m.files, skippedBinary: m.skippedBinary,
      ...(created ? { projectCreated: true } : {}),
    }
  }

  async checkpoint(project, branch = "main", message = "") {
    checkProject(project); checkBranch(branch)
    const dir = this.workspaceDir(project, branch)
    const binding = this.readBinding(dir)
    if (!binding) throw new Error(`no workspace for ${project}/${branch}; provision it first`)
    const local = scanTree(dir, scanSkip())
    const remote = await this.remoteTree(project, branch)
    const changes = [], skippedBinary = []
    let added = 0, modified = 0, deleted = 0
    const remoteFiles = new Map([...remote].filter(([, e]) => e.type === "file")
      .map(([p, e]) => [p.slice(1), e]))
    // directories the branch does not have yet
    const localDirs = new Set()
    for (const rel of Object.keys(local)) {
      const parts = rel.split("/")
      for (let i = 1; i < parts.length; i++) localDirs.add(parts.slice(0, i).join("/"))
    }
    for (const d of [...localDirs].sort())
      if (!remote.has(`/${d}`)) changes.push({ op: "mkdir", path: `/${d}` })
    for (const [rel, f] of Object.entries(local)) {
      const buf = readFileSync(join(dir, ...rel.split("/")))
      const r = remoteFiles.get(rel)
      if (!isTextBuf(buf)) {
        // binary content cannot be read back through the fs surface
        // (code Binary, upstream #417), so it cannot be diffed; an
        // unchanged size against a store copy counts as unchanged
        if (!r || r.size !== f.size) skippedBinary.push(rel)
        continue
      }
      const text = buf.toString("utf8")
      if (!r) { changes.push({ op: "write", path: `/${rel}`, content: text }); added++; continue }
      const remoteText = await this.readText(project, branch, `/${rel}`)
      if (remoteText === null) { if (r.size !== f.size) { changes.push({ op: "write", path: `/${rel}`, content: text }); modified++ } continue }
      if (remoteText !== text) { changes.push({ op: "write", path: `/${rel}`, content: text }); modified++ }
    }
    // Deletions: a remote file missing locally is removed — EXCEPT the
    // binaries this backend could not move. They are absent locally by
    // construction (materialize skipped them, and this round's scan
    // could not commit them), not by deletion, so an rm for one would
    // destroy store content the user never asked to drop. (Pre-0.7.0
    // the rm set had no such exclusion: the first checkpoint on a
    // branch whose import held a binary deleted every one of them.
    // The cost of the safe rule: a skipped binary cannot be deleted
    // from a native branch by checkpointing — the fs surface cannot
    // tell "deleted here" from "never materialized here".)
    const unmovable = new Set([...(binding.skippedBinary ?? []), ...skippedBinary])
    for (const rel of remoteFiles.keys())
      if (!local[rel] && !unmovable.has(rel)) { changes.push({ op: "rm", path: `/${rel}` }); deleted++ }
    const headBefore = (await this.branchMap(project)).get(branch)?.head ?? null
    if (!changes.length)
      return {
        project, branch, commit: headBefore, changed: false,
        added: 0, modified: 0, deleted: 0, skippedBinary,
        note: "nothing to commit (UpToDate)",
      }
    const { commit: c } = await this.rpc("apply", { project, branch, changes, message: message || "Checkpoint" })
    writeJson(join(dir, BINDING),
      { ...binding, head: c.id, skippedBinary: [...unmovable] }, true)
    return {
      project, branch, commit: c.id, parent: c.parent, changed: true,
      message: c.message, added, modified, deleted,
      logicalBytes: c.logical, newBytes: (c.newStored ?? 0) + (c.newMetadata ?? 0),
      skippedBinary,
    }
  }

  async fork(project, branch, from = "main") {
    checkProject(project); checkBranch(branch); checkBranch(from)
    await this.ensureProject(project)
    const branches = await this.branchMap(project)
    if (branches.has(branch)) throw new Error(`branch ${branch} already exists in project ${project}`)
    if (!branches.has(from)) throw new Error(`no branch ${from} in project ${project}`)
    await this.rpc("fork", { project, branch, from })
    const p = await this.provision(project, branch)
    return { project, branch, from, commit: p.commit, copiedBytes: 0, path: p.path, skippedBinary: p.skippedBinary }
  }

  // Publish appends the branch tip's tree as main's next Layer. Guard:
  // the branch must have forked from main's current top Layer — a stale
  // branch's tree would silently replace newer work on main, the same
  // failure the sim backend guards against in commit terms.
  async publish(project, branch, { force = false } = {}) {
    checkProject(project); checkBranch(branch)
    if (branch === "main") throw new Error("publish names a branch other than main; main is what gets published to")
    await this.ensureProject(project)
    const branches = await this.branchMap(project)
    const info = branches.get(branch)
    if (!info) throw new Error(`no branch ${branch} in project ${project}`)
    if (!info.head) throw new Error(`branch ${branch} has no commits to publish`)
    const state = this.readState(project)
    if (state.publishes.some((p) => p.commit === info.head))
      return { project, branch, commit: info.head, alreadyPublished: true, overwrote: false }
    const mainTop = branches.get("main")?.base ?? null
    // Unknown ancestry is not freshness: when the branch's fork point
    // or main's top Layer cannot be read, the guard cannot prove the
    // publish only moves main forward, so it refuses unless forced.
    // (Pre-0.7.0 a null on either side counted as fresh.)
    const unknown = info.forkedFrom == null || mainTop == null
    const stale = !unknown && info.forkedFrom !== mainTop
    if ((unknown || stale) && !force)
      throw new Error(unknown
        ? `cannot tell whether ${branch} is up to date with main (${info.forkedFrom == null ? "its fork point is unknown" : "main's top Layer is unknown"}): publishing could replace main's newer Layer content, so it is refused. Pass force: true to overwrite deliberately.`
        : `main has moved since ${branch} forked: main's top Layer is ${mainTop}, but ${branch} forked from ${info.forkedFrom}. Publishing would replace main's newer Layer content. Fork a fresh branch from main, or pass force: true to overwrite deliberately.`)
    const result = await this.rpc("publish", { project, branch, head: info.head })
    const layer = state.publishes.length + 1
    const overwrote = stale || unknown || (result.publishedLayer?.overwroteCount ?? 0) > 0
    state.publishes.push({
      branch, commit: info.head, layer, layerId: result.publishedLayer?.id ?? null,
      parent: result.publishedLayer?.parent ?? null, overwrote, time: nowIso(),
    })
    this.writeState(project, state)
    return {
      project, branch, layer, commit: info.head,
      previousMain: result.publishedLayer?.parent ?? mainTop, overwrote, engine: result,
    }
  }

  async exec(project, branch = "main", command, message = "", timeoutMs = 50000) {
    checkProject(project); checkBranch(branch)
    if (typeof command !== "string" || !command.trim()) throw new Error("command is a non-empty string")
    const dir = this.workspaceDir(project, branch)
    if (!this.readBinding(dir)) throw new Error(`no workspace for ${project}/${branch}; provision it first`)
    const r = await runShell(command, dir, Math.min(Math.max(100, timeoutMs || 50000), 55000))
    const c = await this.checkpoint(project, branch, message || `exec: ${command.trim().slice(0, 60)}`)
    return {
      project, branch, exitCode: r.code, ...(r.timedOut ? { timedOut: true } : {}),
      stdout: r.stdout, stderr: r.stderr,
      changed: c.changed === true, commit: c.changed ? c.commit : null,
      ...(c.skippedBinary?.length ? { skippedBinary: c.skippedBinary } : {}),
    }
  }

  async history(project, branch = "main", limit = 20) {
    checkProject(project); checkBranch(branch)
    await this.ensureProject(project)
    const commits = await this.commits(project, branch, limit)
    return {
      project, branch,
      commits: commits.map((c) => ({
        commit: c.id, message: c.message, time: new Date(c.time).toISOString(),
        logicalBytes: c.logical, newBytes: (c.newStored ?? 0) + (c.newMetadata ?? 0),
      })),
    }
  }

  async resolve(project, branch = "main", inner = "") {
    checkProject(project); checkBranch(branch)
    await this.ensureProject(project)
    const branches = await this.branchMap(project)
    const info = branches.get(branch)
    if (!info) throw new Error(`no branch ${branch} in project ${project}`)
    const dir = this.workspaceDir(project, branch)
    const provisioned = !!this.readBinding(dir)
    const out = {
      path: provisioned ? (inner ? join(dir, ...inner.split("/")) : dir) : null,
      project, branch, commit: info.head, provisioned,
      ...(provisioned ? {} : { hint: "call provision to materialize this workspace" }),
    }
    if (inner) {
      inner = checkInnerPath(inner)
      try {
        const st = await this.rpc("stat", { project, branch, path: `/${inner}` })
        out.inHead = true; out.size = st.size; out.type = st.type; out.root = st.root
      } catch { out.inHead = false }
    }
    return out
  }

  async projectNames() {
    const names = new Set()
    if (existsSync(this.stateDir))
      for (const f of readdirSync(this.stateDir)) if (f.endsWith(".json")) names.add(f.slice(0, -5))
    if (existsSync(this.homeDir))
      for (const e of readdirSync(this.homeDir, { withFileTypes: true })) if (e.isDirectory()) names.add(e.name)
    return [...names].sort()
  }

  async status() {
    await this.workerInfo() // surfaces the configuration errors, if any
    const projects = []
    let logical = 0, stored = 0
    for (const name of await this.projectNames()) {
      const branches = await this.branchMap(name).catch(() => new Map())
      let commits = 0
      for (const b of branches.keys()) {
        const cs = await this.commits(name, b).catch(() => [])
        commits += cs.length
        for (const c of cs) { logical += c.logical ?? 0; stored += (c.newStored ?? 0) + (c.newMetadata ?? 0) }
      }
      const state = this.readState(name)
      projects.push({
        name, branches: [...branches.keys()], commits,
        layers: 1 + state.publishes.length,
      })
    }
    const workspaces = countWorkspaces(this.workspacesDir)
    return {
      backend: this.kind, root: this.nativeRoot, storePath: this.storePathEnv,
      projects, workspaces,
      logicalBytes: logical, storedBytes: stored,
      savedBytes: Math.max(0, logical - stored),
      dedupRatio: stored ? +(logical / stored).toFixed(2) : 1,
      note: "byte totals sum the branch commits; the initial import layer is not a commit and is not counted",
    }
  }

  // One project's slice of the trajectory, from the engine's own
  // records: commits per branch (the import is a Layer, synthesized as
  // main's first node from the recorded import).
  async trajectoryProject(name) {
    const branches = await this.branchMap(name).catch(() => new Map())
    const state = this.readState(name)
    const out = []
    for (const b of branches.keys()) {
      const cs = await this.commits(name, b).catch(() => [])
      const commits = cs.reverse().map((c) => ({
        id: c.id, parent: c.parent, message: c.message,
        time: new Date(c.time).toISOString(), files: null,
        logicalBytes: c.logical ?? 0, newBytes: (c.newStored ?? 0) + (c.newMetadata ?? 0),
        delta: { added: 0, modified: 0, deleted: 0 },
      }))
      if (b === "main" && state.importLayer)
        commits.unshift({
          id: state.importLayer, parent: null, message: "Import", time: null,
          files: null, logicalBytes: 0, newBytes: 0, delta: { added: 0, modified: 0, deleted: 0 },
        })
      out.push({ name: b, commits })
    }
    return { name, branches: out }
  }

  publishEvents(name) {
    return this.readState(name).publishes.map((p) => ({
      t: p.time, kind: "publish", project: name, branch: p.branch,
      commit: p.commit, layer: p.layer, overwrote: p.overwrote,
    }))
  }

  // Same shape as the sim backend's trajectory; publishes come from
  // the plugin's own publish log with their Layer numbers.
  async trajectory() {
    const projects = []
    for (const name of await this.projectNames()) projects.push(await this.trajectoryProject(name))
    const st = await this.status()
    const events = []
    for (const name of await this.projectNames()) events.push(...this.publishEvents(name))
    return {
      generatedAt: nowIso(), backend: this.kind, projects, events,
      totals: {
        logicalBytes: st.logicalBytes, storedBytes: st.storedBytes,
        savedBytes: st.savedBytes, dedupRatio: st.dedupRatio, workspaces: st.workspaces,
      },
    }
  }

  // The recorded trajectory is built ON DEMAND by trajectory(),
  // exactly as in the sim backend — no per-call trajectory.json is
  // maintained in the store anymore (0.7.1; round-2 review, item 3).
}

// ---- selection ---------------------------------------------------------------------

// The native backend is off unless the user opts in: the plugin's
// "native" option (magpie hands a plugin its options as the plugin
// function's second argument) or MAGPIE_LAYERFS_NATIVE=1 in the host
// environment. An SDK path alone no longer turns it on: opting in is
// what says "run this code, in a child process, with my rights".
export function nativeOptedIn(env = process.env, options = {}) {
  return options?.native === true || env.MAGPIE_LAYERFS_NATIVE === "1"
}

export async function createBackend(env = process.env, options = {}) {
  const want = (env.MAGPIE_LAYERFS_BACKEND || "auto").toLowerCase()
  if (want === "sim") return new SimBackend(env.MAGPIE_LAYERFS_HOME)
  if (want !== "auto" && want !== "native")
    throw new Error(`MAGPIE_LAYERFS_BACKEND is auto, native or sim; got ${JSON.stringify(want)}`)
  if (want === "native" && !nativeOptedIn(env, options))
    throw new Error(
      "the native LayerFS backend is off by default: it runs the LayerFS SDK in a child process with the host's rights. " +
      "Enable it with the plugin's \"native\" option or MAGPIE_LAYERFS_NATIVE=1, with LAYERFS_SDK_PATH pointing at a layerfs checkout's sdk/js/src/index.js.")
  // auto: native when the SDK is configured AND the user opted in,
  // sim otherwise (the native backend derives its store volume itself;
  // LAYERFS_STORE_PATH only anchors it elsewhere when set)
  if (want === "native" || (env.LAYERFS_SDK_PATH && nativeOptedIn(env, options)))
    return new NativeBackend(env.MAGPIE_LAYERFS_HOME)
  return new SimBackend(env.MAGPIE_LAYERFS_HOME)
}
