---
id: card.starryos.abi.process-lifecycle
title: clone/exec/exit/wait 进程生命周期
unit_ids:
  - unit.starryos.abi.process-lifecycle
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.subsystems
  - kc.os.process.lifecycle
  - kc.os.concurrency.lock-and-lifetime
source_refs:
  - src.starryos.abi.process-lifecycle
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/task/clone.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `5cbf93c8ea6e4fedd298134a3336b3d65404c68c`。

本单元的行为边界是：贯通 clone flags、资源共享、exec 地址空间替换、exit 通知、wait 回收和失败回滚，而不是只实现一个创建入口。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
