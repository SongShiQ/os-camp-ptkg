# OS Camp PTKG

OS Camp PTKG is a local-first course compiler for operating-system, kernel, and systems-software projects. A teacher provides a Git repository and, optionally, an Issue, goal, or work document. Codex, Claude Code, or another local coding agent analyzes the frozen source and writes reviewable intermediate artifacts; PTKG applies deterministic validation and compiles them into a versioned Course Package.

```text
Git repository + optional goal/doc
  -> fixed source and code facts
  -> project/task/knowledge graph
  -> teacher review
  -> os-camp-course@1 (legacy) or os-camp-course@2 package
  -> signed public package + optional teacher overlay Release Set
  -> dry-run / transactional platform import
```

The tool plans the complete project from the top down, while the resulting course lets students learn from the bottom up. Course delivery stops at the Project Readiness Gate. It does not assign upstream work, judge personal contribution, or replace project mentors.

## Design Boundaries

- Local first: source, private documents, and authenticated CLI sessions stay on the teacher's machine.
- Deterministic contracts: the same normalized input produces the same ordering, hashes, and findings.
- Evidence before claims: repository facts bind to a 40-character commit and verified source anchor.
- Practice first: required knowledge is connected to code-oriented practice and observable evidence.
- Human release authority: agents may emit only `candidate` or `unresolved`; trusted teachers sign releases.
- Reusable knowledge: canonical nodes are shared; project differences are represented by bindings.
- Rust first, not Rust only: analyzers use a plugin interface and degrade honestly when symbol analysis is unavailable.

## Final Six-Project Fusion Design

The next product increment is frozen in [docs/FUSION_DESIGN_V1.md](./docs/FUSION_DESIGN_V1.md). It distills the useful teaching patterns from six public OS education projects without merging their repositories or copying unlicensed content. Student learning effect is the admission gate: fixed real source, whole-behavior learning episodes, typed assertions, targeted remediation, and teacher-governed evidence enter the core; prediction/replay and richer UI remain measured experiments.

The design intentionally keeps `os-camp-course@1` unchanged for historical packages. F1 now implements the separate `os-camp-course@2` contract layer: structured Practice Contracts, typed assertions, Evidence Envelopes, source bridges, deterministic public projections, teacher-private overlays, and `os-camp-release-set@1`. The first real StarryOS `@2` golden course is still F2 work; the new contract should therefore be read as an implemented compiler/release foundation, not as proof that a teacher has approved a production course.

## Requirements

- Node.js 24 or later
- Git
- Optional: an authenticated `codex` or `claude` CLI for automated authoring
- Optional: Docker for trusted build and execution evidence

## Quick Start

```bash
npm ci
npm run check

# Verify the existing cgroup PTKG sample.
npm run ptkg -- validate fixtures/cgroup-golden
npm run ptkg -- authoring-validate fixtures/authoring/cgroup-golden
```

## Project Authoring (G1)

Project initialization and checkpointed Agent authoring are available:

```bash
ptkg project-init <workspace> --repo <url-or-local-path> [--goal <text>] [--doc <path-or-url>]... [--ref <sha>]
ptkg author <workspace> --agent codex|claude|manual
ptkg status <workspace>
```

`project-init` freezes a 40-character commit and tree, stores remote checkouts under the user cache, classifies local documents as private, and runs Git/Markdown/Cargo/Rust analyzers. Unsupported languages degrade to file-level unresolved facts. `manual` writes the next checkpoint instruction; the other adapters invoke the already-authenticated local CLI and do not persist API keys.

If a repository contains several plausible project goals, initialization stops at the project-contract checkpoint instead of silently choosing one.

### Parallel Agent Authoring

After the project contract, fixed source, and global project skeleton are frozen, two checkpoints may run in parallel. `competency_evidence` is split by connected groups of required coverage units; units that share a behavior chain stay together. `course_assets` is split by non-`project_reference` course unit, while the blueprint, unit definitions, cross-unit edges, gates, and readiness design stay serial:

```bash
ptkg task-split <workspace> --agents 3 --checkpoint competency_evidence
ptkg status <workspace>

# Run one command per shard shown by task-split/status. These may run concurrently.
ptkg author <workspace> --agent codex --shard <shard-id>
ptkg author <workspace> --agent claude --shard <shard-id>
ptkg author <workspace> --agent manual --shard <shard-id>

# Each completed output must be sealed before merge.
ptkg author-seal <workspace> --shard <shard-id>

# The coordinator previews before writing.
ptkg author-merge <workspace>
ptkg author-merge <workspace> --write
```

