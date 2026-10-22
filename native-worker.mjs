// The native backend's SDK worker: a small child process spawned by
// NativeBackend (layerfs.mjs). It is the ONLY part of this package
// that imports the LayerFS SDK. The plugin host process — magpie's
// single shared plugin host, which holds every plugin's credentials —
// never imports the SDK (an import there would run arbitrary code
// with the host's rights) and never has LAYERFS_HOME /
// LAYERFS_STORE_PATH written into its shared environment; this
// process gets its own copies, from the LAYERFS_WORKER_* variables
// the backend passes at spawn.
//
// The SDK itself is not an npm dependency this package can pin: it
// ships in the LayerFS repo (Ephemeral-AI-Lab/layerfs, sdk/js) with a
// native binding the user builds. LAYERFS_SDK_PATH names its entry,
// and the backend only spawns this worker after the user has opted
// in to the native backend.
//
// Protocol: JSON lines over stdio. A request is { id, op, project,
// ... }; the answer is { id, ok: true, result } or { id, ok: false,
// error: { message, code } }. SDK errors cross with their code, so
// the backend can still tell Binary / NoSuchBranch / Exists apart.
import { chmodSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// The SDK reads both variables when a client is constructed; they are
// set here, in this process only, before any client exists.
process.env.LAYERFS_HOME = process.env.LAYERFS_WORKER_HOME
process.env.LAYERFS_STORE_PATH = process.env.LAYERFS_WORKER_STORE
const volDir = process.env.LAYERFS_WORKER_VOL

let sdkPromise = null
function sdk() {
  const entry = process.env.LAYERFS_SDK_PATH
  if (!entry) {
    const e = new Error(
      "native backend needs LAYERFS_SDK_PATH pointing at a layerfs checkout's sdk/js/src/index.js " +
      "(the @layerfs/sdk package is not on npm; it ships with Ephemeral-AI-Lab/layerfs), " +
      "with its native binding built (sdk/js/native/layerfs.node; see the layerfs repo's build-native script)")
    e.code = "NoSdkPath"
    throw e
  }
  sdkPromise ??= import(pathToFileURL(resolve(entry)).href)
  return sdkPromise
}

// One client per project, as the binding expects: one process holds
// one open store per project name, and a client captures LAYERFS_HOME
// and its storePath at construction.
const clients = new Map()
async function client(project) {
  if (!clients.has(project)) {
    const { LayerFS } = await sdk()
    const storePath = join(volDir, project, "global", "store.sqlite")
    mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 })
    chmodSync(join(volDir, project), 0o700)
    chmodSync(dirname(storePath), 0o700)
    clients.set(project, new LayerFS(project, { storePath }))
  }
  return clients.get(project)
}

// -- paginated SDK reads (the walk runs here; only results cross over)

async function branchMap(lfs) {
  const out = []
  let pos = 0
  for (;;) {
    const r = await lfs.project.list_branches(200, pos)
    for (const b of r.items) out.push([b.name, b])
    if (!r.hasMore) return out
    pos = r.nextPagePos
  }
}

async function commits(lfs, branch, limit) {
  const out = []
  let pos = 0
  for (;;) {
    const r = await lfs.branch.list_commits(branch, 200, pos)
    out.push(...r.items)
    if (!r.hasMore || out.length >= limit) return out.slice(0, limit)
    pos = r.nextPagePos
  }
}

async function listAll(lfs, branch, path) {
  const items = []
  let pos = 0
  for (;;) {
    const r = await lfs.fs.list(branch, path, 200, pos)
    items.push(...r.items)
    if (!r.hasMore) return items
    pos = r.nextPagePos
  }
}

// The branch's tree: [[ "/rel/path", { type, size? } ]].
async function tree(lfs, branch) {
  const out = []
  const walk = async (dir) => {
    for (const item of await listAll(lfs, branch, dir)) {
      if (item.type === "dir") { out.push([item.path, { type: "dir" }]); await walk(item.path) }
      else {
        const st = await lfs.fs.stat(branch, item.path)
        out.push([item.path, { type: item.type, size: st.size }])
      }
    }
  }
  await walk("/")
  return out
}

// Full text of a store file, following the line pagination; null when
// the file is binary (the fs surface refuses those with code Binary).
async function readText(lfs, branch, path) {
  try {
    let out = "", start = 1
    for (;;) {
      const r = await lfs.fs.read(branch, path, start)
      out += r.text
      if (r.nextLine == null) return out
      start = r.nextLine
    }
  } catch (e) {
    if (e?.code === "Binary") return null
    throw e
  }
}

const ops = {
  // Load the SDK and report that it loaded: how the backend surfaces
  // configuration errors without importing anything itself.
  sdkInfo: async () => {
    const m = await sdk()
    return { loaded: true, exports: Object.keys(m).sort() }
  },
  branchMap: async ({ project }) => branchMap(await client(project)),
  commits: async ({ project, branch, limit }) => commits(await client(project), branch, limit ?? 1000),
  tree: async ({ project, branch }) => tree(await client(project), branch),
  readText: async ({ project, branch, path }) => ({ text: await readText(await client(project), branch, path) }),
  stat: async ({ project, branch, path }) => {
    const st = await (await client(project)).fs.stat(branch, path)
    return { size: st.size, type: st.type, root: st.root }
  },
  init: async ({ project, sourceDir }) => {
    const r = await (await client(project)).project.init(sourceDir)
    return { layer: r.layer }
  },
  fork: async ({ project, branch, from }) => {
    await (await client(project)).branch.fork(branch, from)
    return {}
  },
  publish: async ({ project, branch, head }) => {
    const r = await (await client(project)).branch.publish(branch, head)
    return { publishedLayer: r.publishedLayer ?? null }
  },
  apply: async ({ project, branch, changes, message }) => {
    const r = await (await client(project)).fs.apply(branch, changes, message)
    return { commit: r.commit }
  },
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let req
    try { req = JSON.parse(line) } catch { continue }
    const answer = (msg) => process.stdout.write(JSON.stringify({ id: req.id, ...msg }) + "\n")
    const op = ops[req.op]
    if (!op) { answer({ ok: false, error: { message: `unknown op ${JSON.stringify(req.op)}` } }); continue }
    op(req).then(
      (result) => answer({ ok: true, result }),
      (e) => answer({ ok: false, error: { message: String(e?.message ?? e), ...(e?.code ? { code: e.code } : {}) } }),
    )
  }
})
process.stdin.on("end", () => process.exit(0))
