import { expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const dir = import.meta.dir
const page = join(dir, "page")
const read = (f) => readFileSync(join(page, f), "utf8")
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))

// view.js is a classic script, as the page loads it
const scope = {}
new Function("globalThis", read("view.js"))(scope)
const V = scope.LayerfsView

test("the package declares the page magpie shows", () => {
  const p = pkg.magpie.page
  expect(p.title).toBe("LayerFS trajectory")
  expect(p.titles.zh).toBe("LayerFS 轨迹")
  expect(p.file).toBe("page/index.html")
  expect(p.icon).toBe("page/icon.svg")
  expect(pkg.files).toContain("page")
  for (const f of ["index.html", "app.js", "view.js", "style.css", "icon.svg"])
    expect(existsSync(join(page, f))).toBe(true)
  const html = read("index.html")
  expect(html).toContain("_magpie/bridge.js") // the host serves the bridge beside every page
  expect(html).toContain('src="trajectory.js"')
  expect(html).toContain('src="trajectory-live.js"') // the tools keep the live trajectory beside the sample
  // the page sandbox forbids inline scripts and any fetch; the only
  // data script is the bundled sample trajectory shipped with the page
  expect(html).not.toMatch(/<script>(?!\s*src)/)
})

test("item 13: the page reads only what package.json declares — nothing — and reaches no network", () => {
  // the ecosystem's convention, as the usage page's test states it: the
  // set of magpie.read names in the page's scripts equals the declared
  // permissions, and no script has a way out of the frame. This page
  // declares no permissions: its data is the bundled sample, because
  // the bridge's reads are a fixed host list with no plugin-private
  // entry (see the README's page section).
  expect(pkg.magpie.permissions).toBeUndefined()
  const reads = new Set()
  for (const f of readdirSync(page).filter((f) => f.endsWith(".js"))) {
    const src = read(f)
    for (const m of src.matchAll(/magpie\.read\(\s*"([^"]+)"/g)) reads.add(m[1])
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/)
  }
  expect([...reads]).toEqual([])
})

test("item 14: every locale the package declares page titles for has a full string table", () => {
  const keys = Object.keys(V.TEXT.en).sort()
  expect(Object.keys(pkg.magpie.page.titles).sort()).toEqual(["ja", "zh", "zh-TW"])
  for (const table of [V.TEXT.ja, V.TEXT["zh-TW"], V.TEXT.zh])
    expect(Object.keys(table).sort()).toEqual(keys)
  expect(V.text("ja")).toBe(V.TEXT.ja)
  expect(V.text("ja-JP")).toBe(V.TEXT.ja)
  expect(V.text("ja").title).toBe(pkg.magpie.page.titles.ja)
  expect(V.text("zh-TW")).toBe(V.TEXT["zh-TW"])
  expect(V.text("zh-HK")).toBe(V.TEXT["zh-TW"]) // Traditional, like the host's title fallback
  expect(V.text("zh-TW").title).toBe(pkg.magpie.page.titles["zh-TW"])
  expect(V.text("zh-CN")).toBe(V.TEXT.zh)
  expect(V.text("zh").title).toBe(pkg.magpie.page.titles.zh)
  expect(V.text("fr")).toBe(V.TEXT.en)
  expect(V.detail(project.branches[1].commits[1], "ja").delta).toContain("追加")
  expect(V.detail(project.branches[1].commits[1], "zh-TW").delta).toContain("新增")
})

test("item 16: the detail card marks its branch with a dot, and the picker is a menu, not a select", () => {
  const html = read("index.html")
  expect(html).not.toContain("<select")
  expect(html).toContain('id="projBtn"')
  expect(html).toContain('id="projList"')
  expect(html).toContain('id="dDot"')
  expect(read("style.css")).not.toMatch(/border-left:\s*3px/)
  const app = read("app.js")
  expect(app).not.toContain("borderLeftColor")
  expect(app).toContain("dDot")
  expect(app).toContain('style.background = colorOf')
})

const C = (id, parent, time, over = {}) => ({
  id, parent, message: `commit ${id}`, time,
  files: 10, logicalBytes: 1000, newBytes: 100,
  delta: { added: 1, modified: 2, deleted: 0 }, ...over,
})
const project = {
  name: "demo",
  branches: [
    { name: "agent-b", commits: [C("b1", "m2", "2026-01-01T00:03:00.000Z"), C("b2", "b1", "2026-01-01T00:05:00.000Z")] },
    {
      name: "main", commits: [
        C("m1", null, "2026-01-01T00:01:00.000Z", { newBytes: 1000 }),
        C("m2", "m1", "2026-01-01T00:02:00.000Z"),
      ],
    },
    { name: "agent-a", commits: [C("a1", "m1", "2026-01-01T00:04:00.000Z")] },
  ],
}

