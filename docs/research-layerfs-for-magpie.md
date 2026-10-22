# LayerFS 到底能为 Magpie 带来什么：源码级调研结论

调研方法：6 路并行分头（Magpie 会话存储 / 网关热路径 / agent 与文件状态三线，
LayerFS 机制与官方基准 / dsh 实证 / 同类方案定位），每条结论带一手出处与原始
数字，负面结论与正面结论同等记录。覆盖 6/6，无失败路。

## 一句话结论

LayerFS 对 Magpie 的增益**不在 Magpie 本体运行时**（网关与会话存储两条线均为
「无杠杆」），而在 **agent 工作区经济学**：并行 agent 的工作区分叉、检查点
历史、以及包含未跟踪/生成/构建产物在内的整棵文件树——这正是本插件
provision / fork / checkpoint / history / resolve 咬住的地方，也是 git
worktree、overlayfs、Btrfs/ZFS 快照、Docker 卷都给不了的组合。

## 无杠杆的两条线（先说清边界）

**网关热路径 — lever: none。** 延迟由上游厂商与网络主导：magpie 的用量记录
专门把 Sent（厂商耗时）与 Own（自身耗时）分开记，正是因为出过「厂商扣住
约 100 秒报 503、总时长读作 104 秒」的事故（#1532）。网关本地中间件是进程内
JS 引擎，约 1–1.6 µs/流事件、0.2–0.7 ms/请求；它仅有的磁盘写（usage.jsonl
单行追加、会话亲和文件 2 秒批量落盘、可选的录制/归档 spool）本就是
append/批量/响应后设计。网关请求路径根本不碰任何 agent 工作区。

**会话存储 — lever: none。** Magpie 对 17+ 种 agent 的会话只是**就地读取**
（internal/sessions 只读 agent 自己的 jsonl/数据库），从不复制；它自有的
存储要么有界（网关会话录制默认关、上限 256 MiB / 7 天过期），要么是元数据
缓存（sessions.json 数十 MB、calls-v15 分片，自行剪枝）。它记录在案的痛点
是进程内 CPU/内存扫描（一份 1.3 GB 会话搜索吃满 8 秒预算；账本重建曾把应用
撑到 85 GB 内存），文件系统层修不了。连唯一真正的大复制（Cursor 的
state.vscdb 每次访问复制 5+ 份）Magpie 也已自己用共享快照 + APFS
clonefile（写时复制）修掉了。

## 真增益：agent 工作区经济学

**1. Fork 是元数据操作，毫秒级。** dsh 两次真实运行的逐调用测量：
branch.fork 中位数 3.6–8 ms，复制 0 字节。对比：整树复制一个 26.8 MB
项目约 321 ms 且随树大小线性增长（本插件基准实测）。

**2. 检查点成本随改动大小，不随树大小；历史按内容寻址去重。**
- dsh-dedup 基准：157 份快照（4.94 GB 的树）存成 100.1 MB，比 Btrfs+zstd
  的 1,994.6 MB 小 **19.9×**；156/156 份提交全部 fork+挂载+独立校验读回。
- Wayfare 真实运行：整段历史（147 提交）去重后 3.38 MB（**27×**），
  store 甚至小于最终应用的一份普通拷贝。
- Quarry 真实运行（每份快照含 8.7–11 GB 的 target/）：**4.93 TB 快照存进
  8.90 GB store（去重 166×）**；重复构建探针里，一次 1.2 GB 的平行构建
  只新增 97 KB 存储。
- 检查点延迟随新增字节走：无改动 24 ms、<1 MB 75 ms、均值约 628 ms
  （dsh-dedup 步距 1）；10 万文件一次提交 10.4 s。

**3. 覆盖 git worktree 覆盖不了的状态。** worktree 只共享已跟踪内容在某个
提交上的检出；node_modules、构建产物、生成文件、工具状态都不在其历史内，
要逐个 worktree 重建。LayerFS 的 init 一次性捕获源树、.git、依赖、缓存、
符号链接与被忽略文件，挂载即整棵树到位。对 worktree 的新颖性不在「共享
历史」（它本来就共享对象库），而在**把分支/合并/回退语义扩展到整棵文件
系统状态**。

**4. 小改动只付改动的钱。** OverlayFS 的 copy-up 是整文件复制（改 1 字节
付整文件）；Btrfs 对整文件重写同样记为全量新数据（post-hoc 去重 bees 在
基准里反而更差）。LayerFS 用内容定义分块 + delta 编码，小编辑复用未受影
响的块。

**5. 读回可验证、历史可回退。** fsstress 并发压力后
Commit → fork → 重挂 → 对比，3,755/3,755 条目全等；任意一份提交可 fork
出来审计或选作胜出版本——这是插件 history/resolve 的价值面。

## 不是增益的地方（引用时勿越界）

- **原始 I/O 更慢**：对 libfuse 直通基线，顺序写 0.31×、顺序读 0.81×、
  随机写 0.40×（随机读混合负载才更快，1.49–2.23×）。
- **POSIX 故意收窄**：无 FIFO/套接字/设备节点、无 xattr、无 fallocate、
  只存 mtime；pjdfstest 保留 76% 的 overlayfs 通过项，其余皆为明示的格式
  取舍，且 0 个意外失败。
- **Store 不是耐久存储**：1.0 仅 Disposable 配置，**无崩溃/断电耐久**，
  且尚无垃圾回收、只增不减；定位应是「耐久落地（git/真实文件系统）前面
  的工作区/检查点层」，本插件 README 已如此声明。
