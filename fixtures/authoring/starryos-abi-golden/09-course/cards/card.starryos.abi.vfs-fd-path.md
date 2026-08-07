---
id: card.starryos.abi.vfs-fd-path
title: VFS、文件描述符、路径与 stat 语义
unit_ids:
  - unit.starryos.abi.vfs-fd-path
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.subsystems
  - kc.os.vfs.axfs-ng-vfs-traits
  - kc.os.concurrency.lock-and-lifetime
source_refs:
  - src.starryos.abi.vfs-fd-path
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/fs/fd_ops.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `97a422d496e8259061598fbea7dcc1439405b971`。

本单元的行为边界是：核实 fd 表生命周期、路径解析、open flags、目录和符号链接边界、stat 布局以及错误优先级。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
