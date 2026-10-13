import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { dirname, join, posix } from 'node:path';

const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_CODE_FILES = 1_000;
const MAX_FILE_BYTES = 512_000;
const MAX_TOTAL_BYTES = 20_000_000;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export async function extractZipCodeOnly(archivePath, extractedPath) {
  const archive = await readFile(archivePath);
  const entries = readZipEntries(archive);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('archive entry limit exceeded');
  }

  const extracted = [];
  const outputPaths = new Set();
  let skippedLargeFiles = 0;
  let extractedBytes = 0;
  for (const entry of entries) {
    const normalized = normalizeEntryPath(entry.name);
    if (normalized === undefined) continue;
    if (entry.isSymlink) throw new Error('symbolic links are not allowed in zip archives');
    if (entry.isDirectory) continue;
    if (!/\.(?:js|cjs|mjs|json)$/iu.test(entry.name)) continue;
    if (outputPaths.has(normalized)) {
      throw new Error(`duplicate normalized output path: ${normalized}`);
    }
    outputPaths.add(normalized);
    if (extracted.length >= MAX_CODE_FILES) {
      throw new Error('code file count limit exceeded');
    }
    if (entry.uncompressedSize > MAX_FILE_BYTES) {
      skippedLargeFiles += 1;
      continue;
    }
    if (extractedBytes + entry.uncompressedSize > MAX_TOTAL_BYTES) {
      throw new Error('total extraction limit exceeded');
    }

    const content = readZipEntry(archive, entry);
    if (content.length > MAX_FILE_BYTES) {
      skippedLargeFiles += 1;
      continue;
    }
    if (content.length !== entry.uncompressedSize) {
      throw new Error('zip entry size mismatch');
    }
    extractedBytes += content.length;
    const destination = join(extractedPath, normalized);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    extracted.push(normalized);
  }
  return { files: extracted, skippedLargeFiles };
}

function readZipEntries(archive) {
  const eocdOffset = findEndOfCentralDirectory(archive);
  if (eocdOffset < 0) throw new Error('zip end of central directory is missing');

  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const entriesTotal = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entriesTotal
    || entriesTotal === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('zip64 and multi-disk archives are not supported');
  }
  if (entriesTotal > MAX_ARCHIVE_ENTRIES) {
    throw new Error('archive entry limit exceeded');
  }
  if (centralOffset + centralSize > archive.length) {
    throw new Error('zip central directory is outside the archive');
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entriesTotal; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('zip central directory entry is invalid');
    }
    const madeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + commentLength;
    if (nextOffset > archive.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff) {
      throw new Error('zip entry uses unsupported zip64 fields');
    }
    if ((flags & 0x1) !== 0) throw new Error('encrypted zip entries are not supported');

    entries.push({
      name: archive.subarray(nameStart, nameStart + nameLength).toString('utf8'),
      nameBytes: archive.subarray(nameStart, nameStart + nameLength),
      flags,
      compression,
      compressedSize,
      uncompressedSize,
      localOffset,
      isDirectory: archive.subarray(nameStart, nameStart + nameLength).at(-1) === 0x2f
        || ((madeBy >>> 8) === 3 && ((externalAttributes >>> 16) & 0xf000) === 0x4000)
        || ((madeBy >>> 8) !== 3 && (externalAttributes & 0x10) !== 0),
      isSymlink: (madeBy >>> 8) === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000,
    });
    offset = nextOffset;
  }
  return entries;
}

function findEndOfCentralDirectory(archive) {
  if (archive.length < 22) return -1;
  const start = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readZipEntry(archive, entry) {
  if (entry.localOffset + 30 > archive.length
    || archive.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error('zip local entry is invalid');
  }
  const nameLength = archive.readUInt16LE(entry.localOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localOffset + 28);
  const localFlags = archive.readUInt16LE(entry.localOffset + 6);
  const localCompression = archive.readUInt16LE(entry.localOffset + 8);
  const localCompressedSize = archive.readUInt32LE(entry.localOffset + 18);
  const localUncompressedSize = archive.readUInt32LE(entry.localOffset + 22);
  const localName = archive.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength);
  if (!localName.equals(entry.nameBytes)) throw new Error('zip local filename mismatch');
  if (localFlags !== entry.flags) throw new Error('zip local flags mismatch');
  if (localCompression !== entry.compression) throw new Error('zip local compression mismatch');
  const usesDataDescriptor = (entry.flags & 0x08) !== 0;
  if ((!usesDataDescriptor && localCompressedSize !== entry.compressedSize)
    || (!usesDataDescriptor && localUncompressedSize !== entry.uncompressedSize)
    || (usesDataDescriptor && localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
    || (usesDataDescriptor && localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)) {
    throw new Error('zip local size mismatch');
  }
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > archive.length) throw new Error('zip entry data is outside the archive');

  const compressed = archive.subarray(dataStart, dataEnd);
  if (entry.compression === 0) return Buffer.from(compressed);
  if (entry.compression === 8) {
    // CRC32 is intentionally not verified in this benchmark-only reader.
    return inflateRawSync(compressed, { maxOutputLength: MAX_FILE_BYTES });
  }
  throw new Error(`unsupported zip compression method: ${entry.compression}`);
}

function normalizeEntryPath(entry) {
  if (entry.startsWith('/') || entry.includes('\\') || entry.includes('\0')) return undefined;
  if (/^[A-Za-z]:/u.test(entry)) return undefined;
  const normalized = posix.normalize(entry.replace(/^\.\//u, ''));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return undefined;
  return normalized;
}
