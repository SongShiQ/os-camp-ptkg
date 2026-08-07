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
| G5 golden courses | Local gate complete; publication pending | cgroup and full ABI candidate courses, six shared canonical nodes, real rCore analysis smoke, and Dream Agent dual-course rehearsal pass; awaiting commit/push and Windows/Ubuntu CI |
| G6 trusted release | Not started | Docker/QEMU environment must be rechecked after G5 publication; real execution cannot be claimed without mount/pids/seeded-fault evidence |

Current regression baseline:

- PTKG: 42 tests, typecheck passing locally on Node 24.
- Stable cgroup fixture: 16 nodes, 24 edges, 12 sources, 0 findings.
- Cgroup source projection: 21 nodes, 29 edges, 27 sources, 0 findings; all 14 required coverage units retain verified source-state records.
- Cgroup course: 4 stages, 14 units/cards/practices, 56 questions, 15 gates; draft root `d14cb067c898b431e5ea48b38efd14abf6cbc9eefcec2b431fe1cc6f55e1f37c`, 0 blockers / 167 teacher reviews.
- StarryOS ABI course: 24 nodes, 23 edges, 23 sources; 4 stages, 16 units/cards/practices, 64 questions and 17 gates; draft root `c7671ae44e624e6ee4c86e0a57f13476f32707255aa3dbc647e8779a6fde9eda`, 0 blockers / 180 teacher reviews.
- Shared trunk: both StarryOS packages contain six byte-equivalent canonical nodes covering build/QEMU, Rust `no_std`, process lifecycle, `axfs-ng-vfs`, concurrency and four-way test evidence.
- rCore smoke: fixed commit `c91bd3752b53ff48555aef4e3c7b8d5ddc8ee6e1`, tree `f649d5b69c790b85ea323edc5c9d02afbbb66104`; real analysis recorded 1,023 facts and 1,018 anchors; draft root `e2fdc3c26be190d5198ab77949f1b609b845c9d4d270cad966d5e7b2fc231ffe` with 0 blockers / 23 reviews.
- Dream Agent rehearsal: a clean temporary SQLite accepted both test-reviewed/test-signed packages transactionally, preserved six shared canonical nodes per version, isolated 120 questions and 32 gates, and independently activated both courses.
- Fixed source: `rcore-os/tgoskits@fc80b868fb3640efe8997994de42c1aee8fd74cb`, tree `832ce21ea6fdf32a8639c576cc97a137c2d14dcc`.
- Course boundary: tutorial, foundation, pre-project, project context, then Project Readiness Gate. Project work assignment and contribution evaluation are out of scope.
