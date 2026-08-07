import path from 'node:path';

import { computeContentHash } from '../authoring/hash.ts';
import type { AuthoringObject } from '../authoring/types.ts';
import type { AnalyzerContext, AnalyzerResult, SourceAnalyzer } from './types.ts';

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || 'root';
}

function anchorId(file: string, symbol?: string): string {
  return `anchor.project.${slug(file)}${symbol ? `.${slug(symbol)}` : ''}`;
}

function fact(
  context: AnalyzerContext,
  input: {
    id: string;
    kind: 'module' | 'symbol' | 'dependency' | 'test' | 'build_entry';
    statement: string;
    file: string;
    symbol?: string;
    status?: 'candidate' | 'unresolved';
    method?: 'git' | 'parser';
  },
): AuthoringObject {
  const anchor = anchorId(input.file, input.symbol);
  const object: AuthoringObject = {
    spec_version: 'code-fact@0.1',
    id: `fact.project.${slug(input.id)}`,
    run_id: context.runId,
    project_ref: context.projectRef,
    status: input.status ?? 'candidate',
    input_refs: ['project-input'],
    claims: [
      {
        id: `claim.project.${slug(input.id)}`,
        statement: input.statement,
        epistemic_status: 'verified_fact',
        source_refs: [`src.repo.${slug(context.projectRef.repo)}`],
        anchor_refs: [anchor],
        method: input.method ?? 'git',
        validity: { commit_bound: true, invalidates_on: ['anchor_change'] },
      },
    ],
    created_by: { actor_type: 'tool', actor_id: 'ptkg-source-analyzer' },
    content_hash: '',
    created_at: new Date().toISOString(),
    fact_kind: input.kind,
    anchors: [
      {
        id: anchor,
        path: input.file,
        ...(input.symbol ? { symbol: input.symbol } : {}),
      },
    ],
  };
  object.content_hash = computeContentHash(object);
  return object;
}

function rustDeclarations(source: string): string[] {
  const declarations: string[] = [];
  const expression = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
  for (const line of source.split(/\r?\n/)) {
    const name = line.match(expression)?.[1];
    if (name && !declarations.includes(name)) declarations.push(name);
    if (declarations.length >= 20) break;
  }
  return declarations;
}

export class GitAnalyzer implements SourceAnalyzer {
  readonly id = 'git';

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const files = await context.listFiles();
    if (files.length === 0) return { analyzer: this.id, capability: 'file', facts: [], warnings: ['固定 Git tree 为空。'] };
    const entry = files.find((file) => /^readme(?:\.|$)/i.test(path.posix.basename(file))) ?? files[0] as string;
    return {
      analyzer: this.id,
      capability: 'file',
      facts: [fact(context, {
        id: 'git-fixed-tree',
        kind: 'module',
        statement: `固定 commit ${context.commit} 的 Git tree 已读取并包含 ${files.length} 个文件`,
        file: entry,
      })],
      warnings: [],
    };
  }
}

export class MarkdownAnalyzer implements SourceAnalyzer {
  readonly id = 'markdown';

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const files = (await context.listFiles()).filter((file) => /\.md$/i.test(file)).slice(0, 100);
    return {
      analyzer: this.id,
      capability: 'file',
      facts: files.map((file) => fact(context, {
        id: `markdown-${file}`,
        kind: 'module',
        statement: `固定源码中存在项目文档 ${file}`,
        file,
      })),
      warnings: files.length === 100 ? ['Markdown 文件超过 100 个，首轮索引已截断。'] : [],
    };
  }
}

export class CargoAnalyzer implements SourceAnalyzer {
  readonly id = 'cargo';

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const files = (await context.listFiles()).filter((file) => path.posix.basename(file) === 'Cargo.toml').slice(0, 100);
    return {
      analyzer: this.id,
      capability: 'file',
      facts: files.map((file) => fact(context, {
        id: `cargo-${file}`,
        kind: 'build_entry',
        statement: `固定源码中的 Cargo 构建入口为 ${file}`,
        file,
      })),
      warnings: files.length === 0 ? ['未发现 Cargo.toml；Rust/Cargo 能力不适用或尚未确认。'] : [],
    };
  }
}

export class RustAnalyzer implements SourceAnalyzer {
  readonly id = 'rust-declaration-v1';

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const files = (await context.listFiles()).filter((file) => file.endsWith('.rs')).slice(0, 300);
    const facts: AuthoringObject[] = [];
    for (const file of files) {
      const source = await context.readFile(file);
      const declarations = rustDeclarations(source);
      if (declarations.length === 0) {
        facts.push(fact(context, {
          id: `rust-module-${file}`,
          kind: 'module',
          statement: `固定源码中存在 Rust 模块文件 ${file}`,
          file,
        }));
      } else {
        for (const symbol of declarations) {
          facts.push(fact(context, {
            id: `rust-symbol-${file}-${symbol}`,
            kind: 'symbol',
            statement: `Rust 声明 ${symbol} 位于固定源码文件 ${file}`,
            file,
            symbol,
            method: 'parser',
          }));
        }
      }
    }
    return {
      analyzer: this.id,
      capability: 'symbol',
      facts,
      warnings: files.length === 300 ? ['Rust 文件超过 300 个，首轮声明索引已截断。'] : [],
    };
  }
}

export class GenericFileAnalyzer implements SourceAnalyzer {
  readonly id = 'generic-file';

  async analyze(context: AnalyzerContext): Promise<AnalyzerResult> {
    const supported = new Set(['.c', '.h', '.cc', '.cpp', '.s', '.asm', '.py', '.go', '.java', '.kt', '.zig']);
    const files = (await context.listFiles())
      .filter((file) => supported.has(path.posix.extname(file).toLowerCase()))
      .slice(0, 200);
    return {
      analyzer: this.id,
      capability: 'file',
      facts: files.map((file) => fact(context, {
        id: `generic-${file}`,
        kind: /(?:^|\/)(?:test|tests|test-suit)(?:\/|$)/i.test(file) ? 'test' : 'module',
        statement: `固定源码中存在 ${file}；当前仅完成文件级定位，语言符号语义待专用分析器核实`,
        file,
        status: 'unresolved',
      })),
      warnings: files.length > 0 ? ['非 Rust 源码当前退化为文件级事实，不能声明符号或调用关系已验证。'] : [],
    };
  }
}

export const DEFAULT_ANALYZERS: readonly SourceAnalyzer[] = [
  new GitAnalyzer(),
  new MarkdownAnalyzer(),
  new CargoAnalyzer(),
  new RustAnalyzer(),
  new GenericFileAnalyzer(),
];

export async function runSourceAnalyzers(
  context: AnalyzerContext,
  analyzers: readonly SourceAnalyzer[] = DEFAULT_ANALYZERS,
): Promise<AnalyzerResult[]> {
  const results: AnalyzerResult[] = [];
  for (const analyzer of analyzers) results.push(await analyzer.analyze(context));
  return results;
}
