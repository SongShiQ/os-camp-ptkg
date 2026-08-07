# StarryOS cgroup profile

This profile contains the project-specific facts used by the first deep golden sample. It is not part of the generic analyzer or compiler behavior.

The frozen source already contains a modular cgroup implementation and controller work. Authoring must describe the implementation state at the fixed commit rather than present cgroup as a from-scratch project. StarryOS uses `axfs-ng-vfs` traits for cgroupfs, and the current tracking issue is `rcore-os/tgoskits#1188`.

The profile covers the complete cgroup project as the planning root. Course delivery still ends at Project Readiness Gate and does not assign controller implementation work to students.
