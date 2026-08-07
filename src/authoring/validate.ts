import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import { validateBundle } from '../validate.ts';
import type { Severity } from '../types.ts';
import { computeContentHash } from './hash.ts';
import { loadAuthoringRun } from './loader.ts';
import {
  AUTHORING_RULE_CODES,
  type AuthoringFinding,
  type AuthoringObject,
  type AuthoringProfile,
  type AuthoringRun,
  type AuthoringValidateResult,
} from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(HERE, '..', '..', 'schema', 'authoring');
const NON_WAIVABLE = new Set([
  'CANDIDATE-CONTRACT-001',
  'CANDIDATE-ANCHOR-001',
  'CANDIDATE-REVIEW-001',
  'CANDIDATE-SANDBOX-001',
  'CANDIDATE-UPDATE-001',
]);

type ValidatorSet = {
  runManifest: ValidateFunction;
  sourceContract: ValidateFunction;
  codeFact: ValidateFunction;
  projectCoverage: ValidateFunction;
  behaviorChain: ValidateFunction;
  learningSlice: ValidateFunction;
  executionResult: ValidateFunction;
  reviewEvent: ValidateFunction;
};

let cachedValidators: ValidatorSet | null = null;

async function readSchema(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(SCHEMA_DIR, name), 'utf8')) as Record<string, unknown>;
}

async function getValidators(): Promise<ValidatorSet> {
  if (cachedValidators) return cachedValidators;
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  type AddFormats = (instance: Ajv) => unknown;
  const moduleValue: unknown = addFormats;
  const applyFormats = (
    typeof moduleValue === 'function'
      ? moduleValue
      : (moduleValue as { default: AddFormats }).default
  ) as AddFormats;
  applyFormats(ajv);

  const common = await readSchema('common.schema.json');
  ajv.addSchema(common);

  const compile = async (name: string): Promise<ValidateFunction> => ajv.compile(await readSchema(name));
  cachedValidators = {
    sourceContract: await compile('source-contract.schema.json'),
    runManifest: await compile('run-manifest.schema.json'),
    codeFact: await compile('code-fact.schema.json'),
    projectCoverage: await compile('project-coverage.schema.json'),
    behaviorChain: await compile('behavior-chain.schema.json'),
    learningSlice: await compile('learning-slice.schema.json'),
    executionResult: await compile('execution-result.schema.json'),
    reviewEvent: await compile('review-event.schema.json'),
  };
  return cachedValidators;
}

function describeSchemaError(error: ErrorObject): string {
  const where = error.instancePath || '根对象';
  switch (error.keyword) {
    case 'required':
      return `${where} 缺少字段 \`${(error.params as { missingProperty: string }).missingProperty}\``;
    case 'additionalProperties':
    case 'unevaluatedProperties':
      return `${where} 出现未定义字段 \`${
        (error.params as { additionalProperty?: string; unevaluatedProperty?: string }).additionalProperty ??
        (error.params as { unevaluatedProperty?: string }).unevaluatedProperty ??
        '?'
      }\``;
    case 'enum':
      return `${where} 取值不在允许集合内`;
    case 'const':
      return `${where} 必须使用固定值 ${(error.params as { allowedValue: unknown }).allowedValue}`;
    case 'pattern':
      return `${where} 格式不正确`;
    case 'minItems':
      return `${where} 至少需要 ${(error.params as { limit: number }).limit} 项`;
    default:
      return `${where} ${error.message ?? '不符合 Schema'}`;
  }
}

