import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { loadAuthoringRun } from '../authoring/loader.ts';
import { validateAuthoringRun } from '../authoring/validate.ts';
import { loadBundle } from '../loader.ts';
import type { CheckpointId, CheckpointState, ProjectInput, ProjectWorkspaceStatus } from './types.ts';
import { CHECKPOINTS } from './types.ts';

async function exists(file: string): Promise<boolean> {
  return Boolean(await stat(file).catch(() => null));
}

async function readInput(root: string): Promise<ProjectInput | null> {
  try {
    return YAML.parse(await readFile(path.join(root, 'project-input.yaml'), 'utf8')) as ProjectInput;
  } catch {
    return null;
  }
}

function state(
  id: CheckpointId,
  complete: boolean,
  previousComplete: boolean,
  evidence: string[],
  blockers: string[] = [],
): CheckpointState {
  return {
    id,
    status: complete ? 'complete' : blockers.length > 0 ? 'blocked' : previousComplete ? 'ready' : 'pending',
    evidence,
    blockers,
  };
}

export async function getProjectStatus(workspace: string): Promise<ProjectWorkspaceStatus> {
  const root = path.resolve(workspace);
  const input = await readInput(root);
  const loaded = await loadAuthoringRun(root);
  const validation = loaded.run ? await validateAuthoringRun(root, 'authoring') : null;
  const bundle = await loadBundle(path.join(root, '07-projection'));
  const nodes = bundle.bundle?.nodes ?? [];
  const edges = bundle.bundle?.edges ?? [];
  const anchorVerifications = loaded.run?.anchorVerifications ?? [];
  const sourceLocked = Boolean(
    input
    && /^[0-9a-f]{40}$/.test(input.repository.commit)
    && /^[0-9a-f]{40}$/.test(input.repository.tree),
  );
  const contractBlockers = input?.unresolved_questions ?? ['project-input.yaml 缺失或不可解析。'];
  const contractComplete = sourceLocked && contractBlockers.length === 0 && Boolean(loaded.run?.sourceContract);
  const factsComplete = Boolean(
    loaded.run
    && loaded.run.codeFacts.length > 0
    && anchorVerifications.length > 0
    && anchorVerifications.every((item) => item.status === 'verified'),
  );
  const graphComplete = ['project', 'outcome', 'work_package'].every((type) => nodes.some((node) => node.type === type));
  const competencyComplete = nodes.some((node) => node.type === 'competency')
    && nodes.some((node) => node.type === 'evidence')
    && edges.some((edge) => edge.type === 'PROVEN_BY');
  const courseFiles = [
    '09-course/blueprint.yaml',
    '09-course/units.jsonl',
    '09-course/questions.jsonl',
    '09-course/practices.jsonl',
    '09-course/gates.jsonl',
  ];
  const courseCards = await stat(path.join(root, '09-course', 'cards')).catch(() => null);
  const cardFiles = courseCards?.isDirectory()
    ? (await readdir(path.join(root, '09-course', 'cards'))).filter((file) => file.endsWith('.md'))
    : [];
  const courseExists = (await Promise.all(courseFiles.map((file) => exists(path.join(root, file))))).every(Boolean)
    && cardFiles.length > 0;
  const reviewComplete = await exists(path.join(root, '08-governance', 'review-queues.json'));

  const checkpoints: CheckpointState[] = [];
  checkpoints.push(state('project_contract', contractComplete, true, sourceLocked ? ['fixed commit and tree'] : [], contractBlockers));
  checkpoints.push(state('code_facts', factsComplete, contractComplete, [
    `${loaded.run?.codeFacts.length ?? 0} code facts`,
    `${anchorVerifications.filter((item) => item.status === 'verified').length}/${anchorVerifications.length} verified anchors`,
  ]));
  checkpoints.push(state('project_graph', graphComplete, factsComplete, [`${nodes.length} projection nodes`]));
  checkpoints.push(state('competency_evidence', competencyComplete, graphComplete, [`${edges.length} projection edges`]));
  checkpoints.push(state('course_assets', courseExists, competencyComplete, courseFiles.filter((file) => courseExists || false)));
  checkpoints.push(state('reuse_review', reviewComplete, courseExists, reviewComplete ? ['review queues generated'] : []));

  const next = checkpoints.find((item) => item.status === 'ready' || item.status === 'blocked')?.id ?? null;
  return {
    workspace: root,
    project_ref: loaded.run?.manifest.project_ref ?? null,
    source_locked: sourceLocked,
    next_checkpoint: next,
    checkpoints,
    findings: validation?.findings ?? loaded.findings,
    unresolved_questions: input?.unresolved_questions ?? [],
    next_command: next ? `ptkg author "${root}" --agent manual` : null,
  };
}

export function checkpointOrdinal(id: CheckpointId): number {
  return CHECKPOINTS.indexOf(id);
}
