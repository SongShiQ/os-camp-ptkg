# Implementation Status

Last updated: 2026-08-07

PTKG is being expanded from a project-graph validator into a deterministic course compiler. The public contract is `os-camp-course@1`; all AI-produced material remains `candidate` or `unresolved` until a trusted teacher signs a release.

| Gate | Status | Evidence |
|---|---|---|
| G0 independent repository | Complete | Public `SongShiQ/os-camp-ptkg`; Windows/Ubuntu CI green |
| G1 generic authoring | Complete | Local/remote Git input, private docs, checkpoints, Agent adapters, generic analyzers |
| G2 course planner | Implemented, CI pending | Deterministic `os-camp-course@1` compiler, calibration unit, normalized hashes and Dream Agent projection |
| G3 course quality | Implemented, CI pending | `COURSE001-012`, Ed25519 trust validation, tamper rejection and deterministic tgz |
| G4 Dream Agent import | Pending | Transactional import and version-scoped repository pending |
| G5 golden courses | Pending | cgroup deep sample exists only as PTKG authoring fixture |
| G6 trusted release | Blocked on implementation | Docker daemon is currently unavailable; real execution cannot be claimed |

Current regression baseline:

- PTKG: 37 tests, typecheck passing locally on Node 24.
- Stable cgroup fixture: 16 nodes, 24 edges, 12 sources, 0 findings.
- Course fixture: 1 candidate unit, 1 card, 1 high-fidelity practice, 4 questions and 1 gate; draft validation has 0 blockers.
- Fixed source: `rcore-os/tgoskits@fc80b868fb3640efe8997994de42c1aee8fd74cb`, tree `832ce21ea6fdf32a8639c576cc97a137c2d14dcc`.
- Course boundary: tutorial, foundation, pre-project, then Project Readiness Gate. Project work assignment and contribution evaluation are out of scope.
