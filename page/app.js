// The trajectory page, drawn the way LayerFS's own History picture is:
// main is the green middle bough, every other branch a bough that splits
// off it, a checkpoint a leaf on its bough, and a publish a graft back
// onto main that lands a Layer badge. The replay is one continuous
// timeline, driven by requestAnimationFrame through the pure motion
// model in view.js: boughs draw themselves as the playhead passes,
// leaves land with a pulse, and the counters count up along the same
// easing magpie itself uses (--ease, cubic-bezier(.2,.8,.2,1)).
//
// The page may read no live data (its sandbox allows no fetch), so the
// tools write the recorded trajectory beside this page as trajectory.js
// after every call; reopening the page shows the newest recording.
(async () => {
  const V = globalThis.LayerfsView;
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STEP_MS = 560; // one checkpoint's stretch of timeline at 1×
  const PULSE_MS = 650;

  let theme = { lang: "en", dark: matchMedia("(prefers-color-scheme: dark)").matches };
  try { theme = (await magpie.ready) || theme; } catch { /* standalone preview */ }
  const lang = theme.lang || "en";
  const t = V.text(lang);
  document.querySelectorAll("[data-t]").forEach((e) => { e.textContent = t[e.dataset.t]; });

  // branch colours: an agent's branch wears the agent's own brand
  // colour in both themes; the rest take magpie's chart series, and
  // main is the leaf green (deeper on light, brighter on dark)
  const SERIES = {
    dark: ["#a5b4fc", "#7dd3fc", "#6ee7b7", "#fcd34d", "#f9a8d4", "#c4b5fd", "#94a3b8"],
    light: ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#64748b"],
  };
  const series = () => SERIES[theme.dark ? "dark" : "light"];
  const mainColor = () => (theme.dark ? "#4ade80" : "#16a34a");
  const colorOf = (branch, lane) =>
    (V.agentOf(branch) || {}).color ||
    (lane === 0 ? mainColor() : series()[(lane - 1) % series().length]);

  const data = globalThis.LayerfsTrajectory;
  const projects = (data && data.projects || []).filter((p) => p.branches.some((b) => b.commits.length));
  if (!projects.length) {
    $("stage").hidden = true; $("controls").hidden = true; $("stats").hidden = true;
    $("empty").hidden = false; $("empty").textContent = t.noData;
    return;
  }
  $("stamp").textContent = data.sample ? t.sample : `${t.recorded} ${String(data.generatedAt || "").replace("T", " ").slice(0, 19)} · ${data.backend || ""}`;

  const picker = $("project");
  for (const p of projects) {
    const o = document.createElement("option");
    o.value = p.name; o.textContent = p.name;
    picker.append(o);
  }
  picker.hidden = projects.length < 2;
  picker.addEventListener("change", () => show(picker.value));

  function el(name, attrs = {}, parent) {
    const e = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.append(e);
    return e;
  }
  const LEAF = "M 0 -10 C 8 -6, 10 4, 0 11 C -10 4, -8 -6, 0 -10 Z";
  const seg = (a, b) => {
    const mx = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
  };

  // the live picture: element registries keyed by replay step, rebuilt
  // per project; render() then only moves styles and attributes
  let view = null; // { project, L, stepsList, nodes, segs, grafts, bands, badges }
  let playhead = 0, playing = false, speed = 1, focus = null, pinned = false;
  let lastLanded = -1, raf = 0, lastTs = 0;
  const pulses = new Map(); // step -> pulse start (performance.now)
  const shown = {}; // last strings written to the stat tiles

  function build(name) {
    stop(); focus = null; pinned = false; pulses.clear(); lastLanded = -1;
    const project = projects.find((p) => p.name === name) || projects[0];
    const stepsList = V.steps(project);
    const wide = Math.max(320, ($("stage").clientWidth || 720) - 8);
    // never squish below a readable pitch: the stage scrolls instead
    const dx = stepsList.length > 1 ? Math.max(46, Math.min(76, (wide - 68) / (stepsList.length - 1))) : 54;
    const L = V.layout(project, data.events, { dx, laneH: 56, padTop: 46 });
    view = { project, L, stepsList, nodes: [], segs: [], grafts: [], bands: [], badges: [] };
    $("histLine").textContent = `${t.history} ${project.name} @ L${L.topLayer}`;
    $("histMeta").textContent = `${L.nodes.length} commits · ${L.laneCount} ${t.live} · ${L.topLayer + 1} ${t.layers}`;
    const svg = $("graph");
    svg.replaceChildren();
    svg.removeAttribute("data-focus");
    svg.setAttribute("viewBox", `0 0 ${L.width} ${L.height}`);
    svg.setAttribute("width", L.width); svg.setAttribute("height", L.height);
    const all = [...L.nodes, ...L.landings];
    const mainY = (L.spines.get("main") || [])[0]?.y ?? 46;

    // Layer bands on main: a stratum behind the bough per layer,
    // fading in as its layer begins
    L.bands.forEach((band, i) => {
      const g = el("g", { class: "band" }, svg);
      el("rect", {
        x: band.x0 - 16, y: mainY - 18, width: Math.max(30, band.x1 - band.x0 + 32), height: 36, rx: 18,
        class: "band-fill",
      }, g);
      const label = el("text", { y: mainY - 28, class: "band-label" }, g);
      // the band a head publish just opened has no width yet: anchor its
      // label at the publish point instead of past the edge
      if (i === L.bands.length - 1 && band.x1 - band.x0 < 60) {
        label.setAttribute("x", band.x1 + 14); label.setAttribute("text-anchor", "end");
      } else {
        label.setAttribute("x", band.x0 - 6);
      }
      label.textContent = `L${band.layer}`;
      view.bands.push({ g, start: i === 0 ? 0 : L.grafts[i - 1].to.step });
    });
    // grafts under everything: a publish joining a branch back to main,
    // drawn as the playhead reaches it; a Layer badge pops at its head
    for (const gr of L.grafts) {
      const path = el("path", {
        d: seg(gr.from, gr.to), class: "graft", pathLength: 1,
        "data-branch": gr.from.branch, stroke: colorOf(gr.from.branch, gr.from.lane),
      }, svg);
      view.grafts.push({ path, step: gr.to.step, branch: gr.from.branch });
      const badge = el("g", { class: "badge", transform: `translate(${gr.to.x} ${mainY - 36})` }, svg);
      const pop = el("g", { class: "badge-pop" }, badge);
      const label = `L${gr.layer}`;
      el("rect", { x: -13 - (label.length - 2) * 3.5, y: -8, width: 26 + (label.length - 2) * 7, height: 16, rx: 8, class: "badge-fill" }, pop);
      const txt = el("text", { y: 3.5, class: "badge-text" }, pop);
      txt.textContent = label;
      view.badges.push({ g: badge, pop, step: gr.to.step, branch: gr.from.branch });
    }
    // one group per branch: spine segments that draw themselves as
    // their target checkpoint appears
    for (const [branch, pts] of L.spines) {
      const g = el("g", { class: "lane", "data-branch": branch }, svg);
      const laneIdx = L.laneOf(branch);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const path = el("path", {
          d: seg(a, b), class: "seg" + (a.lane !== b.lane ? " split-seg" : ""), pathLength: 1,
          stroke: colorOf(branch, laneIdx), "data-branch": branch,
        }, g);
        view.segs.push({ path, step: b.step });
      }
    }
    // checkpoints: a positioned group (attribute transform) around an
    // animated group (style transform), so the two never fight; the
    // ring is the landing pulse
    for (const n of all) {
      const g = el("g", { class: "lane", "data-branch": n.branch }, svg);
      const pos = el("g", { transform: `translate(${n.x} ${n.y})` }, g);
      const ring = el("circle", {
        r: 9, class: "ring", fill: "none",
        stroke: colorOf(n.branch, n.lane), "stroke-width": 2, opacity: 0,
      }, pos);
      const anim = el("g", { class: "node" + (n.landing ? " landing" : ""), "data-branch": n.branch }, pos);
      el("circle", { r: 8.5, class: "halo", fill: colorOf(n.branch, n.lane) }, anim);
      el("path", { d: LEAF, class: "leaf", fill: colorOf(n.branch, n.lane), transform: "rotate(32) scale(1.35)" }, anim);
      el("circle", { r: 2.1, class: "leaf-core" }, anim);
      anim.addEventListener("click", () => { pinned = true; pause(); select(n); });
      view.nodes.push({ anim, ring, step: n.step, node: n });
    }
    // name tags at each branch's first own leaf; main needs none — the
    // HISTORY line and the Layer bands name it. An agent's branch gets
    // its monogram chip in the agent's colour, like magpie's own rows.
    for (const b of project.branches) {
      if (b.name === "main") continue;
      const first = L.nodes.find((n) => n.branch === b.name);
      if (!first) continue;
      const g = el("g", { class: "lane", "data-branch": b.name }, svg);
      const tag = el("g", { class: "tag", transform: `translate(${first.x - 4} ${first.y - 30})` }, g);
      const agent = V.agentOf(b.name);
      let nameX = 0;
      if (agent) {
        el("rect", { x: -2, y: -11, width: 23, height: 15, rx: 3.5, fill: agent.color, class: "chip" }, tag);
        const mark = el("text", { x: 9.5, y: 1, class: "chip-mark", fill: V.markInk(agent.color) }, tag);
        mark.textContent = agent.mark;
        nameX = 27;
      }
      const label = el("text", { x: nameX, y: 1, class: "tag-label", fill: colorOf(b.name, first.lane) }, tag);
      label.textContent = b.name + (!L.graftedBranches.has(b.name) ? " ·" : "");
      tag.addEventListener("click", () => setFocus(focus === b.name ? null : b.name));
    }
    // legend: which agents are in this picture, in their own colours
    const legend = $("legend");
    legend.replaceChildren();
    const seen = new Map();
    for (const b of project.branches) {
      const a = V.agentOf(b.name);
      if (a && !seen.has(a.id)) seen.set(a.id, a);
    }
    for (const a of seen.values()) {
      const item = document.createElement("span");
      item.className = "legend-item";
      const dot = document.createElement("i");
      dot.style.background = a.color;
      item.append(dot, document.createTextNode(a.name));
      legend.append(item);
    }
    legend.hidden = seen.size === 0;
    for (const k of Object.keys(shown)) delete shown[k];
  }

  function setFocus(branch) {
    focus = branch;
    const svg = $("graph");
    if (!branch) { svg.removeAttribute("data-focus"); return; }
    svg.setAttribute("data-focus", branch);
    document.querySelectorAll("#graph .lane, #graph .graft").forEach((e) => {
      e.classList.toggle("focus", e.dataset.branch === branch);
    });
  }

  function setText(id, value) {
    if (shown[id] === value) return;
    shown[id] = value;
    $(id).textContent = value;
  }

  // one frame of the replay at the current playhead
  function render() {
    if (!view) return;
    const { L, stepsList } = view;
    const n = stepsList.length;
    const f = V.frame(stepsList, playhead);
    for (const s of view.segs) {
      const p = f.progress[s.step];
      s.path.style.strokeDashoffset = String(1 - p);
      s.path.style.opacity = p > 0 ? "" : "0";
    }
    for (const g of view.grafts) {
      const p = f.progress[g.step];
      g.path.style.strokeDashoffset = String(1 - p);
      g.path.style.opacity = p > 0 ? (focus && focus !== g.branch ? "0.13" : "") : "0";
    }
    for (const b of view.bands) {
      b.g.style.opacity = String(V.magpieEase(V.clamp01(playhead - b.start)));
    }
    for (const b of view.badges) {
      const raw = V.clamp01(playhead - b.step);
      b.g.style.opacity = raw > 0 ? (focus && focus !== b.branch ? "0.25" : "1") : "0";
      b.pop.style.transform = `scale(${Math.max(0.0001, V.easeOutBack(raw))})`;
    }
    for (const nd of view.nodes) {
      const p = f.progress[nd.step];
      nd.anim.style.opacity = String(p);
      nd.anim.style.transform = `scale(${0.35 + 0.65 * p}) rotate(${-14 * (1 - p)}deg)`;
      nd.anim.classList.toggle("sel", !!nd.node._sel);
    }
    // the counters count up along the same frame
    const total = stepsList[n - 1];
    setText("nCommits", `${f.landed} / ${n}`);
    setText("tBranches", String(f.branches));
    setText("vCopies", V.bytes(f.logical));
    setText("vStored", V.bytes(f.stored));
    setText("tDedup", f.stored > 0 ? `${(f.logical / f.stored).toFixed(2)}×` : "–");
    setText("vSaved", f.logical > 0 ? `${t.saved} ${V.bytes(f.logical - f.stored)} (${Math.round((1 - f.stored / f.logical) * 100)}%)` : "");
    $("barCopies").style.width = total && total.cumLogical ? `${Math.max(1.5, (f.logical / total.cumLogical) * 100)}%` : "0%";
    $("barStored").style.width = total && total.cumLogical ? `${Math.max(1.5, (f.stored / total.cumLogical) * 100)}%` : "0%";
    if (document.activeElement !== $("scrub")) $("scrub").value = n ? Math.round((playhead / n) * 1000) : 0;
    // landing bookkeeping: pulses only for steps the playhead crosses
    // while playing — a scrub sets the state without fanfare
    if (playing && !RM) {
      for (let s = Math.max(0, lastLanded); s < f.landed; s++) pulses.set(s, performance.now());
    }
    if (f.landed !== lastLanded) {
      lastLanded = f.landed;
      if (!pinned) {
        if (f.landed > 0) select(L.nodes[f.landed - 1]);
        else clearDetail();
      }
    }
  }

  function renderPulses(now) {
    for (const [step, start] of pulses) {
      const s = V.pulse((now - start) / PULSE_MS);
      for (const nd of view.nodes) {
        if (nd.step !== step) continue;
        if (!s) { nd.ring.setAttribute("opacity", 0); continue; }
        nd.ring.setAttribute("r", (nd.node.landing ? 13 : 9) * s.scale);
        nd.ring.setAttribute("opacity", s.opacity);
      }
      if (!s) pulses.delete(step);
    }
  }

  function loop(ts) {
    raf = 0;
    if (playing) {
      if (lastTs) {
        playhead = Math.min(view.stepsList.length, playhead + ((ts - lastTs) / STEP_MS) * speed);
        if (playhead >= view.stepsList.length) pause();
      }
      lastTs = ts;
    } else {
      lastTs = 0;
    }
    render();
    renderPulses(ts);
    if (playing || pulses.size) raf = requestAnimationFrame(loop);
  }
  function ensureLoop() { if (!raf) { lastTs = 0; raf = requestAnimationFrame(loop); } }

  function play() {
    if (!view || playing) return;
    pinned = false;
    if (playhead >= view.stepsList.length) { playhead = 0; lastLanded = -1; pulses.clear(); }
    if (RM) { playhead = view.stepsList.length; render(); return; }
    playing = true;
    $("play").textContent = t.pause;
    ensureLoop();
  }
  function pause() {
    playing = false;
    $("play").textContent = t.replay;
  }
  function stop() { pause(); if (raf) cancelAnimationFrame(raf); raf = 0; }

  function select(node) {
    const d = V.detail(node.commit, lang);
    const graft = view.L.grafts.find((g) => g.to === node);
    $("dBranch").textContent = `${t.branch}: ${node.branch}` +
      (graft ? ` · ${t.graft} L${graft.layer}` : node.branch !== "main" && isTip(node) && !view.L.graftedBranches.has(node.branch) ? ` · ${t.twig}` : "");
    $("dMsg").textContent = d.message;
    $("dMeta").textContent = d.meta;
    $("dDelta").textContent = d.delta;
    $("dTime").textContent = String(node.commit.time || "").replace("T", " ").slice(0, 19);
    $("detail").style.borderLeftColor = colorOf(node.branch, node.lane);
    for (const nd of view.nodes) nd.node._sel = nd.node === node;
    for (const nd of view.nodes) nd.anim.classList.toggle("sel", nd.node === node);
  }
  function clearDetail() {
    $("dBranch").textContent = ""; $("dMsg").textContent = "";
    $("dMeta").textContent = ""; $("dDelta").textContent = ""; $("dTime").textContent = "";
    for (const nd of view.nodes) { nd.node._sel = false; nd.anim.classList.remove("sel"); }
  }
  function isTip(node) {
    return !view.L.nodes.some((n) => n.branch === node.branch && n.step > node.step);
  }

  function show(name, keep = false) {
    const at = playhead;
    build(name);
    const n = view.stepsList.length;
    // reduced motion, or a theme change mid-look: settle on the final
    // state (clamped to the new picture) instead of replaying
    playhead = keep ? Math.min(at, n) : RM ? n : 0;
    render();
    if (!RM && !keep && n) play();
  }

  $("play").addEventListener("click", () => (playing ? pause() : play()));
  $("scrub").addEventListener("input", () => {
    pause(); pinned = false; pulses.clear();
    playhead = view ? (Number($("scrub").value) / 1000) * view.stepsList.length : 0;
    lastLanded = -1; // render re-derives the detail for the new position
    render();
  });
  $("speed").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-speed]");
    if (!b) return;
    speed = Number(b.dataset.speed);
    for (const x of $("speed").querySelectorAll("button")) {
      if (x === b) x.setAttribute("aria-selected", "true"); else x.removeAttribute("aria-selected");
    }
  });
  if (window.magpie && typeof magpie.onTheme === "function") {
    magpie.onTheme((th) => {
      const dark = !!th.dark;
      if (dark === theme.dark) return;
      theme = { ...theme, dark };
      show(picker.value, true);
    });
  }

  // the store.stats line, in LayerFS's own accounting words
  const totals = data.totals || {};
  $("statsLine").textContent =
    `${t.stats} · ${t.dedupe} ${totals.dedupRatio ?? "–"}× · ${t.stored} ${V.bytes(totals.storedBytes)} / ${V.bytes(totals.logicalBytes)}`;

  show(projects[0].name);
})();