test("lanes put main first, then branches by first checkpoint", () => {
  const lane = V.lanes(project)
  expect(lane.get("main")).toBe(0)
  expect(lane.get("agent-b")).toBe(1) // first checkpoint 00:03, before agent-a's 00:04
  expect(lane.get("agent-a")).toBe(2)
})

test("steps are time-ordered and accumulate both curves", () => {
  const s = V.steps(project)
  expect(s.map((x) => x.commit.id)).toEqual(["m1", "m2", "b1", "a1", "b2"])
  expect(s[0].cumLogical).toBe(1000)
  expect(s[0].cumStored).toBe(1000) // the import stores everything once
  expect(s[4].cumLogical).toBe(5000) // five checkpoints as copies
  expect(s[4].cumStored).toBe(1400) // but only the changed bytes were new
})

test("layout links each checkpoint to its parent, across lanes on a fork", () => {
  const L = V.layout(project, [])
  expect(L.nodes.length).toBe(5)
  expect(L.laneCount).toBe(3)
  const edge = (id) => L.edges.find((e) => e.to.id === id)
  expect(edge("m2").fork).toBe(false)
  expect(edge("b1").fork).toBe(true) // agent-b forked from main's m2
  expect(edge("b1").from.id).toBe("m2")
  expect(edge("a1").from.id).toBe("m1")
  expect(L.nodes[4].x).toBeGreaterThan(L.nodes[0].x)
})

test("a publish grafts its branch back onto main and adds a Layer band", () => {
  const events = [{ kind: "publish", project: "demo", branch: "agent-b", commit: "b2", layer: 1, t: "2026-01-01T00:06:00.000Z" }]
  expect(V.publishes(project, events)).toEqual([{ layer: 1, commit: "b2", branch: "agent-b", time: "2026-01-01T00:06:00.000Z", overwrote: false }])
  const L = V.layout(project, events)
  expect(L.topLayer).toBe(1)
  expect(L.grafts.length).toBe(1)
  expect(L.grafts[0].from.branch).toBe("agent-b")
  expect(L.grafts[0].to.branch).toBe("main")
  expect(L.grafts[0].to.landing).toBe(true) // main gains a landing leaf, not a copy
  expect(L.graftedBranches.has("agent-b")).toBe(true)
  expect(L.graftedBranches.has("agent-a")).toBe(false) // still a bare twig
  expect(L.bands.map((b) => b.layer)).toEqual([0, 1]) // L0 up to the publish, L1 after
  expect(L.bands[1].x0).toBe(L.bands[0].x1)
})

test("a branch's spine grows out of its fork point on the parent's lane", () => {
  const L = V.layout(project, [])
  const spine = L.spines.get("agent-b")
  expect(spine[0].id).toBe("m2") // the fork point, drawn on main's lane
  expect(spine[0].lane).toBe(0)
  expect(spine.slice(1).map((n) => n.id)).toEqual(["b1", "b2"])
  // and each commit is counted once, however many branches descend from it
  const total = L.nodes[L.nodes.length - 1]
  expect(total.cumLogical).toBe(5000)
  expect(L.nodes.length).toBe(5)
})

test("branches name their agent by token, in that agent's colour", () => {
  expect(V.agentOf("claude").name).toBe("Claude Code")
  expect(V.agentOf("claude").color).toBe("#d97757")
  expect(V.agentOf("claude-fix").id).toBe("claude")
  expect(V.agentOf("codex/feat").id).toBe("codex")
  expect(V.agentOf("pi").mark).toBe("Pi")
  expect(V.agentOf("pipeline")).toBeNull() // a token match, not a substring
  expect(V.agentOf("release")).toBeNull()
  expect(V.agentOf("agent-1")).toBeNull()
})

test("the page's stat tiles and speed seg are in the markup, magpie-style", () => {
  const html = read("index.html")
  expect(html).toContain('class="tiles"')
  for (const id of ["nCommits", "tBranches", "vCopies", "vStored", "tDedup", "vSaved"])
    expect(html).toContain(`id="${id}"`)
  expect(html).toContain('id="speed"')
  expect(html).toContain('data-speed="0.5"')
  expect(html).toContain('data-speed="4"')
  expect(html).not.toContain('<select id="speed"') // a seg control, not a select
  expect(html).toContain('max="1000"') // the scrub is smooth, not per-step
})