Each Agent receives an input-hash-bound manifest, a read-only context snapshot, and a separate `agent-workspace/output/` as its only candidate-output root. Codex runs with the isolated Agent workspace as its `workspace-write` root. Sealing records every output path, byte length, SHA-256, and one aggregate output hash; adding, deleting, or modifying a file after sealing invalidates the shard. An active task plan identifies the current round, so older shards remain auditable without blocking a newer split. A successful write marks the round as merged and `ptkg status` advances to the next real checkpoint. The merge coordinator rejects stale source/input identities, path traversal, symlinks, undeclared files, authority escalation, overlapping scope claims, and same-ID/different-content conflicts. Same-ID/same-content values deduplicate; successful JSONL output is canonical and sorted by locale-independent UTF-16 code-unit order.

The coordinator lock is never taken over automatically after expiry. If a process stopped without releasing it, inspect the reported owner/token, verify that the old process is no longer running, then explicitly recover it:

```bash
ptkg author-recover-lease <workspace> --expected-token <token> --confirm-owner-stopped
```

Global project contracts, commit/tree selection, source facts, L0-L2 skeletons, course blueprints, cross-unit prerequisites, the Project Readiness Gate, teacher review/signing, and Docker/QEMU execution remain single-writer operations. See [docs/MULTI_AGENT_AUTHORING.md](./docs/MULTI_AGENT_AUTHORING.md) for the exact contract.

## Course Compiler and Release CLI (G2-G3 and F1)

Course compilation, validation, signing, and deterministic archiving are available:

```bash
ptkg course-compile <workspace> --out <package-dir>
ptkg course-validate <package-dir> --profile draft|release [--trust-store <file>]
ptkg course-sign <package-dir> --key <ed25519-key> --actor <teacher-id>
ptkg course-pack <package-dir> [--out <archive.tgz>] [--trust-store <file>]

# New F1 contract; @1 remains the default.
ptkg course-compile <workspace> --out <package-dir> --contract os-camp-course@2
ptkg course-sign <package-dir> --key <ed25519-key> --actor <teacher-id> \
  --out <release-set.json> --trust-store-id <id> [--overlay <teacher-overlay-dir>]
ptkg release-set-validate <release-set.json> --package <package-dir> \
  --trust-store <trusted-keys.yaml> [--overlay <teacher-overlay-dir>]
ptkg course-migrate-v2 <course-v1-dir> --out <migration-gaps.json>
```

`course-compile` reads `09-course/` from a staged authoring workspace and writes normalized JSONL, content hashes, checksums, and rebuildable projections. The output directory must be empty. `@1` stays the default so existing workspaces and hashes do not silently change. `@2` additionally requires `blueprint-v2.yaml`, `composition-manifest.json`, `source-bridges.jsonl`, `assertions.jsonl`, `remediations.jsonl`, and the upgraded practice/gate objects. Draft validation permits candidates only for teacher review; release validation blocks unreviewed or unresolved high-impact content.

For `@1`, `course-sign` retains the original behavior: it accepts an Ed25519 PKCS#8 private key, promotes the package only after preflight checks, and writes a package attestation. For `@2`, it instead signs a Release Set that binds the public package root, optional teacher-overlay root, source-composition root, schema versions, and trust policy. A signature does not trust itself; `release-set-validate` requires a separate `ptkg-trust-store@1`.

`course-migrate-v2` deliberately writes a deterministic gap report rather than inventing source anchors, typed assertions, trusted evidence, or overlay semantics that did not exist in `@1`.

```yaml
spec_version: ptkg-trust-store@1
keys:
  - actor: teacher.chen
    public_key: |
      -----BEGIN PUBLIC KEY-----
      ...
      -----END PUBLIC KEY-----
```

## Course Package Contracts

The legacy portable contract ID is `os-camp-course@1`:

```text
manifest.yaml
graph/nodes.jsonl
graph/edges.jsonl
graph/sources.jsonl
course/stages.jsonl
course/units.jsonl
course/questions.jsonl
course/practices.jsonl
course/gates.jsonl
content/cards/*.md
governance/review-events.jsonl
governance/attestations.jsonl
projections/dream-agent-v1.json
checksums.json
```

Stages are `tutorial`, `foundation`, `pre_project`, and `project_reference`. The last stage provides project context only. A required unit must have a knowledge card, a code or high-fidelity practice, two diagnostic/remediation questions, two checkpoint questions, and a trusted-evidence gate. `COURSE001-012` enforce structure, paths/checksums, graph references and DAGs, assets, question pools, evidence, fixed source, review status, reuse metadata, privacy, signature trust, and projection consistency.

New fusion courses use `os-camp-course@2` and add:

```text
course/assertions.jsonl
course/remediations.jsonl
course/source-bridges.jsonl
governance/release-receipts.jsonl
projections/knowledge-forest-v1.json
projections/practice-definition-v1.json
projections/dream-agent-v2.json
```

