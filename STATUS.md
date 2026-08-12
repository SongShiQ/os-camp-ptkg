# Implementation Status

Last updated: 2026-08-12

PTKG is being expanded from a project-graph validator into a deterministic course compiler. The public contract is `os-camp-course@1`; all AI-produced material remains `candidate` or `unresolved` until a trusted teacher signs a release.

| Gate | Status | Evidence |
|---|---|---|
| G0 independent repository | Complete | Public `SongShiQ/os-camp-ptkg`; Windows/Ubuntu CI green |
| G1 generic authoring | Complete | Local/remote Git input, private docs, checkpoints, Agent adapters, generic analyzers |
| G2 course planner | Complete | Deterministic `os-camp-course@1` compiler, calibration unit, normalized hashes and Dream Agent projection |
| G3 course quality | Complete | `COURSE001-012`, Ed25519 trust validation, tamper rejection and deterministic tgz; Windows/Ubuntu CI green |
| G4 Dream Agent import | Complete | `SongShiQ/Dream-Agent:feat/course-package-import`; transactional signed import, immutable versions, cohort pinning and rollback; 204 tests |
| G5 golden courses | Complete | Commit `35eee22`; cgroup and full ABI candidate courses, six shared canonical nodes, real rCore analysis smoke, Dream Agent dual-course rehearsal, and Windows/Ubuntu CI run `31184975233` |
| G6 trusted release | Worker mount strategy repaired; S0 rerun pending | The fixed runtime cache is complete and verified. The prior formal result stopped before QEMU because Rustup tried to update inside a read-only container. The Worker now mounts toolchain, Rustup, QEMU images, firmware metadata and workspace overlay individually as read-only, keeps only `target` writable, and pins `RUSTUP_TOOLCHAIN`; this avoids copying the 8.66GB cache. Local `npm run check` remains 53/53. Formal mount S0, pids S2 and seeded-fault S3 remain unresolved until the new replay produces real QEMU evidence. |

Current regression baseline:

- PTKG: 53 tests, typecheck passing locally on Node 24.
- Stable cgroup fixture: 16 nodes, 24 edges, 12 sources, 0 findings.
- Cgroup source projection: 21 nodes, 29 edges, 27 sources, 0 findings; all 14 required coverage units retain verified source-state records.
- Cgroup course: 4 stages, 14 units/cards/practices, 56 questions, 15 gates; draft root `d14cb067c898b431e5ea48b38efd14abf6cbc9eefcec2b431fe1cc6f55e1f37c`, 0 blockers / 167 teacher reviews.
- StarryOS ABI course: 24 nodes, 23 edges, 23 sources; 4 stages, 16 units/cards/practices, 64 questions and 17 gates; draft root `c7671ae44e624e6ee4c86e0a57f13476f32707255aa3dbc647e8779a6fde9eda`, 0 blockers / 180 teacher reviews.
- Shared trunk: both StarryOS packages contain six byte-equivalent canonical nodes covering build/QEMU, Rust `no_std`, process lifecycle, `axfs-ng-vfs`, concurrency and four-way test evidence.
- rCore smoke: fixed commit `c91bd3752b53ff48555aef4e3c7b8d5ddc8ee6e1`, tree `f649d5b69c790b85ea323edc5c9d02afbbb66104`; real analysis recorded 1,023 facts and 1,018 anchors; draft root `e2fdc3c26be190d5198ab77949f1b609b845c9d4d270cad966d5e7b2fc231ffe` with 0 blockers / 23 reviews.
- Dream Agent rehearsal: a clean temporary SQLite accepted both test-reviewed/test-signed packages transactionally, preserved six shared canonical nodes per version, isolated 120 questions and 32 gates, and independently activated both courses.
- G6 Worker: verifies cached commit/tree, creates and removes a detached disposable worktree, requires an exact image digest already present locally, disables network/secrets/push, limits memory/processes/time, resets source before a seeded-fault phase, writes hashed local artifacts, and uses the slice's single stable `execution_refs` ID for deterministic upsert. Windows defaults to `<drive>:\\ptkg-workers` and forces long-path Git plus LF checkout; non-Windows retains the ignored `.ptkg/workers/` path, and `PTKG_WORKER_DIR` is an absolute-path override. S2 and S3 use independent slices/results. A seeded fault counts only after a non-zero, non-timeout exit with the exact `PTKG_SEEDED_FAULT_DETECTED:<fault-ref>` marker. Fixed-image failure remains `failed/unresolved` and cannot inherit requested test coverage.
- G6 environment: the exact Docker image `ghcr.io/rcore-os/tgoskits-container@sha256:6d3f3af586af971d1570d7993fde2a3ed18c62de1b534efe44bee563cb268c76` is local and its canonical RepoDigest is verified. The frozen source needs an older Rust toolchain, firmware and two QEMU rootfs images absent from the image, so only a separate source/image/command-bound preparation phase may fetch and hash them. Formal evidence continues to run with network disabled; without a succeeded formal execution-result, G6 is not release-ready.
- Fixed source: `rcore-os/tgoskits@fc80b868fb3640efe8997994de42c1aee8fd74cb`, tree `832ce21ea6fdf32a8639c576cc97a137c2d14dcc`.
- WSL reuse check: the same fixed source now builds a RISC-V StarryOS ELF/BIN using the preserved fixed nightly and cached assets. This is a local reproducibility result only: it has no fixed-container execution result or runtime manifest, so it does not advance the G6 release gate.
- Course boundary: tutorial, foundation, pre-project, project context, then Project Readiness Gate. Project work assignment and contribution evaluation are out of scope.