function schemaFindings(
  validator: ValidateFunction,
  value: unknown,
  subject: string,
  file: string,
): AuthoringFinding[] {
  validator(value);
  const findings: AuthoringFinding[] = [];
  const seen = new Set<string>();
  for (const error of validator.errors ?? []) {
    if (error.keyword === 'if' || error.keyword === 'anyOf' || error.keyword === 'allOf') continue;
    const message = describeSchemaError(error);
    const key = `${error.instancePath}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      code: 'CANDIDATE-CONTRACT-001',
      severity: 'blocker',
      subject,
      file,
      path: error.instancePath || undefined,
      message,
    });
  }
  return findings;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function allObjects(run: AuthoringRun): AuthoringObject[] {
  return [
    run.sourceContract,
    ...run.codeFacts,
    run.projectCoverage,
    ...run.behaviorChains,
    ...run.learningSlices,
    ...run.executionResults,
  ];
}

function allReviewEvents(run: AuthoringRun) {
  return [...run.reviewEvents, ...run.exceptionEvents];
}

function checkContentHashes(run: AuthoringRun): AuthoringFinding[] {
  const findings: AuthoringFinding[] = [];
  for (const object of allObjects(run)) {
    const computed = computeContentHash(object);
    if (object.content_hash !== computed) {
      add(
        findings,
        'CANDIDATE-CONTRACT-001',
        'blocker',
        String(object.id ?? '(object)'),
        `content_hash 不匹配：期望 ${computed}，实际 ${String(object.content_hash ?? '(missing)')}。`,
        '运行 `ptkg authoring-hash <run> --write` 回写规范化 SHA-256。',
      );
    }
  }
  return findings;
}

function add(
  findings: AuthoringFinding[],
  code: AuthoringFinding['code'],
  severity: Severity,
  subject: string,
  message: string,
  hint?: string,
): void {
  findings.push({ code, severity, subject, message, hint });
}

function checkClaims(run: AuthoringRun): AuthoringFinding[] {
  const findings: AuthoringFinding[] = [];
  const anchors = new Set<string>();
  for (const object of [...run.codeFacts, ...run.behaviorChains]) {
    for (const anchor of asArray<Record<string, unknown>>(object.anchors)) {
      if (typeof anchor.id === 'string') anchors.add(anchor.id);
    }
  }
  const events = new Map(allReviewEvents(run).map((event) => [event.event_id, event]));
  const verifiedAnchors = new Set(
    run.anchorVerifications
      .filter((verification) => verification.status === 'verified')
      .map((verification) => verification.anchor_id),
  );
  const deterministic = new Set(['git', 'parser', 'build', 'test', 'trace']);

  for (const object of allObjects(run)) {
    for (const claim of asArray<Record<string, unknown>>(object.claims)) {
      const claimId = typeof claim.id === 'string' ? claim.id : `${object.id ?? '(object)'}.claim`;
      const sourceRefs = asArray<string>(claim.source_refs);
      const anchorRefs = asArray<string>(claim.anchor_refs);
      if (claim.epistemic_status === 'verified_fact') {
        if (!deterministic.has(String(claim.method)) || sourceRefs.length + anchorRefs.length === 0) {
          add(
            findings,
            'CANDIDATE-CLAIM-001',
            'blocker',
            claimId,
            'verified_fact 必须使用确定性方法，并绑定来源或锚点。',
          );
        }
        for (const anchorRef of anchorRefs) {
          if (!anchors.has(anchorRef)) {
            add(
              findings,
              'CANDIDATE-ANCHOR-001',
              'blocker',
              claimId,
              `verified_fact 引用了未声明锚点 \`${anchorRef}\`。`,
              'P0 只检查锚点声明；P1 checkout verifier 还会检查 path/symbol 实存。',
            );
          }
          if (anchors.has(anchorRef) && !verifiedAnchors.has(anchorRef)) {
            add(
              findings,
              'CANDIDATE-ANCHOR-001',
              'blocker',
              claimId,
              `verified_fact 的锚点 \`${anchorRef}\` 尚未在固定 checkout 中验证。`,
              '运行 `ptkg authoring-verify-workspace <run>` 生成 anchor-verification.jsonl。',
            );
          }
        }
      }

      if (claim.epistemic_status === 'teacher_decision') {
        const refs = asArray<string>(claim.event_refs);
        const trusted = refs.some((ref) => events.get(ref)?.authentication === 'authenticated');
        if (!trusted) {
          add(
            findings,
            'CANDIDATE-CLAIM-001',
            'blocker',
            claimId,
            'teacher_decision 必须引用 authenticated review-event。',
          );
        }
      }

      if (claim.epistemic_status === 'unresolved' && object.status !== 'unresolved') {
        add(
          findings,
          'CANDIDATE-CLAIM-001',
          'review',
          claimId,
          '包含 unresolved claim 的对象也应标为 unresolved。',
        );
      }
    }
  }
  return findings;
}

