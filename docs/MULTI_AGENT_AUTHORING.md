# Multi-Agent Authoring Contract

Status: implementation contract for `ptkg-agent-shard@1`.

PTKG supports parallel authoring by isolating every Agent's writes and using one deterministic coordinator to merge results. Multiple Agents must never edit the canonical authoring workspace directly.

## Safety model

```text
frozen canonical workspace
  -> ptkg task-split
  -> .ptkg/shards/<shard-id>/manifest.json + instruction.md
  -> Agent writes only .ptkg/shards/<shard-id>/output/**
  -> ptkg author-merge (dry-run)
  -> conflict/stale/rejected report
  -> ptkg author-merge --write
  -> canonical validation and course compilation
```

- `project_contract`, source identity, global course blueprint, cross-unit prerequisite edges, readiness gate, teacher review, signing, release, Docker and QEMU are single-writer operations.
- `competency_evidence` and `course_assets` may be split by required coverage unit.
- `code_facts` may be split only after a future source-path claim implementation; the first version keeps it serial.
- Every shard is bound to a normalized `input_hash`, fixed commit/tree and explicit coverage-unit claims.
- Agents may emit only `candidate` or `unresolved` content.

## Commands

```text
ptkg task-split <workspace> --agents <2..32> [--checkpoint competency_evidence|course_assets]
ptkg author-merge <workspace> [--write]
```

`task-split` assigns sorted required coverage units round-robin and never overwrites a non-empty shard directory. Its manifest contains the only writable output root. `author-merge` is a dry-run by default.

## Mergeable outputs

The first version accepts only independently keyed assets:

- `04-behaviors/behavior-chains.jsonl`
- `05-slices/learning-slices.jsonl`
- `07-projection/nodes.jsonl`
- `07-projection/edges.jsonl`
- `07-projection/sources.jsonl`
- `09-course/units.jsonl`
- `09-course/questions.jsonl`
- `09-course/practices.jsonl`
- `09-course/gates.jsonl`
- `09-course/cards/*.md`

Global YAML, execution results, review events, attestations and runtime artifacts are never shard-mergeable.

## Deterministic merge rules

1. Reject a shard whose `input_hash`, commit, tree, checkpoint or output path no longer matches its manifest.
2. Reject path traversal, symlinks, undeclared files, invalid JSONL, objects without stable IDs, and Agent-produced `approved`/`published` status.
3. Same ID and same normalized content is a duplicate and is accepted once.
4. Same ID and different normalized content is a conflict; no canonical file is changed while any conflict, stale shard or rejection exists.
5. JSONL output is sorted by ID, serialized as canonical JSON with LF line endings, and written through a sibling temporary file plus rename.
6. Markdown cards use their declared card ID and byte hash. Same ID with different bytes is a conflict.
7. A workspace-scoped lease prevents two coordinators from writing simultaneously. A lease may be reclaimed only after its expiry.
8. After a write, the coordinator records an auditable merge report and the caller must run the ordinary authoring/course validators.

## Parallel development discipline

Use independent Git worktrees or branches for tool development. Merge one reviewed commit at a time, run `npm run check`, then update `README.md`, `STATUS.md` and the daily work log before pushing `main`.
