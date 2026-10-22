import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { LayerfsTools } from "./index.mjs"
import {
  IMPORT_MAX_FILES, NativeBackend, SimBackend, checkSourceDir, createBackend, scanImportTree,
} from "./layerfs.mjs"

const sha = (s) => createHash("sha256").update(s).digest("hex")
const FAKE_SDK = join(import.meta.dir, "fake-sdk.mjs")

// Hygiene: every temp dir a test makes is registered and removed, and
// the process env the suite mutates is restored whole at the end —
// a test run leaves nothing behind but its results.
const envSnapshot = { ...process.env }
const tmpDirs = []
function mkTmp(prefix, base = tmpdir()) {
  const d = mkdtempSync(join(base, prefix))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k]
  Object.assign(process.env, envSnapshot)
})

function fixture() {
  const src = mkTmp("layerfs-src-")
  mkdirSync(join(src, "docs"), { recursive: true })
  writeFileSync(join(src, "README.md"), "hello layerfs\n")
  writeFileSync(join(src, "docs", "a.txt"), "A".repeat(1000))
  writeFileSync(join(src, "docs", "b.txt"), "A".repeat(1000)) // identical to a.txt on purpose
  writeFileSync(join(src, "code.js"), "console.log(1)\n")
  return src
}

async function simTools(opts = { exec: true }) {
  const home = mkTmp("layerfs-home-")
  process.env.MAGPIE_LAYERFS_HOME = home
  process.env.MAGPIE_LAYERFS_BACKEND = "sim"
  delete process.env.LAYERFS_SDK_PATH
  delete process.env.LAYERFS_STORE_PATH
  delete process.env.MAGPIE_LAYERFS_EXEC
  delete process.env.MAGPIE_LAYERFS_NATIVE
  const src = fixture()
  // ctx.directory is magpie's CONFIG directory in the real host — the
  // harness models it as its own temp dir, never the source
  const { tool } = await LayerfsTools({ directory: mkTmp("magpie-config-") }, opts)
  // provision's source is a required argument since 0.7.0: the wrapper
  // passes the fixture explicitly, the way a caller now must
  const call = (name, args) => tool[name].execute(
    name === "provision" && args.source === undefined ? { ...args, source: src } : args,
    { agent: "test", abort: AbortSignal.timeout(5000) })
  return { call, home, src, tool }
}

test("gives eight tools, each with a JSON Schema and an execute", async () => {
  const { tool } = await LayerfsTools({})
  expect(Object.keys(tool).sort()).toEqual(["checkpoint", "exec", "fork", "history", "provision", "publish", "resolve", "status"])
  for (const [name, t] of Object.entries(tool)) {
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,48}$/)
    expect(t.description.length).toBeGreaterThan(40)
    expect(typeof t.execute).toBe("function")
    expect(t.args.type).toBe("object")
  }
  // source is a required provision argument; there is no default
  expect(tool.provision.args.required).toEqual(["project", "source"])
})

test("provision imports the source once, then answers the same path without copying", async () => {
  const { call } = await simTools()
  const first = await call("provision", { project: "website" })
  expect(first.projectCreated).toBe(true)
  expect(first.reused).toBe(false)
  expect(first.files).toBe(4)
  expect(readFileSync(join(first.path, "README.md"), "utf8")).toBe("hello layerfs\n")
  const again = await call("provision", { project: "website" })
  expect(again.path).toBe(first.path)
  expect(again.reused).toBe(true)
  expect(again.stale).toBe(false)
})

test("checkpoint stores only the blobs that changed", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  writeFileSync(join(ws.path, "code.js"), "console.log(2)\n") // modified, 15 bytes
  writeFileSync(join(ws.path, "new.txt"), "brand new\n") // added, 10 bytes
  const cp = await call("checkpoint", { project: "website", message: "second take" })
  expect(cp.added).toBe(1)
  expect(cp.modified).toBe(1)
  expect(cp.deleted).toBe(0)
  expect(cp.newBytes).toBe(15 + 10)
  expect(cp.logicalBytes).toBe(14 + 1000 + 1000 + 15 + 10)
  expect(cp.savedBytes).toBe(cp.logicalBytes - cp.newBytes)
})

test("fork copies no bytes and shares the history", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const before = await call("status", {})
  const f = await call("fork", { project: "website", branch: "agent-2" })
  expect(f.copiedBytes).toBe(0)
  const after = await call("status", {})
  expect(after.storedBytes).toBe(before.storedBytes)
  const ws2 = await call("provision", { project: "website", branch: "agent-2" })
  expect(readFileSync(join(ws2.path, "docs", "a.txt"), "utf8")).toBe("A".repeat(1000))
  const hist = await call("history", { project: "website", branch: "agent-2" })
  expect(hist.commits.length).toBe(1)
  expect(hist.commits[0].message).toContain("Import")
  await expect(call("fork", { project: "website", branch: "agent-2" })).rejects.toThrow("already exists")
})

