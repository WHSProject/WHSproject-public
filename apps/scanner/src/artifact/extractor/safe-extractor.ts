import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { finished } from 'node:stream/promises';

import {
  ArtifactProcessingError,
  ExtractOptions,
  ExtractResult,
} from '../artifact.types';

const TAR_BLOCK_SIZE = 512;
const READ_CHUNK_SIZE = 64 * 1024;

interface TarHeader {
  name: string;
  size: number;
  type: string;
  linkName: string;
  prefix: string;
}

export class SafeExtractor {
  async extract(options: ExtractOptions): Promise<ExtractResult> {
    if (!options.integrity.verified) {
      throw this.extractError('Artifact integrity must be verified before extraction');
    }

    const maxBytes = options.maxExtractedBytes ?? this.readLimit('MAX_EXTRACTED_BYTES');
    const maxFiles = options.maxExtractedFiles ?? this.readLimit('MAX_EXTRACTED_FILES');
    const maxDepth = options.maxPathDepth;
    let files = 0;
    let bytes = 0;
    let pendingLongName: string | undefined;
    let pendingPaxPath: string | undefined;
    let createdRoot = false;
    let archiveStream: ReturnType<typeof createGunzip> | undefined;

    try {
      await stat(options.artifactPath);
      await mkdir(options.extractedPath);
      createdRoot = true;

      archiveStream = createReadStream(options.artifactPath).pipe(createGunzip());
      const reader = new TarReader(archiveStream);

      while (true) {
        const block = await reader.readExactly(TAR_BLOCK_SIZE);
        if (block.every((value) => value === 0)) break;

        const header = this.parseHeader(block);

        if (header.type === 'L') {
          const payload = await reader.readPayload(header.size);
          await reader.discardPadding(header.size);
          pendingLongName = this.parseLongName(payload);
          continue;
        }
        if (header.type === 'x' || header.type === 'g') {
          const payload = await reader.readPayload(header.size);
          await reader.discardPadding(header.size);
          pendingPaxPath = this.parsePaxPath(payload) ?? pendingPaxPath;
          continue;
        }

        const entryName = pendingPaxPath ?? pendingLongName ?? this.joinHeaderPath(header);
        pendingLongName = undefined;
        pendingPaxPath = undefined;
        const destination = this.resolveEntry(options.extractedPath, entryName, maxDepth);

        if (header.type === '5') {
          await reader.discardPayload(header.size);
          await reader.discardPadding(header.size);
          await mkdir(destination, { recursive: true });
          continue;
        }

        if (header.type === '2' || header.type === '1') {
          throw this.extractError('Symbolic and hard links are not allowed in artifacts');
        }
        if (header.type !== '0' && header.type !== '') {
          throw this.extractError(`Unsupported tar entry type: ${header.type}`);
        }

        files += 1;
        if (maxFiles !== undefined && files > maxFiles) {
          throw this.extractError('Extracted file count exceeds the configured limit');
        }
        if (maxBytes !== undefined && header.size > maxBytes - bytes) {
          throw this.extractError('Extracted size exceeds the configured limit');
        }

        await mkdir(dirname(destination), { recursive: true });
        const output = createWriteStream(destination, { flags: 'wx' });
        try {
          await reader.consumePayload(header.size, async (chunk) => {
            bytes += chunk.length;
            if (!output.write(chunk)) await new Promise<void>((resolvePromise) => output.once('drain', resolvePromise));
          });
          await reader.discardPadding(header.size);
          output.end();
          await finished(output);
        } catch (error) {
          output.destroy();
          throw error;
        }
      }

      return { extractedPath: options.extractedPath, files, bytes };
    } catch (error) {
      archiveStream?.destroy();
      if (createdRoot) await rm(options.extractedPath, { recursive: true, force: true });
      if (error instanceof ArtifactProcessingError) throw error;
      throw this.extractError(error instanceof Error ? error.message : 'Artifact extraction failed');
    }
  }

