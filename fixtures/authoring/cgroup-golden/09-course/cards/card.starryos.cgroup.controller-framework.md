---
id: card.starryos.cgroup.controller-framework
title: controller trait 与 factory 分离状态和创建策略
unit_ids:
  - unit.starryos.cgroup.controller-framework
node_ids:
  - outcome.starryos.cgroup.controller-framework
  - competency.starryos.cgroup.pids-implement
source_refs:
  - src.axcgroup.controller-rs
  - src.tgoskits.pr1379
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

`CgroupController` 负责属性与状态行为，`CgroupControllerFactory` 负责注册和按需实例化。registry 让 core 面向统一接口，不需要为每个控制器增加固定字段。

教学实践可以实现一个不连接真实资源的最小控制器，用来验证注册、路由、重复名称和非法属性错误。该 fixture 只证明框架边界，不能被包装成真实的新资源控制器。