test("identical files are stored once (dedup at import)", async () => {
  const { call, home } = await simTools()
  await call("provision", { project: "website" })
  const st = await call("status", {})
  // unique contents: "hello layerfs\n" (14) + "A"*1000 (1000) + "console.log(1)\n" (15)
  // storedBytes is those blobs PLUS the import's commit record, whose
  // manifest the accounting has counted since 0.7.1 (r2 item 7)
  const cdir = join(home, "projects", "website", "commits")
  const recordBytes = readdirSync(cdir).reduce((n, f) => n + statSync(join(cdir, f)).size, 0)
  expect(recordBytes).toBeGreaterThan(0)
  expect(st.storedBytes).toBe(14 + 1000 + 15 + recordBytes)
  expect(st.logicalBytes).toBe(14 + 1000 + 1000 + 15)
  expect(st.dedupRatio).toBeGreaterThan(1)
})

test("resolve answers a path and a file's hash without copying", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  const root = await call("resolve", { project: "website" })
  expect(root.path).toBe(ws.path)
  const file = await call("resolve", { project: "website", path: "docs/a.txt" })
  expect(file.path).toBe(join(ws.path, "docs", "a.txt"))
  expect(file.sha).toBe(sha("A".repeat(1000)))
  expect(file.size).toBe(1000)
})

test("names and paths are validated", async () => {
  const { call } = await simTools()
  await expect(call("provision", { project: "Bad Name" })).rejects.toThrow("project name")
  await call("provision", { project: "website" })
  await expect(call("resolve", { project: "website", path: "../escape" })).rejects.toThrow("stay inside")
})

test("a workspace file survives on disk where resolve says it is", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const file = await call("resolve", { project: "website", path: "code.js" })
  expect(existsSync(file.path)).toBe(true)
})

test("publish moves main forward to the branch head, as a numbered Layer", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "feat" })
  const feat = await call("provision", { project: "website", branch: "feat" })
  writeFileSync(join(feat.path, "feature.js"), "export const f = 1\n")
  const cp = await call("checkpoint", { project: "website", branch: "feat", message: "add feature" })
  const pub = await call("publish", { project: "website", branch: "feat" })
  expect(pub.layer).toBe(1)
  expect(pub.commit).toBe(cp.commit)
  expect(pub.overwrote).toBe(false)
  const main = await call("history", { project: "website", branch: "main" })
  expect(main.commits[0].commit).toBe(cp.commit) // main now answers for the feature
  expect(main.commits[0].message).toBe("add feature")
  const again = await call("publish", { project: "website", branch: "feat" })
  expect(again.alreadyPublished).toBe(true)
  expect(ws.path).toBeTruthy()
})

test("publish refuses to drop a main that moved, unless forced", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "feat" })
  const feat = await call("provision", { project: "website", branch: "feat" })
  writeFileSync(join(feat.path, "feature.js"), "f\n")
  await call("checkpoint", { project: "website", branch: "feat", message: "feature" })
  // main advances on its own after the fork: the branch no longer contains it
  const mainWs = await call("provision", { project: "website", branch: "main" })
  writeFileSync(join(mainWs.path, "hotfix.js"), "h\n")
  const hot = await call("checkpoint", { project: "website", branch: "main", message: "hotfix" })
  await expect(call("publish", { project: "website", branch: "feat" })).rejects.toThrow("main has moved")
  const forced = await call("publish", { project: "website", branch: "feat", force: true })
  expect(forced.overwrote).toBe(true)
  expect(forced.previousMain).toBe(hot.commit)
  await expect(call("publish", { project: "website", branch: "main" })).rejects.toThrow("other than main")
})

test("exec runs in the workspace and checkpoints what changed", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const before = await call("history", { project: "website" })
  const r = await call("exec", { project: "website", command: "echo built > build.log && echo hello" })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain("hello")
  expect(r.changed).toBe(true)
  expect(r.commit).toBeTruthy()
  const after = await call("history", { project: "website" })
  expect(after.commits.length).toBe(before.commits.length + 1)
  expect(after.commits[0].message).toContain("exec:")
  const noop = await call("exec", { project: "website", command: "true" })
  expect(noop.changed).toBe(false)
  expect(noop.commit).toBeNull()
  const failed = await call("exec", { project: "website", command: "echo x > partial.txt; exit 3" })
  expect(failed.exitCode).toBe(3)
  expect(failed.changed).toBe(true) // a failing command's edits are still history
})

