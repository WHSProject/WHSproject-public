import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PolicyComparisonOutputFile {
  path: string;
  content: string;
}

export interface PolicyComparisonOutputFileSystem {
  access(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  writeFile(path: string, content: string, options: { encoding: 'utf8'; flag: 'wx' }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: PolicyComparisonOutputFileSystem = {
  access,
  mkdir: async (path, options) => { await mkdir(path, options); },
  writeFile,
  rename,
  unlink,
};
let temporaryFileSequence = 0;

export class PolicyLlmComparisonOutputError extends Error {
  constructor(readonly phase: 'DIRECTORY' | 'EXISTING_FILE' | 'WRITE' | 'COMMIT', readonly format?: 'JSON' | 'CSV') {
    super(`POLICY_LLM_HARNESS_OUTPUT_WRITE_FAILED:${phase}${format ? `:${format}` : ''}`);
  }
}

/**
 * Stages every requested output before committing it, so a JSON/CSV failure does
 * not leave a partial result file. Final paths are never overwritten.
 */
export async function writePolicyLlmComparisonOutputs(
  json: PolicyComparisonOutputFile,
  csv?: PolicyComparisonOutputFile,
  fileSystem: PolicyComparisonOutputFileSystem = nodeFileSystem,
): Promise<void> {
  const outputs = csv ? [json, csv] : [json];
  const temporary = outputs.map((output) => ({ ...output, temporaryPath: `${output.path}.tmp-${process.pid}-${temporaryFileSequence += 1}` }));
  const committed: string[] = [];
  try {
    await makeDirectories(outputs, fileSystem);
    await assertTargetsAvailable(outputs, fileSystem);
    for (const output of temporary) {
      try {
        await fileSystem.writeFile(output.temporaryPath, output.content, { encoding: 'utf8', flag: 'wx' });
      } catch {
        throw new PolicyLlmComparisonOutputError('WRITE', formatFor(output.path));
      }
    }
    for (const output of temporary) {
      try {
        await fileSystem.rename(output.temporaryPath, output.path);
        committed.push(output.path);
      } catch {
        throw new PolicyLlmComparisonOutputError('COMMIT', formatFor(output.path));
      }
    }
  } catch (error) {
    await cleanup([...temporary.map((output) => output.temporaryPath), ...committed], fileSystem);
    if (error instanceof PolicyLlmComparisonOutputError) throw error;
    throw new PolicyLlmComparisonOutputError('DIRECTORY');
  }
}

async function makeDirectories(outputs: PolicyComparisonOutputFile[], fileSystem: PolicyComparisonOutputFileSystem): Promise<void> {
  const directories = [...new Set(outputs.map((output) => dirname(output.path)))];
  try {
    for (const directory of directories) await fileSystem.mkdir(directory, { recursive: true });
  } catch {
    throw new PolicyLlmComparisonOutputError('DIRECTORY');
  }
}

async function assertTargetsAvailable(outputs: PolicyComparisonOutputFile[], fileSystem: PolicyComparisonOutputFileSystem): Promise<void> {
  for (const output of outputs) {
    try {
      await fileSystem.access(output.path);
      throw new PolicyLlmComparisonOutputError('EXISTING_FILE', formatFor(output.path));
    } catch (error) {
      if (error instanceof PolicyLlmComparisonOutputError) throw error;
      if (!isNotFound(error)) throw new PolicyLlmComparisonOutputError('EXISTING_FILE', formatFor(output.path));
    }
  }
}

async function cleanup(paths: string[], fileSystem: PolicyComparisonOutputFileSystem): Promise<void> {
  for (const path of paths) {
    try { await fileSystem.unlink(path); } catch { /* best-effort cleanup never masks the stable output error */ }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function formatFor(path: string): 'JSON' | 'CSV' | undefined {
  if (path.toLowerCase().endsWith('.json')) return 'JSON';
  if (path.toLowerCase().endsWith('.csv')) return 'CSV';
  return undefined;
}
