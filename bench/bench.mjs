// Benchmark: the filesystem path agents take today (a full copy of the
// tree per agent, a full copy per kept snapshot) against the paths this
// plugin gives them (one import, O(1) forks, deduplicated checkpoints).
//
//   bun bench/bench.mjs
//
// Everything runs on the sim backend, i.e. the plugin's own content-
// addressed store on this machine's disk; the native LayerFS engine
// publishes its own numbers (layerfs.ai/benchmarks). Prints a table and
// writes bench/results.json.
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SimBackend } from "../layerfs.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const work = join(here, "results")
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// deterministic bytes, so runs are comparable
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function fill(seed, bytes) {
  const rnd = mulberry32(seed)
  const buf = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(rnd() * 256)
  return buf
}

const MB = 1024 * 1024
const mb = (n) => (n / MB).toFixed(1) + " MB"
const ms = (n) => n.toFixed(0) + " ms"

function treeBytes(dir) {
  let n = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else n += statSync(p).size
    }
  }
  walk(dir)
  return n
}

// ---- fixture: a project tree of ~27 MB -------------------------------------
const src = join(work, "project")
mkdirSync(join(src, "src"), { recursive: true })
mkdirSync(join(src, "assets"), { recursive: true })
mkdirSync(join(src, "vendor"), { recursive: true })
let seed = 1
for (let i = 0; i < 120; i++) writeFileSync(join(src, "src", `mod-${i}.txt`), fill(seed++, 24 * 1024))
for (let i = 0; i < 16; i++) writeFileSync(join(src, "assets", `asset-${i}.bin`), fill(seed++, MB))
for (let i = 0; i < 32; i++) writeFileSync(join(src, "vendor", `lib-${i}.bin`), fill(seed++, 256 * 1024))
const treeSize = treeBytes(src)

const AGENTS = 6, ROUNDS = 3
console.log(`fixture tree: 184 files, ${mb(treeSize)}`)
console.log(`scenario: ${AGENTS} parallel agents, each keeps ${ROUNDS} checkpoints of its work`)
console.log("")

// ---- the naive path: copy per agent, copy per snapshot ----------------------
const naiveDir = join(work, "naive")
mkdirSync(naiveDir, { recursive: true })
let t0 = performance.now()
for (let a = 0; a < AGENTS; a++) cpSync(src, join(naiveDir, `agent-${a}`), { recursive: true })
const naiveCopyMs = performance.now() - t0
t0 = performance.now()
for (let a = 0; a < AGENTS; a++) {
  for (let r = 0; r < ROUNDS; r++) {
    writeFileSync(join(naiveDir, `agent-${a}`, "src", `mod-${a * 10 + r}.txt`), fill(9000 + a * 10 + r, 24 * 1024))
    cpSync(join(naiveDir, `agent-${a}`), join(naiveDir, `agent-${a}-snap-${r}`), { recursive: true })
  }
}
const naiveSnapMs = performance.now() - t0
const naiveBytes = treeBytes(naiveDir)

// ---- the plugin path ----------------------------------------------------------
const home = join(work, "home")
const b = new SimBackend(home)
t0 = performance.now()
await b.provision("benchproj", "main", src)
const importMs = performance.now() - t0
t0 = performance.now()
for (let a = 1; a < AGENTS; a++) await b.fork("benchproj", `agent-${a}`, "main")
const forkMs = performance.now() - t0
t0 = performance.now()
const paths = []
for (let a = 0; a < AGENTS; a++) {
  const p = await b.provision("benchproj", a === 0 ? "main" : `agent-${a}`)
  paths.push(p.path)
}
const provMs = performance.now() - t0
t0 = performance.now()
let lastCp
for (let a = 0; a < AGENTS; a++) {
  const branch = a === 0 ? "main" : `agent-${a}`
  for (let r = 0; r < ROUNDS; r++) {
    writeFileSync(join(paths[a], "src", `mod-${a * 10 + r}.txt`), fill(9000 + a * 10 + r, 24 * 1024))
    lastCp = await b.checkpoint("benchproj", branch, `agent ${a} round ${r}`)
  }
}
const cpMs = performance.now() - t0
const st = await b.status()
const storeBytes = st.storedBytes
const logicalBytes = st.logicalBytes
const wsBytes = treeBytes(join(home, "workspaces"))

t0 = performance.now()
for (let i = 0; i < 1000; i++) await b.resolve("benchproj", "agent-3", "src/mod-33.txt")
const resolveUs = ((performance.now() - t0) / 1000) * 1000

// ---- report ---------------------------------------------------------------------
const rows = [
  ["give 6 agents a working tree", `${ms(naiveCopyMs)} / ${mb(AGENTS * treeSize)} copied`, `${ms(importMs + forkMs + provMs)} (1 import + 5 forks + 6 provisions)`],
  ["fork one more agent's branch", `${ms(naiveCopyMs / AGENTS)} / ${mb(treeSize)} per copy`, `~${(forkMs / (AGENTS - 1)).toFixed(2)} ms / 0 bytes copied`],
  ["keep 18 checkpoints of history", `${ms(naiveSnapMs)} / ${mb(naiveBytes - AGENTS * treeSize)} of snapshots`, `${ms(cpMs)} / store holds ${mb(storeBytes)} for ${mb(logicalBytes)} of checkpoints`],
  ["resolve src/mod-33.txt on agent-3", "walk the copy's tree to find it", `${resolveUs.toFixed(0)} µs -> ${join(paths[3], "src", "mod-33.txt")}`],
]
console.log("paths the agents worked in:")
for (let a = 0; a < AGENTS; a++) console.log(`  agent-${a}: ${paths[a]}`)
console.log("")
for (const [what, naive, plugin] of rows) {
  console.log(what)
  console.log(`  naive : ${naive}`)
  console.log(`  plugin: ${plugin}`)
}
console.log("")
console.log(`TOTAL disk: naive ${mb(naiveBytes)}  vs  plugin ${mb(storeBytes + wsBytes)} (store ${mb(storeBytes)} + live workspaces ${mb(wsBytes)})`)
console.log(`history cost: naive keeps ${AGENTS * ROUNDS} full snapshots; the store keeps every checkpoint of every branch in ${mb(storeBytes)} — dedup ratio ${st.dedupRatio}x over ${mb(logicalBytes)} of logical checkpoints`)
console.log(`sample checkpoint accounting: ${JSON.stringify({ added: lastCp.added, modified: lastCp.modified, newBytes: lastCp.newBytes, logicalBytes: lastCp.logicalBytes })}`)

const results = {
  fixture: { files: 184, treeBytes: treeSize },
  agents: AGENTS, rounds: ROUNDS,
  naive: { copyMs: naiveCopyMs, snapshotMs: naiveSnapMs, totalBytes: naiveBytes },
  plugin: { importMs, forkMs, provisionMs: provMs, checkpointMs: cpMs, storeBytes, logicalBytes, workspaceBytes: wsBytes, dedupRatio: st.dedupRatio, resolveUs },
  paths,
  when: new Date().toISOString(),
}
writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 1))
console.log("\nwrote bench/results.json")
