import { createHash } from 'node:crypto';

import type {
  EvidenceMappingRule,
  EvidenceMappingTarget,
} from './evidence-normalizer.types';

export const EVIDENCE_MAPPING_VERSION = '0.5.0';

const LIFECYCLE_SCRIPT_NOT_EXECUTION =
  'Lifecycle script presence does not prove that the script was executed.';
const METADATA_MISMATCH_LIMITATION =
  'A mismatch between registry metadata and the tarball package.json does not by itself prove tampering or malicious intent.';
const SENSITIVE_FILE_STATIC_LIMITATION =
  'A static access pattern does not prove that sensitive information was acquired.';
const LIFECYCLE_PROCESS_COOCCURRENCE_LIMITATION =
  'Lifecycle and process patterns coexist, but execution order, call linkage, and actual execution are not proven.';
const ENV_NETWORK_COOCCURRENCE_LIMITATION =
  'Environment and network patterns coexist, but data flow from an environment value to the network is not proven.';
const FILE_NETWORK_COOCCURRENCE_LIMITATION =
  'Sensitive-file and network patterns coexist, but transmission of file contents is not proven.';
const GUARDDOG_STATIC_ANALYSIS_LIMITATION =
  'A GuardDog static finding indicates observable code capability or a threat pattern, not runtime execution.';
const GUARDDOG_RELATION_LIMITATION =
  'The GuardDog rule combines multiple static signals, but successful runtime data flow or execution is not independently verified.';
const GUARDDOG_ENDPOINT_LIMITATION =
  'A static endpoint indicator does not prove successful communication, exfiltration, or command-and-control activity.';

const target = (
  signalId: string,
  signalType: EvidenceMappingTarget['signalType'],
  signalCategory: string,
  assertionBasis: EvidenceMappingTarget['assertionBasis'],
  limitations: readonly string[],
  taxonomy?: EvidenceMappingTarget['taxonomy'],
  action?: EvidenceMappingTarget['action'],
): EvidenceMappingTarget => {
  return {
    signalId,
    signalType,
    signalCategory,
    ...(taxonomy === undefined ? {} : { taxonomy }),
    ...(action === undefined ? {} : { action }),
    assertionBasis,
    limitations,
  };
};

