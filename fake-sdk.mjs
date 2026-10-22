// A minimal fake of @layerfs/sdk for the test suite — the same move
// the review made: drive the native backend's logic without building
// the real binding. It implements exactly the surface the worker
// (native-worker.mjs) calls, with the real SDK's shapes: paginated
// lists, branch info { name, head, base, forkedFrom }, commits newest
// first, fs.read refusing binaries with code Binary, publish
// appending a Layer to main. State is per client instance, in memory;
// the worker holds one client per project, so state persists across
// the calls of one backend.
//
// Test-only: this file is not in package.json's files and never ships.
// FAKE_SDK_NULL_FORK=1 makes fork record a null fork point, to
// exercise the publish guard's unknown-ancestry path.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

globalThis.__FAKE_SDK_LOADED__ = (globalThis.__FAKE_SDK_LOADED__ ?? 0) + 1

const err = (code, message) => Object.assign(new Error(message), { code })
const isTextBuf = (buf) => !buf.includes(0) && Buffer.from(buf.toString("utf8"), "utf8").equals(buf)

function importTree(dir) {
  const files = new Map()
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), r)
      else if (e.isFile()) files.set(r, readFileSync(join(d, e.name)))
    }
  }
  walk(dir, "")
  return files
}

export class LayerFS {
  constructor(project, _opts = {}) {
    this.projectName = project
    this.branches = new Map()
    this.commitSeq = 0
    this.layerSeq = 0
  }

  branchState(name) {
    const b = this.branches.get(name)
    if (!b) throw err("NoSuchBranch", `no branch ${name}`)
    return b
  }

  project = {
    init: async (sourceDir) => {
      if (this.branches.size) throw err("Exists", "project already initialized")
      const layer = `L${this.layerSeq}`
      this.branches.set("main", {
        name: "main", head: layer, base: layer, forkedFrom: null,
        commits: [], files: importTree(sourceDir),
      })
      return { layer }
    },
    list_branches: async (limit, pos) => {
      let items = [...this.branches.values()]
        .map(({ name, head, base, forkedFrom }) => ({ name, head, base, forkedFrom }))
      if (process.env.FAKE_SDK_DROP_MAIN === "1") items = items.filter((b) => b.name !== "main")
      return { items: items.slice(pos, pos + limit), hasMore: pos + limit < items.length, nextPagePos: pos + limit }
    },
  }

  branch = {
    fork: async (name, from) => {
      const src = this.branchState(from)
      this.branches.set(name, {
        name, head: src.head, base: src.base,
        forkedFrom: process.env.FAKE_SDK_NULL_FORK === "1" ? null : src.base,
        commits: [...src.commits], files: new Map(src.files),
      })
    },
    list_commits: async (name, limit, pos) => {
      const b = this.branchState(name)
      return { items: b.commits.slice(pos, pos + limit), hasMore: pos + limit < b.commits.length, nextPagePos: pos + limit }
    },
    publish: async (name, _head) => {
      const src = this.branchState(name)
      const main = this.branchState("main")
      const parent = main.base
      const id = `L${++this.layerSeq}`
      main.base = id
      main.head = src.head
      main.files = new Map(src.files)
      main.commits = [...src.commits]
      return { publishedLayer: { id, parent, overwroteCount: 0 } }
    },
  }

  fs = {
    list: async (branch, path, _limit, _pos) => {
      const b = this.branchState(branch)
      const prefix = path === "/" ? "" : path.slice(1) + "/"
      const seen = new Map()
      for (const rel of b.files.keys()) {
        if (!rel.startsWith(prefix)) continue
        const rest = rel.slice(prefix.length)
        const slash = rest.indexOf("/")
        if (slash >= 0) {
          const d = `${prefix}${rest.slice(0, slash)}`
          if (!seen.has(d)) seen.set(d, { path: `/${d}`, type: "dir" })
        } else {
          seen.set(rel, { path: `/${rel}`, type: "file" })
        }
      }
      return { items: [...seen.values()].sort((x, y) => x.path.localeCompare(y.path)), hasMore: false, nextPagePos: 0 }
    },
    stat: async (branch, path) => {
      const b = this.branchState(branch)
      const rel = path.slice(1)
      if (b.files.has(rel)) return { size: b.files.get(rel).length, type: "file", root: path }
      if (rel === "" || [...b.files.keys()].some((k) => k.startsWith(rel + "/")))
        return { size: 0, type: "dir", root: path }
      throw err("NotFound", `no such path ${path}`)
    },
    read: async (branch, path, _startLine) => {
      const b = this.branchState(branch)
      const buf = b.files.get(path.slice(1))
      if (!buf) throw err("NotFound", `no such file ${path}`)
      if (!isTextBuf(buf)) throw err("Binary", "file is binary")
      return { text: buf.toString("utf8"), nextLine: null }
    },
    apply: async (branch, changes, message) => {
      const b = this.branchState(branch)
      let newStored = 0
      for (const ch of changes) {
        const rel = ch.path.slice(1)
        if (ch.op === "write") {
          const buf = ch.bytes !== undefined ? Buffer.from(ch.bytes) : Buffer.from(ch.content ?? "", "utf8")
          b.files.set(rel, buf)
          newStored += buf.length
        } else if (ch.op === "rm") {
          b.files.delete(rel)
        } // mkdir is implicit in the file map
      }
      let logical = 0
      for (const buf of b.files.values()) logical += buf.length
      const commit = {
        id: `c${++this.commitSeq}`, parent: b.head, message,
        time: Date.now(), logical, newStored, newMetadata: 0,
      }
      b.head = commit.id
      b.commits.unshift(commit)
      return { commit }
    },
  }
}
