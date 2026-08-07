/**
 * Bundle 载入器。
 *
 * 设计前提：bundle 由教师本地的任意 Agent（Codex / Claude Code / 其他）生成，
 * 因此输入一定会脏。载入器的职责是：
 *   1. 容忍格式差异（YAML 与 JSONL 都接受，BOM、空行、注释行都跳过）；
 *   2. 任何解析失败都转成带文件名和行号的 Finding，而不是抛栈；
 *   3. 绝不做语义修补——脏数据交给规则层报 PTKG001。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import type {
  Finding,
  PtkgBundle,
  PtkgEdge,
  PtkgManifest,
  PtkgNode,
  PtkgSource,
} from './types.ts';

export interface LoadResult {
  bundle: PtkgBundle | null;
  findings: Finding[];
}

/** bundle 内的标准文件名。manifest 允许 yaml/yml/json 三种扩展名。 */
const MANIFEST_CANDIDATES = ['manifest.yaml', 'manifest.yml', 'manifest.json'];

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return stripBom(await readFile(file, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw err;
  }
}

/**
 * 解析 JSONL。每行一个对象，行号从 1 开始。
 *
 * 跳过空行和以 # 开头的注释行——JSONL 规范里没有注释，但 Agent 很爱加，
 * 与其报错不如接受，因为这不影响语义。
 */
function parseJsonl(
  text: string,
  file: string,
): { rows: Record<string, unknown>[]; findings: Finding[] } {
  const rows: Record<string, unknown>[] = [];
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? '').trim();
    if (raw === '' || raw.startsWith('#')) continue;

    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        findings.push({
          code: 'PTKG001',
          severity: 'blocker',
          subject: `${file}:${i + 1}`,
          message: `JSONL 第 ${i + 1} 行不是对象，实际是 ${Array.isArray(parsed) ? 'array' : typeof parsed}。`,
          file,
          hint: 'JSONL 每行必须是一个独立的 JSON 对象，不要写数组或裸值。',
        });
        continue;
      }
      rows.push(parsed as Record<string, unknown>);
    } catch (err) {
      findings.push({
        code: 'PTKG001',
        severity: 'blocker',
        subject: `${file}:${i + 1}`,
        message: `JSONL 第 ${i + 1} 行解析失败：${(err as Error).message}`,
        file,
        hint: '每行必须是完整的单行 JSON。不要把一个对象跨多行书写。',
      });
    }
  }

  return { rows, findings };
}

/** 解析 YAML 多文档或数组，统一成对象数组。允许 Agent 用 YAML 写节点表。 */
function parseYamlRows(
  text: string,
  file: string,
): { rows: Record<string, unknown>[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const rows: Record<string, unknown>[] = [];

  try {
    const docs = YAML.parseAllDocuments(text);
    for (const doc of docs) {
      for (const e of doc.errors) {
        findings.push({
          code: 'PTKG001',
          severity: 'blocker',
          subject: file,
          message: `YAML 解析错误：${e.message}`,
          file,
        });
      }
      if (doc.errors.length > 0) continue;

      const value = doc.toJS();
      if (value === null || value === undefined) continue;

      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            rows.push(item as Record<string, unknown>);
          }
        }
      } else if (typeof value === 'object') {
        rows.push(value as Record<string, unknown>);
      }
    }
  } catch (err) {
    findings.push({
      code: 'PTKG001',
      severity: 'blocker',
      subject: file,
      message: `YAML 解析失败：${(err as Error).message}`,
      file,
    });
  }

  return { rows, findings };
}

/**
 * 按扩展名选择解析器。
 * `.jsonl` 走 JSONL；`.yaml`/`.yml`/`.json` 走 YAML（YAML 是 JSON 超集，能兼容）。
 */
function parseRows(
  text: string,
  file: string,
): { rows: Record<string, unknown>[]; findings: Finding[] } {
  return file.endsWith('.jsonl') ? parseJsonl(text, file) : parseYamlRows(text, file);
}

/**
 * 在 bundle 目录中定位某一部分的文件。
 *
 * 优先用 manifest.files 声明的路径；找不到再按约定名探测。
 * 这样既支持 manifest 显式声明，也支持 Agent 直接按约定命名。
 */
async function locatePart(
  dir: string,
  declared: string | undefined,
  fallbacks: string[],
): Promise<{ file: string; text: string } | null> {
  const candidates = declared ? [declared, ...fallbacks] : fallbacks;
  for (const name of candidates) {
    const full = path.join(dir, name);
    const text = await readIfExists(full);
    if (text !== null) return { file: name, text };
  }
  return null;
}

