# PTKG Staged Authoring Protocol

Version: 1.0

This file is the model-independent protocol for Codex, Claude Code, and manual authoring. The goal is to turn one complete systems project into a reviewable course candidate that ends at the Project Readiness Gate.

## Product Boundary

The complete project is the top-down planning root. Project outcomes and work packages explain why learning content exists; they are not assigned as upstream student contributions.

The generated course may include source reading, controlled modifications, tests, debugging, design comparison, and review exercises in a frozen environment. It must not:

- allocate real project work;
- evaluate personal upstream contribution;
- require a real pull request or merge;
- treat browsing, chat, or self-report as engineering mastery;
- publish AI-generated high-risk content without a teacher signature.

## Minimal Input

`project-input.yaml` is created by `ptkg project-init`. It contains a Git repository locked to a 40-character commit and tree, an optional complete-project goal, and optional document records.

When the goal is missing or several complete projects are plausible, do not choose one silently. Produce candidate project contracts and a short list of questions for the teacher.

Local document bodies and Agent logs live under `.ptkg/`, which is ignored by Git. Never copy private document text into projection, course content, logs intended for publication, or source excerpts.

## Six Checkpoints

Run only the checkpoint reported by `ptkg status <workspace>`.

1. `project_contract`: confirm or propose the complete project goal, non-goals, fixed source and curriculum boundary.
2. `code_facts`: record modules, declarations, dependencies, tests and entry points that were actually read.
3. `project_graph`: create L0 Project Mission, L1 System Outcomes and L2 Work Packages.
4. `competency_evidence`: derive observable L3 competencies, L4 practices, L5 knowledge and direct evidence.
5. `course_assets`: create stages, units, cards, two question pools, practices and gates.
6. `reuse_review`: match canonical knowledge and generate teacher review queues for ambiguity, conflict and risk.

Every checkpoint has an independent file contract and validator. Do not jump directly from a repository to a final course.

## Source Discipline

- Every repository fact binds to the fixed 40-character commit.
- A file name is not evidence that its implementation behaves a certain way.
- A symbol anchor must resolve to exactly one declaration; call sites do not count.
- Unsupported languages degrade to file-level facts with `unresolved` status.
- Facts that cannot be read or verified remain `unresolved` and become teacher questions.
- A branch, tag, abbreviated SHA, or latest default branch is never a release source identity.

## PTKG Layers

```text
L0 project mission
  -> L1 system outcome
    -> L2 work package
      -> L3 observable competency
        -> L4 complete practice
          -> L5 knowledge/code prerequisite
```

Use canonical knowledge IDs such as `kc.rust.ownership.arc` across projects. Represent project-specific semantics with `binding.<project>.*`. Exact reuse requires identical learning goal, prerequisites, and evidence; otherwise propose `specializes`, `extends`, or `conflicts` for review.

Competencies use this form:

```text
Under <conditions>, the student can <observable action> on <object>,
meet <quality criteria>, and prove it with <direct evidence>.
```

Avoid vague claims such as "understand VFS" or "master concurrency".

## Practice and Evidence

Required knowledge must support at least one practice. Each implementation-oriented competency needs evidence stronger than explanation alone.

A complete practice normally includes:

```text
observe -> reproduce -> trace -> controlled change -> test/debug -> review/explain
```

State which positive, negative, concurrency, and regression checks apply. If a class does not apply, record the reason. AI-generated code must not replace the core student responsibility.

## Authority and Status

Agents and deterministic tools may write only `candidate` or `unresolved`. They may not write `approved`, `published`, a teacher acceptance event, or a trusted attestation.

Teacher review order is:

1. behavior chains, slices, and evidence;
2. low-risk metadata in batches;
3. conflicts, suspected duplicates, high-risk content, and high-impact prerequisite edges.

## Required Self-Checks

Use the commands appropriate to the current checkpoint:

```bash
ptkg status <workspace>
ptkg authoring-hash <workspace> --write
ptkg authoring-verify-workspace <workspace>
ptkg authoring-validate <workspace>
ptkg validate <workspace>/07-projection
ptkg course-compile <workspace> --out <empty-package-dir>
ptkg course-validate <package-dir> --profile draft
```

Zero blocker means the artifact may enter teacher review; it does not mean the Agent may release it. Preserve unresolved questions in the status report.

## IDs

```text
project.<org>.<project>
outcome.<org>.<project>.<slug>
wp.<org>.<project>.<slug>
competency.<org>.<project>.<slug>
practice.<org>.<project>.<slug>
kc.<domain>.<topic>.<slug>
binding.<org>.<project>.<slug>@<commit-prefix>
evidence.<org>.<project>.<slug>
src.<source>.<slug>
```

Stable IDs survive title and wording changes. Never put a project name inside a reusable `kc.` ID.
