# LayerFS for Magpie

[LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) workspaces for every
agent [magpie](https://usemagpie.ai) connects: instead of each agent copying
a project tree to work on it, agents share one durable, deduplicated history
and work through **stable filesystem paths**. Forking a branch for a
parallel agent copies **no file bytes**; a checkpoint stores **only what
changed**; any agent can resolve, read and build on what the others
committed.

给每个 agent 的 LayerFS 工作区：多个 agent 共享一份可去重的持久历史，而不是
各自复制整棵项目树。给并行 agent 开分支不复制任何文件字节；存检查点只写
变化的部分；路径稳定，任何 agent 都能定位、读取并接续其他 agent 的提交。

```sh
magpie plugin add @magpie-community/tools-layerfs
magpie plugin            # lists layerfs_provision, layerfs_checkpoint, ...
```

## Tools

Served on magpie's MCP server as `layerfs_<tool>`:

| Tool | What it does |
|---|---|
| `provision` | Gives the agent a workspace for a project branch and answers the path to work in. The first provision imports the source directory — a required argument, the directory the user chose for the project — as the project's first checkpoint; later provisions of the same branch answer the same path without copying the tree again. |
| `checkpoint` | Saves the workspace's state on its branch, storing only the blobs the store has not seen; answers added / modified / deleted counts and the new-bytes vs saved-bytes accounting. |
| `fork` | Forks a branch for a parallel agent: a pointer at an existing checkpoint, ready immediately, 0 bytes copied. |
| `publish` | Publishes a branch's head as main's new Layer, so finished work becomes what new work forks from. Guarded: main's head must be in the branch's history, so a publish can only move main forward — if main moved on its own, the publish is refused (a real dsh run lost main's 238 tests to a stale publish; this is that lesson, encoded). `force: true` overwrites deliberately and reports what it replaced. |
| `exec` | Runs a shell command in a branch's workspace and checkpoints whatever it changed as one commit — the dsh shape, where every bash call is mount, run, commit. A no-change command commits nothing; a failing command's changes are still checkpointed, with its exit code reported. **Disabled by default** (see Safety defaults): it runs only when the user has opted in. |
| `history` | Lists a branch's checkpoints, newest first, with each one's logical tree size and the bytes it actually stored. |
| `resolve` | Resolves a project / branch / file to a real filesystem path, its checkpoint and content hash — an O(1) lookup, no copying. |
| `status` | Backend in use, projects and branches held, and the storage accounting: logical bytes of all checkpoints vs bytes the store occupies. |

Only the workspace path is persistent. Every workspace carries two
scratch directories, `.tmp/` and `.cache/`, created at provision;
`exec` runs commands with `TMPDIR` and `XDG_CACHE_HOME` redirected at
them, so toolchains keep their temporary files and caches inside the
workspace instead of the host's real `/tmp`. Both directories are
workspace-local scratch: checkpoints and publishes never capture them,
and they live and die with the workspace directory itself. Files a
command writes to the host's real `/tmp` are likewise outside LayerFS
management — if it matters, it belongs in the workspace.

## Backends

- **native** — the real LayerFS through its JavaScript SDK
  (`@layerfs/agent` from a [layerfs](https://github.com/Ephemeral-AI-Lab/layerfs)
  checkout; the SDK is not on npm, and its native binding must be built —
  `npm --prefix api run build:native`, producing `api/binding/layerfs.node`).
  **Off by default**: it runs only
  when the user opts in — the plugin's `"native"` option, or
  `MAGPIE_LAYERFS_NATIVE=1` — with `LAYERFS_SDK_PATH` set (the SDK
  entry, `api/agent/sdk/src/index.js`); `LAYERFS_STORE_PATH` is optional and
  only anchors the store volume elsewhere. When it runs, **every SDK
  call happens in a child process** (`native-worker.mjs`, shipped in
  this package): the plugin host process never imports the SDK and
  never has `LAYERFS_*` variables written into its shared environment —
  the worker gets its own. A pinned npm dependency would be tidier,
  but the SDK is not published to npm, so a version pin does not exist
  to pin; the opt-in plus the subprocess is the mitigation. Adapted
  and verified against a locally built binding (LayerFS 1.1.0): the
  SDK's store calls (project / branch / fs) run in the worker, so
  provision materializes a *checkout* of the branch through
  `fs.list` / `fs.read`, and a checkpoint diffs that checkout and
  lands as one `fs.apply` commit in the engine's own store, with the
  engine's chunk-level dedup. Real workspace mounts (`workspace.*`)
  need a LayerFS deployment (Docker, `LAYERFS_IMAGE`, a daemon) that
  a magpie host does not provide; where one exists, that is the
  natural next step. Two engine limits shape this backend, both
  reported upstream: binary files cannot round-trip through the fs
  surface (writes accept bytes — `fs.write`, and `fs.apply` since
  upstream PR #416 — but `fs.read` refuses binary content with code
  Binary, upstream issue #417, so checkouts and checkpoints name the
  binary files they cannot move instead of dropping them), and
  `LayerFS.init` refuses a source tree on overlayfs with an opaque
  `Project(InvalidInput)`. Project init runs through that factory,
  whose timeout the SDK makes configurable (300 s by default; 1.0.0's
  fixed 60 s is gone) — this backend keeps the SDK default.
- **sim** (the default) — a local content-addressed store implementing
  the same model: immutable blobs named by SHA-256, branches as
  manifest pointers, checkpoints as deduplicated manifests, under
  `MAGPIE_LAYERFS_HOME` (default `~/.magpie-layerfs`). It runs
  anywhere, which is what the tests and the benchmark below use.

`MAGPIE_LAYERFS_BACKEND=auto|native|sim` selects explicitly; `auto`
picks native only when the user has opted in *and* `LAYERFS_SDK_PATH`
is set.

## Safety defaults

magpie serves plugin tools on its MCP server to any caller holding a
gateway key, and the plugin host runs with the user's rights — so the
defaults here are set for that room, not for a private library:

- **`provision`'s `source` is required.** There is no default: an
  earlier version defaulted it to the host's `directory`, which in
  magpie is the *config* directory (`~/.config/magpie`) — it holds
  `plugin-auth.json`, every signed-in plugin's token. The config
  directory, the credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`),
  the home directory, the filesystem root, and the plugin's own store
  are refused as a source — as the source, inside it, or containing
  it. The comparison runs on real paths (`realpathSync`, case-folded),
  so neither a symlink pointing at a refused directory nor a
  case-variant spelling of one (`~/.Config/Magpie`, `~/.AWS`) gets
  past it.
- **Secret-shaped files never enter the store from an import**:
  `.git`, `.env*`, private keys (`id_rsa`, `id_ed25519`, `*.pem`,
  `*.key`, …), `.ssh`, `.aws`. The sim backend skips them and reports
  how many; the native backend's engine imports a tree whole and
  cannot skip, so it refuses an import that holds them. Imports are
  also bounded (20,000 files / 512 MiB) and fail loudly past the limit
  instead of sweeping a disk.
- **The store is private.** Its root and directories are created
  `0700`, its record files `0600`, whatever the umask says; a file's
  own mode is preserved through the sim store (a `0600` file is stored
  and materialized as `0600`).
- **`exec` is disabled by default.** It runs a shell with the plugin
  host's privileges; a model key should not silently become host
  shell access. The user enables it with the plugin's `"exec"`
  option (set to `true` in magpie's plugin options) or
  `MAGPIE_LAYERFS_EXEC=1` in the host's environment.
- **The native backend is opt-in and subprocess-isolated**, as above.
- **A checkpoint never deletes what it could not move.** On the
  native backend, binaries skipped at checkout are absent locally by
  construction; checkpoints exclude them from the delete set (an
  earlier version's first checkpoint on such a branch deleted every
  one of them). The cost: a skipped binary cannot be deleted from a
  native branch by checkpointing — the fs surface cannot tell
  "deleted here" from "never materialized here". Likewise, when a
  native branch has moved since its checkout, re-provisioning keeps
  the workspace's files and reports `stale: true`, as the sim backend
  does, instead of wiping the directory.

## Benchmark

[`bench/bench.mjs`](https://github.com/Mola-maker/magpie-layerfs/blob/main/bench/bench.mjs)
(run from a checkout of this repo) — a 184-file, 26.8 MB project; 6
parallel agents, each keeping 3 checkpoints (sim backend, this machine):

| | naive copies | this plugin |
|---|---|---|
| fork one more agent | 321 ms, 26.8 MB copied | **~1 ms, 0 bytes** |
| keep 18 checkpoints | 482.6 MB of snapshots | **27.2 MB** of store for 509.4 MB of logical checkpoints (**18.7× dedup**) |
| resolve a file path | walk the copy's tree | **138 µs**, with its checkpoint + SHA-256 |
| total disk for the run | 643.5 MB | **188.1 MB** (store + the 6 live workspaces) |

![test run](https://raw.githubusercontent.com/Mola-maker/magpie-layerfs/29b52fb98fc2e9c20fb9e5c3c85a05f80cd01754/docs/assets/tests.png)
![benchmark](https://raw.githubusercontent.com/Mola-maker/magpie-layerfs/29b52fb98fc2e9c20fb9e5c3c85a05f80cd01754/docs/assets/benchmark.png)

Honest limits: a first provision still materializes the tree once, and the
sim backend rehashes the tree at each checkpoint (the native engine tracks
changes through its daemons instead). What the plugin removes is the
per-agent copy, the per-snapshot copy, and the bytes they waste — the
engine's own benchmarks are at
[layerfs.ai/benchmarks](https://layerfs.ai/benchmarks/).

Against the real engine
([`bench/bench-native.mjs`](https://github.com/Mola-maker/magpie-layerfs/blob/main/bench/bench-native.mjs),
native backend, same scenario, generated-text fixture of 184 files /
27.0 MB): import
3.6 s once; a fork plus its checkout 1.8 s (the branch itself is
metadata; the checkout pays the file reads); a checkpoint 1.9 s (the
checkout diff reads the branch back through the fs surface, then one
`fs.apply` lands it); the engine's store file held **5.6 MB for
513 MB of logical checkpoints** on this compressible text fixture —
the sim fixture above is random bytes, the incompressible extreme, so
read the two ratios as the ends of a range, not a single number.

## The page: watch the trajectory

The package also declares a magpie page, **LayerFS trajectory**
(轨迹), which replays how the agents' worktrees grew, drawn the way
LayerFS's own History picture draws them: main is the green middle
bough, each branch a bough of its own, a checkpoint a badge bearing
its agent's own icon — the marks magpie itself ships for them, in
that agent's colour — a fork a split, and a publish a graft back
onto main that adds a Layer band (L0, L1, …). Two running totals
carry the argument — what those checkpoints would have cost as
plain copies against what the deduplicated store actually wrote,
with a store.stats line in LayerFS's own accounting words. Play it,
scrub it, click a badge for its checkpoint's message and byte
split, or click a branch's name tag to focus that branch alone:
that is what the plugin does for an agent's edits, made visible.

The page is drawn in magpie's own design language and built the way
magpie builds pages — plain HTML, CSS and scripts, no build step and
no dependencies, styled by the host's `--magpie-*` theme tokens with
its tiles, seg controls and indigo accent. The replay runs on
requestAnimationFrame through magpie's own `--ease` curve
(cubic-bezier(.2,.8,.2,1)): the boughs draw themselves as the
playhead passes, each badge lands with a pulse while its icon
draws its own outline and fills in, a publish pops its Layer badge
(L1, L2, …) onto main, and the stat tiles count up with the same
easing; with reduced motion preferred, the page simply shows the
finished picture, every icon fully drawn.

A magpie page cannot read plugin-private data: its sandbox forbids
fetch, and the bridge's reads are a fixed host list (`usage:summary`,
`providers:list`) with no entry a plugin can serve its own data
through. So the page animates the sample bundled with it —
`page/trajectory.js`, a labeled recording from the benchmark scenario
(one project, six agents, three checkpoints each), a package asset
that nothing rewrites at runtime. The trajectory itself is computed
on demand from the store's records whenever it is asked for
(`backend.trajectory()`; `tools/gen-trajectory.mjs` uses it to make
the sample). No recording file is maintained per tool call: an
earlier version refreshed one in the store after every call, which
cost a branch-chain walk per call — growing with the project's
history — for a file the page cannot read, so the refresh was
removed in 0.7.1. The page declares no `magpie.read` permissions,
and its test asserts it asks for none.

## Develop

From a checkout of [this repo](https://github.com/Mola-maker/magpie-layerfs)
(the registry package ships only the runtime files):

```sh
bun test                 # the suite (bun:test): tools end to end, plus the page's layout math
bun bench/bench.mjs      # the benchmark above; writes bench/results.json
node tools/gen-trajectory.mjs   # regenerate the page's bundled sample trajectory
MAGPIE_LAYERFS_NATIVE_TEST=1 LAYERFS_SDK_PATH=<layerfs checkout>/api/agent/sdk/src/index.js bun test
                         # the same suite against the real SDK (the native
                         # backend's logic also runs against a fake SDK —
                         # fake-sdk.mjs — in the plain suite)
```

Zero runtime dependencies; the arguments are JSON Schema, like the other
tools packages. MIT.

## Changes in 0.10.0

The page's live channel comes back, out of the plugin's own folder. The
registry's 0.9.0 (magpie-community/plugins #365) carried the review: the
tools no longer write into the installed package's folder — an update
replaces that folder, two hosts with one install race on the same file,
and an install can be read-only — so its page kept only the bundled
sample, and every desktop that auto-updated lost the live trajectory
(`plugin-updates.json` moved installs from 0.8.0 to the registry's 0.9.0
on 2026-10-26). This version answers both sides at once:

- **The live data lives in the plugin's data directory** —
  `~/.magpie-layerfs/page-data/` (move it with
  `MAGPIE_LAYERFS_DATA_DIR`), beside the store, never inside the
  install. On the first `LayerfsTools()` of a host start, an idempotent
  `ensurePageData` copies the bundled page files there once and points
  the installed package's `page/` at that folder — a junction on
  Windows, a symlink elsewhere — so the host's per-request disk
  serving reads through it; the review's `inside()` guard resolves
  symlinks on both ends and passes the layout. A development checkout
  (a `.git` beside `index.mjs`) is never swapped, only seeded;
  `MAGPIE_LAYERFS_INSTALL_DIR` overrides the install for the tests.
- **The tools write the live file into the data folder** — the same
  debounced, tmp-then-renamed `trajectory-live.js` as 0.8.0, landing in
  the data directory instead of the package. The write needs no swap:
  a read-only install still gets the data folder current, and the page
  follows the next time the swap can be laid.
- **An Agent activity table.** The page now lists every recorded tool
  call — the calling agent, the tool, the project, the branch and the
  time, newest last — under the replay: each agent's provision, fork,
  checkpoint and publish visible per round, answering with what each
  one did to which worktree. The bundled sample carries no events, so
  the section hides itself there; the locales (en, zh, zh-TW, ja) all
  carry the new strings.

`MAGPIE_LAYERFS_PAGE_DIR` still moves the folder the tests point at and
keeps its old meaning. An install whose page folder cannot be swapped
(read-only, a filesystem without junctions) falls back to the bundled
sample, silently; the tools and the data folder are untouched.

## Changes in 0.9.0

The native backend speaks LayerFS 1.1.0. That release split the SDK
(`@layerfs/sdk`, from `sdk/js`) into `@layerfs/agent`, `@layerfs/backend`
and `@layerfs/runtime` (sources under `api/`), and replaced the client
constructor with factories: `LayerFS.open(name)` for an existing
project (a missing one is refused `NoSuchProject` at once) and
`LayerFS.init(name, folder, timeout?)` for a new one, with every
setting read from the environment at creation — the constructor's
options argument is refused, and `close()` is now final. The worker
(the only file that imports the SDK) follows: it sets the project's
`LAYERFS_STORE_PATH` immediately before each factory call, caches the
creation so concurrent calls share one open attempt, drops a refused
attempt instead of caching it, and never closes a client. Init is the
factory call, with the SDK's configurable timeout (300 s by default;
this backend keeps the default) and its answer's Layer read from the
client's `created`. The surfaces this backend uses — `project`,
`branch` and `fs` — kept their calls and answer shapes, so nothing
else moved: the sim backend, the tools and the page are unchanged,
and the fake SDK the plain suite drives was ported to the same
factory shape (`open` refusing `NoSuchProject`, `init` refusing
`Exists`, `fs.read`/`fs.stat` refusing a missing path as
`NoSuchPath`). Verified against a locally built 1.1.0 binding: the
plain suite and the real-SDK suite both pass. `LAYERFS_SDK_PATH` now
points at `api/agent/sdk/src/index.js` in a layerfs checkout, and the
binding builds with `npm --prefix api run build:native`. One upstream
limit is unchanged: `fs.read` still refuses binary content (issue
#417), so the native backend still names the binary files it cannot
move. A store written by LayerFS 1.0.0 opens as it did — the store
format did not change.

## Changes in 0.8.0

The page shows the real trajectory now. The 0.7.x page could only
animate the bundled sample — a magpie page cannot fetch, and the
bridge's reads are a fixed host list — so the live picture the tools
held never reached it. The channel was there all along, though:
magpie serves a page's files from the plugin's folder as they sit on
disk, per request. So:

- **The page's live file.** After any provision, fork, checkpoint,
  publish or exec lands, the tools rebuild the trajectory on demand
  (`backend.trajectory()`) and write it, tmp-then-renamed, to
  `page/trajectory-live.js` in the plugin's own folder — debounced,
  off the tool calls' path, errors swallowed (the page keeps its
  last file; the calls are untouched). The page loads it after the
  bundled sample and prefers it. An empty store writes an empty
  live file, and the page shows its honest empty state instead of
  the demo; the sample remains what a store the tools have never
  written shows. `MAGPIE_LAYERFS_PAGE_DIR` moves the folder (the
  tests point it at a scratch dir, so the suite writes nothing into
  the package).
- **The real agent on every commit.** The tools record the calling
  agent — the tool host's `ctx.agent`, the gateway's name for the
  agent that made the call — on the events and commits each call
  creates. The page prefers it over the branch-name token guess: a
  claude badge lands where claude actually checkpointed, even on
  `main`, and the detail card names the agent. On the native
  backend the publish log carries it; the engine's own commit
  records read no agent (the engine owns its records).

## Changes in 0.7.1

The second round of the PR #318 review — the holes it found in
0.7.0's own new code, plus its smaller items:

- **The source guard compares real paths now.** 0.7.0 compared
  `resolve()`d strings, which a symlink to a refused directory — or
  a case-variant spelling of one on a case-insensitive volume —
  walked straight past (the review imported `plugin-auth.json`
  through `~/.Config/Magpie` and through a symlink). Both sides are
  canonicalized with `realpathSync` and case-folded; refused roots
  that do not exist are canonicalized through their nearest existing
  ancestor. Regression tests cover the symlink and the case variant,
  unit-level and end to end.
- **Breaking on-disk change: workspaces moved, branch encoding
  widened.** Workspaces now live at `workspaces/<project>/<encoded
  branch>` — the flat `<project>--<branch>` name was not injective
  (project `a` branch `b--c` and project `a--b` branch `c` shared one
  directory, and a checkpoint crossed the projects). The branch
  encoder now percent-encodes every character outside `[a-z0-9._-]`,
  uppercase included, so `Main` and `main` no longer share a head
  file or a workspace on case-insensitive volumes either. Stores are
  **not migrated**: branch head files are unchanged for names the old
  encoder already spelled the same way (lowercase, `_`, `-`, `.`,
  and `/`→`%2F`); a branch whose name contains uppercase or `%`
  keeps its commits but its old head file (`branches/Main.json`)
  and old workspace (`workspaces/<project>--Main`) are not picked
  up — re-fork such branches, and remove the old workspace
  directories by hand.
- **No per-call trajectory refresh.** The `trajectory.json` the
  tools maintained in the store after every call is gone: keeping it
  current cost a walk of the touched branch's whole chain per call,
  for a file the page cannot read. `trajectory()` still builds the
  same data on demand.
- **`exec`'s plumbing**: stdin is closed (a command reading it gets
  EOF instead of waiting out the timeout), the child runs detached
  in its own process group and a timeout kills the group, and the
  call resolves on `exit` plus a short drain instead of `close` —
  a background child holding the stdout pipe can no longer hold the
  call open past its shell.
- **Manifests are counted.** `storedBytes`/`dedupRatio` now include
  the commit records — each checkpoint's full manifest — which for
  a wide tree are a real share of the store (the review measured
  128 MB of manifests for 200 checkpoints of a 5,000-file tree,
  previously uncounted, under a description claiming history "costs
  little more than the changes themselves"; the description now
  states the real cost model). Stores written before 0.7.1 keep
  their incremental record, which undercounts by the records written
  before this version until the record is rebuilt (delete
  `accounting.json` to force the rebuild walk).
- The page's README images are pinned to a commit instead of the
  moving `main`.

## Changes in 0.7.0

A safety pass over the whole package (prompted by the PR #318 review):

- `provision` requires `source` explicitly and refuses magpie's config
  directory and the credential stores as sources; imports skip
  secret-shaped files (sim) or refuse them (native), and are bounded.
- `exec` is off by default; the user's `"exec"` plugin option or
  `MAGPIE_LAYERFS_EXEC=1` turns it on.
- The native backend is off by default (the `"native"` option or
  `MAGPIE_LAYERFS_NATIVE=1`) and runs entirely in a child process
  (`native-worker.mjs`); the host process imports no SDK and shares no
  `LAYERFS_*` environment writes.
- A native checkpoint no longer deletes binaries it skipped at
  checkout; re-provisioning a moved native branch reports `stale`
  instead of wiping the workspace; native publish refuses when the
  fork point or main's top Layer is unknown.
- The store and workspaces are `0700`, record files `0600`, and file
  modes are preserved through the sim store.
- The recorded trajectory lives in the store (`trajectory.json`),
  refreshed per affected project; the page's bundled file is a static
  sample, and running the test suite modifies no package file.
- **Breaking on-disk change**: branch head files and workspace
  directories now percent-encode `/` (`feat/x` → `feat%2Fx`), so slash
  branches and `feat__x` no longer collide and slash branches list
  correctly. Stores written by 0.6.x keep working for non-slash
  branches; a slash branch's old head file (`branches/feat/x.json`)
  and workspace (`feat__x`) are not migrated — re-fork slash branches.
- The page gained Japanese and Traditional Chinese string tables
  (matching its declared titles), a magpie-style project menu in
  place of the native `<select>`, and a branch-colour dot on the
  detail card in place of the coloured edge.