test("exec redirects TMPDIR and the cache home into the workspace scratch dirs", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  // provision pre-creates both scratch directories
  expect(existsSync(join(ws.path, ".tmp"))).toBe(true)
  expect(existsSync(join(ws.path, ".cache"))).toBe(true)
  const r = await call("exec", {
    project: "website",
    command: 'echo "$TMPDIR" && echo scratch > "$TMPDIR/probe.txt" && echo cache > "$XDG_CACHE_HOME/probe.txt"',
  })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain(join(ws.path, ".tmp")) // $TMPDIR points inside the workspace
  expect(readFileSync(join(ws.path, ".tmp", "probe.txt"), "utf8")).toBe("scratch\n")
  expect(readFileSync(join(ws.path, ".cache", "probe.txt"), "utf8")).toBe("cache\n")
  // scratch is not history: a run that touched only scratch commits nothing
  expect(r.changed).toBe(false)
  expect(r.commit).toBeNull()
})

test("checkpoint never captures the scratch directories", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  writeFileSync(join(ws.path, ".tmp", "junk.txt"), "junk\n")
  writeFileSync(join(ws.path, ".cache", "junk.txt"), "junk\n")
  writeFileSync(join(ws.path, "real.txt"), "real\n") // the one real change, 5 bytes
  const cp = await call("checkpoint", { project: "website", message: "with scratch present" })
  expect(cp.added).toBe(1) // real.txt only — the scratch files are not counted
  expect(cp.modified).toBe(0)
  expect(cp.deleted).toBe(0)
  expect(cp.files).toBe(5) // the 4 imported files + real.txt
  expect(cp.newBytes).toBe(5)
  expect(cp.logicalBytes).toBe(14 + 1000 + 1000 + 15 + 5)
  // the scratch content itself stays put in the live workspace
  expect(readFileSync(join(ws.path, ".tmp", "junk.txt"), "utf8")).toBe("junk\n")
  expect(readFileSync(join(ws.path, ".cache", "junk.txt"), "utf8")).toBe("junk\n")
})

// ---- the review's findings, one regression test each -------------------------

test("item 1: provision has no default source — the host's config directory is never imported", async () => {
  const home = mkTmp("layerfs-home-")
  process.env.MAGPIE_LAYERFS_HOME = home
  process.env.MAGPIE_LAYERFS_BACKEND = "sim"
  const cfg = mkTmp("magpie-config-")
  writeFileSync(join(cfg, "plugin-auth.json"), JSON.stringify({ token: "secret" }))
  mkdirSync(join(cfg, "sub"))
  const { tool } = await LayerfsTools({ directory: cfg })
  const call = (name, args) => tool[name].execute(args, { agent: "test", abort: AbortSignal.timeout(5000) })
  // no source at all
  await expect(call("provision", { project: "website" })).rejects.toThrow("source is required")
  // the config directory itself, a directory under it, and a parent of it
  await expect(call("provision", { project: "website", source: cfg })).rejects.toThrow("refusing to import")
  await expect(call("provision", { project: "website", source: join(cfg, "sub") })).rejects.toThrow("refusing to import")
  await expect(call("provision", { project: "website", source: tmpdir() })).rejects.toThrow("refusing to import")
  // and the home directory
  await expect(call("provision", { project: "website", source: homedir() })).rejects.toThrow("refusing to import")
  // nothing was imported anywhere along the way
  const st = await call("status", {})
  expect(st.projects).toEqual([])
})

test("item 2: exec is disabled by default and runs only on the user's opt-in", async () => {
  const off = await simTools({}) // no plugin options, no env switch
  await off.call("provision", { project: "website" })
  await expect(off.call("exec", { project: "website", command: "echo hi > hi.txt" }))
    .rejects.toThrow("disabled by default")
  const hist = await off.call("history", { project: "website" })
  expect(hist.commits.length).toBe(1) // the refused exec committed nothing
  // the environment switch turns it on for the same tools
  process.env.MAGPIE_LAYERFS_EXEC = "1"
  try {
    const r = await off.call("exec", { project: "website", command: "echo hi > hi.txt" })
    expect(r.exitCode).toBe(0)
    expect(r.changed).toBe(true)
  } finally {
    delete process.env.MAGPIE_LAYERFS_EXEC
  }
  // and the plugin option turns it on without the environment (the
  // other exec tests run through simTools' default { exec: true })
  const on = await simTools({ exec: true })
  await on.call("provision", { project: "website" })
  const r2 = await on.call("exec", { project: "website", command: "true" })
  expect(r2.exitCode).toBe(0)
})