The teacher-review projection stays under the private authoring workspace and is never packed into the public course. Hidden assertions, trusted harness material, reference patches, and answers live only in `os-camp-teacher-overlay@1`. A signed `os-camp-release-set@1` binds that overlay (or explicit `null`) to exactly one public package and source composition. Any root replacement under the same course version is rejected.

Release receipts embedded before final signing may leave `public_package_root` and `release_set_root` as `null`; the Release Set signature subsequently commits to the package containing those receipts. Student-attempt and mastery evidence may not use this pre-release form and must bind the final roots. This avoids a circular hash while keeping the evidence inside the signed release identity.

## G5 Golden Courses

The cgroup authoring fixture is the first deep candidate course: 4 stages, 16 required units, 16 cards, 64 questions, 16 practices, and 17 gates culminating in one Project Readiness Gate. It starts with fixed-source repository navigation, then covers build/test/debug, cgroup core and cgroupfs, membership, controller and provider boundaries, delegation, pids/cpu/memory/cpuset/io, kernel integration, concurrency, and a final complete-project context reconstruction. The `project_reference` stage is required context only: it does not assign issues, pull requests, or contribution work. Partial controllers explicitly separate file/state presence from accounting, kernel enforcement, and executed evidence. Under the D8 scope decision, this fixture is a cgroup project-reference candidate plus a separate executable-specialization candidate; its unresolved S0/S2/S3 evidence does not block the public StarryOS core. Public executable units will be rebound to a teacher-selected `starryos_merged_baseline` commit/tree before release.

The second deep fixture covers the complete StarryOS Linux ABI/syscall compatibility project as a backward-design root. It contains 4 stages, 16 required units/cards/practices, 64 questions, and 17 gates across fixed builds, Rust `no_std`, ABI contracts, user memory, dispatch, process/VFS/MM, signals, futex, IPC, time, networking, event multiplexing, security/resources, and compatibility regression. The two StarryOS courses reuse six byte-equivalent canonical nodes for build/QEMU, `no_std`, process lifecycle, `axfs-ng-vfs`, concurrency, and four-way test evidence.

`rCore-Tutorial-v3` is a deliberately small cross-repository smoke fixture. Its evidence records a real fixed-source analysis of 1,023 facts and 1,018 anchors at commit `c91bd3752b53ff48555aef4e3c7b8d5ddc8ee6e1`; it proves analysis and compilation portability without pretending to be a complete rCore course. Every golden item remains `candidate` or `unresolved`; none of these fixtures is an approved or release-ready course.

## Trusted Execution Worker (G6 In Progress)

The evidence Worker can execute one learning slice against a verified fixed commit and tree:

```bash
ptkg authoring-execute <workspace> \
  --slice <slice-id> \
  --image <name@sha256:digest> \
  --run-command <command> \
  [--fault-command <command> --fault-ref <stable-id>] \
  [--test-classes positive,negative,concurrency,regression] \
  [--expected <text>] [--cache-dir <dir>] [--runtime-cache <prepared-cache-dir>]
```

The Worker refuses floating image tags and uses `--pull never`. It verifies the image's reported digest, creates a detached disposable Git worktree, disables network access, host secrets and push, applies memory/PID/time limits, and removes both the worktree directory and Git registration. On Windows the default worker root is the short path `<drive>:\\ptkg-workers`; elsewhere it is the run workspace's ignored `.ptkg/workers/`. `PTKG_WORKER_DIR` may supply an explicit absolute alternative. Every worker checkout enables Git long-path support and forces `core.autocrlf=false` / `core.eol=lf`, preserving frozen shell-script bytes for the target guest. Keeping build/QEMU staging on the workspace volume avoids silently exhausting a small system temporary disk. QEMU may create Linux symlinks that Windows cannot remove reliably, so the evidence shell installs an exit/signal trap that deletes only `qemu-cases` run directories. Each evidence phase also records a container ID; after a timeout the Worker force-stops that container and invokes the same fixed image, offline and with only the writable runtime target mounted, as a bounded cleanup fallback. Before a seeded-fault phase it resets tracked files and removes untracked/ignored files, then verifies the original commit, tree and clean status. A fault is counted as detected only when its command exits non-zero without timing out and prints an exact line `PTKG_SEEDED_FAULT_DETECTED:<fault-ref>`; an injection/build script error without that marker cannot create false S3 evidence.