/** manifest.files 只能引用 bundle 根目录内的相对路径，避免网页导入时越界读文件。 */
function safeDeclaredPart(
  dir: string,
  label: string,
  declared: string | undefined,
  manifestFile: string,
  findings: Finding[],
): string | undefined {
  if (!declared) return undefined;

  const root = path.resolve(dir);
  const target = path.resolve(root, declared);
  const relative = path.relative(root, target);
  const escapesRoot =
    path.isAbsolute(declared) ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`);

  if (!escapesRoot) return declared;

  findings.push({
    code: 'PTKG001',
    severity: 'blocker',
    subject: manifestFile,
    message: `manifest.files.${label} 指向 bundle 外部：\`${declared}\`。`,
    file: manifestFile,
    path: `/files/${label}`,
    hint: '文件路径必须是 bundle 根目录内的相对路径，不能使用绝对路径或 ../。',
  });
  return undefined;
}

/** 载入并解析一个 bundle 目录。不做语义校验，只做结构解析。 */
export async function loadBundle(dir: string): Promise<LoadResult> {
  const findings: Finding[] = [];

  // manifest 是唯一硬性必需的文件：没有它就无法知道 bundle 的身份和 project_ref。
  let manifestFile: string | null = null;
  let manifestText: string | null = null;
  for (const name of MANIFEST_CANDIDATES) {
    const text = await readIfExists(path.join(dir, name));
    if (text !== null) {
      manifestFile = name;
      manifestText = text;
      break;
    }
  }

  if (manifestText === null || manifestFile === null) {
    findings.push({
      code: 'PTKG001',
      severity: 'blocker',
      subject: dir,
      message: `bundle 目录缺少 manifest：期望 ${MANIFEST_CANDIDATES.join(' / ')} 之一。`,
      hint: '运行 `ptkg init <dir>` 生成骨架，或检查是否指向了错误的目录。',
    });
    return { bundle: null, findings };
  }

  const manifestParsed = parseYamlRows(manifestText, manifestFile);
  findings.push(...manifestParsed.findings);
  const manifest = (manifestParsed.rows[0] ?? {}) as unknown as PtkgManifest;

  const declared = (manifest as { files?: Record<string, string> }).files ?? {};

  const declaredNodes = safeDeclaredPart(
    dir,
    'nodes',
    declared.nodes,
    manifestFile,
    findings,
  );
  const declaredEdges = safeDeclaredPart(
    dir,
    'edges',
    declared.edges,
    manifestFile,
    findings,
  );
  const declaredSources = safeDeclaredPart(
    dir,
    'sources',
    declared.sources,
    manifestFile,
    findings,
  );

  const nodesPart = await locatePart(dir, declaredNodes, ['nodes.jsonl', 'nodes.yaml', 'nodes.yml']);
  const edgesPart = await locatePart(dir, declaredEdges, ['edges.jsonl', 'edges.yaml', 'edges.yml']);
  const sourcesPart = await locatePart(dir, declaredSources, [
    'sources.jsonl',
    'sources.yaml',
    'sources.yml',
  ]);

  for (const [label, part] of [
    ['nodes', nodesPart],
    ['edges', edgesPart],
    ['sources', sourcesPart],
  ] as const) {
    if (part === null) {
      findings.push({
        code: 'PTKG001',
        severity: 'blocker',
        subject: dir,
        message: `bundle 缺少 ${label} 文件。`,
        hint: `新建 ${label}.jsonl，或在 manifest.files.${label} 中声明实际路径。`,
      });
    }
  }

  const nodesParsed = nodesPart
    ? parseRows(nodesPart.text, nodesPart.file)
    : { rows: [], findings: [] };
  const edgesParsed = edgesPart
    ? parseRows(edgesPart.text, edgesPart.file)
    : { rows: [], findings: [] };
  const sourcesParsed = sourcesPart
    ? parseRows(sourcesPart.text, sourcesPart.file)
    : { rows: [], findings: [] };

  findings.push(...nodesParsed.findings, ...edgesParsed.findings, ...sourcesParsed.findings);

  const bundle: PtkgBundle = {
    manifest,
    nodes: nodesParsed.rows as unknown as PtkgNode[],
    edges: edgesParsed.rows as unknown as PtkgEdge[],
    sources: sourcesParsed.rows as unknown as PtkgSource[],
    origin: {
      manifest: manifestFile,
      nodes: nodesPart?.file ?? 'nodes.jsonl',
      edges: edgesPart?.file ?? 'edges.jsonl',
      sources: sourcesPart?.file ?? 'sources.jsonl',
    },
  };

  return { bundle, findings };
}
