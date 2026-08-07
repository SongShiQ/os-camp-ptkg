# OS Camp PTKG

OS Camp PTKG is a local-first course compiler for operating-system, kernel, and systems-software projects. A teacher provides a Git repository and, optionally, an Issue, goal, or work document. Codex, Claude Code, or another local coding agent analyzes the frozen source and writes reviewable intermediate artifacts; PTKG applies deterministic validation and compiles them into a versioned Course Package.

```text
Git repository + optional goal/doc
  -> fixed source and code facts
  -> project/task/knowledge graph
  -> teacher review
  -> os-camp-course@1 package
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

## Course Compiler and Release CLI (G2-G3)

Course compilation, validation, signing, and deterministic archiving are available:

```bash
ptkg course-compile <workspace> --out <package-dir>
ptkg course-validate <package-dir> --profile draft|release [--trust-store <file>]
ptkg course-sign <package-dir> --key <ed25519-key> --actor <teacher-id>
ptkg course-pack <package-dir> [--out <archive.tgz>] [--trust-store <file>]
```

`course-compile` reads `09-course/` from a staged authoring workspace and writes normalized JSONL, content hashes, checksums, and the Dream Agent projection. The output directory must be empty. Draft validation permits `candidate`/`unresolved` content only as review findings; release validation blocks it.

`course-sign` accepts an Ed25519 PKCS#8 private key, changes the package to release status only after all non-signature release checks pass, and writes a public attestation. A signature does not trust itself. `course-validate --profile release` and `course-pack` require a separate `ptkg-trust-store@1` file through `--trust-store` or `PTKG_TRUST_STORE`:

```yaml
spec_version: ptkg-trust-store@1
keys:
  - actor: teacher.chen
    public_key: |
      -----BEGIN PUBLIC KEY-----
      ...
      -----END PUBLIC KEY-----
```

## Course Package Contract

The portable contract ID is `os-camp-course@1`:

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

The cgroup authoring fixture now contains one complete candidate calibration unit. It demonstrates compilation and teacher review input; it is intentionally not presented as an approved course or a complete cgroup curriculum.

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
ptkg authoring-execute <dir> ...            Run a constrained evidence worker
```

Exit codes are `0` for success, `1` for validation blockers, and `2` for usage or internal errors. JSON output is available with `--json` where applicable.

## Repository Layout

```text
src/authoring/       Fixed-source authoring and evidence chain
src/project/         Generic project workspace, analyzers, checkpoints, and Agent adapters
src/course/          Course compiler, validation, signing, and packing
schema/              Stable JSON Schema contracts
fixtures/            Golden and deliberately broken examples
test/                Deterministic regression tests
AGENT_INSTRUCTIONS.md Model-independent staged authoring protocol
STATUS.md             Gate-level implementation status
```

The cgroup fixture is the first deep calibration sample, not the product boundary. Planned compatibility samples cover the complete StarryOS Linux ABI/syscall project and cross-repository analysis of rCore-Tutorial-v3.

## Security and Privacy

Do not commit source checkouts, caches, private documents, credentials, signing keys, hidden tests, or student data. Network documents are recorded by URL and digest; local documents carry an explicit privacy classification. Release validation rejects path traversal, checksum mismatches, mutable source references, and missing or untrusted attestations.

## Development

```bash
npm run typecheck
npm test
npm run check
```

CI runs the full check and graph, authoring, and course-package golden validations on Windows and Ubuntu. The G2/G3 baseline contains 37 tests. Rule meanings are append-only: PTKG001-014 retain their existing semantics, while course-package findings use the independent `COURSE001-012` namespace.

See [STATUS.md](./STATUS.md) for the current implementation gate and [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md) for the authoring protocol.

## License

Apache-2.0. See [LICENSE](./LICENSE).
