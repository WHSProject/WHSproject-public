import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { AnalyzerModule } from '../src/analyzers/analyzer.module';
import { CustomRuleAnalyzer } from '../src/analyzers/custom-rule/custom-rule.analyzer';
import { GuardDogAnalyzer } from '../src/analyzers/guarddog/guarddog.analyzer';
import { MetadataAnalyzer } from '../src/analyzers/metadata/metadata.analyzer';
import { Orchestrator } from '../src/application/orchestrator/orchestrator';
import { ScanService } from '../src/application/scan-service/scan.service';
import { TarballAcquisitionService } from '../src/application/tarball-acquisition/tarball-acquisition.service';
import { ArtifactModule } from '../src/artifact/artifact.module';
import { createScannerApplication } from '../src/main';
import { RegistryMetadataClient } from '../src/registry/metadata-client/registry-metadata-client';
import { RegistryModule } from '../src/registry/registry.module';
import { ScannerModule } from '../src/scanner/scanner.module';
import { ScanHistoryService } from '../src/history/scan-history.service';
import { EvidenceNormalizer } from '../src/evidence/normalizer/evidence-normalizer';
import { EvidencePersistenceClient } from '../src/evidence/evidence-persistence.client';
import { OsvFeedClient } from '../src/osv/osv-feed-client';
import { JevProviderClient } from '../src/llm-agent/context-check/jev-provider.client';

describe('Scanner bootstrap', () => {
  it('registers the artifact, analyzer, and Registry module boundaries', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScannerModule],
    }).compile();

    expect(moduleRef.select(ArtifactModule)).toBeDefined();
    expect(moduleRef.select(AnalyzerModule)).toBeDefined();
    expect(moduleRef.select(RegistryModule)).toBeDefined();
    expect(
      moduleRef
        .select(RegistryModule)
        .get(RegistryMetadataClient, { strict: true }),
    ).toBeInstanceOf(RegistryMetadataClient);
    expect(moduleRef.select(AnalyzerModule).get(MetadataAnalyzer, { strict: true }))
      .toBeInstanceOf(MetadataAnalyzer);
    expect(moduleRef.select(AnalyzerModule).get(CustomRuleAnalyzer, { strict: true }))
      .toBeInstanceOf(CustomRuleAnalyzer);
    expect(moduleRef.select(AnalyzerModule).get(GuardDogAnalyzer, { strict: true }))
      .toBeInstanceOf(GuardDogAnalyzer);
    // The Agent context check provider reaches the Orchestrator; whether it is called is decided by LLM_AGENT_CONTEXT_CHECK_ENABLED.
    expect((moduleRef.get(Orchestrator, { strict: false }) as unknown as { contextCheckProvider?: unknown }).contextCheckProvider)
      .toBeInstanceOf(JevProviderClient);
    expect(moduleRef.get(Orchestrator)).toBeInstanceOf(Orchestrator);
    expect(moduleRef.get(ScanService)).toBeInstanceOf(ScanService);
    expect(moduleRef.get(ScanHistoryService)).toBeInstanceOf(ScanHistoryService);
    expect(moduleRef.get(TarballAcquisitionService)).toBeInstanceOf(
      TarballAcquisitionService,
    );
    expect(moduleRef.get(EvidenceNormalizer)).toBeInstanceOf(
      EvidenceNormalizer,
    );
    expect(moduleRef.get(OsvFeedClient)).toBeInstanceOf(OsvFeedClient);
    expect(moduleRef.get(EvidencePersistenceClient)).toBeInstanceOf(
      EvidencePersistenceClient,
    );

    await moduleRef.close();
  });

  it('composes the scanner module in the application module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef.select(ScannerModule)).toBeDefined();
    expect(moduleRef.get(RegistryMetadataClient)).toBeInstanceOf(
      RegistryMetadataClient,
    );
    expect(moduleRef.get(TarballAcquisitionService)).toBeInstanceOf(
      TarballAcquisitionService,
    );
    expect(moduleRef.get(EvidenceNormalizer)).toBeInstanceOf(
      EvidenceNormalizer,
    );

    await moduleRef.close();
  });

  it('creates the application with the Fastify adapter', async () => {
    const app = await createScannerApplication();

    await app.init();

    expect(app.getHttpAdapter().getType()).toBe('fastify');

    await app.close();
  });
});