function checkBehaviors(run: AuthoringRun): AuthoringFinding[] {
  const findings: AuthoringFinding[] = [];
  for (const behavior of run.behaviorChains) {
    const state = asRecord(behavior.state);
    const kind = behavior.behavior_kind;
    const evidence = asArray(behavior.evidence_refs);
    const coverage = asArray(behavior.coverage_refs);
    if (
      asArray(behavior.preconditions).length === 0 ||
      typeof behavior.entry !== 'string' ||
      typeof behavior.success_exit !== 'string' ||
      asArray(behavior.anchors).length === 0 ||
      evidence.length === 0 ||
      coverage.length === 0
    ) {
      add(
        findings,
        'CANDIDATE-BEHAVIOR-001',
        'blocker',
        behavior.id,
        '行为链必须闭合到前置、入口、成功出口、锚点、证据和完整项目位置。',
      );
    }

    if (kind === 'state_change' || kind === 'resource_lifecycle') {
      const failure = asRecord(behavior.failure_exit);
      const cleanup = asRecord(behavior.cleanup);
      const concurrency = asRecord(behavior.concurrency);
      if (
        asArray(state.writes).length === 0 ||
        failure.applicability !== 'applicable' ||
        cleanup.applicability !== 'applicable' ||
        concurrency.applicability !== 'applicable' ||
        asArray(behavior.invariants).length === 0
      ) {
        add(
          findings,
          'CANDIDATE-BEHAVIOR-002',
          'blocker',
          behavior.id,
          '状态/资源变更链必须显式记录写状态、失败、清理/回滚、不变量和并发风险。',
        );
      }
    }
  }
  return findings;
}

function checkSlices(run: AuthoringRun): AuthoringFinding[] {
  const findings: AuthoringFinding[] = [];
  const executions = new Map(run.executionResults.map((result) => [result.id, result]));
  const behaviors = new Map(run.behaviorChains.map((behavior) => [behavior.id, behavior]));

  for (const slice of run.learningSlices) {
    const scaffold = asRecord(slice.scaffold);
    const provided = asArray<string>(scaffold.provided).map((item) => item.trim().toLowerCase());
    const withheld = asArray<string>(scaffold.withheld).map((item) => item.trim().toLowerCase());
    const overlap = provided.filter((item) => withheld.includes(item));
    if (overlap.length > 0 || (['S2', 'S3', 'S4'].includes(String(slice.level)) && withheld.length === 0)) {
      add(
        findings,
        'CANDIDATE-SCAFFOLD-001',
        'blocker',
        slice.id,
        overlap.length > 0
          ? `脚手架同时提供并隐藏：${overlap.join('、')}。`
          : `${slice.level} 必须明确保留给学生的核心责任。`,
      );
    }

    if (slice.activity_kind === 'design_review') {
      if (asArray(slice.rubric).length === 0 || asArray(slice.evidence_refs).length === 0) {
        add(
          findings,
          'CANDIDATE-EVIDENCE-001',
          'blocker',
          slice.id,
          '设计/评审任务必须绑定固定 rubric 和教师可核验证据。',
        );
      }
      continue;
    }

    const executionRefs = asArray<string>(slice.execution_refs);
    const matched = executionRefs.map((ref) => executions.get(ref)).filter(Boolean) as AuthoringObject[];
    if (matched.length === 0 || matched.some((result) => result.result_status !== 'succeeded')) {
      add(
        findings,
        'CANDIDATE-EXEC-001',
        'blocker',
        slice.id,
        '可执行切片必须引用至少一个 succeeded execution-result。',
      );
      continue;
    }

    const level = String(slice.level);
    const tests = matched.map((result) => asRecord(result.test_classes));
    if (['S2', 'S3', 'S4'].includes(level)) {
      const complete = tests.some(
        (test) => test.positive === true && test.negative === true && test.regression === true,
      );
      if (!complete) {
        add(
          findings,
          'CANDIDATE-EVIDENCE-001',
          'blocker',
          slice.id,
          `${level} 至少需要正例、负例和回归执行证据。`,
        );
      }
    }

    if (level === 'S3') {
      const discriminates = matched.some((result) => {
        const fault = asRecord(result.fault_detection);
        return fault.baseline_passed === true && fault.fault_failed === true;
      });
      if (!discriminates) {
        add(
          findings,
          'CANDIDATE-TEST-001',
          'blocker',
          slice.id,
          'S3 测试必须在正确实现通过，并击中 seeded fault 或历史错误。',
        );
      }
    }

    if (level === 'S4') {
      const behavior = behaviors.get(String(slice.behavior_ref));
      const concurrency = asRecord(behavior?.concurrency);
      if (
        concurrency.applicability === 'applicable' &&
        !tests.some((test) => test.concurrency === true)
      ) {
        add(
          findings,
          'CANDIDATE-EVIDENCE-001',
          'blocker',
          slice.id,
          'S4 对存在并发风险的行为必须有并发执行证据。',
        );
      }
    }
  }
  return findings;
}