export const DEFAULT_EVIDENCE_MAPPING_RULES: readonly EvidenceMappingRule[] =
  Object.freeze([
    {
      analyzerName: 'metadata',
      ruleId: 'metadata.lifecycle.preinstall',
      mappingStatus: 'EXACT',
      targets: [
        target(
          'capability.lifecycle.preinstall',
          'PREINSTALL_SCRIPT',
          'METADATA',
          'METADATA_VALUE',
          [LIFECYCLE_SCRIPT_NOT_EXECUTION],
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'metadata',
      ruleId: 'metadata.lifecycle.install',
      mappingStatus: 'EXACT',
      targets: [
        target(
          'capability.lifecycle.install',
          'INSTALL_SCRIPT',
          'METADATA',
          'METADATA_VALUE',
          [LIFECYCLE_SCRIPT_NOT_EXECUTION],
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'metadata',
      ruleId: 'metadata.lifecycle.postinstall',
      mappingStatus: 'EXACT',
      targets: [
        target(
          'capability.lifecycle.postinstall',
          'POSTINSTALL_SCRIPT',
          'METADATA',
          'METADATA_VALUE',
          [LIFECYCLE_SCRIPT_NOT_EXECUTION],
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'metadata',
      ruleId: 'metadata.lifecycle.prepare',
      mappingStatus: 'EXACT',
      targets: [
        target(
          'capability.lifecycle.prepare',
          'LIFECYCLE_SCRIPT',
          'METADATA',
          'METADATA_VALUE',
          [LIFECYCLE_SCRIPT_NOT_EXECUTION],
          'INSTALLATION_AND_EXECUTION',
          'LIFECYCLE_ENTRY',
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'metadata',
      ruleId: 'metadata.license.mismatch',
      mappingStatus: 'EXACT',
      targets: [
        target(
          'consistency.metadata.license-mismatch',
          'METADATA_MISMATCH',
          'METADATA',
          'METADATA_VALUE',
          [METADATA_MISMATCH_LIMITATION],
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'metadata',
      ruleId: 'metadata.repository.mismatch',
      mappingStatus: 'EXACT',
      targets: [
        target(
          'consistency.metadata.repository-mismatch',
          'METADATA_MISMATCH',
          'METADATA',
          'METADATA_VALUE',
          [METADATA_MISMATCH_LIMITATION],
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.sensitive-file-access',
      mappingStatus: 'PARTIAL',
      targets: [
        target(
          'capability.filesystem.sensitive-read',
          'SENSITIVE_FILE_READ',
          'FILESYSTEM',
          'PATTERN_MATCH',
          [SENSITIVE_FILE_STATIC_LIMITATION],
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.lifecycle-process-coexistence',
      mappingStatus: 'PARTIAL',
      targets: [
        target(
          'capability.process.spawn',
          'CHILD_PROCESS',
          'EXECUTION',
          'CO_OCCURRENCE',
          [LIFECYCLE_PROCESS_COOCCURRENCE_LIMITATION],
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.env-network-coexistence',
      mappingStatus: 'PARTIAL',
      targets: [
        target(
          'capability.environment.read',
          'ENV_READ',
          'ENVIRONMENT',
          'CO_OCCURRENCE',
          [ENV_NETWORK_COOCCURRENCE_LIMITATION],
        ),
        target(
          'capability.network.outbound',
          'NETWORK_EGRESS',
          'NETWORK',
          'CO_OCCURRENCE',
          [ENV_NETWORK_COOCCURRENCE_LIMITATION],
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.sensitive-file-network-coexistence',
      mappingStatus: 'PARTIAL',
      targets: [
        target(
          'capability.filesystem.sensitive-read',
          'SENSITIVE_FILE_READ',
          'FILESYSTEM',
          'CO_OCCURRENCE',
          [FILE_NETWORK_COOCCURRENCE_LIMITATION],
        ),
        target(
          'capability.network.outbound',
          'NETWORK_EGRESS',
          'NETWORK',
          'CO_OCCURRENCE',
          [FILE_NETWORK_COOCCURRENCE_LIMITATION],
        ),
      ],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.lifecycle-entry',
      mappingStatus: 'PARTIAL',
      targets: [target(
        'capability.lifecycle.local-entry',
        'INSTALL_SCRIPT',
        'METADATA',
        'EXECUTION_LINK',
        [LIFECYCLE_SCRIPT_NOT_EXECUTION],
        'INSTALLATION_AND_EXECUTION',
        'LIFECYCLE_ENTRY',
      )],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.process-execution',
      mappingStatus: 'PARTIAL',
      targets: [target(
        'capability.process.spawn',
        'CHILD_PROCESS',
        'EXECUTION',
        'PATTERN_MATCH',
        ['Static process API presence does not prove successful command execution.'],
        'INSTALLATION_AND_EXECUTION',
        'PROCESS_EXECUTION',
      )],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.collection-source',
      mappingStatus: 'PARTIAL',
      targets: [target(
        'capability.system.information-read',
        'SYSTEM_INFO',
        'SYSTEM',
        'PATTERN_MATCH',
        ['Static collection source presence does not prove that collected data was used or transmitted.'],
        'DISCOVERY_AND_COLLECTION',
        'INFORMATION_COLLECTION',
      )],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.credential-source',
      mappingStatus: 'PARTIAL',
      targets: [target(
        'capability.credential.read',
        'CREDENTIAL_READ',
        'ENVIRONMENT',
        'PATTERN_MATCH',
        ['A credential-like source name or path does not prove that a valid credential was acquired.'],
        'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS',
        'CREDENTIAL_ACCESS',
      )],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'threat-network-form-data-exfiltration',
      mappingStatus: 'EXACT',
      targets: [target(
        'capability.network.outbound',
        'NETWORK_EGRESS',
        'NETWORK',
        'DATA_FLOW',
        ['Static form-data flow to an external endpoint does not prove successful transmission.'],
        'NETWORK_C2_AND_EXFILTRATION',
        'FORM_DATA_EXFILTRATION',
      )],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.network-outbound',
      mappingStatus: 'PARTIAL',
      targets: [target(
        'capability.network.outbound',
        'NETWORK_EGRESS',
        'NETWORK',
        'PATTERN_MATCH',
        ['Static network API presence does not prove successful external communication.'],
        'NETWORK_C2_AND_EXFILTRATION',
        'NETWORK_REQUEST',
      )],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.remote-download',
      mappingStatus: 'PARTIAL',
      targets: [target(
        'capability.network.download',
        'REMOTE_FETCH',
        'NETWORK',
        'PATTERN_MATCH',
        ['Static response flow does not prove successful download or payload retrieval.'],
        'PAYLOAD_AND_DYNAMIC_CODE',
        'REMOTE_PAYLOAD_DOWNLOAD',
      )],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    {
      analyzerName: 'custom-rule',
      ruleId: 'custom.filesystem.write',
      mappingStatus: 'PARTIAL',
      targets: [target(
        'capability.filesystem.write',
        'FILE_WRITE',
        'FILESYSTEM',
        'PATTERN_MATCH',
        ['Static filesystem write API presence does not prove successful file creation or modification.'],
        'FILESYSTEM_AND_SYSTEM_MODIFICATION',
        'FILE_WRITE',
      )],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
    },
    ...guardDogRules(),
  ] satisfies readonly EvidenceMappingRule[]);

function guardDogRules(): EvidenceMappingRule[] {
  const rule = (
    ruleId: string,
    mappingStatus: 'EXACT' | 'PARTIAL',
    targets: readonly [EvidenceMappingTarget, ...EvidenceMappingTarget[]],
  ): EvidenceMappingRule => ({
    analyzerName: 'guarddog',
    ruleId,
    mappingStatus,
    targets,
    mappingVersion: EVIDENCE_MAPPING_VERSION,
  });

  const exact = (
    ruleId: string,
    mappingTarget: EvidenceMappingTarget,
  ): EvidenceMappingRule => rule(ruleId, 'EXACT', [mappingTarget]);

  const staticTarget = (
    signalId: string,
    signalType: EvidenceMappingTarget['signalType'],
    signalCategory: string,
    taxonomy?: EvidenceMappingTarget['taxonomy'],
    action?: string,
    assertionBasis: EvidenceMappingTarget['assertionBasis'] = 'PATTERN_MATCH',
    limitations: readonly string[] = [GUARDDOG_STATIC_ANALYSIS_LIMITATION],
  ): EvidenceMappingTarget => target(
    signalId,
    signalType,
    signalCategory,
    assertionBasis,
    limitations,
    taxonomy,
    action,
  );

  return [
    exact(
      'capability-filesystem-delete',
      staticTarget(
        'capability.filesystem.delete',
        'FILE_DELETE',
        'FILESYSTEM',
        'FILESYSTEM_AND_SYSTEM_MODIFICATION',
        'FILE_DELETE',
      ),
    ),
    exact(
      'capability-filesystem-read',
      staticTarget('capability.filesystem.read', 'FILE_READ', 'FILESYSTEM'),
    ),
    exact(
      'capability-filesystem-browser',
      staticTarget(
        'capability.filesystem.browser-sensitive-read',
        'SENSITIVE_FILE_READ',
        'FILESYSTEM',
        'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS',
        'BROWSER_CREDENTIAL_STORE_ACCESS',
      ),
    ),
    exact(
      'capability-filesystem-write-executable',
      staticTarget(
        'capability.filesystem.executable-write',
        'FILE_WRITE',
        'FILESYSTEM',
        'FILESYSTEM_AND_SYSTEM_MODIFICATION',
        'EXECUTABLE_FILE_WRITE',
      ),
    ),
    exact(
      'capability-network-download',
      staticTarget('capability.network.download', 'REMOTE_FETCH', 'NETWORK'),
    ),
    exact(
      'capability-network-outbound',
      staticTarget('capability.network.outbound', 'NETWORK_EGRESS', 'NETWORK'),
    ),
    rule(
      'capability-network-lolbas',
      'PARTIAL',
      [staticTarget(
        'capability.network.lolbas',
        'NETWORK_EGRESS',
        'NETWORK',
        undefined,
        'NETWORK_TOOL_USAGE',
        'PATTERN_MATCH',
        ['Static use of a network-capable system tool does not prove outbound communication or a malicious purpose.'],
      )],
    ),
    exact(
      'capability-process-hooks',
      staticTarget(
        'capability.lifecycle.hook',
        'LIFECYCLE_SCRIPT',
        'METADATA',
        'INSTALLATION_AND_EXECUTION',
        'LIFECYCLE_SCRIPT_DECLARATION',
      ),
    ),
    exact(
      'capability-process-spawn',
      staticTarget(
        'capability.process.spawn',
        'CHILD_PROCESS',
        'EXECUTION',
        'INSTALLATION_AND_EXECUTION',
        'PROCESS_EXECUTION',
      ),
    ),
    rule(
      'threat-network-exfil-messenger',
      'PARTIAL',
      [staticTarget(
        'threat.network.messaging-endpoint',
        'NETWORK_EGRESS',
        'NETWORK',
        'NETWORK_C2_AND_EXFILTRATION',
        'MESSAGING_ENDPOINT_INDICATOR',
        'PATTERN_MATCH',
        [GUARDDOG_ENDPOINT_LIMITATION],
      )],
    ),
    rule(
      'threat-network-exfil-sysinfo',
      'PARTIAL',
      [
        staticTarget(
          'threat.system.information-collection',
          'SYSTEM_INFO',
          'SYSTEM',
          'DISCOVERY_AND_COLLECTION',
          'SYSTEM_INFORMATION_COLLECTION',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
        staticTarget(
          'threat.network.system-info-egress',
          'NETWORK_EGRESS',
          'NETWORK',
          'NETWORK_C2_AND_EXFILTRATION',
          'SYSTEM_INFORMATION_EXFILTRATION_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
      ],
    ),
    rule(
      'threat-network-exfiltration',
      'PARTIAL',
      [staticTarget(
        'threat.network.suspicious-endpoint',
        'NETWORK_EGRESS',
        'NETWORK',
        'NETWORK_C2_AND_EXFILTRATION',
        'SUSPICIOUS_NETWORK_ENDPOINT',
        'PATTERN_MATCH',
        [GUARDDOG_ENDPOINT_LIMITATION],
      )],
    ),
    rule(
      'threat-network-outbound-shady-links',
      'PARTIAL',
      [staticTarget(
        'threat.network.shady-link',
        'NETWORK_EGRESS',
        'NETWORK',
        'NETWORK_C2_AND_EXFILTRATION',
        'SUSPICIOUS_NETWORK_ENDPOINT',
        'PATTERN_MATCH',
        [GUARDDOG_ENDPOINT_LIMITATION],
      )],
    ),
    rule(
      'threat-network-dns-exfil',
      'PARTIAL',
      [staticTarget(
        'threat.network.dns-egress',
        'NETWORK_EGRESS',
        'NETWORK',
        'NETWORK_C2_AND_EXFILTRATION',
        'DNS_EXFILTRATION_CANDIDATE',
        'PATTERN_MATCH',
        [GUARDDOG_RELATION_LIMITATION],
      )],
    ),
    rule(
      'threat-network-reverse-shell',
      'PARTIAL',
      [
        staticTarget(
          'threat.network.reverse-shell-egress',
          'NETWORK_EGRESS',
          'NETWORK',
          'NETWORK_C2_AND_EXFILTRATION',
          'REVERSE_SHELL_NETWORK_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
        staticTarget(
          'threat.execution.reverse-shell-command',
          'SHELL_EXEC',
          'EXECUTION',
          'INSTALLATION_AND_EXECUTION',
          'REVERSE_SHELL_EXECUTION_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
      ],
    ),
    rule(
      'threat-process-download-exec',
      'PARTIAL',
      [
        staticTarget(
          'threat.network.download',
          'REMOTE_FETCH',
          'NETWORK',
          'PAYLOAD_AND_DYNAMIC_CODE',
          'REMOTE_PAYLOAD_DOWNLOAD',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
        staticTarget(
          'threat.process.downloaded-file-execution',
          'CHILD_PROCESS',
          'EXECUTION',
          'INSTALLATION_AND_EXECUTION',
          'DOWNLOADED_FILE_EXECUTION_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
      ],
    ),
    rule(
      'threat-process-hooks',
      'PARTIAL',
      [
        staticTarget(
          'threat.lifecycle.install-hook',
          'LIFECYCLE_SCRIPT',
          'METADATA',
          'INSTALLATION_AND_EXECUTION',
          'INSTALL_HOOK_DECLARATION',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
        staticTarget(
          'threat.process.hook-command',
          'CHILD_PROCESS',
          'EXECUTION',
          'INSTALLATION_AND_EXECUTION',
          'INSTALL_HOOK_PROCESS_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
      ],
    ),
    rule(
      'threat-process-spawn-silent',
      'PARTIAL',
      [staticTarget(
        'threat.process.spawn-silent',
        'CHILD_PROCESS',
        'EXECUTION',
        'INSTALLATION_AND_EXECUTION',
        'SILENT_PROCESS_EXECUTION_CANDIDATE',
      )],
    ),
    rule(
      'threat-process-powershell-encoded',
      'PARTIAL',
      [
        staticTarget(
          'threat.process.powershell-command',
          'SHELL_EXEC',
          'EXECUTION',
          'INSTALLATION_AND_EXECUTION',
          'POWERSHELL_EXECUTION_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
        staticTarget(
          'threat.code.powershell-encoded',
          'OBFUSCATED_CODE',
          'CODE',
          'EVASION_AND_OBFUSCATION',
          'ENCODED_COMMAND',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
      ],
    ),
    exact(
      'threat-filesystem-autostart',
      staticTarget(
        'threat.persistence.autostart',
        'AUTOSTART',
        'FILESYSTEM',
        'PERSISTENCE_AND_PROPAGATION',
        'AUTOSTART_PERSISTENCE',
      ),
    ),
    exact(
      'threat-filesystem-destruction',
      staticTarget(
        'threat.filesystem.destruction',
        'FILE_DELETE',
        'FILESYSTEM',
        'FILESYSTEM_AND_SYSTEM_MODIFICATION',
        'FILESYSTEM_DESTRUCTION',
      ),
    ),
    exact(
      'threat-filesystem-read',
      staticTarget(
        'threat.filesystem.sensitive-read',
        'SENSITIVE_FILE_READ',
        'FILESYSTEM',
        'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS',
        'SENSITIVE_FILE_ACCESS',
      ),
    ),
    exact(
      'threat-npm-http-dependency',
      staticTarget(
        'threat.package.remote-http-dependency',
        'REMOTE_DEPENDENCY',
        'METADATA',
        'PACKAGE_AND_PUBLISHING_RISK',
        'REMOTE_HTTP_DEPENDENCY',
      ),
    ),
    exact(
      'threat-npm-dependency-confusion',
      staticTarget(
        'threat.package.dependency-confusion',
        'DEPENDENCY_CONFUSION',
        'METADATA',
        'PACKAGE_AND_PUBLISHING_RISK',
        'DEPENDENCY_CONFUSION_INDICATOR',
      ),
    ),
    exact(
      'threat-npm-preinstall-script',
      staticTarget(
        'threat.lifecycle.preinstall',
        'PREINSTALL_SCRIPT',
        'METADATA',
        'INSTALLATION_AND_EXECUTION',
        'PREINSTALL_SCRIPT_DECLARATION',
      ),
    ),
    rule(
      'threat-process-sysinfo',
      'PARTIAL',
      [
        staticTarget(
          'threat.process.sysinfo',
          'SYSTEM_INFO',
          'SYSTEM',
          'DISCOVERY_AND_COLLECTION',
          'SYSTEM_INFORMATION_COLLECTION_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
        staticTarget(
          'threat.process.sysinfo-command',
          'CHILD_PROCESS',
          'EXECUTION',
          'INSTALLATION_AND_EXECUTION',
          'SYSTEM_INFORMATION_COMMAND_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
      ],
    ),
    exact(
      'threat-runtime-environment-read',
      staticTarget('threat.runtime.environment.read', 'ENV_READ', 'ENVIRONMENT'),
    ),
    rule(
      'threat-runtime-enumeration',
      'PARTIAL',
      [staticTarget(
        'threat.runtime.system-enumeration',
        'SYSTEM_INFO',
        'SYSTEM',
        'DISCOVERY_AND_COLLECTION',
        'SYSTEM_ENUMERATION',
        'PATTERN_MATCH',
        ['The generic system-information signal does not preserve every network or host enumeration technique detected by GuardDog.'],
      )],
    ),
    exact(
      'threat-runtime-keylogging',
      staticTarget(
        'threat.runtime.keylogging',
        'KEYSTROKE_CAPTURE',
        'SYSTEM',
        'DISCOVERY_AND_COLLECTION',
        'KEYSTROKE_COLLECTION',
      ),
    ),
    exact(
      'threat-runtime-obfuscation',
      staticTarget(
        'threat.runtime.obfuscation',
        'OBFUSCATED_CODE',
        'CODE',
        'EVASION_AND_OBFUSCATION',
        'CODE_OBFUSCATION',
      ),
    ),
    exact(
      'threat-runtime-obfuscation-api',
      staticTarget(
        'threat.runtime.obfuscation.api',
        'OBFUSCATED_CODE',
        'CODE',
        'EVASION_AND_OBFUSCATION',
        'API_CALL_OBFUSCATION',
      ),
    ),
    rule(
      'threat-runtime-obfuscation-chr',
      'EXACT',
      [
        staticTarget(
          'threat.runtime.obfuscation.chr',
          'OBFUSCATED_CODE',
          'CODE',
          'EVASION_AND_OBFUSCATION',
          'CHARACTER_CODE_OBFUSCATION',
        ),
        staticTarget(
          'threat.runtime.obfuscation.chr-execution',
          'DYNAMIC_CODE_EXECUTION',
          'EXECUTION',
          'PAYLOAD_AND_DYNAMIC_CODE',
          'DECODED_PAYLOAD_EXECUTION',
        ),
      ],
    ),
    rule(
      'threat-runtime-obfuscation-dynamic-eval',
      'EXACT',
      [
        staticTarget(
          'threat.runtime.obfuscation.dynamic-eval',
          'OBFUSCATED_CODE',
          'CODE',
          'EVASION_AND_OBFUSCATION',
          'SELF_DECODING_PAYLOAD',
        ),
        staticTarget(
          'threat.runtime.dynamic-eval',
          'DYNAMIC_CODE_EXECUTION',
          'EXECUTION',
          'PAYLOAD_AND_DYNAMIC_CODE',
          'DYNAMIC_EVAL_EXECUTION',
        ),
      ],
    ),
    exact(
      'threat-runtime-obfuscation-general',
      staticTarget(
        'threat.runtime.obfuscation.general',
        'OBFUSCATED_CODE',
        'CODE',
        'EVASION_AND_OBFUSCATION',
        'CODE_OBFUSCATION',
      ),
    ),
    exact(
      'threat-runtime-obfuscation-hidden-code',
      staticTarget(
        'threat.runtime.obfuscation.hidden-code',
        'OBFUSCATED_CODE',
        'CODE',
        'EVASION_AND_OBFUSCATION',
        'HIDDEN_CODE_OBFUSCATION',
      ),
    ),
    rule(
      'threat-runtime-obfuscation-import-exec',
      'EXACT',
      [
        staticTarget(
          'threat.runtime.obfuscation.import-chain',
          'OBFUSCATED_CODE',
          'CODE',
          'EVASION_AND_OBFUSCATION',
          'DYNAMIC_IMPORT_OBFUSCATION',
        ),
        staticTarget(
          'threat.runtime.obfuscation.import-execution',
          'DYNAMIC_CODE_EXECUTION',
          'EXECUTION',
          'PAYLOAD_AND_DYNAMIC_CODE',
          'DYNAMIC_IMPORT_EXECUTION',
        ),
      ],
    ),
    rule(
      'threat-runtime-obfuscation-log-suppress',
      'PARTIAL',
      [staticTarget(
        'threat.runtime.obfuscation.log-suppress',
        'OBFUSCATED_CODE',
        'CODE',
        'EVASION_AND_OBFUSCATION',
        'LOG_SUPPRESSION_WITH_OBFUSCATION',
        'CO_OCCURRENCE',
        ['The existing obfuscation signal preserves only part of the GuardDog rule; log suppression has no dedicated Atomic Signal.'],
      )],
    ),
    exact(
      'threat-runtime-obfuscation-pyarmor',
      staticTarget(
        'threat.runtime.obfuscation.pyarmor',
        'OBFUSCATED_CODE',
        'CODE',
        'EVASION_AND_OBFUSCATION',
        'PYARMOR_OBFUSCATION',
      ),
    ),
    exact(
      'threat-runtime-obfuscation-unicode',
      staticTarget(
        'threat.runtime.obfuscation.unicode',
        'OBFUSCATED_CODE',
        'CODE',
        'EVASION_AND_OBFUSCATION',
        'UNICODE_OBFUSCATION',
      ),
    ),
    rule(
      'threat-runtime-obfuscation-base64exec',
      'EXACT',
      [
        staticTarget(
          'threat.runtime.obfuscation.base64exec',
          'OBFUSCATED_CODE',
          'CODE',
          'EVASION_AND_OBFUSCATION',
          'BASE64_PAYLOAD_DECODING',
        ),
        staticTarget(
          'threat.runtime.obfuscation.base64exec.execution',
          'DYNAMIC_CODE_EXECUTION',
          'EXECUTION',
          'PAYLOAD_AND_DYNAMIC_CODE',
          'DECODED_PAYLOAD_EXECUTION',
        ),
      ],
    ),
    exact(
      'threat-runtime-obfuscation-js-mangling',
      staticTarget(
        'threat.runtime.obfuscation.js-mangling',
        'OBFUSCATED_CODE',
        'CODE',
        'EVASION_AND_OBFUSCATION',
        'JAVASCRIPT_NAME_MANGLING',
      ),
    ),
    rule(
      'threat-runtime-obfuscation-steganography',
      'EXACT',
      [
        staticTarget(
          'threat.runtime.obfuscation.steganography',
          'OBFUSCATED_CODE',
          'CODE',
          'EVASION_AND_OBFUSCATION',
          'STEGANOGRAPHIC_PAYLOAD_DECODING',
        ),
        staticTarget(
          'threat.runtime.obfuscation.steganography-exec',
          'DYNAMIC_CODE_EXECUTION',
          'EXECUTION',
          'PAYLOAD_AND_DYNAMIC_CODE',
          'DECODED_PAYLOAD_EXECUTION',
        ),
      ],
    ),
    exact(
      'threat-runtime-system-info',
      staticTarget(
        'threat.runtime.system-info',
        'SYSTEM_INFO',
        'SYSTEM',
        'DISCOVERY_AND_COLLECTION',
        'SYSTEM_INFORMATION_COLLECTION',
      ),
    ),
    rule(
      'threat-setup-import-aliasing',
      'PARTIAL',
      [staticTarget(
        'threat.setup.import-aliasing',
        'OBFUSCATED_CODE',
        'CODE',
        'EVASION_AND_OBFUSCATION',
        'IMPORT_ALIASING',
        'PATTERN_MATCH',
        ['The generic obfuscation signal does not distinguish setup.py import aliasing from other code-hiding techniques.'],
      )],
    ),
    rule(
      'threat-setup-network-in-install',
      'PARTIAL',
      [
        staticTarget(
          'threat.setup.install-context',
          'INSTALL_SCRIPT',
          'METADATA',
          'INSTALLATION_AND_EXECUTION',
          'INSTALL_CONTEXT',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
        staticTarget(
          'threat.setup.network-operation',
          'NETWORK_EGRESS',
          'NETWORK',
          'NETWORK_C2_AND_EXFILTRATION',
          'INSTALL_TIME_NETWORK_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
      ],
    ),
    rule(
      'threat-runtime-dynamic-loader',
      'PARTIAL',
      [
        staticTarget(
          'threat.runtime.dynamic-loader-fetch',
          'REMOTE_FETCH',
          'NETWORK',
          'PAYLOAD_AND_DYNAMIC_CODE',
          'REMOTE_CODE_FETCH_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
        staticTarget(
          'threat.runtime.dynamic-loader-execution',
          'DYNAMIC_CODE_EXECUTION',
          'EXECUTION',
          'PAYLOAD_AND_DYNAMIC_CODE',
          'REMOTE_CODE_EXECUTION_CANDIDATE',
          'CO_OCCURRENCE',
          [GUARDDOG_RELATION_LIMITATION],
        ),
      ],
    ),
  ];
}

export class EvidenceMappingRegistry {
  private readonly rules: ReadonlyMap<string, EvidenceMappingRule>;
  readonly mappingHash: string;

  constructor(
    rules: readonly EvidenceMappingRule[] = DEFAULT_EVIDENCE_MAPPING_RULES,
    readonly mappingVersion: string = EVIDENCE_MAPPING_VERSION,
  ) {
    const byKey = new Map<string, EvidenceMappingRule>();
    for (const rule of rules) {
      const key = mappingKey(rule.analyzerName, rule.ruleId);
      if (byKey.has(key)) {
        throw new Error(
          `Duplicate Evidence mapping for ${rule.analyzerName}:${rule.ruleId}`,
        );
      }
      byKey.set(key, rule);
    }

    this.rules = byKey;
    this.mappingHash = calculateMappingHash([...byKey.values()]);
  }

  find(analyzerName: string, ruleId: string): EvidenceMappingRule | undefined {
    return this.rules.get(mappingKey(analyzerName, ruleId));
  }
}

export function calculateMappingHash(
  rules: readonly EvidenceMappingRule[],
): string {
  const canonicalRules = rules
    .map((rule) => ({
      analyzerName: rule.analyzerName,
      ruleId: rule.ruleId,
      mappingStatus: rule.mappingStatus,
      targets: [...rule.targets]
        .map((mappingTarget) => ({
          signalId: mappingTarget.signalId,
          signalType: mappingTarget.signalType,
          signalCategory: mappingTarget.signalCategory,
          taxonomy: mappingTarget.taxonomy,
          action: mappingTarget.action,
          assertionBasis: mappingTarget.assertionBasis,
          limitations: [...mappingTarget.limitations].sort(),
        }))
        .sort(compareTargets),
      mappingVersion: rule.mappingVersion,
    }))
    .sort((left, right) =>
      compareStrings(left.analyzerName, right.analyzerName) ||
      compareStrings(left.ruleId, right.ruleId),
    );

  return createHash('sha256')
    .update(JSON.stringify(canonicalRules))
    .digest('hex');
}

function compareTargets(
  left: Pick<EvidenceMappingTarget, 'signalId' | 'signalType'>,
  right: Pick<EvidenceMappingTarget, 'signalId' | 'signalType'>,
): number {
  return (
    compareStrings(left.signalId, right.signalId) ||
    compareStrings(left.signalType, right.signalType)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mappingKey(analyzerName: string, ruleId: string): string {
  return `${analyzerName}\u0000${ruleId}`;
}
