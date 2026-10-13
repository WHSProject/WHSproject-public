import { Injectable } from '@nestjs/common';

import type {
  AnalyzerResult,
  Finding,
} from '../../domain/analysis.types';
import type { Analyzer, AnalyzerContext } from '../analyzer.contract';

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
export const METADATA_ANALYZER_VERSION = '0.1.0';

export type MetadataLifecycleScript = (typeof LIFECYCLE_SCRIPTS)[number];

/**
 * Legacy observation shape retained for the existing analyzer API and adapted
 * to the shared Finding contract by analyzeResult.
 */
export interface MetadataLifecycleObservation {
  ruleId: `metadata.lifecycle.${MetadataLifecycleScript}`;
  type: 'LIFECYCLE_SCRIPT';
  message: string;
  location: {
    type: 'METADATA';
    jsonPointer: `/scripts/${MetadataLifecycleScript}`;
  };
  data: {
    scriptName: MetadataLifecycleScript;
    scriptValue: unknown;
    observation: 'PRESENT';
  };
}

export type MetadataConsistencyField = 'license' | 'repository';

export interface MetadataMismatchObservation {
  ruleId: `metadata.${MetadataConsistencyField}.mismatch`;
  type: 'METADATA_MISMATCH';
  message: string;
  location: {
    type: 'METADATA';
    jsonPointer: `/${MetadataConsistencyField}`;
  };
  data: {
    field: MetadataConsistencyField;
    packageJsonValue: string;
    registryMetadataValue: string;
    observation: 'MISMATCH';
  };
}

export interface MetadataAnalyzerInput {
  registryMetadata: unknown;
  packageJson: unknown;
}

export type MetadataFinding = Finding<
  MetadataLifecycleObservation['data'] | MetadataMismatchObservation['data']
>;

export interface MetadataAnalyzerResult extends AnalyzerResult<MetadataFinding> {}

@Injectable()
export class MetadataAnalyzer implements Analyzer<
  MetadataAnalyzerInput,
  MetadataAnalyzerResult
> {
  readonly name = 'metadata';
  readonly version = METADATA_ANALYZER_VERSION;

  /**
   * Adapts the existing lifecycle observations to the shared analyzer result contract.
   * The lifecycle detection itself remains in findLifecycleScripts.
   */
  analyzeResult(
    input: MetadataAnalyzerInput,
    context: AnalyzerContext,
    // Metadata rules are synchronous; the signal is accepted for the common
    // contract but cannot interrupt work already on the call stack.
    _signal?: AbortSignal,
  ): MetadataAnalyzerResult {
    // Keep lifecycle observations first so their existing finding IDs remain stable.
    const observations: Array<MetadataLifecycleObservation | MetadataMismatchObservation> = [
      ...this.findLifecycleScripts(input),
      ...this.findMetadataMismatches(input),
    ];

    return {
      requestId: context.requestId,
      scanId: context.scanId,
      analyzer: this.name,
      analyzerVersion: this.version,
      status: 'SUCCESS',
      findings: observations.map((observation, index) => this.toFinding(observation, index)),
      errors: [],
    };
  }

  private toFinding(
    observation: MetadataLifecycleObservation | MetadataMismatchObservation,
    index: number,
  ): MetadataFinding {
    return {
      findingId: `${this.name}:${observation.ruleId}:${index}`,
      ruleId: observation.ruleId,
      type: observation.type,
      message: observation.message,
      location: observation.location,
      data: observation.data,
    };
  }

  /**
   * Detects only the presence of the first-phase lifecycle script fields.
   * No script content is interpreted or executed.
   */
  findLifecycleScripts(input: MetadataAnalyzerInput): MetadataLifecycleObservation[] {
    const packageJson = asRecord(input.packageJson);
    const scripts = asRecord(packageJson?.scripts);
    if (scripts === undefined) return [];

    return LIFECYCLE_SCRIPTS.flatMap((scriptName) => {
      if (!Object.prototype.hasOwnProperty.call(scripts, scriptName)) return [];

      return [createObservation(scriptName, scripts[scriptName])];
    });
  }

  /**
   * Compares metadata present in both the tarball manifest and the npm
   * version manifest. Missing or unsupported values are deliberately ignored.
   */
  findMetadataMismatches(input: MetadataAnalyzerInput): MetadataMismatchObservation[] {
    const packageJson = asRecord(input.packageJson);
    const registryMetadata = asRecord(input.registryMetadata);
    if (packageJson === undefined || registryMetadata === undefined) return [];

    const observations: MetadataMismatchObservation[] = [];
    const packageLicense = normalizeLicense(packageJson.license);
    const registryLicense = normalizeLicense(registryMetadata.license);
    if (
      packageLicense !== undefined &&
      registryLicense !== undefined &&
      packageLicense.normalized !== registryLicense.normalized
    ) {
      observations.push(createMismatchObservation(
        'license',
        packageLicense.value,
        registryLicense.value,
      ));
    }

    const packageRepository = normalizeRepository(packageJson.repository);
    const registryRepository = normalizeRepository(registryMetadata.repository);
    if (
      packageRepository !== undefined &&
      registryRepository !== undefined &&
      packageRepository.normalized !== registryRepository.normalized
    ) {
      observations.push(createMismatchObservation(
        'repository',
        packageRepository.value,
        registryRepository.value,
      ));
    }

    return observations;
  }
}