test("magpie's easing curve starts and ends true and stays monotonic", () => {
  const e = V.magpieEase // cubic-bezier(.2,.8,.2,1), magpie's --ease token
  expect(e(0)).toBe(0)
  expect(e(1)).toBe(1)
  expect(e(-1)).toBe(0)
  expect(e(2)).toBe(1)
  let prev = 0
  for (let x = 0.05; x < 1; x += 0.05) {
    expect(e(x)).toBeGreaterThan(prev)
    prev = e(x)
  }
  expect(e(0.5)).toBeGreaterThan(0.8) // the curve leans out early
  expect(V.easeOutCubic(0)).toBe(0)
  expect(V.easeOutCubic(1)).toBe(1)
  expect(V.easeOutBack(0)).toBeCloseTo(0)
  expect(V.easeOutBack(1)).toBe(1)
  expect(V.easeOutBack(0.7)).toBeGreaterThan(1) // the badge pop overshoots
})

test("a frame at playhead t eases each step in and interpolates the counters", () => {
  const s = V.steps(project) // cumStored 1000,1100,1200,1300,1400; cumLogical 1000..5000
  const f0 = V.frame(s, 0)
  expect(f0.progress).toEqual([0, 0, 0, 0, 0])
  expect(f0.logical).toBe(0)
  expect(f0.landed).toBe(0)
  const fEnd = V.frame(s, 5)
  expect(fEnd.progress).toEqual([1, 1, 1, 1, 1])
  expect(fEnd.logical).toBe(5000)
  expect(fEnd.stored).toBe(1400)
  expect(fEnd.landed).toBe(5)
  expect(fEnd.branches).toBe(3)
  const fMid = V.frame(s, 2.5) // third step half-way through its stretch
  expect(fMid.landed).toBe(2)
  expect(fMid.progress[2]).toBeGreaterThan(0)
  expect(fMid.progress[2]).toBeLessThan(1)
  expect(fMid.logical).toBeGreaterThan(2000)
  expect(fMid.logical).toBeLessThan(3000)
  expect(fMid.branches).toBe(1) // only main's two checkpoints have landed
  // and the counters never run backwards as t grows
  let last = 0
  for (let tt = 0; tt <= 5; tt += 0.25) {
    expect(V.frame(s, tt).logical).toBeGreaterThanOrEqual(last)
    last = V.frame(s, tt).logical
  }
  expect(V.frame(s, 99).landed).toBe(5) // clamped past the end
  expect(V.frame(s, -1).landed).toBe(0)
})

test("a landing pulse swells and thins, then is spent", () => {
  const p0 = V.pulse(0)
  expect(p0.opacity).toBeCloseTo(0.85)
  const pMid = V.pulse(0.5)
  expect(pMid.scale).toBeGreaterThan(p0.scale)
  expect(pMid.opacity).toBeLessThan(p0.opacity)
  expect(V.pulse(1).opacity).toBe(0)
  expect(V.pulse(1.5)).toBeNull()
  expect(V.pulse(-0.1)).toBeNull()
})

test("a monogram's ink reads on its agent's colour", () => {
  expect(V.markInk("#e7e5e4")).toBe("#101410") // OpenCode's near-white
  expect(V.markInk("#f59e0b")).toBe("#101410") // Pi's amber
  expect(V.markInk("#4d6bfe")).toBe("#ffffff") // dsh's deep blue
  expect(V.markInk("#d97757")).toBe("#ffffff") // Claude's terracotta
  expect(V.markInk("not-a-color")).toBe("#101410")
})

test("every agent has a drawable icon in the registry", () => {
  expect(Object.keys(V.ICONS).sort()).toEqual(Object.keys(V.AGENTS).sort())
  for (const [id, icon] of Object.entries(V.ICONS)) {
    const box = icon.viewBox.split(/\s+/).map(Number)
    expect(box.length).toBe(4)
    expect(box.every((n) => Number.isFinite(n))).toBe(true)
    expect(icon.paths.length).toBeGreaterThanOrEqual(1)
    for (const p of icon.paths) {
      expect(p.d.startsWith("M")).toBe(true)
      expect(p.d.length).toBeGreaterThanOrEqual(20)
    }
  }
})

