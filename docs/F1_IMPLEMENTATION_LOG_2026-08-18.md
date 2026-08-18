# F1 Contract Hardening Implementation Log — 2026-08-18

## Scope

This work implements the low-resource F1 contract layer from `FUSION_DESIGN_V1.md`. It does not run Docker, QEMU, StarryOS, WSL builds, or create source checkouts. It does not claim that a real teacher-approved `os-camp-course@2` course already exists.

## Resource and parallel-work decision

- Three independent Agent tasks were started for Practice/Evidence, Release Set, and source composition.
- Two Agents were stopped by the local proxy after physical-memory use exceeded its 90% safety threshold. The third was interrupted to prevent repeated 503 errors.
- Windows reported about 0.37 GiB free physical memory at the low point. WSL was using about 3.3 GiB working set, but it contained active ASR, Ollama/llama-server, API, bridge, and Vite processes. Those user processes were inspected and deliberately left untouched.
- The implementation continued as a single low-memory TypeScript/JSON-Schema task. No large cache, image, checkout, or build output was created.

## Implemented contracts

- `os-camp-course@2` manifest and deterministic package layout.
- `practice-definition@2` with fixed source identity, verified anchors, structured change boundaries, trusted execution, evidence-gated hints, remediation, risk, visibility, and overlay requirements.
- `assertion-definition@1` and `assertion-result@1`, including run-purpose separation and complete public/overlay/source/diff/environment/harness/reset hash bindings.
- `evidence-envelope@1` for release, attempt, and mastery evidence.
- `gate-policy@1`; an infrastructure error produces `pending`, never a pass or student penalty.
- `source-bridge@1` and `composition-manifest@1`; execution, navigation, diff, and runtime evidence cannot cross a source contract.
- `os-camp-teacher-overlay@1` deterministic index and `os-camp-release-set@1` Ed25519 signature/trust verification.
- Deterministic `knowledge-forest`, `practice-definition`, and private `teacher-review` projections.
- Honest `os-camp-course@1 → @2` migration-gap report; missing assertions/evidence are not fabricated.

## Important design correction

A release receipt stored inside the public package cannot itself contain the final public-package and Release-Set roots: those roots depend on the receipt bytes, creating a cryptographic cycle. The implemented rule is:

1. a pre-release receipt may set both final roots to `null`;
2. the teacher signs a Release Set that commits to the public package containing that receipt and to the optional private overlay;
3. student-attempt and mastery evidence must bind the final non-null roots.

No placeholder hash or self-referential checksum is accepted.

## CLI changes

```text
ptkg course-compile <workspace> --out <dir> --contract os-camp-course@2
ptkg course-validate <dir> --profile draft|release
ptkg course-sign <dir> --key <key> --actor <teacher> --out <release-set.json> --trust-store-id <id> [--overlay <dir>]
ptkg release-set-validate <release-set.json> --package <dir> --trust-store <file> [--overlay <dir>]
ptkg course-migrate-v2 <course-v1-dir> --out <report.json>
```

The default compiler remains `@1`; existing workspaces do not silently change contract or hashes.

## Verification completed so far

- `npm run typecheck`: passed during implementation.
- New focused F1 suite: 12/12 passed.
- Final `npm run check`: 97 tests, 96 passed, 0 failed, 1 Windows symlink-permission skip.
- `npm run fixtures:g5`: passed; generated fixtures produced no tracked drift.
- At the time this section was first written, the final diff audit, commit, push, and Windows/Ubuntu CI were still pending. They were completed in the F1 close-out below.

## F1 close-out (2026-08-18)

- Audited the committed diff for source checkouts, caches, private documents, credentials, signing keys, hidden tests, and runtime output; none are tracked.
- Commit `c02224ff9b0c568bb812c068f4a4712625a59d91` was pushed to `origin/main`.
- GitHub Actions run `32103734994` completed successfully on both Windows and Ubuntu.
- The local and remote result is therefore F1 complete. This closes the contract/release foundation only; it does not claim a teacher-approved StarryOS `@2` course or successful cgroup S0/S2/S3 execution.

## Next action

F2 can now start after the teacher supplies the immutable `starryos_merged_baseline` 40-character commit and tree. F2 will build the first real merged-StarryOS `@2` vertical course; cgroup formal execution remains separately unresolved.
