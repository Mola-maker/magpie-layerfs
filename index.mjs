// LayerFS for every agent magpie connects: instead of each agent copying a
// project tree to work on it, agents share one durable, deduplicated history
// and work through stable workspace paths. Forking a branch for a parallel
// agent copies no file bytes; a checkpoint stores only what changed.
// Arguments are JSON Schema, so the package needs no dependency.
//
// The page's data channel: magpie serves a plugin page's files from the
// plugin's folder as they sit on disk, so after the calls that change the
// store the tools rewrite page/trajectory-live.js from backend.trajectory()
// — the page's real commits, branches, storage and dedup accounting, with
// the real calling agent on each. See the README's page section.
//
// Backends: the real LayerFS through its JavaScript SDK — off by
// default, on only when the user opts in (the plugin's "native"
// option, or MAGPIE_LAYERFS_NATIVE=1) with LAYERFS_SDK_PATH set, and
// always behind a child process — otherwise a local content-addressed
// store with the same model. See layerfs.mjs and the README.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkBranch, checkInnerPath, checkProject, checkSourceDir, createBackend } from "./layerfs.mjs"

const str = (v, name) => {
  if (typeof v !== "string" || !v) throw new Error(`${name} is a non-empty string`)
  return v
}
const opt = (v, name, dflt) => (v === undefined || v === "" ? dflt : str(v, name))

// The calling agent, as the gateway knows it (the tool host's ctx.agent):
// the one field of a tool call that says WHO made it. Trimmed and capped,
// then recorded on the events and commits the call creates — the page
// attributes the work to the agent that actually made it, not to a token
// guessed from the branch name.
const callingAgent = (ctx) => {
  const a = ctx?.agent
  return typeof a === "string" && a.trim() ? a.trim().slice(0, 40) : ""
}

// ---- the page's live trajectory ------------------------------------------
// magpie serves a page's files from the plugin's folder per request, as they
// sit on disk, so a file the tools keep current IS a data channel: after the
// calls that change the store, backend.trajectory() is rebuilt and written
// to page/trajectory-live.js — tmp-then-renamed, so the page never loads a
// half-written file. The page loads it after the bundled sample and prefers
// it; an empty store writes an empty live file, and the page shows its
// honest empty state instead of the demo. The write is debounced and off
// the calls' critical path, errors swallowed — the page keeps its last
// file, the tool calls are untouched. MAGPIE_LAYERFS_PAGE_DIR moves the
// folder (the tests point it at a scratch dir).
const LIVE = "trajectory-live.js"
const LIVE_DEBOUNCE_MS = 1200

// The page's folder is the installed package's page/; the live data lives
// OUT of it, in the plugin's data directory (the registry review #365,
// item 2: nothing writes into the installed plugin's own folder — an
// update replaces that folder, two hosts with one install race on the
// same file, and an install can be read-only). ensurePageData copies the
// bundled page files into the data folder once, then points the installed
// page/ at it — a junction on Windows, a symlink elsewhere — so the
// host's per-request disk serving reads through it and the tools' live
// writes land in the data directory. Idempotent: the second call sees the
// link and leaves it. Every step is safe to fail: the page falls back to
// the bundled sample and the tools are untouched. MAGPIE_LAYERFS_PAGE_DIR
// keeps the tests' handle on the folder actually served;
// MAGPIE_LAYERFS_DATA_DIR moves the data folder (the default sits beside
// the store, under ~/.magpie-layerfs).
const dataDir = () =>
  process.env.MAGPIE_LAYERFS_DATA_DIR || join(homedir(), ".magpie-layerfs", "page-data")

// One host lays the swap while others may hold the folder: the holder of
// a lock file laid within the last 10s is laying it too, so we skip.
const ensureLockFresh = (p) => {
  try { return Date.now() - lstatSync(p).mtimeMs < 10_000 } catch { return false }
}

