import { Module } from '@nestjs/common';

import { loadScannerEnvironment } from '../config/scanner-environment';
import { AnalyzerModule } from '../analyzers/analyzer.module';
import { Orchestrator } from '../application/orchestrator/orchestrator';
import { ScanService } from '../application/scan-service/scan.service';
import { TarballAcquisitionService } from '../application/tarball-acquisition/tarball-acquisition.service';
import { ArtifactModule } from '../artifact/artifact.module';
import { RegistryModule } from '../registry/registry.module';
import { ScanHistoryService } from '../history/scan-history.service';
import { EvidenceNormalizer } from '../evidence/normalizer/evidence-normalizer';
import { EvidencePersistenceClient } from '../evidence/evidence-persistence.client';
import { PolicyEvaluationClient } from '../policy/policy-evaluation.client';
import { OsvFeedClient } from '../osv/osv-feed-client';
import { LlmAgentModule } from '../llm-agent/llm-agent.module';
import { FeedAdminController } from '../api/feed-admin.controller';
import { OsvFeedCacheAdapter, FEED_SNAPSHOT_STORE, HttpFeedSnapshotStore, type FeedSnapshotStore } from '../osv/osv-feed-cache';
import { HttpFeedRefreshValidator, HttpReevaluationTrigger, OsvFeedRefreshWorker } from '../osv/osv-feed-refresh.worker';

@Module({
  imports: [ArtifactModule, AnalyzerModule, RegistryModule, LlmAgentModule],
  controllers: [FeedAdminController],
  providers: [
    Orchestrator,
    ScanHistoryService,
    ScanService,
    {
      provide: EvidencePersistenceClient,
      useFactory: (): EvidencePersistenceClient => new EvidencePersistenceClient(),
    },
    TarballAcquisitionService,
    {
      provide: OsvFeedClient,
      useFactory: (): OsvFeedClient => new OsvFeedClient(),
    },
    {
      provide: PolicyEvaluationClient,
      useFactory: (): PolicyEvaluationClient =>
        new PolicyEvaluationClient(loadScannerEnvironment()),
    },
    {
      provide: EvidenceNormalizer,
      useFactory: (): EvidenceNormalizer => new EvidenceNormalizer(),
    },
    {
      provide: FEED_SNAPSHOT_STORE,
      useFactory: (): FeedSnapshotStore => new HttpFeedSnapshotStore(),
    },
    {
      provide: OsvFeedCacheAdapter,
      useFactory: (store: FeedSnapshotStore, client: OsvFeedClient): OsvFeedCacheAdapter => new OsvFeedCacheAdapter(store, client),
      inject: [FEED_SNAPSHOT_STORE, OsvFeedClient],
    },
    {
      provide: OsvFeedRefreshWorker,
      useFactory: (client: OsvFeedClient, store: FeedSnapshotStore): OsvFeedRefreshWorker => new OsvFeedRefreshWorker(client, store, {}, new HttpReevaluationTrigger(), new HttpFeedRefreshValidator()),
      inject: [OsvFeedClient, FEED_SNAPSHOT_STORE],
    },
  ],
  exports: [
    RegistryModule,
    Orchestrator,
    ScanHistoryService,
    ScanService,
    TarballAcquisitionService,
    PolicyEvaluationClient,
    OsvFeedRefreshWorker,
  ],
})
export class ScannerModule {}