function coverageRank(status: unknown): number {
  return {
    unresolved: -1,
    skeleton: 0,
    source_verified: 1,
    teachable: 2,
    pilot_validated: 3,
    excluded: 4,
  }[String(status)] ?? -1;
}

function checkCoverage(run: AuthoringRun): AuthoringFinding[] {
  const findings: AuthoringFinding[] = [];
  const requiredIds = asArray<string>(run.projectCoverage.required_unit_ids);
  const units = asArray<Record<string, unknown>>(run.projectCoverage.units);
  const byId = new Map(units.map((unit) => [String(unit.id), unit]));
  for (const id of requiredIds) {
    if (!byId.has(id)) {
      add(
        findings,
        'CANDIDATE-COVERAGE-001',
        'blocker',
        run.projectCoverage.id,
        `required coverage unit \`${id}\` 未出现在 units 中。`,
      );
    }
  }

  const requiredUnits = requiredIds.map((id) => byId.get(id)).filter(Boolean) as Record<string, unknown>[];
  const level = run.projectCoverage.release_level;
  if (level === 'internal_pilot') {
    const invalid = requiredUnits.filter(
      (unit) => coverageRank(unit.status) < 1 || (unit.critical === true && coverageRank(unit.status) < 2),
    );
    if (invalid.length > 0) {
      add(
        findings,
        'CANDIDATE-COVERAGE-002',
        'blocker',
        run.projectCoverage.id,
        `内部试点覆盖不足：${invalid.map((unit) => unit.id).join('、')}。`,
      );
    }
  }
  if (level === 'complete_course') {
    const invalid = requiredUnits.filter(
      (unit) =>
        unit.status === 'excluded' ||
        coverageRank(unit.status) < 2 ||
        (unit.critical === true && coverageRank(unit.status) < 3),
    );
    if (invalid.length > 0) {
      add(
        findings,
        'CANDIDATE-COVERAGE-002',
        'blocker',
        run.projectCoverage.id,
        `完整课程覆盖不足：${invalid.map((unit) => unit.id).join('、')}。`,
      );
    }
  }

  for (const link of asArray<Record<string, unknown>>(run.projectCoverage.reuse_links)) {
    if (link.relation !== 'exact_reuse') continue;
    const alignment = asRecord(link.alignment);
    if (
      alignment.learning_goal !== true ||
      alignment.prerequisites !== true ||
      alignment.evidence !== true
    ) {
      add(
        findings,
        'CANDIDATE-REUSE-001',
        'review',
        `${link.from ?? '?'}->${link.to ?? '?'}`,
        'exact_reuse 必须同时对齐学习目标、前置语义和证据要求。',
      );
    }
  }
  return findings;
}

function checkExecution(run: AuthoringRun): AuthoringFinding[] {
  const findings: AuthoringFinding[] = [];
  for (const result of run.executionResults) {
    const sandbox = asRecord(result.sandbox);
    const limits = asRecord(result.limits);
    const reset = asRecord(result.reset);
    if (
      !['disabled', 'allowlisted'].includes(String(sandbox.network)) ||
      !['disposable_worktree', 'read_only'].includes(String(sandbox.filesystem)) ||
      sandbox.secrets !== 'none' ||
      sandbox.resettable !== true ||
      sandbox.push_allowed !== false ||
      Number(limits.timeout_seconds) <= 0 ||
      Number(limits.memory_mb) <= 0 ||
      Number(limits.processes) <= 0 ||
      reset.succeeded !== true
    ) {
      add(
        findings,
        'CANDIDATE-SANDBOX-001',
        'blocker',
        result.id,
        '执行必须限制网络/资源，禁止 secret 和 push，并在可丢弃环境中成功重置。',
      );
    }
  }
  return findings;
}

