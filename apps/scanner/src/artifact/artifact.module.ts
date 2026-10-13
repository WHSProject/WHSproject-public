import { Module } from '@nestjs/common';

import { TarballDownloader } from './downloader/tarball-downloader';
import { SafeExtractor } from './extractor/safe-extractor';
import { ArtifactHasher } from './hasher/artifact-hasher';
import { PackageIdentityVerifier } from './identity/package-identity-verifier';
import { IntegrityVerifier } from './integrity/integrity-verifier';
import { ArtifactFileManager } from './storage/artifact-file-manager';

@Module({
  providers: [
    ArtifactFileManager,
    TarballDownloader,
    IntegrityVerifier,
    SafeExtractor,
    ArtifactHasher,
    PackageIdentityVerifier,
  ],
  exports: [
    ArtifactFileManager,
    TarballDownloader,
    IntegrityVerifier,
    SafeExtractor,
    ArtifactHasher,
    PackageIdentityVerifier,
  ],
})
export class ArtifactModule {}