test("item 3: an import skips secret-shaped files and reports them", async () => {
  const { call, src } = await simTools()
  writeFileSync(join(src, ".env"), "TOKEN=x\n")
  writeFileSync(join(src, "docs", ".env.local"), "TOKEN=y\n")
  mkdirSync(join(src, ".git"))
  writeFileSync(join(src, ".git", "config"), "[core]\n")
  writeFileSync(join(src, "id_rsa"), "-----BEGIN-----\n")
  writeFileSync(join(src, "cert.pem"), "-----BEGIN-----\n")
  mkdirSync(join(src, "sub", ".ssh"), { recursive: true })
  writeFileSync(join(src, "sub", ".ssh", "known_hosts"), "host\n")
  const ws = await call("provision", { project: "website" })
  expect(ws.files).toBe(4) // only the fixture's real files
  expect(ws.importSkipped).toBe(6) // .env, docs/.env.local, .git, id_rsa, cert.pem, sub/.ssh
  expect(ws.skippedSecrets).toContain(".env")
  expect(existsSync(join(ws.path, ".env"))).toBe(false)
  expect(existsSync(join(ws.path, "id_rsa"))).toBe(false)
  expect(existsSync(join(ws.path, ".git"))).toBe(false)
  const st = await call("status", {})
  expect(st.logicalBytes).toBe(14 + 1000 + 1000 + 15) // none of the secrets' bytes either
})

test("item 3: an import over the file limit is refused, not swept in", () => {
  const src = mkTmp("layerfs-big-")
  for (let i = 0; i <= IMPORT_MAX_FILES; i++) writeFileSync(join(src, `f${i}.txt`), "")
  expect(() => scanImportTree(src)).toThrow("import limit")
}, 30000)

test("item 4: the store is private, and a file's mode survives the store", async () => {
  const { call, home, src } = await simTools()
  writeFileSync(join(src, "secret.txt"), "s3cret\n")
  chmodSync(join(src, "secret.txt"), 0o600)
  const ws = await call("provision", { project: "website" })
  const mode = (p) => statSync(p).mode & 0o777
  expect(mode(join(home, "store"))).toBe(0o700)
  expect(mode(join(home, "projects"))).toBe(0o700)
  expect(mode(join(home, "workspaces"))).toBe(0o700)
  expect(mode(ws.path)).toBe(0o700)
  expect(mode(join(ws.path, "secret.txt"))).toBe(0o600) // 0600 in, 0600 out
  expect(mode(join(ws.path, "README.md"))).toBe(mode(join(src, "README.md"))) // the source's own mode, kept
  expect(mode(join(home, "accounting.json"))).toBe(0o600) // record files stay private
})

test("item 5: the native backend needs an explicit opt-in, not just an SDK path", async () => {
  delete process.env.LAYERFS_SDK_PATH
  const sim1 = await createBackend({ MAGPIE_LAYERFS_HOME: mkTmp("layerfs-auto-") })
  expect(sim1).toBeInstanceOf(SimBackend)
  // an SDK path alone no longer turns native on (pre-0.7 it did)
  const sim2 = await createBackend({ MAGPIE_LAYERFS_HOME: mkTmp("layerfs-auto-"), LAYERFS_SDK_PATH: "/x/index.js" })
  expect(sim2).toBeInstanceOf(SimBackend)
  const byEnv = await createBackend({
    MAGPIE_LAYERFS_HOME: mkTmp("layerfs-auto-"), LAYERFS_SDK_PATH: "/x/index.js", MAGPIE_LAYERFS_NATIVE: "1",
  })
  expect(byEnv).toBeInstanceOf(NativeBackend)
  await byEnv.close()
  const byOption = await createBackend(
    { MAGPIE_LAYERFS_HOME: mkTmp("layerfs-auto-"), LAYERFS_SDK_PATH: "/x/index.js" }, { native: true })
  expect(byOption).toBeInstanceOf(NativeBackend)
  await byOption.close()
  // asking for native outright without the opt-in is refused, loudly
  await expect(createBackend({ MAGPIE_LAYERFS_BACKEND: "native" })).rejects.toThrow("off by default")
  const native = await createBackend({
    MAGPIE_LAYERFS_BACKEND: "native", MAGPIE_LAYERFS_NATIVE: "1", MAGPIE_LAYERFS_HOME: mkTmp("layerfs-auto-"),
  })
  expect(native).toBeInstanceOf(NativeBackend)
  await expect(native.status()).rejects.toThrow("LAYERFS_SDK_PATH")
  await native.close()
  await expect(createBackend({ MAGPIE_LAYERFS_BACKEND: "bogus" })).rejects.toThrow("auto, native or sim")
})

test("item 8 + r2 item 3: no trajectory file is maintained per call; the trajectory builds on demand", async () => {
  const pageFile = join(import.meta.dir, "page", "trajectory.js")
  const before = readFileSync(pageFile, "utf8")
  const { call, home } = await simTools()
  await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "feat" })
  const feat = await call("provision", { project: "website", branch: "feat" })
  writeFileSync(join(feat.path, "f.txt"), "f\n")
  await call("checkpoint", { project: "website", branch: "feat", message: "work" })
  expect(readFileSync(pageFile, "utf8")).toBe(before) // the shipped file is a sample, untouched (item 8)
  // 0.7.0 refreshed <root>/trajectory.json after every call; 0.7.1
  // dropped that — the refresh re-walked branch chains per call for a
  // file nothing reads (r2 item 3)
  expect(existsSync(join(home, "trajectory.json"))).toBe(false)
  // the trajectory itself is still there, built when asked
  const traj = await new SimBackend(home).trajectory()
  const proj = traj.projects.find((p) => p.name === "website")
  expect(proj.branches.map((x) => x.name).sort()).toEqual(["feat", "main"])
  const featSlice = proj.branches.find((x) => x.name === "feat")
  expect(featSlice.commits.at(-1).message).toBe("work")
  expect(traj.totals.logicalBytes).toBeGreaterThan(0)
})

