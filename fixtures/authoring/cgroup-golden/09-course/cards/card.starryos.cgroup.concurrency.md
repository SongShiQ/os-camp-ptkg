---
id: card.starryos.cgroup.concurrency
title: 并发正确性需要故障判别力和资源复位
unit_ids:
  - unit.starryos.cgroup.concurrency
node_ids:
  - competency.starryos.cgroup.pids-implement
  - kc.rust.static-dyn-singleton
  - evidence.starryos.cgroup.pids-lab
source_refs:
  - src.axcgroup.libr-rs
  - src.axcgroup.pids-rs
  - src.starryos.cgroup-pids-test
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

成员迁移、fork、exit 和 controller 更新共享成员状态、祖先计数与锁。并发测试要验证不超发、不为负、不重复归还，并明确超时和失败后的状态。

seeded fault 通过绕过 pids 限额检查来检验测试判别力：正常版本应通过，故障版本必须失败。最终证据还要包含可丢弃 worktree、资源和计数的 reset 结果；一次 AC 不能替代整个准备度门。
