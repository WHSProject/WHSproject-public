import { Module } from '@nestjs/common';

import { loadScannerEnvironment } from '../config/scanner-environment';
import { RegistryMetadataClient } from './metadata-client/registry-metadata-client';

@Module({
  providers: [
    {
      provide: RegistryMetadataClient,
      useFactory: (): RegistryMetadataClient =>
        new RegistryMetadataClient(loadScannerEnvironment()),
    },
  ],
  exports: [RegistryMetadataClient],
})
export class RegistryModule {}