test("items 9+10: slash branches are distinct, flat, and listed everywhere", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "feat/x" })
  await call("fork", { project: "website", branch: "feat__x" })
  const a = await call("provision", { project: "website", branch: "feat/x" })
  const b = await call("provision", { project: "website", branch: "feat__x" })
  expect(a.path).not.toBe(b.path) // feat/x and feat__x no longer collide on one directory
  writeFileSync(join(a.path, "only-x.txt"), "x\n")
  const cp = await call("checkpoint", { project: "website", branch: "feat/x", message: "x work" })
  expect(cp.added).toBe(1)
  const st = await call("status", {})
  expect(st.projects[0].branches).toEqual(["feat/x", "feat__x", "main"]) // slash branches are listed
  const h = await call("history", { project: "website", branch: "feat/x" })
  expect(h.commits[0].message).toBe("x work")
  const h2 = await call("history", { project: "website", branch: "feat__x" })
  expect(h2.commits[0].message).toContain("Import")
  const traj = await new SimBackend(st.root).trajectory()
  expect(traj.projects[0].branches.map((x) => x.name).sort()).toEqual(["feat/x", "feat__x", "main"])
})

// ---- the round-2 review's findings, one regression test each ------------------

test("r2 item 1: the source guard compares real paths — a symlink to a refused directory is refused", async () => {
  const cfg = mkTmp("magpie-config-")
  writeFileSync(join(cfg, "plugin-auth.json"), JSON.stringify({ token: "secret" }))
  // (a) a symlink whose target is the refused directory: resolve()
  // spellings differ, real paths do not
  const link = join(mkTmp("layerfs-links-"), "cfglink")
  symlinkSync(cfg, link)
  expect(() => checkSourceDir(link, { configDir: cfg })).toThrow("refusing to import")
  // a symlink PARENT of the source is seen through the same way
  const inner = join(mkTmp("layerfs-outer-"), "proj")
  mkdirSync(inner)
  const parentLink = join(mkTmp("layerfs-links-"), "parentlink")
  symlinkSync(dirname(inner), parentLink)
  expect(() => checkSourceDir(join(parentLink, "proj"), { configDir: dirname(inner) })).toThrow("refusing to import")
  // and end to end: provision through the symlink is refused, nothing imported
  const home = mkTmp("layerfs-home-")
  process.env.MAGPIE_LAYERFS_HOME = home
  process.env.MAGPIE_LAYERFS_BACKEND = "sim"
  const { tool } = await LayerfsTools({ directory: cfg }, {})
  const call = (name, args) => tool[name].execute(args, { agent: "test", abort: AbortSignal.timeout(5000) })
  await expect(call("provision", { project: "website", source: link })).rejects.toThrow("refusing to import")
  const st = await call("status", {})
  expect(st.projects).toEqual([])
})

test("r2 item 1: the source guard folds case — a case-variant spelling of a refused root is refused", () => {
  const mixed = mkTmp("Layerfs-Case-")
  // the same directory, named by a differently-cased spelling: on a
  // case-insensitive volume that spelling IS the directory; the
  // guard's case-folded realpath comparison refuses it everywhere,
  // including here, where the volume is case-sensitive and the
  // lowercase spelling does not even exist as a path
  const lowerSpelling = join(dirname(mixed), basename(mixed).toLowerCase())
  expect(lowerSpelling).not.toBe(mixed)
  expect(() => checkSourceDir(mixed, { configDir: lowerSpelling })).toThrow("refusing to import")
  // the review's "~/.Config/Magpie" shape: an upper-case spelling of
  // the source itself — refused as the config dir where the volume
  // folds case, "not a directory" where it does not; never imported
  const variant = join(dirname(mixed), basename(mixed).toUpperCase())
  expect(() => checkSourceDir(variant, { configDir: mixed })).toThrow(/refusing to import|not a directory/)
  // a refused root that does not exist at all must not make the guard throw the wrong error
  const ok = mkTmp("layerfs-oksrc-")
  expect(checkSourceDir(ok, { configDir: join(mkTmp("layerfs-gone-"), "nope") })).toBe(ok)
})

