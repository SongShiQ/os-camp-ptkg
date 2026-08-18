# Multi-Agent Authoring Contract

Status: implementation contract for `ptkg-agent-shard@1`.

PTKG supports parallel authoring by isolating every Agent's writes and using one deterministic coordinator to merge results. Multiple Agents must never edit the canonical authoring workspace directly.

## Safety model

```text
frozen canonical workspace
  -> ptkg task-split
  -> .ptkg/coordination/task-plan.json
  -> .ptkg/shards/<shard-id>/manifest.json + instruction.md
  -> agent-workspace/input/context.json (fixed snapshot)
  -> ptkg author --shard <shard-id>
  -> Agent writes only agent-workspace/output/**
  -> ptkg author-seal --shard <shard-id>
  -> ptkg author-merge (dry-run)
  -> conflict/stale/rejected report
  -> ptkg author-merge --write
  -> canonical validation and course compilation
```

- `project_contract`, source identity, global course blueprint, cross-unit prerequisite edges, readiness gate, teacher review, signing, release, Docker and QEMU are single-writer operations.
- `competency_evidence` is split by connected components of required coverage units: units sharing any `behavior_ref` must remain in the same shard.
- `course_assets` is split by non-`project_reference` course unit; each generated card, question, or practice must bind to exactly one authorized unit.
- `code_facts` may be split only after a future source-path claim implementation; the first version keeps it serial.
- Every shard is bound to a normalized `input_hash`, fixed commit/tree, exact checkpoint, explicit scope kind/IDs, and a task-plan manifest hash.
- Agents may emit only `candidate` or `unresolved` content.

## Commands

```text
ptkg task-split <workspace> --agents <2..32> [--checkpoint competency_evidence|course_assets]
ptkg author <workspace> --agent codex|claude|manual --shard <shard-id>
ptkg author-seal <workspace> --shard <shard-id>
ptkg author-merge <workspace> [--write]
ptkg author-recover-lease <workspace> --expected-token <token> --confirm-owner-stopped
```

`task-split` assigns sorted indivisible scope groups round-robin and never overwrites a non-empty shard directory. It atomically replaces the active task plan only after all new shards exist. A changed upstream input gets new hash-qualified shard IDs; older rounds remain on disk for audit but are not part of the active merge. Each manifest contains the only writable output root. `author-seal` snapshots every relative path, byte length and SHA-256 plus one aggregate output hash. `author-merge` is a dry-run by default; it scans and verifies the seal once during planning and again under the coordinator lease immediately before writing. A successful `--write` changes the task-plan state from `active` to `merged`, allowing `ptkg status` to advance while repeated merges remain idempotent.

## Mergeable outputs

The first version accepts only independently keyed, checkpoint-local assets:

- `competency_evidence`:
- `04-behaviors/behavior-chains.jsonl`
- `05-slices/learning-slices.jsonl`
- `course_assets`:
- `09-course/questions.jsonl`
- `09-course/practices.jsonl`
- `09-course/cards/*.md`

Projection nodes/edges/sources, unit definitions, gates, cross-unit dependencies, global YAML, execution results, review events, attestations and runtime artifacts are never shard-mergeable.

## Deterministic merge rules

1. Reject a shard whose `input_hash`, commit, tree, checkpoint, scope kind/IDs, manifest hash or output path no longer matches its active task plan.
2. A shard is not ready until sealed. Reject any output path, byte count or hash that changes after sealing.
3. Reject path traversal, symlinks, undeclared files, invalid JSONL, objects without stable IDs, escaped/overlapping scope claims, and Agent-produced `approved`/`published` status.
4. Same ID and same normalized content is a duplicate and is accepted once.
5. Same ID and different normalized content is a conflict; no canonical file is changed while any conflict, stale shard or rejection exists.
6. JSONL output is sorted by ID using locale-independent UTF-16 code-unit order, serialized as canonical JSON with LF line endings, and written through a sibling temporary file plus rename.
7. Markdown cards use their declared card ID and byte hash. Same ID with different bytes is a conflict.
8. A workspace-scoped lease prevents two coordinators from writing simultaneously. An expired lease is never automatically reclaimed: the operator must verify the old process stopped and explicitly recover the exact reported token.
9. After a write, the coordinator records an auditable merge report and changes the task plan from `active` to `merged`; the caller must then run the ordinary authoring/course validators.

## Parallel development discipline

Use independent Git worktrees or branches for tool development. Merge one reviewed commit at a time, run `npm run check`, then update `README.md`, `STATUS.md` and the daily work log before pushing `main`.
