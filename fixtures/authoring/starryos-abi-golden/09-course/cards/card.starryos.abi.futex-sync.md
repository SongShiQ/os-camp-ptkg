---
id: card.starryos.abi.futex-sync
title: futex、唤醒竞态与同步合同
unit_ids:
  - unit.starryos.abi.futex-sync
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.subsystems
  - kc.os.process.lifecycle
  - kc.os.concurrency.lock-and-lifetime
  - kc.os.testing.four-way-evidence
source_refs:
  - src.starryos.abi.futex-sync
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/sync/futex.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `320d8293d5eb1476419dd653a9c6d34f69620cc6`。

本单元的行为边界是：核实值比较、等待队列键、超时、唤醒数量、spurious wakeup 和退出清理，并重放已知 wait/wake 回归。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