function createObservation(
  scriptName: MetadataLifecycleScript,
  scriptValue: unknown,
): MetadataLifecycleObservation {
  return {
    ruleId: `metadata.lifecycle.${scriptName}`,
    type: 'LIFECYCLE_SCRIPT',
    message: `Lifecycle script "${scriptName}" is present in package.json`,
    location: {
      type: 'METADATA',
      jsonPointer: `/scripts/${scriptName}`,
    },
    data: {
      scriptName,
      scriptValue,
      observation: 'PRESENT',
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeLicense(value: unknown): { value: string; normalized: string } | undefined {
  const candidate = typeof value === 'string'
    ? value
    : asRecord(value)?.type;
  if (typeof candidate !== 'string') return undefined;

  const normalized = normalizeComparableText(candidate);
  return normalized === '' ? undefined : { value: candidate.trim(), normalized };
}

function normalizeRepository(value: unknown): { value: string; normalized: string } | undefined {
  const candidate = typeof value === 'string'
    ? value
    : asRecord(value)?.url;
  if (typeof candidate !== 'string' || candidate.trim() === '') return undefined;

  const displayValue = candidate.trim();
  const urlValue = displayValue.replace(/^git\+/iu, '');
  try {
    const url = new URL(urlValue);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;

    const path = url.pathname
      .replace(/\/+$/u, '')
      .replace(/\.git$/iu, '');
    if (path === '') return undefined;

    return {
      value: displayValue,
      // Git repository transport schemes (https, ssh, and git) do not change
      // the repository identity when the host and path are the same.
      normalized: `${url.host}${path}${url.search}${url.hash}`,
    };
  } catch {
    // Unsupported repository shorthand is not compared, avoiding guesses about
    // whether two registry-specific forms identify the same repository.
    return undefined;
  }
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function createMismatchObservation(
  field: MetadataConsistencyField,
  packageJsonValue: string,
  registryMetadataValue: string,
): MetadataMismatchObservation {
  const jsonPointer = `/${field}` as const;
  return {
    ruleId: `metadata.${field}.mismatch`,
    type: 'METADATA_MISMATCH',
    message: `Registry version manifest ${field} ${JSON.stringify(registryMetadataValue)} does not match tarball package.json ${field} ${JSON.stringify(packageJsonValue)}`,
    location: {
      type: 'METADATA',
      jsonPointer,
    },
    data: {
      field,
      packageJsonValue,
      registryMetadataValue,
      observation: 'MISMATCH',
    },
  };
}
