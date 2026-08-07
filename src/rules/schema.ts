/**
 * PTKG001：结构与必填字段校验。
 *
 * 用 Ajv 跑 `schema/` 下的四份 JSON Schema。所有结构性问题统一归到 PTKG001，
 * 这样教师和网页只需理解一个「结构不合法」的入口，具体字段在 message 里说明。
 *
 * Schema 文件是 CLI 与教师网页共用的唯一契约来源，因此这里从磁盘读取而不是
 * 内联，避免出现两份定义漂移。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// schema/ 下的四份 schema 声明的是 draft 2020-12，必须用 Ajv 的 2020 入口；
// 默认入口只认 draft-07，会在 compile 时报 "no schema with key or ref ...2020-12"。
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import type { Finding, PtkgBundle } from '../types.ts';

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema');

type Validators = {
  manifest: ValidateFunction;
  node: ValidateFunction;
  edge: ValidateFunction;
  source: ValidateFunction;
};

let cached: Validators | null = null;

async function loadSchema(name: string): Promise<object> {
  const text = await readFile(path.join(SCHEMA_DIR, name), 'utf8');
  return JSON.parse(text) as object;
}

/** 编译一次并缓存。Ajv 编译开销不小，validate 会被每个节点调用。 */
async function getValidators(): Promise<Validators> {
  if (cached) return cached;

  const ajv = new Ajv({
    allErrors: true,
    strict: false, // 允许 schema 里出现 Ajv 不认识的注解关键字
    allowUnionTypes: true,
  });
  // ajv-formats 是 CJS 包，default 导出在 ESM 下可能被再包一层。
  // 两种形态都兼容，避免 Node 与打包器行为差异导致的运行时崩溃。
  type AddFormats = (instance: Ajv) => unknown;
  const mod: unknown = addFormats;
  const applyFormats = (
    typeof mod === 'function' ? mod : (mod as { default: AddFormats }).default
  ) as AddFormats;
  applyFormats(ajv);

  const [manifest, node, edge, source] = await Promise.all([
    loadSchema('manifest.schema.json'),
    loadSchema('node.schema.json'),
    loadSchema('edge.schema.json'),
    loadSchema('source.schema.json'),
  ]);

  cached = {
    manifest: ajv.compile(manifest),
    node: ajv.compile(node),
    edge: ajv.compile(edge),
    source: ajv.compile(source),
  };
  return cached;
}

/**
 * 把 Ajv 错误翻译成中文可读信息。
 *
 * Ajv 原始信息（"must have required property 'claim'"）对教师不友好，
 * 而教师是这些报告的主要读者，所以这里做一层本地化。
 */
function describe(err: ErrorObject): string {
  const where = err.instancePath === '' ? '根对象' : err.instancePath;

  switch (err.keyword) {
    case 'required':
      return `${where} 缺少必填字段 \`${(err.params as { missingProperty: string }).missingProperty}\``;
    case 'enum': {
      const allowed = (err.params as { allowedValues: unknown[] }).allowedValues;
      return `${where} 取值不在允许集合内，允许值：${allowed.join(' / ')}`;
    }
    case 'type':
      return `${where} 类型应为 ${(err.params as { type: string }).type}`;
    case 'minLength':
      return `${where} 不能为空字符串`;
    case 'minItems':
      return `${where} 至少需要 ${(err.params as { limit: number }).limit} 项`;
    case 'pattern':
      return `${where} 格式不符合要求（${(err.params as { pattern: string }).pattern}）`;
    case 'additionalProperties':
      return `${where} 出现未定义字段 \`${(err.params as { additionalProperty: string }).additionalProperty}\``;
    case 'if':
      // if/then 的外层错误没有信息量，具体原因在同批的其他 error 里
      return '';
    default:
      return `${where} ${err.message ?? '不符合 schema'}`;
  }
}

function toFindings(
  errors: ErrorObject[] | null | undefined,
  subject: string,
  file: string,
  hint?: string,
): Finding[] {
  if (!errors) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();

  for (const err of errors) {
    const message = describe(err);
    if (message === '') continue;

    // Ajv 在 anyOf/if-then 下会对同一问题报多条，去重避免噪音淹没教师
    const key = `${err.instancePath}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      code: 'PTKG001',
      severity: 'blocker',
      subject,
      message,
      file,
      path: err.instancePath || undefined,
      hint,
    });
  }
  return out;
}

export async function checkSchema(bundle: PtkgBundle): Promise<Finding[]> {
  const v = await getValidators();
  const findings: Finding[] = [];

  v.manifest(bundle.manifest);
  findings.push(
    ...toFindings(
      v.manifest.errors,
      bundle.manifest.bundle_id ?? '(manifest)',
      bundle.origin.manifest,
      '参照 docs/plans/.../08-模板与机器可读契约.md 第 2 节的 manifest 模板。',
    ),
  );

  for (let i = 0; i < bundle.nodes.length; i++) {
    const node = bundle.nodes[i];
    v.node(node);
    findings.push(
      ...toFindings(
        v.node.errors,
        node?.id ?? `${bundle.origin.nodes}#${i + 1}`,
        bundle.origin.nodes,
        node?.type === 'competency'
          ? '能力主张必须用可观察动作 + 证据表达，禁止只写「理解 X」。见规范 Step 3。'
          : undefined,
      ),
    );
  }

  for (let i = 0; i < bundle.edges.length; i++) {
    const edge = bundle.edges[i];
    v.edge(edge);
    findings.push(
      ...toFindings(v.edge.errors, edge?.id ?? `${bundle.origin.edges}#${i + 1}`, bundle.origin.edges),
    );
  }

  for (let i = 0; i < bundle.sources.length; i++) {
    const src = bundle.sources[i];
    v.source(src);
    findings.push(
      ...toFindings(v.source.errors, src?.id ?? `${bundle.origin.sources}#${i + 1}`, bundle.origin.sources),
    );
  }

  return findings;
}
