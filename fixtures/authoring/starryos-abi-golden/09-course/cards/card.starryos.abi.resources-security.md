---
id: card.starryos.abi.resources-security
title: 凭据、rlimit、namespace 与安全边界
unit_ids:
  - unit.starryos.abi.resources-security
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.contracts
  - kc.os.process.lifecycle
  - kc.os.testing.four-way-evidence
source_refs:
  - src.starryos.abi.resources-security
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/resources.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `719146a88eebb1a134aa3b7dbebaea203749730e`。

本单元的行为边界是：核实 uid/gid/capability、rlimit、prctl、namespace 和资源查询的权限、继承及跨架构兼容边界。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
