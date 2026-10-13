import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { resolveUserDbConfig } from '../config/user-db.config';

// 인증과 기록이 같은 Pool을 사용한다. 오류 처리는 각 호출자가 결정한다.
@Injectable()
export class UserDbService implements OnModuleDestroy {
  private readonly logger = new Logger(UserDbService.name);
  private readonly config = resolveUserDbConfig();
  private pool: Pool | null = null;

  get configured(): boolean { return this.config !== null; }

  getPool(): Pool {
    if (!this.config) throw new Error('User DB is not configured');
    if (!this.pool) {
      this.pool = new Pool({ ...this.config, max: 5, connectionTimeoutMillis: 2000, query_timeout: 2000 });
      this.pool.on('error', () => this.logger.warn('User DB idle connection error'));
    }
    return this.pool;
  }

  async onModuleDestroy(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    await pool?.end();
  }
}
