// The trajectory page's working parts, with no DOM in them, so a test can
// check them. The model follows LayerFS's own History picture: main is
// the middle bough, each branch a bough of its own, a commit a leaf on
// its bough, a fork a split, a publish a graft back onto main that adds
// a Layer band. A classic script: it sets globalThis.LayerfsView.
(() => {
  const TEXT = {
    en: {
      title: "LayerFS trajectory", replay: "Replay", pause: "Pause",
      commits: "checkpoints", stored: "stored", asCopies: "as copies",
      saved: "saved by dedup", added: "added", modified: "modified", deleted: "deleted",
      files: "files", newBytes: "new bytes", noData: "No trajectory recorded yet. When an agent provisions, forks or checkpoints, the path appears here.",
      sample: "Sample trajectory from the plugin's benchmark run.",
      recorded: "Recorded", branch: "branch", workspace: "workspace",
      live: "live", layers: "layers", history: "HISTORY", stats: "store.stats · read-only",
      dedupe: "dedupe", graft: "published", twig: "bare twig",
      checkpointsK: "Checkpoints", branchesK: "Branches",
      agentsK: "Agent activity", agentsEmpty: "No tool calls yet. Each agent's provision, fork, checkpoint and publish lands here as it happens.",
      agentCol: "Agent", toolCol: "Tool", projectCol: "Project", branchCol: "Branch", whenCol: "When",
    },
    zh: {
      title: "LayerFS 轨迹", replay: "回放", pause: "暂停",
      commits: "个检查点", stored: "实际存储", asCopies: "若逐份复制",
      saved: "去重省下", added: "新增", modified: "修改", deleted: "删除",
      files: "个文件", newBytes: "新增字节", noData: "还没有记录到轨迹。agent 一旦 provision、fork 或 checkpoint，它的路径就会出现在这里。",
      sample: "示例轨迹，来自插件的基准运行。",
      recorded: "记录于", branch: "分支", workspace: "工作区",
      live: "条存活分支", layers: "层", history: "HISTORY", stats: "store.stats · 只读",
      dedupe: "去重", graft: "已发布", twig: "未发布的枝条",
      checkpointsK: "检查点", branchesK: "分支",
      agentsK: "Agent 活动", agentsEmpty: "还没有工具调用。每个 agent 的 provision、fork、checkpoint 和 publish 会实时落在这里。",
      agentCol: "Agent", toolCol: "工具", projectCol: "项目", branchCol: "分支", whenCol: "时间",
    },
    "zh-TW": {
      title: "LayerFS 軌跡", replay: "重播", pause: "暫停",
      commits: "個檢查點", stored: "實際儲存", asCopies: "若逐份複製",
      saved: "去重省下", added: "新增", modified: "修改", deleted: "刪除",
      files: "個檔案", newBytes: "新增位元組", noData: "還沒有記錄到軌跡。agent 一旦 provision、fork 或 checkpoint，它的路徑就會出現在這裡。",
      sample: "範例軌跡，來自外掛的基準執行。",
      recorded: "記錄於", branch: "分支", workspace: "工作區",
      live: "條存活分支", layers: "層", history: "HISTORY", stats: "store.stats · 唯讀",
      dedupe: "去重", graft: "已發布", twig: "未發布的枝條",
      checkpointsK: "檢查點", branchesK: "分支",
      agentsK: "Agent 活動", agentsEmpty: "還沒有工具呼叫。每個 agent 的 provision、fork、checkpoint 和 publish 會即時落在這裡。",
      agentCol: "Agent", toolCol: "工具", projectCol: "專案", branchCol: "分支", whenCol: "時間",
    },
    ja: {
      title: "LayerFS の軌跡", replay: "再生", pause: "一時停止",
      commits: "件のチェックポイント", stored: "実ストレージ", asCopies: "コピー換算",
      saved: "重複排除で節約", added: "追加", modified: "変更", deleted: "削除",
      files: "ファイル", newBytes: "新規バイト", noData: "まだ軌跡が記録されていません。エージェントが provision、fork、checkpoint を行うと、その経路がここに表示されます。",
      sample: "サンプル軌跡（プラグインのベンチマーク実行より）。",
      recorded: "記録", branch: "ブランチ", workspace: "ワークスペース",
      live: "本の生存ブランチ", layers: "レイヤー", history: "HISTORY", stats: "store.stats · 読み取り専用",
      dedupe: "重複排除", graft: "公開済み", twig: "未公開の枝",
      checkpointsK: "チェックポイント", branchesK: "ブランチ",
      agentsK: "エージェントの活動", agentsEmpty: "まだツール呼び出しはありません。各エージェントの provision、fork、checkpoint、publish は随時ここに記録されます。",
      agentCol: "エージェント", toolCol: "ツール", projectCol: "プロジェクト", branchCol: "ブランチ", whenCol: "時刻",
    },
  };

  // The locale the host hands over picks the table, the way the host
  // resolves page titles: zh-TW / zh-HK / zh-Hant get Traditional,
  // other zh gets Simplified, ja gets Japanese, the rest English.
  function text(lang) {
    const l = String(lang || "").toLowerCase();
    if (l.startsWith("ja")) return TEXT.ja;
    if (/^(zh-tw|zh-hk|zh-hant)/.test(l)) return TEXT["zh-TW"];
    if (l.startsWith("zh")) return TEXT.zh;
    return TEXT.en;
  }

  // The agents magpie drives, in the colours their own products wear, so
  // a branch an agent worked on carries that agent's identity in the
  // picture: its colour on the bough and leaves, its monogram on the
  // name tag. Matching is by token: "claude", "claude-fix" and
  // "codex/feat" name their agent; anything else keeps the palette.
  const AGENTS = {
    claude: { name: "Claude Code", color: "#d97757", mark: "Cl" },
    codex: { name: "Codex", color: "#10a37f", mark: "Cx" },
    opencode: { name: "OpenCode", color: "#e7e5e4", mark: "Oc" },
    cursor: { name: "Cursor", color: "#94a3b8", mark: "Cu" },
    gemini: { name: "Gemini", color: "#5b8def", mark: "Gm" },
    pi: { name: "Pi", color: "#f59e0b", mark: "Pi" },
    dsh: { name: "DeepSeek Harness", color: "#4d6bfe", mark: "Ds" },
    qoder: { name: "Qoder", color: "#6366f1", mark: "Qd" },
    cline: { name: "Cline", color: "#38bdf8", mark: "Cn" },
    grok: { name: "Grok", color: "#d4d4d8", mark: "Gk" },
    kimi: { name: "Kimi", color: "#a78bfa", mark: "Km" },
    droid: { name: "Droid", color: "#34d399", mark: "Dr" },
    hermes: { name: "Hermes", color: "#f472b6", mark: "Hm" },
    goose: { name: "Goose", color: "#fbbf24", mark: "Gs" },
    zcode: { name: "ZCode", color: "#22d3ee", mark: "Zc" },
  };

  function agentOf(branch) {
    const tokens = String(branch || "").toLowerCase().split(/[-_/ ]+/).filter(Boolean);
    for (const tok of tokens) if (AGENTS[tok]) return { id: tok, ...AGENTS[tok] };
    return null;
  }

  function bytes(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
    return n + " B";
  }

  // Lane 0 is main, the middle bough; other branches follow in the order
  // their first checkpoint appears.
  function lanes(project) {
    const firstAt = new Map();
    for (const b of project.branches) {
      if (b.commits.length) firstAt.set(b.name, b.commits[0].time);
    }
    const names = project.branches.map((b) => b.name).sort((a, b) => {
      if (a === "main") return -1;
      if (b === "main") return 1;
      return String(firstAt.get(a) ?? "").localeCompare(String(firstAt.get(b) ?? "")) || a.localeCompare(b);
    });
    return new Map(names.map((name, i) => [name, i]));
  }

  // Every commit of the project in the order the replay reveals them:
  // by time, ties broken by lane then id so a fork's first checkpoint
  // never precedes the checkpoint it forked from. A branch's list holds
  // only its own checkpoints (ancestors belong to their own bough), so
  // each commit appears exactly once and the curves count it once.
  function steps(project) {
    const lane = lanes(project);
    const all = [];
    for (const b of project.branches) {
      for (const c of b.commits) all.push({ branch: b.name, lane: lane.get(b.name), commit: c });
    }
    all.sort((x, y) =>
      String(x.commit.time).localeCompare(String(y.commit.time)) ||
      x.lane - y.lane || String(x.commit.id).localeCompare(String(y.commit.id)));
    let cumLogical = 0, cumStored = 0;
    for (const s of all) {
      cumLogical += s.commit.logicalBytes || 0;
      cumStored += s.commit.newBytes || 0;
      s.cumLogical = cumLogical;
      s.cumStored = cumStored;
    }
    return all;
  }

  // The publishes that landed on this project, oldest first, each one a
  // Layer on main. Falls back to numbering by order when an older
  // recording has no layer field.
  function publishes(project, events) {
    const pubs = (events || [])
      .filter((e) => e.kind === "publish" && e.project === project.name)
      .sort((a, b) => String(a.t).localeCompare(String(b.t)));
    return pubs.map((e, i) => ({
      layer: Number.isInteger(e.layer) ? e.layer : i + 1,
      commit: e.commit, branch: e.branch, time: e.t, overwrote: !!e.overwrote,
    }));
  }

  // The picture, worked out: one node per checkpoint on the lane of the
  // branch that made it; a publish adds a landing node on main's lane at
  // the same step and a graft from the branch's leaf to it; each branch's
  // spine runs from its fork point (a node on another lane) through its
  // own leaves; main's Layer bands run between consecutive landings.
  function layout(project, events, { dx = 54, laneH = 64, padX = 34, padTop = 42 } = {}) {
    const lane = lanes(project);
    const ordered = steps(project);
    const nodes = ordered.map((s, i) => ({
      id: s.commit.id, branch: s.branch, lane: s.lane, step: i,
      x: padX + i * dx, y: padTop + s.lane * laneH, commit: s.commit,
      cumLogical: s.cumLogical, cumStored: s.cumStored, landing: false,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pubs = publishes(project, events);
    const mainLane = lane.get("main") ?? 0;
    const landings = [];
    const grafts = [];
    for (const pub of pubs) {
      const from = byId.get(pub.commit);
      if (!from || from.branch === "main") continue;
      const to = {
        id: pub.commit, branch: "main", lane: mainLane, step: from.step,
        x: from.x, y: padTop + mainLane * laneH, commit: from.commit,
        cumLogical: from.cumLogical, cumStored: from.cumStored, landing: true,
      };
      landings.push(to);
      grafts.push({ from, to, layer: pub.layer });
    }
    // parent edges: within a lane along the bough, or a fork split when
    // the parent leaf sits on another lane
    const edges = [];
    for (const n of nodes) {
      const p = n.commit.parent && byId.get(n.commit.parent);
      if (p && p !== n) edges.push({ from: p, to: n, fork: p.lane !== n.lane });
    }
    // spines: per branch, the fork point first (when it lives on another
    // lane), then the branch's own leaves in order. Main's spine also
    // runs through its landing leaves.
    const spines = new Map();
    for (const b of project.branches) {
      const own = nodes.filter((n) => n.branch === b.name);
      const pts = [];
      if (b.name !== "main" && own.length) {
        const parent = byId.get(own[0].commit.parent);
        if (parent && parent.lane !== own[0].lane) pts.push({ ...parent, spineStep: own[0].step });
      }
      pts.push(...own);
      if (b.name === "main") {
        const merged = [...pts, ...landings].sort((a, z) => a.x - z.x || a.step - z.step);
        spines.set(b.name, merged);
      } else {
        spines.set(b.name, pts);
      }
    }
    // A branch whose head was published is grafted; any other branch is
    // still a bare twig at its tip.
    const grafted = new Set(grafts.map((g) => g.from.branch));
    const bands = [];
    const mainExtent = spines.get("main") || [];
    if (mainExtent.length) {
      let start = mainExtent[0].x, layer = 0;
      for (const g of grafts) {
        bands.push({ layer, x0: start, x1: g.to.x });
        start = g.to.x; layer = g.layer;
      }
      bands.push({ layer, x0: start, x1: mainExtent[mainExtent.length - 1].x });
    }
    const laneCount = Math.max(1, lane.size);
    return {
      nodes, landings, edges, grafts, spines, bands,
      topLayer: pubs.length ? pubs[pubs.length - 1].layer : 0,
      graftedBranches: grafted,
      width: padX * 2 + Math.max(0, nodes.length - 1) * dx,
      height: padTop * 2 + (laneCount - 1) * laneH + 18,
      laneOf: (name) => lane.get(name), laneCount,
    };
  }

  // --- the replay's motion model, pure so a test can check it --------
  // Magpie's own easing (its --ease token): cubic-bezier(.2,.8,.2,1).
  // Solved the way browsers solve it: Newton steps on x, bisection
  // when they stall.
  function cubicBezier(x1, y1, x2, y2) {
    const at = (a, b, u) => {
      const v = 1 - u;
      return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
    };
    const dx = (u) => {
      const v = 1 - u;
      return 3 * v * v * x1 + 6 * v * u * (x2 - x1) + 3 * u * u * (1 - x2);
    };
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let u = x;
      for (let i = 0; i < 8; i++) {
        const err = at(x1, x2, u) - x;
        if (Math.abs(err) < 1e-6) return at(y1, y2, u);
        const d = dx(u);
        if (Math.abs(d) < 1e-6) break;
        u -= err / d;
      }
      let lo = 0, hi = 1;
      u = x;
      while (hi - lo > 1e-6) {
        if (at(x1, x2, u) < x) lo = u; else hi = u;
        u = (lo + hi) / 2;
      }
      return at(y1, y2, u);
    };
  }
  const magpieEase = cubicBezier(0.2, 0.8, 0.2, 1);
  const easeOutCubic = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  // a soft overshoot for the Layer badges popping in
  const easeOutBack = (t) => {
    t = Math.min(1, Math.max(0, t));
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // The replay at playhead t (0..steps.length, fractional): each step
  // appears over the unit after its index, eased by magpie's curve.
  // Bytes interpolate along the same easing, so the counters count up
  // smoothly instead of jumping at each landing.
  function frame(stepsList, t) {
    const n = stepsList.length;
    t = Math.min(n, Math.max(0, t));
    const progress = new Array(n);
    let logical = 0, stored = 0, landed = 0;
    const branches = new Set();
    for (let i = 0; i < n; i++) {
      const raw = clamp01(t - i);
      const p = magpieEase(raw);
      progress[i] = p;
      const prevL = i ? stepsList[i - 1].cumLogical : 0;
      const prevS = i ? stepsList[i - 1].cumStored : 0;
      logical += (stepsList[i].cumLogical - prevL) * p;
      stored += (stepsList[i].cumStored - prevS) * p;
      if (raw >= 1) { landed++; branches.add(stepsList[i].branch); }
    }
    return { progress, logical, stored, landed, branches: branches.size };
  }

  // A landing's pulse ring, u seconds-fraction through its life: it
  // swells out and thins away. Null once spent.
  function pulse(u) {
    if (u < 0 || u > 1) return null;
    return { scale: 0.35 + 1.9 * easeOutCubic(u), opacity: 0.85 * (1 - u) * (1 - u) };
  }

  // The ink for an agent's monogram on its own colour: near-black on
  // light brand colours, white on dark ones (relative luminance).
  function markInk(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return "#101410";
    const n = parseInt(m[1], 16);
    const lum = (0.2126 * (n >> 16) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
    return lum > 0.62 ? "#101410" : "#ffffff";
  }

  // The agents' own marks, drawn inside each checkpoint badge.
  // Geometry sources: for most agents this is the icon magpie itself
  // ships in internal/gui/assets/icons (claude's starburst, codex's
  // knot — its rounded-square backing dropped, the badge is the disc
  // — cursor's hex mark, gemini's sparkle, opencode's frame, pi's
  // blocks, deepseek's whale for dsh, cline's bot head, grok's swirl,
  // kimi's K, hermes' winged H, goose's bird). Three are original
  // simplified glyphs in the same weight, where magpie ships only a
  // raster (zcode) or a mark too fine to survive at badge size
  // (qoder's folded ribbon, factory's droid). An agent with no entry
  // here falls back to its monogram in the same badge (glyphFor).
  const ICONS = {
    claude: { viewBox: "0 0 24 24", sw: 1.0, paths: [{ d: "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z", rule: "nonzero" }] },
    codex: { viewBox: "0 0 24 24", sw: 1.1, paths: [{ d: "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" }] },
    opencode: { viewBox: "0 0 24 24", paths: [{ d: "M16 6H8v12h8V6zm4 16H4V2h16v20z" }] },
    cursor: { viewBox: "0 0 24 24", paths: [{ d: "M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" }] },
    gemini: { viewBox: "0 0 24 24", paths: [{ d: "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" }] },
    pi: { viewBox: "0 0 24 24", paths: [{ d: "M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z", rule: "evenodd" }, { d: "M17.5 12H23v11h-5.5V12z", rule: "evenodd" }] },
    dsh: { viewBox: "0 0 24 24", sw: 1.1, paths: [{ d: "M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" }] },
    qoder: { viewBox: "0 0 24 24", paths: [{ d: "M3.9 11.5a7.6 7.6 0 1 1 15.2 0a7.6 7.6 0 1 1-15.2 0M7.4 11.5a4.1 4.1 0 1 1 8.2 0a4.1 4.1 0 1 1-8.2 0", rule: "evenodd" }, { d: "M13.9 14.6l2.5-1.7 4.9 7.3-2.5 1.7z" }] },
    cline: { viewBox: "0 0 24 24", paths: [{ d: "M17.035 3.991c2.75 0 4.98 2.24 4.98 5.003v1.667l1.45 2.896a1.01 1.01 0 01-.002.909l-1.448 2.864v1.668c0 2.762-2.23 5.002-4.98 5.002H7.074c-2.751 0-4.98-2.24-4.98-5.002V17.33l-1.48-2.855a1.01 1.01 0 01-.003-.927l1.482-2.887V8.994c0-2.763 2.23-5.003 4.98-5.003h9.962zM8.265 9.6a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 004.547 0v-4.042A2.274 2.274 0 008.265 9.6zm7.326 0a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 104.548 0v-4.042A2.274 2.274 0 0015.59 9.6z" }, { d: "M12.054 5.558a2.779 2.779 0 100-5.558 2.779 2.779 0 000 5.558z" }] },
    grok: { viewBox: "0 0 24 24", paths: [{ d: "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" }] },
    kimi: { viewBox: "0 0 24 24", paths: [{ d: "M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z" }, { d: "M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z" }] },
    droid: { viewBox: "0 0 24 24", paths: [{ d: "M4.5 10.2c0-1.9 1.5-3.4 3.4-3.4h8.2c1.9 0 3.4 1.5 3.4 3.4v5.6c0 1.9-1.5 3.4-3.4 3.4H7.9c-1.9 0-3.4-1.5-3.4-3.4zM11.2 3.9h1.6v2.9h-1.6zM10.8 3a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1-2.4 0M7.65 12.8a1.35 1.35 0 1 1 2.7 0a1.35 1.35 0 1 1-2.7 0M13.65 12.8a1.35 1.35 0 1 1 2.7 0a1.35 1.35 0 1 1-2.7 0", rule: "evenodd" }] },
    hermes: { viewBox: "12 16 40 40", sw: 2.2, paths: [{ d: "M21 20h7v14h8V20h7v32h-7V40h-8v12h-7zM13 21l7 3v6l-7-3zM51 21l-7 3v6l7-3z" }] },
    goose: { viewBox: "0 0 24 24", paths: [{ d: "M21.595 23.61c1.167-.254 2.405-.944 2.405-.944l-2.167-1.784a12.124 12.124 0 01-2.695-3.131 12.127 12.127 0 00-3.97-4.049l-.794-.462a1.115 1.115 0 01-.488-.815.844.844 0 01.154-.575c.413-.582 2.548-3.115 2.94-3.44.503-.416 1.065-.762 1.586-1.159.074-.056.148-.112.221-.17.003-.002.007-.004.009-.007.167-.131.325-.272.45-.438.453-.524.563-.988.59-1.193-.061-.197-.244-.639-.753-1.148.319.02.705.272 1.056.569.235-.376.481-.773.727-1.171.165-.266-.08-.465-.086-.471h-.001V3.22c-.007-.007-.206-.25-.471-.086-.567.35-1.134.702-1.639 1.021 0 0-.597-.012-1.305.599a2.464 2.464 0 00-.438.45l-.007.009c-.058.072-.114.147-.17.221-.397.521-.743 1.083-1.16 1.587-.323.391-2.857 2.526-3.44 2.94a.842.842 0 01-.574.153 1.115 1.115 0 01-.815-.488l-.462-.794a12.123 12.123 0 00-4.049-3.97 12.133 12.133 0 01-3.13-2.695L1.332 0S.643 1.238.39 2.405c.352.428 1.27 1.49 2.34 2.302C1.58 4.167.73 3.75.06 3.4c-.103.765-.063 1.92.043 2.816.726.317 1.961.806 3.219 1.066-1.006.236-2.11.278-2.961.262.15.554.358 1.119.64 1.688.119.263.25.52.39.77.452.125 2.222.383 3.164.171l-2.51.897a27.776 27.776 0 002.544 2.726c2.031-1.092 2.494-1.241 4.018-2.238-2.467 2.008-3.108 2.828-3.8 3.67l-.483.678c-.25.351-.469.725-.65 1.117-.61 1.31-1.47 4.1-1.47 4.1-.154.486.202.842.674.674 0 0 2.79-.861 4.1-1.47.392-.182.766-.4 1.118-.65l.677-.483c.227-.187.453-.37.701-.586 0 0 1.705 2.02 3.458 3.349l.896-2.511c-.211.942.046 2.712.17 3.163.252.142.509.272.772.392.569.28 1.134.49 1.688.64-.016-.853.026-1.956.261-2.962.26 1.258.75 2.493 1.067 3.219.895.106 2.051.146 2.816.043a73.87 73.87 0 01-1.308-2.67c.811 1.07 1.874 1.988 2.302 2.34h-.001z" }] },
    zcode: { viewBox: "0 0 24 24", paths: [{ d: "M5.5 4.2h13v3L10.7 16.8h7.8v3h-13v-3L13.3 7.2H5.5z" }] },
  };

  // LayerFS's own mark for a bough with no agent on it (main, or a
  // branch named for its work): the leaf the picture began with, in
  // the same badge and the same draw-on treatment as the icons.
  const LEAF_GLYPH = { viewBox: "-11 -11 22 22", paths: [{ d: "M0-10C8-6 10 4 0 11C-10 4-8-6 0-10Z" }] };

  // What a branch's checkpoint badge carries: its agent's icon when
  // the branch names an agent, the agent's monogram when the agent
  // has no drawable glyph, and the leaf when no agent is named. A
  // commit that carries the real calling agent (ctx.agent, recorded
  // by the tools) names its agent outright, ahead of the branch-name
  // token guess.
  function glyphFor(branch, commit) {
    const agent = (commit && agentOf(commit.agent)) || agentOf(branch);
    if (!agent) return { type: "leaf", glyph: LEAF_GLYPH };
    const icon = ICONS[agent.id];
    if (icon) return { type: "icon", agent, icon };
    return { type: "mark", agent };
  }

  // A glyph's draw state at step progress p: its outline draws
  // itself over the first stretch (stroke dashoffset, the same
  // pathLength trick as the boughs), the fill fades in over the
  // second half, and a soft outline lingers once landed. Reduced
  // motion settles every glyph fully drawn at any progress.
  function iconDraw(p, rm) {
    if (rm) return { offset: 0, fillOpacity: 1, strokeOpacity: 0.45 };
    const fill = clamp01((p - 0.5) / 0.5);
    return { offset: 1 - clamp01(p / 0.72), fillOpacity: fill, strokeOpacity: 1 - fill * 0.55 };
  }
  // One line of a checkpoint's detail card.
  function detail(commit, lang) {
    const t = text(lang);
    const d = commit.delta || { added: 0, modified: 0, deleted: 0 };
    const parts = [];
    if (d.added) parts.push(`+${d.added} ${t.added}`);
    if (d.modified) parts.push(`~${d.modified} ${t.modified}`);
    if (d.deleted) parts.push(`-${d.deleted} ${t.deleted}`);
    const a = commit.agent ? agentOf(commit.agent) : null;
    return {
      agent: a ? a.name : String(commit.agent || ""),
      message: commit.message || "",
      meta: `${commit.files == null ? "" : `${commit.files} ${t.files} · `}${t.newBytes} ${bytes(commit.newBytes)} / ${bytes(commit.logicalBytes)}`,
      delta: parts.join(" · "),
    };
  }

  globalThis.LayerfsView = {
    TEXT, text, bytes, lanes, steps, publishes, layout, detail, AGENTS, agentOf,
    ICONS, LEAF_GLYPH, glyphFor, iconDraw,
    cubicBezier, magpieEase, easeOutCubic, easeOutBack, clamp01, frame, pulse, markInk,
  };
})();
