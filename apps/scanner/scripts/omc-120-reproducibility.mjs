import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const reportPath = resolve(process.env.OMC_TIER2_REPORT_PATH
  ?? 'reports/validation/tier2-omcbench-120-2026-09-30.json');
const manifestPath = resolve(process.env.OMC_REPRO_MANIFEST_PATH
  ?? 'reports/validation/omc-120-reproducibility-manifest-2026-09-30.json');
const archiveDir = resolve(process.env.OMC_ARCHIVE_DIR
  ?? 'reports/validation/omc-120-archives-2026-09-30');
const preserveArchives = process.env.OMC_PRESERVE_ARCHIVES !== '0';
const useExistingArchives = process.env.OMC_USE_EXISTING_ARCHIVES === '1';

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const repository = report.source.repository;
const revision = report.source.revision;
const sourceBase = `https://raw.githubusercontent.com/${repository}/${revision}/packages/`;
const selectionMethod = [
  'OMC results/manifest.csv JS rows',
  'archive size <= 1,000,000 bytes',
  '60 samples per label using existing tier2-omcbench-eval.mjs midpoint/even-spacing selection',
].join('; ');

if (preserveArchives) await mkdir(archiveDir, { recursive: true });

const parseFilenameIdentity = (archiveName) => {
  const withoutExtension = archiveName.replace(/\.(?:tgz|zip)$/iu, '');
  if (archiveName.endsWith('.zip')) {
    const at = withoutExtension.lastIndexOf('@');
    if (at > 0) return { packageName: withoutExtension.slice(0, at), version: withoutExtension.slice(at + 1) };
  }
  const versionMatch = withoutExtension.match(/-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u);
  if (versionMatch) {
    return { packageName: withoutExtension.slice(0, versionMatch.index), version: versionMatch[1] };
  }
  return { packageName: withoutExtension, version: null };
};

const samples = [];
for (const item of report.cases) {
  const sourceUrl = `${sourceBase}${encodeURIComponent(item.name)}`;
  const archivePath = join(archiveDir, item.name);
  const identity = parseFilenameIdentity(item.name);
  const sample = {
    package: identity.packageName,
    version: identity.version,
    archiveName: item.name,
    label: item.label,
    source: {
      repository,
      revision,
      url: sourceUrl,
    },
    selectionMethod,
    acquisitionStatus: 'PENDING',
    archiveSha256: null,
    archiveBytes: null,
    archivePath: preserveArchives ? `LOCAL_ARCHIVE_CACHE/${item.name}` : null,
  };
  try {
    const bytes = useExistingArchives
      ? await readFile(archivePath)
      : await downloadArchive(sourceUrl);
    sample.archiveBytes = bytes.length;
    sample.archiveSha256 = createHash('sha256').update(bytes).digest('hex');
    if (preserveArchives) await writeFile(archivePath, bytes);
    const archiveIdentity = readArchiveIdentity(archivePath);
    if (archiveIdentity.packageName !== null) sample.package = archiveIdentity.packageName;
    if (archiveIdentity.version !== null) sample.version = archiveIdentity.version;
    sample.acquisitionStatus = 'SUCCESS';
  } catch (error) {
    sample.acquisitionStatus = 'FAILED';
    sample.error = String(error.message).slice(0, 180);
  }
  samples.push(sample);
  console.log(`${samples.length}/${report.cases.length} ${sample.label} ${sample.archiveName}: ${sample.acquisitionStatus}`);
}

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dataset: {
    name: 'OMC-120',
    purpose: 'reproducible real-package Tier2/Gate-focused validation input',
    sourceRepository: repository,
    sourceRevision: revision,
    sourceManifestUrl: `https://raw.githubusercontent.com/${repository}/${revision}/results/manifest.csv`,
    sourceReport: reportPath,
    selectionMethod,
    packageExecution: 'NOT PERFORMED',
    archiveRetention: preserveArchives ? 'local ignored archive cache' : 'hash only',
  },
  samples,
  summary: {
    total: samples.length,
    benign: samples.filter((sample) => sample.label === 'benign').length,
    malicious: samples.filter((sample) => sample.label === 'malicious').length,
    acquired: samples.filter((sample) => sample.acquisitionStatus === 'SUCCESS').length,
    failed: samples.filter((sample) => sample.acquisitionStatus !== 'SUCCESS').length,
  },
};
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`manifest: ${manifestPath}`);

async function downloadArchive(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function readArchiveIdentity(archivePath) {
  try {
    const entries = execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8' })
      .split(/\r?\n/u).filter(Boolean);
    const packageEntry = entries.find((entry) => entry === 'package/package.json')
      ?? entries.find((entry) => entry === 'package.json')
      ?? entries.find((entry) => /(?:^|\/)package\.json$/iu.test(entry));
    if (packageEntry === undefined) return { packageName: null, version: null };
    const packageJson = JSON.parse(execFileSync('tar', ['-xOf', archivePath, packageEntry], {
      encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    }));
    return {
      packageName: typeof packageJson.name === 'string' ? packageJson.name : null,
      version: typeof packageJson.version === 'string' ? packageJson.version : null,
    };
  } catch {
    return { packageName: null, version: null };
  }
}
