---
id: card.starryos.cgroup.build-test-debug
title: 固定源码先于一切课程结论
unit_ids:
  - unit.starryos.cgroup.build-test-debug
node_ids:
  - project.starryos.cgroup
  - practice.starryos.cgroup.trace-provider
source_refs:
  - src.tgoskits.pr1379
  - src.starryos.xtask-main
  - src.starryos.cgroup-basic-test
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

课程中的仓库事实必须绑定 40 位 commit 和对应 tree。分支、PR head 和默认分支都会移动，不能作为可重放证据。构建记录还要保存工具链或镜像身份、完整命令、stdout/stderr、退出码和 reset 结果。

测试文件存在只说明固定 tree 中有入口，不说明它成功编译或运行。Docker/QEMU 不可用或基线构建失败时，正确状态是保留真实失败日志并标记 unresolved，而不是用 fixture 或文字描述代替成功证据。
