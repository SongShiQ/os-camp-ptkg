# PTKG 拆分指令（给本地 Agent 的唯一权威说明）

**版本**：v0.1 · 2026-07-25
**适用对象**：教师本地运行的任意编码 Agent（Claude Code / Codex / 其他能读文件并执行命令的 Agent）
**你的角色**：把一个真实系统项目拆成可审核的项目—任务—知识图谱（PTKG bundle），交给教师在网页端审核发布，形成学生进入项目阶段之前的完整学习道路。

本文件是模型无关的。无论你是哪个模型，同一份输入必须产出结构一致的 bundle，并且必须通过同一套校验（`ptkg validate`）。校验结果不由你判断——由 CLI 判断。

---

## 0. 先读这四件事，否则你会拆错

1. **项目先导范围决定**：`docs/plans/2026-07-25-StarryOS-cgroup-项目牵引式学习系统/SCOPE-2026-07-26-项目先导边界.md`。完整项目是拆分根，但课程交付止于 Project Readiness Gate；不评价个人贡献，不要求真实 PR。
2. **本仓库的思想边界**：`docs/plans/2026-07-25-StarryOS-cgroup-项目牵引式学习系统/00-思想原则与不可违背的边界.md`
   其中第 7 节「不可违背的禁止事项」对你有强制约束。
3. **拆分规范**：同目录 `02-项目到知识网络的拆分规范.md`（六层结构、节点/关系类型、十步流程、粒度判定）。
4. **事实勘误表**：同目录 `ERRATA-2026-07-25.md`
   如果你的训练数据与勘误表冲突，**以勘误表为准**。特别是：cgroup 在 StarryOS 上已有实现（不是从零做）、VFS 是 `axfs-ng-vfs` 的 `NodeOps`/`DirNodeOps`/`FileNodeOps`（不是 `axfs_vfs` 的 `VfsOps`）、cgroup 跟踪 issue 是 #1188（不是 #782）。

离线事实库在 `docs/plans/information/`，先读 `00-索引与关键结论.md`。**优先用它，不要靠记忆编造仓库事实。**

---

## 1. 你的输入

教师最少只会给你两样东西：

```text
GitHub 仓库 URL
（可选）目标范围：一个 Issue URL、一句话目标，或一份工作文档
```

你要自己补齐其余信息，靠读源码而不是靠猜。如果某件事读不出来，写成 `unresolved` 交教师决定——**不要填一个看起来合理的值**。

## 2. 硬性纪律（违反即为不合格产出）

| # | 纪律 | 为什么 |
|---|---|---|
| 1 | 仓库事实必须绑 **40 位 commit sha**，不能写分支名 | 分支在漂移，分支名记录的事实明天就失效。校验器会用 PTKG006 拦你 |
| 2 | 没读过的文件不许写进 `repo_artifacts` | 凭文件名猜实现是本项目最主要的历史事故来源 |
| 3 | 能力主张必须可观察，禁止「理解 X」「掌握 Y」 | Schema 会用正则拒收。要写「在什么条件下能对什么做什么，并通过什么证明」 |
| 4 | 每个必修 knowledge 至少绑一个 practice | 原则三：实践优先。PTKG005 会拦 |
| 5 | 每个 competency 至少绑一个 evidence，实现类能力的证据不能只是「解释」 | 原则五：证据比自评可信。PTKG004 会拦 |
| 6 | 你只能产出 `candidate` / `unresolved`，**不得写 `approved` 或 `published`** | 原则八：AI 提议，教师发布 |
| 7 | 通用知识优先复用已有 canonical node，项目差异写进 `project_binding` | 04 号方案第 7 节的搭积木模型。重复会被 PTKG009 标记 |
| 8 | 拿不准的一律标 `unresolved` 并写进 `unresolved_questions` | 比编一个答案好得多 |

## 3. 十二步流程

严格按 `11-从项目输入到知识森林发布的完整链路.md` 的状态机执行。压缩版：

