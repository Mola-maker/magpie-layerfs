// The page's data directory, and the swap that points an installed page
// at it (the registry review #365, item 2: nothing writes into the
// installed plugin's own folder). This lives beside index.mjs rather than
// in it because the plugin host takes every function the entry module
// exports for an OpenCode plugin factory (host.js servers()) and calls it
// with the host's context at load — an exported helper would be called as
// one and fail. index.mjs imports these; the host never scans this file.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { storeHome } from "./layerfs.mjs"

// The page loads this after the bundled sample and prefers it.
export const LIVE = "trajectory-live.js"

// The data folder: MAGPIE_LAYERFS_DATA_DIR moves it; the default sits
// beside the store, under ~/.magpie-layerfs.
export const dataDir = () =>
  process.env.MAGPIE_LAYERFS_DATA_DIR || join(storeHome(), "page-data")

// One host lays the swap while others may hold the folder: the holder of
// a lock file laid within the last 10s is laying it too, so we skip.
const ensureLockFresh = (p) => {
  try { return Date.now() - lstatSync(p).mtimeMs < 10_000 } catch { return false }
}

// The page's folder is the installed package's page/; the live data lives
// OUT of it, in the plugin's data directory (an update replaces the
// installed folder, two hosts with one install race on the same file, and
// an install can be read-only). ensurePageData copies the bundled page
// files into the data folder once, then points the installed page/ at it
// — a junction on Windows, a symlink elsewhere — so the host's
// per-request disk serving reads through it and the tools' live writes
// land in the data directory. Idempotent: the second call sees the link
// and leaves it. Every step is safe to fail: the page falls back to the
// bundled sample and the tools are untouched.
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
