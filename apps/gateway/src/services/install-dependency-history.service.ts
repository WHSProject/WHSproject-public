import { Injectable, Logger } from '@nestjs/common';

import type { ArtifactIdentity } from '../types/artifact.types';
import { UserDbService } from './user-db.service';

export interface InstallDependencySnapshot {
  rootRequestId: string;
  root: ArtifactIdentity;
  artifacts: ArtifactIdentity[];
  capturedAt?: Date;
}

const INSERT_DEPENDENCY_HISTORY = `
  INSERT INTO install_dependency_history (
    root_request_id,
    root_package_name,
    root_package_version,
    package_name,
    package_version,
    integrity,
    captured_at
  )
  SELECT
    $1,
    $2,
    $3,
    package_name,
    package_version,
    integrity,
    $7
  FROM unnest(
    $4::text[],
    $5::text[],
    $6::text[]
  ) AS artifact(package_name, package_version, integrity)
  ON CONFLICT (
    root_request_id,
    package_name,
    package_version,
    integrity
  ) DO NOTHING
`;

@Injectable()
export class InstallDependencyHistoryService {
  private readonly logger =
    new Logger(InstallDependencyHistoryService.name);

  constructor(private readonly db: UserDbService) {}

  async record(snapshot: InstallDependencySnapshot): Promise<void> {
    if (!this.db.configured) {
      return;
    }

    if (snapshot.artifacts.length === 0) {
      return;
    }

    try {
      await this.db.getPool().query(
        INSERT_DEPENDENCY_HISTORY,
        [
          snapshot.rootRequestId,
          snapshot.root.packageName,
          snapshot.root.version,
          snapshot.artifacts.map((artifact) => artifact.packageName),
          snapshot.artifacts.map((artifact) => artifact.version),
          snapshot.artifacts.map((artifact) => artifact.integrity),
          snapshot.capturedAt ?? new Date(),
        ],
      );
    } catch (error) {
      this.logger.warn(
        `Failed to record dependency history `
        + `rootRequestId=${snapshot.rootRequestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