- **成品归档 Git 更小**：同一段完成历史，git pack 55.1 MB < LayerFS
  100.1 MB；LayerFS 赢的是「活的、可挂载可写」的历史。
- **单机同内核边界**：所有打开同一 Store 的进程须共享一个 Linux 内核、
  Store 须在本地 ext4/xfs/btrfs 上；跨机共享历史无一手文档支撑，不宣传。
- 官方 core-ideas 页的示意数字官方自注「是示意，不是测量」，不可当基准
  引用；全部 v1.0.0 基准为单样本单次运行，官方自注「不构成对你的负载的
  保证」。

## Magpie 内部还有两个真实复制面（插件当前够不着）

1. **Library 的 copy 模式技能放置**：默认是符号链接（零复制），但用户选
   复制、WSL 内 agent、Claude Desktop、Windows 链接失败回退、项目
   Project.Copy=true 时，走 copyDir 整树重建（.magpie-next + 改名），
   相同字节按（agent + 项目 + 发行版）倍增，且已复制内容带哈希标记
   （.magpie-library）——正好是内容寻址可去重的键；技能类备份还免于
   30 份上限剪枝。可行的扩展是 Magpie 侧加一种 SkillHow='layerfs' 放置
   模式，需 Magpie 配合，不是本插件单方面能做的。
2. **Bun 安装缓存**与已安装副本并存（曾积累 131 个版本）——Magpie 已自
   行加了剪枝。

## 本插件对 dsh 已验证流程的两个缺口（下一步）

dsh 的流程能跑通，靠的不只是 fork/checkpoint，还有两件事本插件还没有：

- **publish（发布成 main 的一层 Layer）**：dsh 里只有主 agent 能发布。
  Wayfare 有过血的教训：从错误分支发布把 main 从 238 个测试打回 38 个
  ——所以 publish 工具必须带护栏：只允许发布「从当前 main 分叉出的
  分支」，发布前报将替换的提交。
- **exec（在工作区里执行并自动提交）**：dsh 的每次 bash 调用即
  mount → run → commit；本插件目前要靠 agent 自己在 provision 给的
  路径里干活、再手动 checkpoint。exec 工具可把「改完即成检查点」变成
  原子一步。

## 证据出处（节选）

- Magpie：internal/sessions/{sessions,gateway,cursor_snapshot}.go、
  internal/usage/usage.go、internal/gateway/{middleware,affinity}.go、
  internal/library/{skills,skill_how,backup}.go、
  internal/plugin/installcache.go、docs/subsystems/{gateway-sessions,
  gateway-middleware,library}.md、issue #1532 / #1988 / #2278。
- LayerFS：layerfs.ai/benchmarks/{dsh-dedup,fs-bench,smallfile,mdtest,
  fio,fsstress,fsx,pjdfstest}、docs/core-ideas、
  docs/general/{concepts,cas_cdc_deltaencoding_handbook}.md、
  dsh/README.md、dsh/demo/{wayfare,quarry}/README.md、仓库 README
  （Disposable 声明）。
- 同类：git-worktree 文档、内核 overlayfs 文档、Docker overlay2/卷文档、
  Btrfs Subvolumes 文档、OpenZFS 概念文档。

## Addendum (2026-10-22): the native adaptation, measured

The native backend was adapted against a locally built LayerFS 1.0.0
binding and its real SDK shapes. What the adaptation established:

- Store calls (project/branch/fs) run in-process; workspace.* calls
  need a deployment (Docker, LAYERFS_IMAGE, a daemon) a magpie host
  does not have. The backend therefore works in checkout mode:
  fs.list/fs.read materialize a branch, fs.apply lands a checkpoint
  as one commit. Native tests (opt-in, real store) pass: import,
  fork (0 bytes), checkpoint, UpToDate, publish as Layer 1,
  trajectory, exec.
- Publish is a Layer append (branch.publish returns a publishedLayer
  chained to the previous top), not a commit on main; main has no
  commits at all (list_commits(main) is NoSuchBranch until a branch
  writes to it directly). The plugin's publish guard is expressed in
  Layer terms: the branch's forkedFrom must equal main's current top
  Layer, or the publish needs force.
- Binary files cannot round-trip through the fs surface: fs.read
  refuses them (code Binary; read-back tracked upstream as issue
  #417), while writes do accept bytes — fs.write reshapes any
  non-string content into a bytes form, and fs.apply accepts a
  `bytes` field per change (its `content` key refused every
  non-string form until upstream PR #416 fixed the wrapper).
  Correction to the first probe report (issue #413): fs.write with
  Buffer/Uint8Array worked all along; only fs.apply's content key
  and the bare-ArrayBuffer/number[] forms failed. Binaries can be
  committed but never read back, so in practice they still enter a
  project via project.init's import.
- project.init refuses a source tree on overlayfs with
  Failed/Project(InvalidInput) and detail null; the same tree imports
  from tmpfs. Reported upstream with a minimal repro.
- A client captures LAYERFS_HOME at construction; one process holds
  one open store per project name; LAYERFS_HOME and store dirs must
  be user-private (0700) or calls fail Unauthorized.
- Native bench (bench/bench-native.mjs, generated-text fixture,
  184 files / 27.0 MB, 6 forks × 3 checkpoints): import 3.6 s; fork +
  checkout 1.8 s avg; checkpoint (full diff + one apply) 1.9 s avg;
  store file 5.6 MB for 513 MB logical. The fixture is templated and
  compressible; the sim bench's random-byte fixture is the other
  extreme.