test("r2 item 2: project a branch b--c and project a--b branch c never share a workspace", async () => {
  const { call } = await simTools() // its wrapper supplies the (ignored) source branch provisions require
  const dirA = mkTmp("layerfs-srcA-")
  writeFileSync(join(dirA, "a.txt"), "from A\n")
  const dirB = mkTmp("layerfs-srcB-")
  writeFileSync(join(dirB, "b.txt"), "from B\n")
  await call("provision", { project: "a", source: dirA })
  await call("fork", { project: "a", branch: "b--c" })
  const pa = await call("provision", { project: "a", branch: "b--c" })
  await call("provision", { project: "a--b", source: dirB })
  await call("fork", { project: "a--b", branch: "c" })
  const pb = await call("provision", { project: "a--b", branch: "c" })
  // pre-fix both were workspaces/a--b--c, and pb answered a's checkout
  expect(pb.path).not.toBe(pa.path)
  expect(pb.reused).toBe(false)
  expect(readFileSync(join(pb.path, "b.txt"), "utf8")).toBe("from B\n")
  const st = await call("status", {})
  expect(st.workspaces).toBe(4) // a/main, a/b--c, a--b/main, a--b/c — counted across project dirs
  writeFileSync(join(pb.path, "b2.txt"), "more B\n")
  const cp = await call("checkpoint", { project: "a--b", branch: "c", message: "B work" })
  expect(cp.added).toBe(1)
  expect(cp.deleted).toBe(0) // pre-fix this committed a's files into a--b (added 1, deleted 1)
  const ha = await call("history", { project: "a", branch: "b--c" })
  expect(ha.commits).toHaveLength(1) // a's branch untouched by a--b's checkpoint
})

test("r2 item 2: branches Main and main are distinct, on disk as in the model", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "Main" })
  const lower = await call("provision", { project: "website", branch: "main" })
  const upper = await call("provision", { project: "website", branch: "Main" })
  // %4Dain vs main: distinct files even on a case-insensitive volume —
  // pre-fix they shared branches/main.json and one workspace
  expect(upper.path).not.toBe(lower.path)
  writeFileSync(join(upper.path, "upper.txt"), "upper\n")
  await call("checkpoint", { project: "website", branch: "Main", message: "upper work" })
  const mainHist = await call("history", { project: "website", branch: "main" })
  expect(mainHist.commits).toHaveLength(1) // a checkpoint on Main did not move main's head
  const st = await call("status", {})
  expect(st.projects[0].branches).toEqual(["Main", "main"])
})

test("r2 item 6: exec's stdin is closed — a command that reads it finishes at once", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const t0 = Date.now()
  const r = await call("exec", { project: "website", command: "cat", timeoutMs: 5000 })
  expect(r.timedOut).toBeUndefined()
  expect(r.exitCode).toBe(0)
  expect(Date.now() - t0).toBeLessThan(3000) // pre-fix: an open stdin pipe held it to the full timeout
})

test("r2 item 6: background children cannot hold an exec call open, and a timeout kills the group", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const t0 = Date.now()
  const r = await call("exec", { project: "website", command: "sleep 6 & echo started", timeoutMs: 1000 })
  expect(r.stdout).toContain("started")
  expect(Date.now() - t0).toBeLessThan(4000) // pre-fix: ~6011 ms, waiting for 'close' on the held pipe
  const t1 = Date.now()
  const r2 = await call("exec", { project: "website", command: "sleep 30", timeoutMs: 1000 })
  expect(r2.timedOut).toBe(true)
  expect(Date.now() - t1).toBeLessThan(4000) // the group kill lands; no orphaned sleep outlives the call
})

test("r2 item 7: storedBytes grows by the commit record's size, not just the changed blobs", async () => {
  const { call, home } = await simTools()
  const ws = await call("provision", { project: "website" })
  const before = await call("status", {})
  writeFileSync(join(ws.path, "tiny.txt"), "x") // a 1-byte change on the imported tree
  const cp = await call("checkpoint", { project: "website", message: "tiny" })
  expect(cp.newBytes).toBe(1)
  const after = await call("status", {})
  const recordBytes = statSync(join(home, "projects", "website", "commits", `${cp.commit}.json`)).size
  expect(recordBytes).toBeGreaterThan(0)
  // pre-fix the growth was 1 (the blob alone); the manifest record is counted now
  expect(after.storedBytes - before.storedBytes).toBe(recordBytes + 1)
})

// ---- the native backend against a fake SDK ------------------------------------
// The fake implements the SDK surface the worker calls, so the
// backend's own logic — including the review's binary-deletion repro —
// runs in the plain suite, no binding build needed.
function fakeNative() {
  const root = mkTmp("layerfs-native-")
  const prev = process.env.LAYERFS_SDK_PATH
  process.env.LAYERFS_SDK_PATH = FAKE_SDK
  const b = new NativeBackend(root)
  const restore = () => {
    if (prev === undefined) delete process.env.LAYERFS_SDK_PATH
    else process.env.LAYERFS_SDK_PATH = prev
  }
  return { b, root, restore }
}

