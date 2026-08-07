---
id: card.starryos.cgroup.io
title: io 控制需要跨过设备键、统计和块层节流
unit_ids:
  - unit.starryos.cgroup.io
node_ids:
  - outcome.starryos.cgroup.controller-framework
  - project.starryos.cgroup
source_refs:
  - src.axcgroup.io-rs
  - src.starryos.cgroup-kernel-rs
  - src.tgoskits.pr1379
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

io controller 的配置接受、统计变化和真实吞吐节流是三层不同事实。块层提交路径必须读取 cgroup 状态并实施限制，才形成可观察的资源控制。

Linux cgroup selftests 目录没有专门的 io/blkio C 用例，课程不能引用不存在的标准测试。应在临时来宾镜像上设计受限对照负载，并明确测试来源和适配边界。