Execution artifacts are written under the ignored `reports/execution/<execution-id>/` directory. Each executable slice must declare exactly one stable `execution_refs` ID; the Worker writes that ID directly so the result cannot become detached from the slice. The public result stores artifact hashes and safe relative paths, not host checkout/cache paths. Declared slice tests are not treated as executed coverage: failed runs report every test class as false, and successful S2/S3 evidence must explicitly identify the classes actually exercised. S2 implementation evidence and S3 seeded-fault discrimination use separate slices/results. Repeating the same run/slice upserts one result instead of appending duplicates. When `--runtime-cache` is supplied, the Worker re-verifies its source/image binding and every asset hash, mounts assets read-only, and uses a disposable writable copy; it rejects cache mutation or overlays that replace frozen source.

The frozen tgoskits image is available under its verified digest. `ptkg authoring-runtime-prepare <run> --image <digest> --prepare-command <cmd> --out <cache-dir>` prepares an external, source/image/command-bound offline cache for toolchains, generated inputs and QEMU assets; it hashes every asset and rejects identity drift or mutations before a formal run may consume it. A prepare command that generates workspace-overlay files required by its own build must materialize that overlay in `/workspace` after verification and before invoking the build; the prepared cache remains the source for the later network-disabled replay. The current cgroup runtime cache is complete and verified, but the persisted formal mount S0 run still timed out before the guest test emitted a result. Real mount S0, pids S2 and seeded-fault S3 therefore remain unresolved. The three succeeded results in `fixtures/authoring/cgroup-golden` demonstrate the data contract only; a floating tag, runtime preparation output, or fixture result must not be substituted for the release gate.

## Available PTKG Commands

The original graph and authoring commands remain supported:

```text
ptkg init <dir>                            Create a four-file PTKG bundle
ptkg validate <dir>                        Run PTKG001-014
ptkg lint <dir>                            Show blockers only
ptkg diff <old> <new>                      Compare two graph bundles
ptkg report <dir>                          Render a generation report
ptkg pack <dir> -o <out.json>              Pack the legacy graph bundle
ptkg rules                                 List stable graph rules
ptkg authoring-init <dir>                  Create intermediate authoring artifacts
ptkg authoring-validate <dir>              Validate the authoring chain
ptkg authoring-hash <dir> [--write]        Verify normalized SHA-256 hashes
ptkg authoring-verify-workspace <dir>       Verify commit, tree, paths, and symbols
ptkg authoring-impact <old> <new>           Build an incremental impact report
ptkg authoring-execute <dir> ...            Run the fixed-source disposable evidence worker
ptkg task-split <dir> --agents <n>          Create input-bound, isolated Agent shards
ptkg author <dir> --agent <kind> --shard <id> Run one shard through a local Agent
ptkg author-seal <dir> --shard <id>          Seal all output paths and hashes
ptkg author-merge <dir> [--write]           Preview or apply a deterministic shard merge
ptkg author-recover-lease <dir> ...          Explicitly clear one verified stale coordinator lease
```

Exit codes are `0` for success, `1` for validation blockers, and `2` for usage or internal errors. JSON output is available with `--json` where applicable.

## Repository Layout

```text
src/authoring/       Fixed-source authoring and evidence chain
src/project/         Generic project workspace, analyzers, checkpoints, and Agent adapters
src/course/          Legacy course compiler plus the explicit v2 contract/release workflow
schema/              Stable JSON Schema contracts (`@1`, Practice/Evidence, composition, `@2`, Release Set)
fixtures/            Golden and deliberately broken examples
test/                Deterministic regression tests
AGENT_INSTRUCTIONS.md Model-independent staged authoring protocol
STATUS.md             Gate-level implementation status
```

The fixtures are calibration samples, not the product boundary. `scripts/generate-g5-fixtures.ts` deterministically rebuilds the shared StarryOS trunk, the complete ABI candidate course, and the rCore cross-repository smoke artifacts.

## Security and Privacy

Do not commit source checkouts, caches, private documents, credentials, signing keys, hidden tests, or student data. Network documents are recorded by URL and digest; local documents carry an explicit privacy classification. Release validation rejects path traversal, checksum mismatches, mutable source references, and missing or untrusted attestations.

## Development

```bash
npm run typecheck
npm test
npm run check
```

CI runs the full check and graph, authoring, and course-package golden validations on Windows and Ubuntu. The current local baseline contains 97 tests (96 pass, 0 fail, one Windows symlink-permission skip), including deterministic G5 fixture regeneration, the 16-unit cgroup course, the 16-unit ABI course, exact shared-node reuse, the rCore smoke compilation, sealed multi-Agent CLI/split/merge/lease/scope safety, runtime-cache/overlay security cases, and the F1 `@2`/Practice/Evidence/bridge/Release Set/migration tests. Rule meanings are append-only: PTKG001-014 retain their existing semantics, while course-package findings use the independent `COURSE001-012` namespace.

See [STATUS.md](./STATUS.md) for the current implementation gate and [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md) for the authoring protocol.

## License

Apache-2.0. See [LICENSE](./LICENSE).
