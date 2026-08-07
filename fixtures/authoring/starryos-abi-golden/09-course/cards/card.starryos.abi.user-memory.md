---
id: card.starryos.abi.user-memory
title: 用户指针、地址空间与 copy 边界
unit_ids:
  - unit.starryos.abi.user-memory
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.contracts
  - kc.rust.no-std.kernel-boundaries
source_refs:
  - src.starryos.abi.user-memory
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/mm/access.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `cfc7bd12751924875332d0cfe524fdab44a84f13`。

本单元的行为边界是：核实用户地址、长度、跨页访问、权限、字符串终止和失败时 EFAULT 路径，禁止直接解引用用户指针。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