```text
01 归档教师输入          → project-input.yaml
02 clone 并锁定 commit   → 记下 40 位 sha，之后所有事实都挂在它上面
03 提取代码事实图        → 模块、符号、调用、测试、入口（只写读到的）
04 识别成果域与工作包    → L1 / L2，按「系统能交付什么」而非教材章节
05 推导能力与证据        → L3 + evidence，先定怎么证明，再定学什么
06 向下拆到基础知识      → L4 practice + L5 knowledge，一直拆到可独立诊断
07 匹配通用知识积木      → 复用 / SPECIALIZES / EXTENDS / CONFLICTS
08 跑校验并修            → ptkg validate <dir>，必须 0 blocker
09 标出该问教师的问题    → unresolved + 高风险项
10 输出 bundle           → manifest + nodes + edges + sources
11 生成报告              → ptkg report <dir>
12 交教师审核            → 你的工作到此结束，不要自行发布
```

### 关于 04 步的一个常见错误

不要把完整项目缩成一个 syscall 或一个函数。cgroup 项目的 L0 是「完善 StarryOS cgroup」，`sys_mount` 只能是某个 practice 的代码触点。反过来也不对：也不要因为「不能缩小」就拒绝拆分——项目内部必须拆到学生能进入。

### 关于课程边界的一个常见错误

L1/L2 是倒推学习内容的项目锚点，不是平台给学生分配的真实贡献。所有学生实践都应在锁定 commit 的隔离教学分支、fixture 或 QEMU 环境完成，产物是 diff、测试、设计与复盘。不要要求真实 PR、个人最低贡献或上游合并；课程出口是“具备进入项目阶段的准备度”。

## 4. 输出格式

一个目录，四个文件：

```text
<bundle-dir>/
├── manifest.yaml     # bundle 身份 + project_ref（必须含 40 位 commit）
├── nodes.jsonl       # 每行一个节点
├── edges.jsonl       # 每行一条边
└── sources.jsonl     # 每行一个来源
```

用 `ptkg init <dir>` 生成骨架。字段定义看 `schema/*.schema.json`——那是唯一权威，不要照抄本文档里的示例当完整字段表。

### 节点 id 命名约定

```text
project.<org>.<project>                    项目
outcome.<org>.<project>.<slug>             成果域
wp.<org>.<project>.<slug>                  工作包
competency.<org>.<project>.<slug>          能力
practice.<org>.<project>.<slug>            实践
kc.<domain>.<topic>.<slug>                 通用知识积木（跨项目复用，不带项目名）
binding.<org>.<project>.<slug>@<commit前7位> 项目绑定
evidence.<org>.<project>.<slug>            证据
src.<source>.<slug>                        来源
```

`kc.` 前缀的节点是**跨项目共享**的，所以 id 里不要出现项目名——否则无法复用。

## 5. 自检：交付前必须跑

```bash
cd tools/ptkg
node src/cli.ts validate <你的bundle目录>
```

要求 **0 blocker**。review 项可以留给教师，但你要在报告里说明每一条为什么留着。

其他有用命令：

```bash
node src/cli.ts lint <dir>              # 只看 blocker
node src/cli.ts validate <dir> --only PTKG006   # 只查 commit 绑定
node src/cli.ts report <dir>            # 生成 Generation Report
node src/cli.ts diff <旧dir> <新dir>     # 增量更新时看影响面
node src/cli.ts rules                   # 全部稳定规则码含义
```

## 6. 参考样例

`fixtures/cgroup-golden/` 是一个通过校验的真实切片（StarryOS cgroup 模块化重构主线，16 节点 / 24 边 / 11 来源，0 findings）。它演示了：

- L0→L5 六层如何连起来；
- `kc.` 通用积木与 `binding.` 项目绑定如何分离；
- 实现类能力如何配 `controlled_change` 级证据；
- 仓库事实如何绑 commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`。

`fixtures/broken/` 是反例集，每条规则都有一个触发案例。想知道某条规则拦的是什么，看它。

## 7. 你不负责的事

- 不判断内容能否发布（教师负责）
- 不给学生打 mastery（服务端证据负责）
- 不修改 `docs/plans/` 下的方案文件
- 不把学生隐私、真实 token 或未公开代码写进 bundle
- 不因为教师催就跳过校验
