// LayerFS for every agent magpie connects: instead of each agent copying a
// project tree to work on it, agents share one durable, deduplicated history
// and work through stable workspace paths. Forking a branch for a parallel
// agent copies no file bytes; a checkpoint stores only what changed.
// Arguments are JSON Schema, so the package needs no dependency.
//
// Backends: the real LayerFS through its JavaScript SDK — off by
// default, on only when the user opts in (the plugin's "native"
// option, or MAGPIE_LAYERFS_NATIVE=1) with LAYERFS_SDK_PATH set, and
// always behind a child process — otherwise a local content-addressed
// store with the same model. See layerfs.mjs and the README.
import { checkBranch, checkInnerPath, checkProject, checkSourceDir, createBackend } from "./layerfs.mjs"

const str = (v, name) => {
  if (typeof v !== "string" || !v) throw new Error(`${name} is a non-empty string`)
  return v
}
const opt = (v, name, dflt) => (v === undefined || v === "" ? dflt : str(v, name))

// The plugin's options: magpie hands a plugin its options (the
// magpie.options defaults in package.json, as the user set them) as
// the plugin function's second argument. Two of them are switches
// only the user may flip, because both widen what these tools can do
// with the host's rights: "exec" (run shell commands) and "native"
// (run the LayerFS SDK, in a child process). The MAGPIE_LAYERFS_EXEC /
// MAGPIE_LAYERFS_NATIVE environment variables are the same switches
// for hosts that do not pass options.
export const LayerfsTools = async (ctx = {}, options = {}) => {
  let backendPromise
  const backend = () => (backendPromise ??= createBackend(process.env, options))
  const execEnabled = () => options?.exec === true || process.env.MAGPIE_LAYERFS_EXEC === "1"
  // A call touches only the state its own operation needs. Nothing
  // here maintains a recorded trajectory file: an earlier version
  // refreshed one in the store after every call, at a cost that grew
  // with the project's history, for a file the page cannot read — the
  // trajectory is built on demand by the backend when asked (0.7.1).
  const call = async (fn) => {
    const b = await backend()
    return fn(b)
  }

  return {
    tool: {
      provision: {
        description:
          "Gives the agent a LayerFS workspace for a project branch and answers the filesystem path to work in. " +
          "The first provision of a project imports the source directory the caller passes — source is required, there is no default — as its first checkpoint; " +
          "later provisions of the same branch answer the same path without copying the tree again (source is then ignored). " +
          "Pass the directory the user chose for this project: magpie's config directory, credential stores (.ssh, .aws, .gnupg), the home directory and the plugin's own store are refused as sources, " +
          "and secret-shaped files in the tree (.env*, private keys, .git internals) never enter the store — the sim backend skips them on import and reports how many, the native backend refuses an import that holds them. " +
          "Work in the returned path, then save progress with the checkpoint tool. " +
          "Only the returned path is persistent — work anywhere else, including the host's /tmp, is outside LayerFS management; " +
          "the workspace also carries .tmp/ and .cache/ scratch directories (exec points TMPDIR and XDG_CACHE_HOME at them), which checkpoint and publish never capture.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name, e.g. website" },
            branch: { type: "string", description: "branch to work on (default main)" },
            source: { type: "string", description: "the directory the user chose for this project; imported when the project is first created, ignored afterwards" },
          },
          required: ["project", "source"],
        },
        async execute(args) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          // ctx.directory is magpie's config directory, never a default
          // source: it holds plugin credentials. It is refused as a
          // source here (and in the backend) like the other blocked roots.
          if (args.source === undefined) throw new Error(
            "source is required: the directory to import when the project is first created — pass the directory the user chose for this project")
          const source = checkSourceDir(str(args.source, "source"), { configDir: ctx.directory })
          return call((b) => b.provision(project, branch, source))
        },
      },
      checkpoint: {
        description:
          "Saves the workspace's current state as a deduplicated checkpoint on its branch: only blobs the store has not seen are written. " +
          "The real cost model: the changed blobs, plus one commit record per checkpoint holding the tree's full manifest — " +
          "for a wide tree the manifests are a real part of the store's bytes, and the storage accounting counts them. " +
          "Answers the commit id and the added / modified / deleted counts with the new-bytes and saved-bytes accounting.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch the workspace belongs to (default main)" },
            message: { type: "string", description: "what this checkpoint did" },
          },
          required: ["project"],
        },
        async execute(args) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          return call((b) => b.checkpoint(project, branch, opt(args.message, "message", "")))
        },
      },
      fork: {
        description:
          "Forks a branch of a project for a parallel agent. A fork is a pointer at an existing checkpoint: it copies no file bytes and is ready immediately, " +
          "where copying the tree for another agent costs the whole tree's size and time. Provision the new branch to get its workspace path.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "the new branch's name" },
            from: { type: "string", description: "branch to fork from (default main)" },
          },
          required: ["project", "branch"],
        },
        async execute(args) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(str(args.branch, "branch"))
          const from = checkBranch(opt(args.from, "from", "main"))
          return call((b) => b.fork(project, branch, from))
        },
      },
      publish: {
        description:
          "Publishes a branch's head as main's new state (a Layer), so the work every agent did on that branch becomes what new work forks from. " +
          "Guarded: main's current head must be in the branch's history, so a publish can only move main forward; if main has newer checkpoints the branch never saw, " +
          "the publish is refused and says so. Pass force: true only to overwrite deliberately; the result then reports overwrote and the previous main head.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch to publish to main" },
            force: { type: "boolean", description: "overwrite main even if it has checkpoints the branch never saw (default false)" },
          },
          required: ["project", "branch"],
        },
        async execute(args) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(str(args.branch, "branch"))
          return call((b) => b.publish(project, branch, { force: args.force === true }))
        },
      },
      exec: {
        description:
          "Runs a shell command inside a branch's provisioned workspace and checkpoints whatever it changed as one commit: run, test, fix, all captured in the branch's history. " +
          "DISABLED by default: the command runs with the plugin host's privileges, and magpie serves these tools to remote callers holding a gateway key, so a shell is not something a model key should silently become. " +
          "It runs only when the user has opted in — the plugin's \"exec\" option set to true, or MAGPIE_LAYERFS_EXEC=1 in the host's environment. " +
          "A command that changes nothing commits nothing. A failing command's changes are still checkpointed (history can be rewound), and its exit code, stdout and stderr are returned. " +
          "Only the workspace path is persistent: the command runs with TMPDIR and XDG_CACHE_HOME redirected into the workspace (.tmp/ and .cache/), " +
          "workspace-local scratch that checkpoint and publish never capture, and files written to the host's real /tmp are likewise outside LayerFS management. " +
          "The timeout is capped at 55 seconds, the tools budget.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch whose workspace to run in (default main)" },
            command: { type: "string", description: "the shell command to run in the workspace" },
            message: { type: "string", description: "checkpoint message (default: the command itself)" },
            timeoutMs: { type: "number", description: "timeout in milliseconds (default 50000, capped at 55000)" },
          },
          required: ["project", "command"],
        },
        async execute(args) {
          if (!execEnabled()) throw new Error(
            "layerfs_exec is disabled by default: it runs shell commands with the plugin host's privileges, and these tools are reachable by any caller holding a gateway key. " +
            "To enable it, the user sets the plugin's \"exec\" option to true in magpie's plugin options, or sets MAGPIE_LAYERFS_EXEC=1 in the plugin host's environment, and restarts the host.")
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          const command = str(args.command, "command")
          const message = args.message === undefined ? "" : str(args.message, "message")
          const timeoutMs = args.timeoutMs === undefined ? 50000 : Number(args.timeoutMs) || 50000
          return call((b) => b.exec(project, branch, command, message, timeoutMs))
        },
      },
      history: {
        description:
          "Lists a branch's checkpoints, newest first: commit id, message, time, file count and the logical size of the tree at that point, " +
          "plus how many new bytes that checkpoint actually stored. The history is shared and durable: any agent can read what every other agent committed.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch to read (default main)" },
            limit: { type: "number", description: "how many checkpoints to return (default 20)" },
          },
          required: ["project"],
        },
        async execute(args) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(200, Number(args.limit) || 20))
          return call((b) => b.history(project, branch, limit))
        },
      },
      resolve: {
        description:
          "Resolves a logical LayerFS location to a real filesystem path without copying anything: the workspace path for a project branch, " +
          "or one file inside it, with the checkpoint that path currently answers for and, for a file, its content hash and size. " +
          "Use it to find where a branch lives before reading or handing the path to another tool.",
        args: {
          type: "object",
          properties: {
            project: { type: "string", description: "LayerFS project name" },
            branch: { type: "string", description: "branch to resolve (default main)" },
            path: { type: "string", description: "a file path inside the workspace, relative to its root" },
          },
          required: ["project"],
        },
        async execute(args) {
          const project = checkProject(str(args.project, "project"))
          const branch = checkBranch(opt(args.branch, "branch", "main"))
          const inner = args.path === undefined || args.path === "" ? "" : checkInnerPath(str(args.path, "path"))
          return call((b) => b.resolve(project, branch, inner))
        },
      },
      status: {
        description:
          "Reports the LayerFS backend in use (native or sim), the projects and branches it holds, and the storage accounting: " +
          "the logical bytes of every checkpoint ever taken against the bytes the deduplicated store actually occupies, and the ratio between them.",
        args: { type: "object", properties: {} },
        async execute() {
          return call((b) => b.status())
        },
      },
    },
  }
}