export async function ensurePageData(installDir, { swap = true } = {}) {
  const install = installDir ? join(installDir, "page") : null
  const data = dataDir()
  const here = dirname(fileURLToPath(import.meta.url))
  // The served folder already points at our data dir: done (idempotent).
  // realpathSync, not readlinkSync: junctions answer with their target
  // verbatim, and a drive letter's case or a trailing separator would
  // read as a mismatch and send the seed step into copying the data
  // folder onto itself.
  const isLink = (p) => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
  const pointsAt = (p, target) => {
    try { return realpathSync(p) === realpathSync(target) } catch { return false }
  }
  if (install && isLink(install)) {
    if (pointsAt(install, data)) return data
    // A junction at an old data dir (DATA_DIR moved): re-point it.
    try {
      rmSync(install, { force: true })
      symlinkSync(data, install, "junction")
      return data
    } catch { /* fall through: reseed and retry the swap below */ }
  }
  // Another host's lock: it may be mid-swap; serve the install's own page.
  if (ensureLockFresh(join(data, ".ensure-lock"))) return install ?? data
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, ".ensure-lock"), String(Date.now()))
  try {
    // Asides a killed host left behind: the page that was mid-swap is
    // back in the install (its rename is the first step) or gone with
    // the aside, in which case the seed below re-copies it from the
    // module's own page/.
    if (install) {
      try {
        for (const a of readdirSync(dirname(install)))
          if (a.startsWith(".page-aside-")) rmSync(join(dirname(install), a), { recursive: true, force: true })
      } catch { /* the install's parent may be gone (a fresh install unpacking) */ }
    }
    // Seed the data copy from the freshest bundled files: the install's
    // page/ when it is still a real folder, else this module's own. A
    // source that resolves into the data folder itself (the served page
    // is the link already) is skipped: copying the folder onto itself
    // would truncate the files it reads.
    const seedFrom = install && !isLink(install) && existsSync(install) ? install
      : existsSync(join(here, "page")) && !pointsAt(join(here, "page"), data) ? join(here, "page")
      : null
    if (seedFrom) {
      for (const f of readdirSync(seedFrom)) {
        if (f === LIVE) continue // a previous live file is superseded by the data copy's
        if (install && pointsAt(join(dirname(install), f), join(data, f))) continue
        cpSync(join(seedFrom, f), join(data, f), { recursive: true, force: true })
      }
    }
    if (!swap || !install) return data
    // Swap the install's page/ for the link — or, when the install is
    // read-only or the link fails, leave the bundled page in place: the
    // page falls back to the sample, the tools are untouched.
    if (isLink(install)) return data
    const aside = mkdtempSync(join(dirname(install), ".page-aside-"))
    const putBack = () => { try { renameSync(join(aside, "page"), install) } catch { /* both gone: the data copy is still seeded */ } }
    try {
      try {
        renameSync(install, join(aside, "page"))
        symlinkSync(data, install, "junction")
        rmSync(aside, { recursive: true, force: true })
      } catch {
        // no junction support (or the rename failed): put the bundled page back
        if (!existsSync(install)) putBack()
        rmSync(aside, { recursive: true, force: true })
        return install
      }
    } catch {
      putBack()
      try { rmSync(aside, { recursive: true, force: true }) } catch { /* the aside may be gone already */ }
      return install
    }
    return data
  } finally {
    try { rmSync(join(data, ".ensure-lock"), { force: true }) } catch { /* best effort */ }
  }
}
// The folder the live write lands in: the folder the host actually
// serves the page from. An install serves the page through the link the
// swap laid, so its live write lands in the data directory. A bare
// development checkout — never swapped, no install wired — serves its
// own page/, so the write lands there. MAGPIE_LAYERFS_PAGE_DIR keeps
// the tests' handle on the folder actually served and wins over both.
const here0 = dirname(fileURLToPath(import.meta.url))
const isCheckout = existsSync(join(here0, ".git"))
const pageDir = () =>
  process.env.MAGPIE_LAYERFS_PAGE_DIR
  || (isCheckout && !process.env.MAGPIE_LAYERFS_INSTALL_DIR ? join(here0, "page") : dataDir())

