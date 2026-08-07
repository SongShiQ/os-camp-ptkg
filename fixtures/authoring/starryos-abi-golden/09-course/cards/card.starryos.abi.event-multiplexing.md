---
id: card.starryos.abi.event-multiplexing
title: poll/select/epoll 事件多路复用
unit_ids:
  - unit.starryos.abi.event-multiplexing
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.subsystems
  - kc.os.concurrency.lock-and-lifetime
  - kc.os.testing.four-way-evidence
source_refs:
  - src.starryos.abi.event-multiplexing
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/io_mpx/epoll.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `60477b0e905f814ee40502e1acef771f29924a14`。

本单元的行为边界是：核实 readiness、边沿/水平触发、oneshot、fd 关闭、超时和信号交互，避免把一次可读事件当成完整 epoll 语义。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
