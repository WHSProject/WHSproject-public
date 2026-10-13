import { Injectable, Logger } from '@nestjs/common';

import { UserDbService } from './user-db.service';
import type { Decision } from '../types/decision.types';

export type DownloadOutcome =
  | 'DELIVERED'
  | 'BLOCKED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'ERROR';

// download_events 1행. 형식은 apps/dashboard/docs/download-events-contract.md를 따른다.
export interface DownloadEvent {
  occurredAt: Date;
  requestId: string;
  sourceIp: string | null;
  packageName: string;
  version: string;
  outcome: DownloadOutcome;
  httpStatus: number | null;
  decision: Decision | null;
  decisionId: string | null;
  isRoot: boolean;
  userId: string | null;
  username: string | null;
}

const INSERT_DOWNLOAD_EVENT = `
  INSERT INTO download_events (
    occurred_at, request_id, source_ip, package_name, version,
    outcome, http_status, decision, decision_id, is_root, user_id, username
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
`;

// tarball 요청마다 다운로드 기록을 남긴다.
// 기록은 부가 기능이므로 DB 장애가 설치를 막지 않도록 실패해도 던지지 않는다.
@Injectable()
export class DownloadEventService {
  private readonly logger = new Logger(DownloadEventService.name);
  constructor(private readonly db: UserDbService) {}

  async record(event: DownloadEvent): Promise<void> {
    if (!this.db.configured) {
      return;
    }

    try {
      await this.db.getPool().query(INSERT_DOWNLOAD_EVENT, [
        event.occurredAt,
        event.requestId,
        event.sourceIp,
        event.packageName,
        event.version,
        event.outcome,
        event.httpStatus,
        event.decision,
        event.decisionId,
        event.isRoot,
        event.userId,
        event.username,
      ]);
    } catch (error) {
      this.logger.warn(
        `Failed to record download event requestId=${event.requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

}