test("a checkpoint badge carries its agent's icon, else a monogram, else the leaf", () => {
  const g = V.glyphFor("claude-fix")
  expect(g.type).toBe("icon")
  expect(g.agent.id).toBe("claude")
  // the geometry the renderer puts in the node is the registry's own
  expect(g.icon).toBe(V.ICONS.claude)
  expect(g.icon.paths[0].d).toContain("M4.709 15.955") // claude's starburst, as magpie ships it
  expect(V.glyphFor("pi").icon.paths.length).toBe(2) // pi's two block paths
  expect(V.glyphFor("main").type).toBe("leaf") // no agent on main's bough
  expect(V.glyphFor("release").type).toBe("leaf")
  expect(V.glyphFor("release").glyph).toBe(V.LEAF_GLYPH)
  // an agent whose glyph goes missing falls back to its monogram
  const saved = V.ICONS.grok
  delete V.ICONS.grok
  const fb = V.glyphFor("grok")
  expect(fb.type).toBe("mark")
  expect(fb.agent.mark).toBe("Gk")
  V.ICONS.grok = saved
  expect(V.glyphFor("grok").type).toBe("icon")
})

test("a commit's real calling agent names its badge, ahead of the branch-name token guess", () => {
  // claude worked on the release branch: the badge is claude's, not the leaf
  const g = V.glyphFor("release", { agent: "claude" })
  expect(g.type).toBe("icon")
  expect(g.agent.id).toBe("claude")
  // the branch-name guess still holds when the commit names no agent
  expect(V.glyphFor("release", {}).type).toBe("leaf")
  expect(V.glyphFor("release").type).toBe("leaf")
  expect(V.glyphFor("claude-fix", { agent: "" }).type).toBe("icon")
  // an agent the registry does not know leaves the badge to the branch
  // guess (here none), and the detail card says the raw name
  expect(V.glyphFor("release", { agent: "aider" }).type).toBe("leaf")
})
test("the detail card names the commit's real agent", () => {
  expect(V.detail({ ...project.branches[1].commits[1], agent: "codex" }, "en").agent).toBe("Codex")
  expect(V.detail({ ...project.branches[1].commits[1], agent: "aider" }, "en").agent).toBe("aider")
  expect(V.detail(project.branches[1].commits[1], "en").agent).toBe("")
})

test("an icon draws itself as its step lands, then its fill fades in", () => {
  const d0 = V.iconDraw(0, false)
  expect(d0.offset).toBe(1) // nothing of the outline yet
  expect(d0.fillOpacity).toBe(0)
  const dMid = V.iconDraw(0.36, false)
  expect(dMid.offset).toBeCloseTo(0.5)
  expect(dMid.fillOpacity).toBe(0) // the fill waits for the outline
  const dLate = V.iconDraw(0.75, false)
  expect(dLate.offset).toBe(0) // outline complete before the step ends
  expect(dLate.fillOpacity).toBeCloseTo(0.5)
  const d1 = V.iconDraw(1, false)
  expect(d1.offset).toBe(0)
  expect(d1.fillOpacity).toBe(1)
  expect(d1.strokeOpacity).toBeCloseTo(0.45) // a soft outline lingers
  // neither measure ever runs backwards as progress grows
  let lastOff = 1, lastFill = 0
  for (let p = 0; p <= 1.001; p += 0.1) {
    const d = V.iconDraw(Math.min(1, p), false)
    expect(d.offset).toBeLessThanOrEqual(lastOff)
    expect(d.fillOpacity).toBeGreaterThanOrEqual(lastFill)
    lastOff = d.offset; lastFill = d.fillOpacity
  }
})

test("reduced motion renders every icon fully drawn at any progress", () => {
  for (const p of [0, 0.2, 0.63, 1]) {
    const d = V.iconDraw(p, true)
    expect(d.offset).toBe(0)
    expect(d.fillOpacity).toBe(1)
  }
  // and the page wires the model in: badges, glyphs, no leaf nodes left
  const app = read("app.js")
  expect(app).toContain("glyphFor")
  expect(app).toContain("iconDraw")
  expect(app).toContain("badge-disc")
  expect(app).not.toContain("leaf-core")
  expect(app).not.toContain("LEAF")
  expect(read("style.css")).toContain(".glyph-path")
})

test("a checkpoint's detail line carries its delta and byte split", () => {
  const d = V.detail(project.branches[1].commits[1], "en")
  expect(d.meta).toContain("10 files")
  expect(d.meta).toContain("100 B / 1.0 KB")
  expect(d.delta).toContain("+1 added")
  expect(d.delta).toContain("~2 modified")
  expect(V.detail(project.branches[1].commits[1], "zh").delta).toContain("新增")
})
