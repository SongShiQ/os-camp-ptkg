---
id: card.starryos.cgroup.cgroupfs
title: cgroupfs 连接用户接口、VFS 和控制器状态
unit_ids:
  - unit.starryos.cgroup.cgroupfs
node_ids:
  - kc.os.vfs.axfs-ng-vfs-traits
  - kc.os.cgroup.hierarchy-semantics
source_refs:
  - src.starryos.cgroupfs-rs
  - src.axfs-ng-vfs
  - src.linux.cgroup-v2-doc
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

StarryOS 宏内核侧使用 `axfs-ng-vfs` 的 `NodeOps`、`DirNodeOps` 和 `FileNodeOps`，属性文件还经过 pseudofs 操作层。它不是 ArceOS unikernel 侧 `axfs_vfs` 的 `VfsOps/VfsNodeOps`。

完整纵切从 `sys_mount` 的 `cgroup2` 分支开始，经 `new_cgroup2fs`、目录 lookup 和属性文件操作到 core/controller 状态。正确实践必须同时覆盖成功观察、未知属性、非法写入和失败后状态不变。
