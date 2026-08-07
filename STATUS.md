# Implementation Status

Last updated: 2026-08-07

PTKG is being expanded from a project-graph validator into a deterministic course compiler. The public contract is `os-camp-course@1`; all AI-produced material remains `candidate` or `unresolved` until a trusted teacher signs a release.

| Gate | Status | Evidence |
|---|---|---|
| G0 independent repository | Complete | Public `SongShiQ/os-camp-ptkg`; Windows/Ubuntu CI green |
| G1 generic authoring | Complete | Local/remote Git input, private docs, checkpoints, Agent adapters, generic analyzers |
| G2 course planner | Complete | Deterministic `os-camp-course@1` compiler, calibration unit, normalized hashes and Dream Agent projection |
| G3 course quality | Complete | `COURSE001-012`, Ed25519 trust validation, tamper rejection and deterministic tgz; Windows/Ubuntu CI green |
| G4 Dream Agent import | Complete | `SongShiQ/Dream-Agent:feat/course-package-import`; transactional signed import, immutable versions, cohort pinning and rollback; 203 tests |
| G5 golden courses | In progress | cgroup 14-unit candidate course complete; commit `79ba1eb`, Windows/Ubuntu CI run `31176323277` green; full ABI course and rCore smoke remain |
| G6 trusted release | Blocked on implementation | Docker daemon is currently unavailable; real execution cannot be claimed |

Current regression baseline:

- PTKG: 38 tests, typecheck passing locally on Node 24.
- Stable cgroup fixture: 16 nodes, 24 edges, 12 sources, 0 findings.
- Cgroup authoring source projection: 22 fixed sources; 14 required coverage units have verified source-state records.
- Cgroup course fixture: 4 stages, 14 candidate units/cards/practices, 56 questions and 15 gates; draft validation has 0 blockers and 157 expected teacher-review findings.
- Deterministic course package: 27 files, root `b87c61261094198ae4b840472c05de5e6a0b05ea0dcafc85e19fd9a28976760c` on two independent compilations.
- Fixed source: `rcore-os/tgoskits@fc80b868fb3640efe8997994de42c1aee8fd74cb`, tree `832ce21ea6fdf32a8639c576cc97a137c2d14dcc`.
- Course boundary: tutorial, foundation, pre-project, project context, then Project Readiness Gate. Project work assignment and contribution evaluation are out of scope.
