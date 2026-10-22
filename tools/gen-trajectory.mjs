// Produce the page's bundled sample trajectory.js: drive the plugin's
// own sim backend through the benchmark scenario (one project, six
// agents, three checkpoints each) in a throwaway store, and write the
// recorded trajectory next to the page. The bundled file is a static
// sample — nothing rewrites it at runtime. The tools build the same
// shape on demand (backend.trajectory()); no per-call recording is
// kept in the store (that refresh was removed in 0.7.1 — it cost a
// branch-chain walk per tool call for a file the page cannot read).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SimBackend } from "../layerfs.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(join(tmpdir(), "lfs-sample-"))
try {
  const src = join(work, "src")
  mkdirSync(join(src, "app"), { recursive: true })
  for (let i = 0; i < 24; i++) {
    const mod = `mod-${String(i).padStart(2, "0")}`
    writeFileSync(join(src, "app", `${mod}.txt`),
      Array.from({ length: 300 }, (_, l) => `${mod} line ${l} the quick brown fox`).join("\n"))
  }
  writeFileSync(join(src, "README.md"), "# demo project\n")

  const home = join(work, "store")
  const b = new SimBackend(home)
  await b.provision("demo", "main", src) // the import checkpoint
  // one branch per agent magpie drives, so the page shows each agent's
  // own colour and monogram, the way magpie's rows do
  for (const branch of ["claude", "codex", "opencode", "cursor", "gemini", "pi"]) {
    await b.fork("demo", branch, "main")
    const ws = await b.provision("demo", branch)
    for (let round = 1; round <= 3; round++) {
      for (let k = 0; k < 4; k++) {
        const mod = `mod-${String((branch.length * 7 + round * 4 + k) % 24).padStart(2, "0")}`
        writeFileSync(join(ws.path, "app", `${mod}.txt`),
          `${mod} edited by ${branch}, round ${round}\n` + "x".repeat(4000 * round))
      }
      if (round === 2) writeFileSync(join(ws.path, "app", `${branch}-notes.md`), `# ${branch} notes\n`)
      await b.checkpoint("demo", branch, `${branch}: round ${round} edits`)
    }
  }
  // land two publishes so main carries Layer bands, as a real run would:
  // codex's work becomes L1, then a release branch off the new main
  // adds two checkpoints and becomes L2
  await b.publish("demo", "codex")
  await b.fork("demo", "release", "main")
  const rel = await b.provision("demo", "release")
  for (let round = 1; round <= 2; round++) {
    writeFileSync(join(rel.path, "app", `release-notes-${round}.md`), `# release round ${round}\n`)
    await b.checkpoint("demo", "release", `release: round ${round}`)
  }
  await b.publish("demo", "release")

  const data = await b.trajectory()
  data.sample = true
  const out = join(here, "..", "page", "trajectory.js")
  writeFileSync(out, `globalThis.LayerfsTrajectory = ${JSON.stringify(data)};\n`)
  console.log(`wrote ${out}: ${data.projects[0].branches.length} branches, ` +
    `${data.projects[0].branches.reduce((n, x) => n + x.commits.length, 0)} commits, ` +
    `totals ${JSON.stringify(data.totals)}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