export const LayerfsTools = async (ctx = {}, options = {}) => {
  let backendPromise
  const backend = () => (backendPromise ??= createBackend(process.env, options))
  const execEnabled = () => options?.exec === true || process.env.MAGPIE_LAYERFS_EXEC === "1"
  // Lay the page's data-channel swap once per host start: idempotent,
  // off the tool calls' path, every failure keeps the bundled sample.
  // The install is this package's own folder as the host has it — the
  // module's own directory — but never a development checkout: one
  // carries a .git (magpie's installs never do), so a checkout is only
  // seeded, never swapped. MAGPIE_LAYERFS_INSTALL_DIR overrides the
  // install for the tests.
  const here = here0
  const installDir = process.env.MAGPIE_LAYERFS_INSTALL_DIR || (existsSync(join(here, ".git")) ? null : here)
  if (installDir) ensurePageData(installDir).catch(() => { /* the page falls back to the sample */ })
  else if (process.env.MAGPIE_LAYERFS_PAGE_DIR === undefined)
    ensurePageData(null, { swap: false }).catch(() => { /* seed only */ })
  // A call touches only the state its own operation needs. Reads (history,
  // resolve, status) change nothing and refresh nothing.
  const call = async (fn) => {
    const b = await backend()
    return fn(b)
  }
  // The live trajectory, per plugin instance: a trailing debounce coalesces
  // a burst of parallel agents' calls into one rebuild-and-write. The file
  // persists in the page folder, so it is already current when magpie (and
  // the host) restarts — there is deliberately no refresh at plugin start:
  // it would create the store (or touch the page folder) from a bare
  // `LayerfsTools({})`, and nothing has changed that the last write missed.
  let liveTimer = null, liveInFlight = false, livePending = false
  const writeLive = async (b, dir = pageDir()) => {
    const data = await b.trajectory()
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `${LIVE}.tmp`)
    writeFileSync(tmp, `globalThis.LayerfsTrajectory = ${JSON.stringify(data)};\n`)
    renameSync(tmp, join(dir, LIVE))
  }
  const scheduleLive = (b) => {
    // The dir is read at schedule time, not fire time: the env can
    // change under the timer (a test suite's per-test env), and the
    // write belongs to the store the call landed in.
    const dir = pageDir()
    livePending = true
    if (liveTimer || liveInFlight) return
    liveTimer = setTimeout(() => {
      liveTimer = null
      liveInFlight = true
      writeLive(b, dir)
        .catch(() => { /* the page keeps its last file; the tools are untouched */ })
        .finally(() => {
          liveInFlight = false
          if (livePending) { livePending = false; scheduleLive(b) }
        })
    }, LIVE_DEBOUNCE_MS)
  }
  // A mutating call refreshes the page's live trajectory after it lands.
  const mutate = async (fn) => {
    const b = await backend()
    const out = await fn(b)
    try { scheduleLive(b) } catch { /* never on the tool call's path */ }
    return out
  }

  return {
    tool: {
      provision: {
        description:
          "Gives the agent a LayerFS workspace for a project branch and answers the filesystem path to work in. " +
          "The first provision of a project imports the source directory the caller passes — source is required, there is no default — as its first checkpoint; " +
          "later provisions of the same branch answer the same path without copying the tree again (source is then ignored). " +
          "Pass the directory the user chose for this project: magpie's config directory, credential stores (.ssh, .aws, .gnupg), the home directory and the plugin's own store are refused as sources, " +
          "and secret-shaped files in the tree (.env*, private keys, .git internals) never enter the store — the sim backend skips them on import and reports how many, the native backend refuses an import that holds them. " +
          "Work in the returned path, then save progress with the checkpoint tool. " +
          "Only the returned path is persistent — work anywhere else, including the host's /tmp, is outside LayerFS management; " +
          "the workspace also carries .tmp/ and .cache/ scratch directories (exec points TMPDIR and XDG_CACHE_HOME at them), which checkpoint and publish never capture.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name, e.g. website" },
            branch: { type: "string", description: "branch to work on (default main)" },
            source: { type: "string", description: "the directory the user chose for this project; imported when the project is first created, ignored afterwards" },
          },
          required: ["project", "source"],
        },
        async execute(args, callCtx) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          // ctx.directory is magpie's config directory, never a default
          // source: it holds plugin credentials. It is refused as a
          // source here (and in the backend) like the other blocked roots.
          if (args.source === undefined) throw new Error(
            "source is required: the directory to import when the project is first created — pass the directory the user chose for this project")
          const source = checkSourceDir(str(args.source, "source"), { configDir: ctx.directory })
          return mutate((b) => b.provision(project, branch, source, callingAgent(callCtx)))
        },
      },
      checkpoint: {
        description:
          "Saves the workspace's current state as a deduplicated checkpoint on its branch: only blobs the store has not seen are written. " +
          "The real cost model: the changed blobs, plus one commit record per checkpoint holding the tree's full manifest — " +
          "for a wide tree the manifests are a real part of the store's bytes, and the storage accounting counts them. " +
          "Answers the commit id and the added / modified / deleted counts with the new-bytes and saved-bytes accounting.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch the workspace belongs to (default main)" },
            message: { type: "string", description: "what this checkpoint did" },
          },
          required: ["project"],
        },
        async execute(args, callCtx) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          return mutate((b) => b.checkpoint(project, branch, opt(args.message, "message", ""), callingAgent(callCtx)))
        },
      },
      fork: {
        description:
          "Forks a branch of a project for a parallel agent. A fork is a pointer at an existing checkpoint: it copies no file bytes and is ready immediately, " +
          "where copying the tree for another agent costs the whole tree's size and time. Provision the new branch to get its workspace path.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "the new branch's name" },
            from: { type: "string", description: "branch to fork from (default main)" },
          },
          required: ["project", "branch"],
        },
        async execute(args, callCtx) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(str(args.branch, "branch"))
          const from = checkBranch(opt(args.from, "from", "main"))
          return mutate((b) => b.fork(project, branch, from, callingAgent(callCtx)))
        },
      },
      publish: {
        description:
          "Publishes a branch's head as main's new state (a Layer), so the work every agent did on that branch becomes what new work forks from. " +
          "Guarded: main's current head must be in the branch's history, so a publish can only move main forward; if main has newer checkpoints the branch never saw, " +
          "the publish is refused and says so. Pass force: true only to overwrite deliberately; the result then reports overwrote and the previous main head.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch to publish to main" },
            force: { type: "boolean", description: "overwrite main even if it has checkpoints the branch never saw (default false)" },
          },
          required: ["project", "branch"],
        },
        async execute(args, callCtx) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(str(args.branch, "branch"))
          return mutate((b) => b.publish(project, branch, { force: args.force === true, agent: callingAgent(callCtx) }))
        },
      },
      exec: {
        description:
          "Runs a shell command inside a branch's provisioned workspace and checkpoints whatever it changed as one commit: run, test, fix, all captured in the branch's history. " +
          "DISABLED by default: the command runs with the plugin host's privileges, and magpie serves these tools to remote callers holding a gateway key, so a shell is not something a model key should silently become. " +
          "It runs only when the user has opted in — the plugin's \"exec\" option set to true, or MAGPIE_LAYERFS_EXEC=1 in the host's environment. " +
          "A command that changes nothing commits nothing. A failing command's changes are still checkpointed (history can be rewound), and its exit code, stdout and stderr are returned. " +
          "Only the workspace path is persistent: the command runs with TMPDIR and XDG_CACHE_HOME redirected into the workspace (.tmp/ and .cache/), " +
          "workspace-local scratch that checkpoint and publish never capture, and files written to the host's real /tmp are likewise outside LayerFS management. " +
          "The timeout is capped at 55 seconds, the tools budget.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch whose workspace to run in (default main)" },
            command: { type: "string", description: "the shell command to run in the workspace" },
            message: { type: "string", description: "checkpoint message (default: the command itself)" },
            timeoutMs: { type: "number", description: "timeout in milliseconds (default 50000, capped at 55000)" },
          },
          required: ["project", "command"],
        },
        async execute(args, callCtx) {
          if (!execEnabled()) throw new Error(
            "layerfs_exec is disabled by default: it runs shell commands with the plugin host's privileges, and these tools are reachable by any caller holding a gateway key. " +
            "To enable it, the user sets the plugin's \"exec\" option to true in magpie's plugin options, or sets MAGPIE_LAYERFS_EXEC=1 in the plugin host's environment, and restarts the host.")
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          const command = str(args.command, "command")
          const message = args.message === undefined ? "" : str(args.message, "message")
          const timeoutMs = args.timeoutMs === undefined ? 50000 : Number(args.timeoutMs) || 50000
          return mutate((b) => b.exec(project, branch, command, message, timeoutMs, callingAgent(callCtx)))
        },
      },
      history: {
        description:
          "Lists a branch's checkpoints, newest first: commit id, message, time, file count and the logical size of the tree at that point, " +
          "plus how many new bytes that checkpoint actually stored. The history is shared and durable: any agent can read what every other agent committed.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch to read (default main)" },
            limit: { type: "number", description: "how many checkpoints to return (default 20)" },
          },
          required: ["project"],
        },
        async execute(args) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(200, Number(args.limit) || 20))
          return call((b) => b.history(project, branch, limit))
        },
      },
      resolve: {
        description:
          "Resolves a logical LayerFS location to a real filesystem path without copying anything: the workspace path for a project branch, " +
          "or one file inside it, with the checkpoint that path currently answers for and, for a file, its content hash and size. " +
          "Use it to find where a branch lives before reading or handing the path to another tool.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch to resolve (default main)" },
            path: { type: "string", description: "a file path inside the workspace, relative to its root" },
          },
          required: ["project"],
        },
        async execute(args) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          const inner = args.path === undefined || args.path === "" ? "" : checkInnerPath(str(args.path, "path"))
          return call((b) => b.resolve(project, branch, inner))
        },
      },
      status: {
        description:
          "Reports the LayerFS backend in use (native or sim), the projects and branches it holds, and the storage accounting: " +
          "the logical bytes of every checkpoint ever taken against the bytes the deduplicated store actually occupies, and the ratio between them.",
        args: { type: "object", properties: {} },
        async execute() {
          return call((b) => b.status())
        },
      },
    },
  }
}
