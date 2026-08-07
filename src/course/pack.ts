import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import type { CoursePackResult } from './types.ts';
import { listPackageFiles, loadCoursePackage, safeCoursePath } from './io.ts';
import { validateCoursePackage } from './validate.ts';

const TAR_BLOCK = 512;

function writeString(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > length) throw new Error(`tar 路径或字段过长：${value}`);
  bytes.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  writeString(target, offset, length, encoded);
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'ptkg');
  writeString(header, 297, 32, 'ptkg');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

async function deterministicTar(root: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const files = (await listPackageFiles(root)).filter((file) => !file.endsWith('.tgz')).sort();
  for (const file of files) {
    if (!safeCoursePath(file)) throw new Error(`不安全的课程包路径：${file}`);
    const bytes = await readFile(path.join(root, file));
    chunks.push(tarHeader(file, bytes.byteLength), bytes);
    const padding = (TAR_BLOCK - (bytes.byteLength % TAR_BLOCK)) % TAR_BLOCK;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(chunks);
}

export async function packCoursePackage(
  directory: string,
  output?: string,
  trustStore?: string,
): Promise<CoursePackResult> {
  const root = path.resolve(directory);
  const validation = await validateCoursePackage(root, 'release', { trustStore });
  if (!validation.passed) {
    throw new Error(`只有通过 release 校验的课程包才能归档：${validation.findings
      .filter((item) => item.severity === 'blocker')
      .map((item) => `${item.code} ${item.subject}`)
      .join('；')}`);
  }
  const loaded = await loadCoursePackage(root);
  if (!loaded.package?.checksums) throw new Error('课程包缺少 checksums。');
  const archive = path.resolve(output ?? `${root}.tgz`);
  const gzip = gzipSync(await deterministicTar(root), { level: 9 });
  await writeFile(archive, gzip);
  return {
    package_dir: root,
    archive,
    bytes: gzip.byteLength,
    root_hash: loaded.package.checksums.root_hash,
  };
}