function checkReview(run: AuthoringRun, profile: AuthoringProfile): AuthoringFinding[] {
  const findings: AuthoringFinding[] = [];
  const objects = new Map(allObjects(run).map((object) => [object.id, object]));
  for (const event of allReviewEvents(run)) {
    const target = objects.get(event.object_ref);
    if (target && target.content_hash !== event.object_hash) {
      add(
        findings,
        'CANDIDATE-REVIEW-001',
        'blocker',
        event.event_id,
        'review-event 的 object_hash 与当前对象不一致，原审批已失效。',
      );
    }
    if (
      ['accept', 'publish', 'approve_exception'].includes(event.action) &&
      event.authentication !== 'authenticated' &&
      profile !== 'authoring'
    ) {
      add(
        findings,
        'CANDIDATE-REVIEW-001',
        'blocker',
        event.event_id,
        'review/publishing profile 不接受 local_unverified_review 授权。',
      );
    }
    if (event.action === 'approve_exception') {
      if (event.rule_code && NON_WAIVABLE.has(event.rule_code)) {
        add(
          findings,
          'CANDIDATE-EXCEPTION-001',
          'blocker',
          event.event_id,
          `规则 ${event.rule_code} 属于不可豁免 blocker。`,
        );
      }
      const roles = new Set(asArray<string>(event.actor_roles));
      if (!roles.has('project_mentor') || !roles.has('course_teacher')) {
        add(
          findings,
          'CANDIDATE-EXCEPTION-001',
          'blocker',
          event.event_id,
          'blocker 例外必须同时具有项目导师和课程教师角色。',
        );
      }
    }
  }

  if (profile === 'publishing') {
    const publish = allReviewEvents(run).some(
      (event) =>
        event.action === 'publish' &&
        event.authentication === 'authenticated' &&
        asArray<string>(event.actor_roles).includes('release_owner'),
    );
    if (!publish) {
      add(
        findings,
        'CANDIDATE-REVIEW-001',
        'blocker',
        run.sourceContract.id,
        'publishing profile 必须有 authenticated release_owner publish event。',
      );
    }
  }
  return findings;
}

function checkRunIdentity(run: AuthoringRun): AuthoringFinding[] {
  const findings: AuthoringFinding[] = [];
  const expectedRun = run.sourceContract.run_id;
  const expectedProjectRef = asRecord(run.sourceContract.project_ref);
  const expectedRepo = expectedProjectRef.repo;
  const expectedCommit = expectedProjectRef.commit;
  if (
    run.manifest.run_id !== expectedRun ||
    run.manifest.project_ref?.repo !== expectedRepo ||
    run.manifest.project_ref?.commit !== expectedCommit
  ) {
    add(
      findings,
      'CANDIDATE-UPDATE-001',
      'blocker',
      run.manifest.run_id ?? '(run-manifest)',
      'run-manifest 必须与 source-contract 使用相同 run_id、repo 和固定 commit。',
    );
  }
  for (const object of allObjects(run)) {
    const projectRef = asRecord(object.project_ref);
    if (
      object.run_id !== expectedRun ||
      projectRef.repo !== expectedRepo ||
      projectRef.commit !== expectedCommit
    ) {
      add(
        findings,
        'CANDIDATE-UPDATE-001',
        'blocker',
        object.id,
        '同一 authoring run 必须使用相同 run_id、repo 和固定 commit。',
      );
    }
  }
  for (const event of allReviewEvents(run)) {
    if (event.run_id !== expectedRun) {
      add(
        findings,
        'CANDIDATE-UPDATE-001',
        'blocker',
        event.event_id,
        'review-event 不属于当前 run_id。',
      );
    }
  }
  return findings;
}

