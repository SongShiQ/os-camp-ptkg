---
id: card.rcore.analysis-smoke
title: rCore-Tutorial-v3 跨仓库分析冒烟
unit_ids:
  - unit.rcore.analysis-smoke
node_ids:
  - project.rcore.tutorial-v3
  - outcome.rcore.analysis-smoke
  - kc.rust.no-std.kernel-boundaries
source_refs:
  - src.rcore.commit
  - src.rcore.syscall-mod
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码为 `c91bd3752b53ff48555aef4e3c7b8d5ddc8ee6e1` / tree `f649d5b69c790b85ea323edc5c9d02afbbb66104`。真实 project-init 抽取 1023 条事实，其中 5 条因非 Rust 符号能力降级为 unresolved；1018 个锚点中 956 个唯一验证，62 个歧义保持 unresolved。

本样例只证明通用分析和课程编译契约跨仓库可用，不冒充完整 rCore 课程。
