// Benchmark: the native backend against the real LayerFS engine.
//   MAGPIE_LAYERFS_NATIVE_TEST=1 LAYERFS_SDK_PATH=<sdk/js/src/index.js> \
//     bun bench/bench-native.mjs
//
// Same scenario as bench.mjs (one import, 6 agent forks, 3 checkpoint
// rounds each) but with a text fixture: checkout-mode checkpoints are
// a text workflow because fs.read refuses binary content (code
// Binary, upstream #417) — binaries can be written but never read
// back or diffed. The imported source
// sits on tmpfs because the engine refuses an overlayfs source
// (Project(InvalidInput), reported upstream); the store volume sits on
// the working disk, as it must (ext4/xfs/btrfs only). Writes
// bench/results-native.json.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { NativeBackend } from "../layerfs.mjs"

if (!process.env.LAYERFS_SDK_PATH) {
  console.error("set LAYERFS_SDK_PATH to a layerfs checkout's sdk/js/src/index.js (native binding built)")
  process.exit(2)
}
const here = dirname(fileURLToPath(import.meta.url))
const MB = 1024 * 1024
const mb = (n) => (n / MB).toFixed(1) + " MB"
const ms = (n) => n.toFixed(0) + " ms"

// Deterministic text with mostly-unique lines, like source code: a
// degenerate fixture (one repeated line) would flatter the engine's
// dedup beyond honesty, and random bytes would not be text at all.
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango".split(" ")
function text(seed, bytes) {
  let x = seed >>> 0
  const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x }
  let out = "", i = 0
  while (out.length < bytes) {
    out += `const v${i} = compute(0x${(rnd() >>> 0).toString(16)}, "${WORDS[rnd() % 20]} ${WORDS[rnd() % 20]} ${WORDS[rnd() % 20]}"); // ${seed}:${i}\n`
    i++
  }
  return out.slice(0, bytes)
}

const src = mkdtempSync(join(tmpdir(), "lfs-bench-src-"))
mkdirSync(join(src, "src"), { recursive: true })
mkdirSync(join(src, "docs"), { recursive: true })
for (let i = 0; i < 120; i++) writeFileSync(join(src, "src", `mod-${i}.txt`), text(i + 1, 128 * 1024))
for (let i = 0; i < 64; i++) writeFileSync(join(src, "docs", `doc-${i}.md`), text(5000 + i, 192 * 1024))
let treeSize = 0
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : (treeSize += statSync(p).size) } }
walk(src)

const root = mkdtempSync(join(process.env.HOME, "workspace", ".tmp-native-bench-"))
const b = new NativeBackend(root)
const AGENTS = ["claude", "codex", "opencode", "cursor", "gemini", "pi"], ROUNDS = 3
console.log(`fixture tree: 184 text files, ${mb(treeSize)}`)
console.log(`scenario: import once, ${AGENTS.length} agent forks, ${ROUNDS} checkpoints each`)
console.log("")

let t0 = performance.now()
await b.provision("bench", "main", src)
const importMs = performance.now() - t0

t0 = performance.now()
for (const a of AGENTS) await b.fork("bench", a)
const forkMs = (performance.now() - t0) / AGENTS.length

let checkpointMs = 0
for (const a of AGENTS) {
  const dir = b.workspaceDir("bench", a)
  for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < 8; k++)
      writeFileSync(join(dir, "src", `mod-${(k * 13 + r * 7) % 120}.txt`), text(9000 + k * 31 + r, 128 * 1024))
    const t = performance.now()
    await b.checkpoint("bench", a, `round ${r + 1}`)
    checkpointMs += performance.now() - t
  }
}
checkpointMs /= AGENTS.length * ROUNDS

const storeFile = join(root, "native", "vol", "bench", "global", "store.sqlite")
const storeBytes = existsSync(storeFile) ? statSync(storeFile).size : 0
const st = await b.status()
const logicalTotal = treeSize * (1 + AGENTS.length * ROUNDS) // import + every checkpoint's full tree, logically

console.log(`import (project.init)      ${ms(importMs)}`)
console.log(`fork (branch + checkout)   ${ms(forkMs)} avg`)
console.log(`checkpoint (diff + apply)  ${ms(checkpointMs)} avg`)
console.log(`store file on disk         ${mb(storeBytes)} for ${mb(logicalTotal)} logical (${(logicalTotal / storeBytes).toFixed(1)}x)`)
console.log(`engine commit accounting   logical ${mb(st.logicalBytes)} / stored ${mb(st.storedBytes)} across branch commits`)

const results = { fixture: { files: 184, treeBytes: treeSize, kind: "text" }, importMs, forkMs, checkpointMs, storeBytes, logicalTotal, engine: { logicalBytes: st.logicalBytes, storedBytes: st.storedBytes } }
mkdirSync(join(here, "results"), { recursive: true })
writeFileSync(join(here, "results", "native.json"), JSON.stringify(results, null, 1))
rmSync(root, { recursive: true, force: true })
rmSync(src, { recursive: true, force: true })
console.log("\nwrote bench/results/native.json")
