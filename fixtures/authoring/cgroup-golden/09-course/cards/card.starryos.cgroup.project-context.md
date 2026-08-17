---
id: card.starryos.cgroup.project-context
title: 重建完整 cgroup 项目上下文与准备度边界
unit_ids:
  - unit.starryos.cgroup.project-context
node_ids:
  - project.starryos.cgroup
  - outcome.starryos.cgroup.modularization
  - outcome.starryos.cgroup.controller-framework
  - wp.starryos.cgroup.pids-enforcement
  - wp.starryos.cgroup.provider-decoupling
  - kc.os.build.reproducible-qemu
  - kc.rust.no-std.kernel-boundaries
  - kc.os.process.lifecycle
  - kc.os.vfs.axfs-ng-vfs-traits
  - kc.os.concurrency.lock-and-lifetime
  - kc.os.testing.four-way-evidence
source_refs:
  - src.opencamp.project1
  - src.tgoskits.issue1188
  - src.tgoskits.pr1379
  - src.tgoskits.pr1234
  - src.linux.cgroup-v2-doc
status: candidate
generated_by:
  tool: '@os-camp/ptkg'
  version: 0.4.0
  agent: g5-golden-course
content_hash: ''
---

完整项目上下文是课程的收束，不是项目任务分配。请把前面的单元重新放回“完善 StarryOS cgroup v2”这棵树：构建和 no_std 是共享底座，cgroup core、cgroupfs、成员生命周期和 controller framework 是子系统主干，pids 是目前最深的可执行纵向链路，cpu、memory、cpuset、io 则要继续对照调度、页分配、CPU 亲和性和块层连接点。

重建地图时必须同时标出三种状态：

- `present`：固定源码中有唯一声明、生产调用或可核实的执行证据；
- `partial`：接口、状态或局部测试存在，但关键内核连接或运行效果尚未闭合；
- `absent` / `unresolved`：固定源码中没有生产接入，或当前证据不足以做出结论。

准备度报告可以确认学生能否定位代码、解释状态和不变量、完成隔离练习、设计正负/并发/回归验证并表达风险。它不能声称 mount S0、pids S2/S3 已通过，也不能把“能够进入项目阶段”写成已经完成上游功能。报告不提出真实 issue、PR、合并或个人贡献安排；这些属于项目阶段和项目导师的范围。
