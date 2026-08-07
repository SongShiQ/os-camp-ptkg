---
id: card.starryos.abi.build-qemu
title: 固定源码、构建矩阵与 QEMU 基线
unit_ids:
  - unit.starryos.abi.build-qemu
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.validation
  - kc.os.build.reproducible-qemu
  - kc.os.testing.four-way-evidence
source_refs:
  - src.starryos.abi.build-qemu
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`xtask/src/main.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `7a02fd7a65a77f3b89abd259259d4b39ce14405a`。

本单元的行为边界是：锁定 commit/tree、Rust 工具链、架构、rootfs 与 QEMU 参数，并保存失败也完整的构建证据。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
