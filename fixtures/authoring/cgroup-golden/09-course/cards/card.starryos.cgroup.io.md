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

固定 commit 的 `io.weight` 和 `io.max` 能保存配置；`io.max` 会先解析全部行，再按 major:minor 对 rbps/wbps/riops/wiops 做局部 upsert，宿主测试覆盖 round-trip、多设备和非法输入原子拒绝。

但源码明确写明 `rdif-block` 没有可安装 token bucket 的队列层，commit-wide 搜索也没有找到 `IoState` 的块层消费者；配置读回不等于真实节流，当前 enforcement 是 absent。Linux cgroup selftests 目录又没有专门的 io/blkio C 用例，所以课程只能把配置持久化作为已核实事实，把吞吐对照负载作为未来连接点补齐后的验证设计。