test("item 5: the SDK loads in the worker process, never in this one, and the shared env is untouched", async () => {
  const { b, restore } = fakeNative()
  const homeBefore = process.env.LAYERFS_HOME
  const storeBefore = process.env.LAYERFS_STORE_PATH
  try {
    const p = await b.provision("demo", "main", fixture())
    expect(p.backend).toBe("native")
    expect(p.mode).toBe("checkout")
    // the fake SDK's module marker: set in whichever process imported it
    expect(globalThis.__FAKE_SDK_LOADED__).toBeUndefined()
    // the pre-0.7 backend wrote both of these into the shared env
    expect(process.env.LAYERFS_HOME).toBe(homeBefore)
    expect(process.env.LAYERFS_STORE_PATH).toBe(storeBefore)
    const info = await b.workerInfo()
    expect(info.loaded).toBe(true)
  } finally {
    await b.close()
    restore()
  }
})

test("item 3: the native backend refuses a source holding secret-shaped files", async () => {
  const { b, restore } = fakeNative()
  try {
    const src = fixture()
    writeFileSync(join(src, ".env"), "TOKEN=x\n")
    await expect(b.provision("demo", "main", src)).rejects.toThrow("refusing to import")
  } finally {
    await b.close()
    restore()
  }
})

test("item 6: a native checkpoint never deletes the binaries materialize skipped", async () => {
  const { b, restore } = fakeNative()
  try {
    const src = mkTmp("layerfs-src-")
    mkdirSync(join(src, "img"), { recursive: true })
    writeFileSync(join(src, "README.md"), "# demo\n")
    writeFileSync(join(src, "img", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    const p = await b.provision("demo", "main", src)
    expect(p.skippedBinary).toContain("img/logo.png")
    const f = await b.fork("demo", "feat")
    expect(f.skippedBinary).toContain("img/logo.png")
    writeFileSync(join(f.path, "feat.txt"), "feat\n")
    const c = await b.checkpoint("demo", "feat", "add feat.txt")
    expect(c.added).toBe(1)
    expect(c.deleted).toBe(0) // pre-0.7 this checkpoint deleted img/logo.png from the store
    // and the binary is still there: a fresh fork's checkout skips it by name again
    const f2 = await b.fork("demo", "feat2")
    expect(f2.skippedBinary).toContain("img/logo.png")
  } finally {
    await b.close()
    restore()
  }
})

test("item 7: re-provisioning a moved native branch keeps the workspace and reports stale", async () => {
  const { b, restore } = fakeNative()
  try {
    const src = fixture()
    const p = await b.provision("demo", "main", src)
    expect(p.stale).toBe(false)
    writeFileSync(join(p.path, "draft.txt"), "uncommitted work\n")
    const f = await b.fork("demo", "feat")
    writeFileSync(join(f.path, "feat.txt"), "shipped\n")
    await b.checkpoint("demo", "feat", "feat work")
    await b.publish("demo", "feat") // moves main's head past the checkout's binding
    const again = await b.provision("demo", "main", src)
    expect(again.reused).toBe(true)
    expect(again.stale).toBe(true) // the sim backend's shape
    // pre-0.7 this re-provision wiped the directory with rmSync
    expect(readFileSync(join(p.path, "draft.txt"), "utf8")).toBe("uncommitted work\n")
  } finally {
    await b.close()
    restore()
  }
})

test("item 11: native publish refuses when the fork point is unknown, unless forced", async () => {
  process.env.FAKE_SDK_NULL_FORK = "1"
  const { b, restore } = fakeNative()
  try {
    const src = fixture()
    await b.provision("demo", "main", src)
    const f = await b.fork("demo", "feat")
    writeFileSync(join(f.path, "feat.txt"), "x\n")
    await b.checkpoint("demo", "feat", "work")
    // pre-0.7 a null fork point counted as fresh and the publish went ahead
    await expect(b.publish("demo", "feat")).rejects.toThrow("cannot tell whether")
    const forced = await b.publish("demo", "feat", { force: true })
    expect(forced.overwrote).toBe(true)
  } finally {
    delete process.env.FAKE_SDK_NULL_FORK
    await b.close()
    restore()
  }
})

// ---- native backend against the real SDK -------------------------------------
// Opt-in: these run only when MAGPIE_LAYERFS_NATIVE_TEST=1 and
// LAYERFS_SDK_PATH points at a layerfs checkout whose native binding is
// built. The backend root sits on the working disk (its store volume must
// carry SQLite locks), while the imported source is a tmpdir fixture —
// the engine refuses to import a source tree from overlayfs (upstream,
// Project(InvalidInput)), and tmpfs imports fine.
const NATIVE_SDK = process.env.LAYERFS_SDK_PATH // captured before the sim tests scrub the env
const nativeIt = process.env.MAGPIE_LAYERFS_NATIVE_TEST === "1" && NATIVE_SDK
  ? test : test.skip

nativeIt("native: provision imports, fork and checkpoint commit through the real store", async () => {
  process.env.LAYERFS_SDK_PATH = NATIVE_SDK
  const root = mkTmp(".tmp-native-test-", join(process.env.HOME, "workspace"))
  const b = new NativeBackend(root)
  try {
    const src = fixture()
    writeFileSync(join(src, "bin.dat"), Buffer.from([0, 1, 2, 3, 255, 254]))
    const p = await b.provision("demo", "main", src)
    expect(p.backend).toBe("native")
    expect(p.mode).toBe("checkout")
    expect(p.projectCreated).toBe(true)
    // the import captured bin.dat, but the fs surface cannot read binary
    // files back, so the checkout names it instead of dropping it silently
    expect(p.skippedBinary).toContain("bin.dat")
    expect(readFileSync(join(p.path, "README.md"), "utf8")).toBe("hello layerfs\n")

    const f = await b.fork("demo", "feat")
    expect(f.copiedBytes).toBe(0)
    writeFileSync(join(f.path, "feat.txt"), "from the fork\n")
    const c = await b.checkpoint("demo", "feat", "add feat.txt")
    expect(c.changed).toBe(true)
    expect(c.added).toBe(1)
    expect(c.deleted).toBe(0) // the skipped bin.dat is not a deletion (item 6)
    const h = await b.history("demo", "feat")
    expect(h.commits[0].message).toBe("add feat.txt")
    const again = await b.checkpoint("demo", "feat", "nothing changed")
    expect(again.changed).toBe(false)
  } finally {
    await b.close()
  }
}, 60000)

nativeIt("native: publish appends a Layer, and the trajectory replays it", async () => {
  process.env.LAYERFS_SDK_PATH = NATIVE_SDK
  const root = mkTmp(".tmp-native-test-", join(process.env.HOME, "workspace"))
  const b = new NativeBackend(root)
  try {
    await b.provision("site", "main", fixture())
    const f = await b.fork("site", "feat")
    writeFileSync(join(f.path, "feat.txt"), "shipped\n")
    await b.checkpoint("site", "feat", "feat work")
    const pub = await b.publish("site", "feat")
    expect(pub.layer).toBe(1)
    expect(pub.overwrote).toBe(false)
    const repub = await b.publish("site", "feat")
    expect(repub.alreadyPublished).toBe(true)
    const t = await b.trajectory()
    const proj = t.projects.find((x) => x.name === "site")
    expect(proj.branches.map((x) => x.name).sort()).toEqual(["feat", "main"])
    const main = proj.branches.find((x) => x.name === "main")
    expect(main.commits[0].message).toBe("Import") // the import Layer, synthesized
    expect(t.events.filter((e) => e.kind === "publish")).toHaveLength(1)
    const e = await b.exec("site", "feat", "echo via-exec > exec.txt")
    expect(e.exitCode).toBe(0)
    expect(e.changed).toBe(true)
    const st = await b.status()
    expect(st.projects[0].layers).toBe(2) // import + one publish
  } finally {
    await b.close()
  }
}, 60000)

nativeIt("native: exec scratch stays inside the workspace and out of checkpoints", async () => {
  process.env.LAYERFS_SDK_PATH = NATIVE_SDK
  const root = mkTmp(".tmp-native-test-", join(process.env.HOME, "workspace"))
  const b = new NativeBackend(root)
  try {
    const p = await b.provision("scratchy", "main", fixture())
    // provision (through materialize) pre-creates both scratch directories
    expect(existsSync(join(p.path, ".tmp"))).toBe(true)
    expect(existsSync(join(p.path, ".cache"))).toBe(true)
    const e = await b.exec("scratchy", "main",
      'echo "$TMPDIR" && echo probe > "$TMPDIR/probe.txt" && echo probe > "$XDG_CACHE_HOME/probe.txt"')
    expect(e.exitCode).toBe(0)
    expect(e.stdout).toContain(join(p.path, ".tmp"))
    expect(readFileSync(join(p.path, ".tmp", "probe.txt"), "utf8")).toBe("probe\n")
    expect(readFileSync(join(p.path, ".cache", "probe.txt"), "utf8")).toBe("probe\n")
    // a checkpoint after scratch-only writes is still UpToDate
    expect(e.changed).toBe(false)
    expect(e.commit).toBeNull()
    const c = await b.checkpoint("scratchy", "main", "scratch only")
    expect(c.changed).toBe(false)
    expect(c.added).toBe(0)
    expect(c.modified).toBe(0)
    expect(c.deleted).toBe(0)
  } finally {
    await b.close()
  }
}, 60000)
