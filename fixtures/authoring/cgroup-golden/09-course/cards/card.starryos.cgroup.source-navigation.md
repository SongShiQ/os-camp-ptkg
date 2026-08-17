---
id: card.starryos.cgroup.source-navigation
title: 从仓库入口定位 cgroup 完整系统地图
unit_ids:
  - unit.starryos.cgroup.source-navigation
node_ids:
  - project.starryos.cgroup
  - outcome.starryos.cgroup.modularization
  - outcome.starryos.cgroup.controller-framework
  - practice.starryos.cgroup.trace-provider
  - kc.os.build.reproducible-qemu
  - kc.rust.no-std.kernel-boundaries
  - kc.os.process.lifecycle
  - kc.os.vfs.axfs-ng-vfs-traits
source_refs:
  - src.tgoskits.pr1379
  - src.starryos.xtask-main
  - src.axcgroup.cargotoml
  - src.starryos.cgroup-kernel-rs
  - src.starryos.cgroupfs-rs
  - src.starryos.cgroup-pids-test
status: candidate
generated_by:
  tool: '@os-camp/ptkg'
  version: 0.4.0
  agent: g5-golden-course
content_hash: ''
---

这张卡的目标不是让你背仓库目录，而是建立一条可以反复重放的源码导航方法。先锁定 `fc80b868fb3640efe8997994de42c1aee8fd74cb` 和对应 tree，再从构建入口追踪到实际声明、调用者和测试。

可以先按四层建立地图：

1. 构建与运行入口：从 `xtask/src/main.rs` 找到 StarryOS 的构建、rootfs、QEMU 和测试参数。
2. 通用 cgroup 子系统：在 `components/ax-cgroup/` 核对 core、controller、provider 和五个 controller 的声明与状态。
3. 内核和文件系统连接：在 `os/StarryOS/kernel/src/cgroup/`、`os/StarryOS/kernel/src/pseudofs/cgroup.rs` 核对 provider、挂载和属性文件的实际接入。
4. 验证入口：定位 cgroup-basic、cgroup-pids 及相关宿主测试，把“存在测试入口”和“测试已经通过”严格分开。

每个地图节点都要记录唯一声明、直接调用者、错误路径和测试证据。只看到文件名、同名调用或目录结构时，结论必须保持 `unresolved`。共享的 Rust/no_std、进程生命周期、VFS 和构建能力属于可复用底座；cgroup 层级、controller 和内核连接则属于项目绑定。这样后续换成 syscall 或另一个系统项目时，导航方法可以复用，但不会把项目差异误当成通用知识。
