---
id: card.starryos.abi.compat-regression
title: 兼容矩阵、seeded fault 与回归证据
unit_ids:
  - unit.starryos.abi.compat-regression
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.validation
  - kc.os.build.reproducible-qemu
  - kc.os.testing.four-way-evidence
source_refs:
  - src.starryos.abi.compat-regression
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`test-suit/starryos/qemu-smp1/system/syscall-test-compat/src/main.c`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `e235aef46d9e65dce7bae49b51aa3044318dfcf1`。

本单元的行为边界是：从应用行为建立 syscall/架构/错误路径矩阵，先证明测试能识别 seeded fault，再把通过、失败和未运行分开报告。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