  private parseHeader(block: Buffer): TarHeader {
    const storedChecksum = this.parseOctal(block.subarray(148, 156));
    const checksumBlock = Buffer.from(block);
    checksumBlock.fill(0x20, 148, 156);
    const checksum = checksumBlock.reduce((sum, value) => sum + value, 0);
    if (storedChecksum !== checksum) throw this.extractError('Tar header checksum is invalid');

    return {
      name: this.readString(block.subarray(0, 100)),
      size: this.parseOctal(block.subarray(124, 136)),
      type: this.readString(block.subarray(156, 157)),
      linkName: this.readString(block.subarray(157, 257)),
      prefix: this.readString(block.subarray(345, 500)),
    };
  }

  private joinHeaderPath(header: TarHeader): string {
    return header.prefix.length > 0 ? `${header.prefix}/${header.name}` : header.name;
  }

  private resolveEntry(root: string, entryName: string, maxDepth: number | undefined): string {
    if (entryName.length === 0 || entryName.includes('\0') || entryName.includes('\\')) {
      throw this.extractError('Tar entry path is invalid');
    }

    const rawSegments = entryName.split('/');
    if (entryName.startsWith('/') || entryName.startsWith('~') || rawSegments.includes('..')) {
      throw this.extractError('Tar entry path traversal is not allowed');
    }
    const normalized = posix.normalize(entryName);
    const segments = normalized.split('/').filter(Boolean);
    if ((maxDepth !== undefined && segments.length > maxDepth) || /^[A-Za-z]:/u.test(entryName)) {
      throw this.extractError('Tar entry path depth or format is not allowed');
    }

    const rootPath = resolve(root);
    const destination = resolve(rootPath, ...segments);
    const relativePath = relative(rootPath, destination);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw this.extractError('Tar entry resolves outside extraction directory');
    }
    return join(rootPath, relativePath);
  }

  private parseLongName(payload: Buffer[]): string {
    return Buffer.concat(payload).toString('utf8').replace(/\0+$/u, '').trimEnd();
  }

  private parsePaxPath(payload: Buffer[]): string | undefined {
    const text = Buffer.concat(payload).toString('utf8');
    for (const record of text.split(/(?=\d+ [^\n]*\n)/u)) {
      const match = /^\d+ path=(.*)\n$/su.exec(record);
      if (match !== null) return match[1];
    }
    return undefined;
  }

  private parseOctal(value: Buffer): number {
    const text = value.toString('ascii').replace(/\0.*$/u, '').trim();
    if (text === '') return 0;
    const parsed = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw this.extractError('Tar numeric field is invalid');
    return parsed;
  }

  private readString(value: Buffer): string {
    return value.toString('utf8').replace(/\0.*$/u, '');
  }

  private readLimit(name: string): number | undefined {
    const configured = Number(process.env[name]);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : undefined;
  }

  private extractError(message: string): ArtifactProcessingError {
    return new ArtifactProcessingError('EXTRACT_FAILED', 'EXTRACT', message);
  }
}

class TarReader {
  private buffered = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(stream: NodeJS.ReadableStream) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async readExactly(size: number): Promise<Buffer> {
    while (this.buffered.length < size) {
      const next = await this.iterator.next();
      if (next.done) throw new Error('Unexpected end of gzip tar stream');
      this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
    }
    const result = this.buffered.subarray(0, size);
    this.buffered = this.buffered.subarray(size);
    return result;
  }

  async readPayload(size: number): Promise<Buffer[]> {
    const chunks: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      const chunk = await this.readExactly(Math.min(READ_CHUNK_SIZE, remaining));
      chunks.push(chunk);
      remaining -= chunk.length;
    }
    return chunks;
  }

  async consumePayload(size: number, consume: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      const chunk = await this.readExactly(Math.min(READ_CHUNK_SIZE, remaining));
      await consume(chunk);
      remaining -= chunk.length;
    }
  }

  async discardPayload(size: number): Promise<void> {
    await this.consumePayload(size, async () => undefined);
  }

  async discardPadding(size: number): Promise<void> {
    const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) await this.readExactly(padding);
  }
}
