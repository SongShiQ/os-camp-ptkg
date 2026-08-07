---
id: card.starryos.abi.signals
title: 信号投递、mask、handler 与 sigreturn
unit_ids:
  - unit.starryos.abi.signals
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.subsystems
  - kc.os.process.lifecycle
  - kc.os.concurrency.lock-and-lifetime
source_refs:
  - src.starryos.abi.signals
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/signal.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `ff259fdb062de2a1bb143be54bb82c786b2450ba`。

本单元的行为边界是：贯通信号产生、线程/进程选择、pending/mask、用户栈 frame、handler 和 sigreturn 上下文恢复。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
