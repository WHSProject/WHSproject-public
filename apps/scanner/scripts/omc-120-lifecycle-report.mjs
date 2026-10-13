import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { analyzeP0StaticFlows } from '../dist/analyzers/custom-rule/custom-rule-p0-static.js';
import { MetadataAnalyzer } from '../dist/analyzers/metadata/metadata.analyzer.js';
import { extractZipCodeOnly } from './tier2-omcbench-archive.mjs';

const manifestPath = resolve(process.env.OMC_REPRO_MANIFEST_PATH
  ?? 'reports/validation/omc-120-reproducibility-manifest-2026-09-30.json');
const archiveRoot = resolve(process.env.OMC_ARCHIVE_ROOT
  ?? 'reports/validation/omc-120-archives-2026-09-30');
const reportPath = resolve(process.env.OMC_LIFECYCLE_REPORT_PATH
  ?? 'reports/validation/omc-120-lifecycle-report-2026-09-30.json');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const metadata = new MetadataAnalyzer();
const lifecycleNames = ['preinstall', 'install', 'postinstall', 'prepare'];
const downloadPattern = /(?:curl|wget|fetch\s*\(|https?:\/\/|Invoke-WebRequest|npm\s+(?:install|pack))/iu;
const executionPattern = /(?:\bnode\b|\bnpx\b|\bpython(?:3)?\b|\bsh\b|\bbash\b|\bpowershell\b|\bexec(?:File|Sync)?\s*\(|child_process|require\s*\(\s*['"]child_process)/iu;
const credentialPattern = /(?:NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|AWS_ACCESS_KEY|AWS_SECRET|AZURE_CLIENT_SECRET|process\.env)/iu;
const sensitivePattern = /(?:\.npmrc|\.ssh|id_rsa|credential|secret|token|password|passwd)/iu;

const readPackageJson = (archivePath) => {
  const entries = execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8' })
    .split(/\r?\n/u).filter(Boolean);
  const packageEntry = entries.find((entry) => entry === 'package/package.json')
    ?? entries.find((entry) => entry === 'package.json')
    ?? entries.find((entry) => /(?:^|\/)package\.json$/iu.test(entry));
  if (!packageEntry) return { packageJson: null, packageJsonPath: null };
  const content = execFileSync('tar', ['-xOf', archivePath, packageEntry], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  return { packageJson: JSON.parse(content), packageJsonPath: packageEntry };
};

const samples = [];
for (const sample of manifest.samples) {
  const archivePath = resolve(archiveRoot, sample.archiveName);
  const row = {
    package: sample.package,
    version: sample.version,
    archiveName: sample.archiveName,
    label: sample.label,
    archiveSha256: sample.archiveSha256,
    packageJsonPath: null,
    lifecycleScripts: [],
    metadataFindingRuleIds: [],
    p0RuleIds: [],
    p0RelationTypes: [],
    p0ExecutionContexts: [],
    staticCommandObservations: {
      downloadOrNetwork: false,
      processExecution: false,
      credentialOrEnvironmentSource: false,
      sensitiveFileOrSecretReference: false,
    },
    status: 'SUCCESS',
  };
  try {
    const extracted = readPackageJson(archivePath);
    row.packageJsonPath = extracted.packageJsonPath;
    const packageJson = extracted.packageJson ?? {};
    const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
    row.lifecycleScripts = lifecycleNames
      .filter((name) => Object.prototype.hasOwnProperty.call(scripts, name))
      .map((name) => ({ name, command: typeof scripts[name] === 'string' ? scripts[name] : String(scripts[name]) }));
    row.metadataFindingRuleIds = metadata.findLifecycleScripts({ registryMetadata: null, packageJson })
      .map((finding) => finding.ruleId);
    const commandText = row.lifecycleScripts.map(({ command }) => command).join('\n');
    row.staticCommandObservations = {
      downloadOrNetwork: downloadPattern.test(commandText),
      processExecution: executionPattern.test(commandText),
      credentialOrEnvironmentSource: credentialPattern.test(commandText),
      sensitiveFileOrSecretReference: sensitivePattern.test(commandText),
    };
    const workRoot = await mkdtemp(join(tmpdir(), 'omc-120-lifecycle-'));
    try {
      const extractedFiles = await extractCodeOnly(archivePath, workRoot);
      const p0 = await analyzeP0StaticFlows(workRoot, packageJson);
      row.p0RuleIds = [...new Set(p0.observations.map(({ ruleId }) => ruleId))].sort();
      row.p0RelationTypes = [...new Set(p0.relations.map(({ relationType }) => relationType))].sort();
      row.p0ExecutionContexts = [...new Set(p0.observations.map(({ data }) => data.executionContext))].sort();
      row.extractedCodeFileCount = extractedFiles.length;
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  } catch (error) {
    row.status = 'FAILED';
    row.error = String(error.message).slice(0, 180);
  }
  samples.push(row);
  console.log(`${samples.length}/${manifest.samples.length} ${sample.label} ${sample.archiveName}: ${row.status}`);
}

const lifecycleSamples = samples.filter((sample) => sample.lifecycleScripts.length > 0);
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceManifest: manifestPath,
  archiveRoot: 'LOCAL_ARCHIVE_CACHE',
  executionSafety: {
    packageExecution: false,
    lifecycleExecution: false,
    networkCallsByPackage: false,
    analysis: 'package.json metadata and lifecycle command text only',
  },
  summary: {
    total: samples.length,
    succeeded: samples.filter((sample) => sample.status === 'SUCCESS').length,
    failed: samples.filter((sample) => sample.status !== 'SUCCESS').length,
    benignWithLifecycle: lifecycleSamples.filter((sample) => sample.label === 'benign').length,
    maliciousWithLifecycle: lifecycleSamples.filter((sample) => sample.label === 'malicious').length,
    lifecycleScriptCount: lifecycleSamples.reduce((total, sample) => total + sample.lifecycleScripts.length, 0),
    lifecycleWithDownloadOrNetwork: lifecycleSamples.filter((sample) => sample.staticCommandObservations.downloadOrNetwork).length,
    lifecycleWithProcessExecution: lifecycleSamples.filter((sample) => sample.staticCommandObservations.processExecution).length,
    lifecycleWithCredentialOrEnvironmentSource: lifecycleSamples.filter((sample) => sample.staticCommandObservations.credentialOrEnvironmentSource).length,
    lifecycleWithSensitiveReference: lifecycleSamples.filter((sample) => sample.staticCommandObservations.sensitiveFileOrSecretReference).length,
  },
  samples,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`report: ${reportPath}`);

async function extractCodeOnly(archivePath, extractedPath) {
  if (archivePath.endsWith('.zip')) return (await extractZipCodeOnly(archivePath, extractedPath)).files;
  const entries = execFileSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 5_000_000,
  }).split(/\r?\n/u).filter(Boolean);
  const extracted = [];
  let extractedBytes = 0;
  for (const entry of entries) {
    if (!/\.(?:js|cjs|mjs|json)$/iu.test(entry)) continue;
    if (extracted.length >= 1_000) throw new Error('code file count limit exceeded');
    if (entry.startsWith('/') || entry.includes('\\') || entry.includes('\0')) continue;
    const normalized = posix.normalize(entry.replace(/^\.\//u, ''));
    if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) continue;
    const content = execFileSync('tar', ['-xOzf', archivePath, entry], {
      timeout: 10_000,
      maxBuffer: 600_000,
    });
    if (content.length > 512_000) continue;
    extractedBytes += content.length;
    if (extractedBytes > 20_000_000) throw new Error('code extraction size limit exceeded');
    const destination = join(extractedPath, normalized);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    extracted.push(normalized);
  }
  return extracted;
}