async function checkSchemas(run: AuthoringRun): Promise<AuthoringFinding[]> {
  const validators = await getValidators();
  const findings: AuthoringFinding[] = [];
  findings.push(
    ...schemaFindings(
      validators.runManifest,
      run.manifest,
      run.manifest.run_id ?? '(run-manifest)',
      'run-manifest.yaml',
    ),
    ...schemaFindings(
      validators.sourceContract,
      run.sourceContract,
      typeof run.sourceContract.id === 'string' ? run.sourceContract.id : '(source-contract)',
      run.origin.sourceContract,
    ),
    ...schemaFindings(
      validators.projectCoverage,
      run.projectCoverage,
      typeof run.projectCoverage.id === 'string' ? run.projectCoverage.id : '(project-coverage)',
      run.origin.projectCoverage,
    ),
  );
  for (const [objects, validator, file] of [
    [run.codeFacts, validators.codeFact, run.origin.codeFacts],
    [run.behaviorChains, validators.behaviorChain, run.origin.behaviorChains],
    [run.learningSlices, validators.learningSlice, run.origin.learningSlices],
    [run.executionResults, validators.executionResult, run.origin.executionResults],
  ] as [AuthoringObject[], ValidateFunction, string][]) {
    for (const object of objects) {
      findings.push(
        ...schemaFindings(
          validator,
          object,
          typeof object.id === 'string' ? object.id : file,
          file,
        ),
      );
    }
  }
  for (const event of run.reviewEvents) {
    findings.push(
      ...schemaFindings(
        validators.reviewEvent,
        event,
        event.event_id ?? run.origin.reviewEvents,
        run.origin.reviewEvents,
      ),
    );
  }
  return findings;
}

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, review: 1, info: 2 };

export async function validateAuthoringRun(
  dir: string,
  profile: AuthoringProfile = 'authoring',
): Promise<AuthoringValidateResult> {
  const loaded = await loadAuthoringRun(dir);
  const findings: AuthoringFinding[] = [...loaded.findings];
  const run = loaded.run;

  if (run) {
    findings.push(
      ...(await checkSchemas(run)),
      ...checkContentHashes(run),
      ...checkClaims(run),
      ...checkBehaviors(run),
      ...checkSlices(run),
      ...checkCoverage(run),
      ...checkExecution(run),
      ...checkReview(run, profile),
      ...checkRunIdentity(run),
    );

    const projection = await validateBundle(run.projectionDir);
    for (const stableFinding of projection.findings.filter((item) => item.severity === 'blocker')) {
      add(
        findings,
        'CANDIDATE-CONTRACT-001',
        'blocker',
        stableFinding.subject,
        `PTKG projection 未通过 ${stableFinding.code}：${stableFinding.message}`,
      );
    }
  }

  findings.sort((a, b) => {
    const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severity !== 0) return severity;
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    return a.subject.localeCompare(b.subject);
  });

  const byCode: Record<string, number> = Object.fromEntries(
    AUTHORING_RULE_CODES.map((code) => [code, 0]),
  );
  for (const item of findings) byCode[item.code] = (byCode[item.code] ?? 0) + 1;
  const blocker = findings.filter((item) => item.severity === 'blocker').length;
  const review = findings.filter((item) => item.severity === 'review').length;
  const info = findings.filter((item) => item.severity === 'info').length;

  return {
    run,
    findings,
    summary: {
      total: findings.length,
      blocker,
      review,
      info,
      byCode,
      counts: {
        code_facts: run?.codeFacts.length ?? 0,
        behavior_chains: run?.behaviorChains.length ?? 0,
        learning_slices: run?.learningSlices.length ?? 0,
        execution_results: run?.executionResults.length ?? 0,
        review_events: run?.reviewEvents.length ?? 0,
        exception_events: run?.exceptionEvents.length ?? 0,
        anchor_verifications: run?.anchorVerifications.length ?? 0,
      },
    },
    passed: blocker === 0,
    profile,
  };
}

export function formatAuthoringResult(result: AuthoringValidateResult): string {
  const lines = [
    `PTKG 作者链校验（profile: ${result.profile}）`,
    '='.repeat(60),
    `blocker ${result.summary.blocker} · review ${result.summary.review} · info ${result.summary.info}`,
    `facts ${result.summary.counts.code_facts} · behaviors ${result.summary.counts.behavior_chains} · slices ${result.summary.counts.learning_slices} · executions ${result.summary.counts.execution_results}`,
  ];
  if (result.findings.length === 0) {
    lines.push('', '未发现问题。作者运行可以进入下一 profile。');
    return lines.join('\n');
  }
  for (const item of result.findings) {
    lines.push('', `[${item.severity}] ${item.code} ${item.subject}`, `  ${item.message}`);
    if (item.hint) lines.push(`  建议：${item.hint}`);
  }
  return lines.join('\n');
}
