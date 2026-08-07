import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import type {
  AuthoringFinding,
  AuthoringObject,
  AuthoringRun,
  AnchorVerification,
  LoadAuthoringResult,
  ReviewEvent,
  RunManifest,
} from './types.ts';

const PARTS = {
  manifest: 'run-manifest.yaml',
  sourceContract: '01-source/source-contract.yaml',
  codeFacts: '02-facts/code-facts.jsonl',
  projectCoverage: '03-coverage/project-coverage.yaml',
  behaviorChains: '04-behaviors/behavior-chains.jsonl',
  learningSlices: '05-slices/learning-slices.jsonl',
  executionResults: '06-execution/execution-results.jsonl',
  reviewEvents: '08-governance/review-events.jsonl',
  exceptionEvents: '08-governance/exception-events.jsonl',
} as const;
const OPTIONAL_PARTS = {
  anchorVerifications: '02-facts/anchor-verification.jsonl',
} as const;

function finding(file: string, message: string, subject = file): AuthoringFinding {
  return {
    code: 'CANDIDATE-CONTRACT-001',
    severity: 'blocker',
    subject,
    file,
    message,
  };
}

async function readRequired(root: string, relative: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(root, relative), 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function parseYamlObject<T extends object>(text: string, file: string): { value: T | null; findings: AuthoringFinding[] } {
  try {
    const value: unknown = YAML.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { value: null, findings: [finding(file, 'YAML 根节点必须是对象。')] };
    }
    return { value: value as T, findings: [] };
  } catch (err) {
    return { value: null, findings: [finding(file, `YAML 解析失败：${(err as Error).message}`)] };
  }
}

function parseJsonl<T extends object>(
  text: string,
  file: string,
): { values: T[]; findings: AuthoringFinding[] } {
  const values: T[] = [];
  const findings: AuthoringFinding[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const raw = line.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        findings.push(finding(file, `JSONL 第 ${index + 1} 行必须是对象。`, `${file}:${index + 1}`));
      } else {
        values.push(parsed as T);
      }
    } catch (err) {
      findings.push(
        finding(file, `JSONL 第 ${index + 1} 行解析失败：${(err as Error).message}`, `${file}:${index + 1}`),
      );
    }
  }
  return { values, findings };
}

export async function loadAuthoringRun(root: string): Promise<LoadAuthoringResult> {
  const findings: AuthoringFinding[] = [];
  const texts: Partial<Record<keyof typeof PARTS, string>> = {};

  for (const [key, relative] of Object.entries(PARTS) as [keyof typeof PARTS, string][]) {
    const text = await readRequired(root, relative);
    if (text === null) {
      findings.push(finding(relative, `作者运行目录缺少必需文件 \`${relative}\`。`, root));
    } else {
      texts[key] = text;
    }
  }

  const projectionDir = path.join(root, '07-projection');
  const projectionManifest = await readRequired(root, '07-projection/manifest.yaml');
  if (projectionManifest === null) {
    findings.push(finding('07-projection/manifest.yaml', '作者运行缺少 PTKG projection manifest。', root));
  }

  if (findings.length > 0) return { run: null, findings };

  const manifest = parseYamlObject<RunManifest>(texts.manifest ?? '', PARTS.manifest);
  const source = parseYamlObject<AuthoringObject>(texts.sourceContract ?? '', PARTS.sourceContract);
  const coverage = parseYamlObject<AuthoringObject>(texts.projectCoverage ?? '', PARTS.projectCoverage);
  const facts = parseJsonl<AuthoringObject>(texts.codeFacts ?? '', PARTS.codeFacts);
  const behaviors = parseJsonl<AuthoringObject>(texts.behaviorChains ?? '', PARTS.behaviorChains);
  const slices = parseJsonl<AuthoringObject>(texts.learningSlices ?? '', PARTS.learningSlices);
  const executions = parseJsonl<AuthoringObject>(texts.executionResults ?? '', PARTS.executionResults);
  const reviews = parseJsonl<ReviewEvent>(texts.reviewEvents ?? '', PARTS.reviewEvents);
  const exceptions = parseJsonl<ReviewEvent>(texts.exceptionEvents ?? '', PARTS.exceptionEvents);
  const verificationText = await readRequired(root, OPTIONAL_PARTS.anchorVerifications);
  const verifications = parseJsonl<AnchorVerification>(
    verificationText ?? '',
    OPTIONAL_PARTS.anchorVerifications,
  );

  findings.push(
    ...manifest.findings,
    ...source.findings,
    ...coverage.findings,
    ...facts.findings,
    ...behaviors.findings,
    ...slices.findings,
    ...executions.findings,
    ...reviews.findings,
    ...exceptions.findings,
    ...verifications.findings,
  );

  if (!manifest.value || !source.value || !coverage.value) return { run: null, findings };

  const run: AuthoringRun = {
    root,
    manifest: manifest.value,
    sourceContract: source.value,
    codeFacts: facts.values,
    projectCoverage: coverage.value,
    behaviorChains: behaviors.values,
    learningSlices: slices.values,
    executionResults: executions.values,
    reviewEvents: reviews.values,
    exceptionEvents: exceptions.values,
    anchorVerifications: verifications.values,
    projectionDir,
    origin: {
      sourceContract: PARTS.sourceContract,
      codeFacts: PARTS.codeFacts,
      projectCoverage: PARTS.projectCoverage,
      behaviorChains: PARTS.behaviorChains,
      learningSlices: PARTS.learningSlices,
      executionResults: PARTS.executionResults,
      reviewEvents: PARTS.reviewEvents,
      exceptionEvents: PARTS.exceptionEvents,
      anchorVerifications: OPTIONAL_PARTS.anchorVerifications,
    },
  };
  return { run, findings };
}
