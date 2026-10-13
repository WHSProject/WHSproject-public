import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface SafeCodeFile { file: string; lines: string[] }

export class SafeCodeFileError extends Error {
  constructor(readonly kind: 'TOO_LARGE' | 'BINARY', readonly sizeBytes?: number) {
    super(kind === 'TOO_LARGE' ? 'Oversized code file' : 'Binary code file');
  }
}

export async function readSafeCodeFile(root: string, file: string, maxBytes: number, signal?: AbortSignal): Promise<SafeCodeFile> {
  signal?.throwIfAborted();
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Unsafe package root');
  if (!file || isAbsolute(file) || file.includes('\\') || file.includes('\0') || file.split('/').some((part) => part === '..' || part === '' || part === '.')) throw new Error('Invalid package relative path');
  const absoluteRoot = await realpath(root);
  const destination = resolve(absoluteRoot, file);
  const relativePath = relative(absoluteRoot, destination);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error('Path outside package root');
  const parts = relativePath.split(sep);
  let current = absoluteRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new Error('Unsafe package path');
    if (index === parts.length - 1 && (!info.isFile() || info.nlink !== 1)) throw new Error('Unsafe code file');
    if (index === parts.length - 1 && info.size > maxBytes) throw new SafeCodeFileError('TOO_LARGE', info.size);
  }
  const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe code file');
    if (info.size > maxBytes) throw new SafeCodeFileError('TOO_LARGE', info.size);
    const bytes = await handle.readFile({ signal });
    signal?.throwIfAborted();
    if (bytes.includes(0)) throw new SafeCodeFileError('BINARY');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new SafeCodeFileError('BINARY'); }
    return { file: relativePath.split(sep).join('/'), lines: content.replace(/\r\n/g, '\n').split('\n') };
  } finally { await handle.close(); }
}
