# Implementation Status

Last updated: 2026-08-05

PTKG is being expanded from a project-graph validator into a deterministic course compiler. The public contract is `os-camp-course@1`; all AI-produced material remains `candidate` or `unresolved` until a trusted teacher signs a release.

| Gate | Status | Evidence |
|---|---|---|
| G0 independent repository | In progress | Apache-2.0, clean ignore rules, cross-platform CI, generic README |
| G1 generic authoring | In progress | Existing fixed Git/tree/anchor verifier; generic project workspace pending |
| G2 course planner | Pending | Course Package schemas and compiler pending |
| G3 course quality | Pending | `COURSE001+` release rules pending |
| G4 Dream Agent import | Pending | Transactional import and version-scoped repository pending |
| G5 golden courses | Pending | cgroup deep sample exists only as PTKG authoring fixture |
| G6 trusted release | Blocked on implementation | Docker daemon is currently unavailable; real execution cannot be claimed |

Current regression baseline:

- PTKG: 28 tests, typecheck passing.
- Stable cgroup fixture: 16 nodes, 24 edges, 12 sources, 0 findings.
- Fixed source: `rcore-os/tgoskits@fc80b868fb3640efe8997994de42c1aee8fd74cb`, tree `832ce21ea6fdf32a8639c576cc97a137c2d14dcc`.
- Course boundary: tutorial, foundation, pre-project, then Project Readiness Gate. Project work assignment and contribution evaluation are out of scope.
