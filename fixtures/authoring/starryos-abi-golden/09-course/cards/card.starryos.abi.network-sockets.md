---
id: card.starryos.abi.network-sockets
title: socket 地址、状态机与消息边界
unit_ids:
  - unit.starryos.abi.network-sockets
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.subsystems
  - kc.os.concurrency.lock-and-lifetime
  - kc.os.testing.four-way-evidence
source_refs:
  - src.starryos.abi.network-sockets
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/net/socket.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `d1984829749e6128a21fd9e8678b09611c5d7861`。

本单元的行为边界是：核实地址族、sockaddr 长度、bind/connect/listen/accept 状态转换、阻塞语义、flags 和部分传输。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
