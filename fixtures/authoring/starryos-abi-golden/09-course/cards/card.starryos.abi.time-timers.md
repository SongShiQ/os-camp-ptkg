---
id: card.starryos.abi.time-timers
title: 时钟、睡眠与 timer 系列语义
unit_ids:
  - unit.starryos.abi.time-timers
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.subsystems
  - kc.os.testing.four-way-evidence
source_refs:
  - src.starryos.abi.time-timers
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/time.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `3c59a8cb1732c76612c8fe0c972751856f5e9c8f`。

本单元的行为边界是：区分单调/实时时钟、相对/绝对超时、精度、剩余时间、信号中断和定时器资源回收。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
