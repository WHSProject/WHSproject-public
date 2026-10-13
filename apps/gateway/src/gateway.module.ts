import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AnalyzedArtifactRegistry } from './cache/analyzed-artifact.registry';
import { ArboristClient } from './clients/arborist.client';
import { DecisionLookupClient } from './clients/decision-lookup.client';
import { ApprovalClient } from './clients/approval.client';
import { ScannerClient } from './clients/scanner.client';
import { VerdaccioClient } from './clients/verdaccio.client';
import { GatewayExceptionFilter } from './http/gateway-exception.filter';
import { GatewayController } from './controllers/gateway.controller';
import { RootInstallIntentController } from './controllers/root-install-intent.controller';
import { TarballController } from './controllers/tarball.controller';
import { DecisionHandlerService } from './services/decision-handler.service';
import { DecisionLookupAdapterService } from './services/decision-lookup-adapter.service';
import { DecisionLookupService } from './services/decision-lookup.service';
import { DependencyTreeService } from './services/dependency-tree.service';
import { DownloadEventService } from './services/download-event.service';
import { InstallDependencyHistoryService } from './services/install-dependency-history.service';
import { NpmAuthService } from './services/npm-auth.service';
import { PackageNameParserService } from './services/package-name-parser.service';
import { RootInstallIntentService } from './services/root-install-intent.service';
import { TarballPathParserService } from './services/tarball-path-parser.service';
import { UserDbService } from './services/user-db.service';
import { RegistryProxy } from './http/registry-proxy';
import { TarballAnalysisService } from './services/tarball-analysis.service';
import { NpmAuthController } from './controllers/npm-auth.controller';
import { MetadataController } from './controllers/metadata.controller';

@Module({
  controllers: [
    GatewayController,
    NpmAuthController,
    TarballController,
    RootInstallIntentController,
    MetadataController,
  ],
  providers: [
    DependencyTreeService,
    PackageNameParserService,
    TarballPathParserService,
    DecisionLookupAdapterService,
    DecisionLookupService,
    DecisionHandlerService,
    ApprovalClient,
    AnalyzedArtifactRegistry,
    ArboristClient,
    DecisionLookupClient,
    ScannerClient,
    VerdaccioClient,
    RegistryProxy,
    TarballAnalysisService,
    DownloadEventService,
    InstallDependencyHistoryService,
    RootInstallIntentService,
    UserDbService,
    NpmAuthService,
    {
      provide: APP_FILTER,
      useClass: GatewayExceptionFilter,
    },
  ],
})
export class GatewayModule {}
