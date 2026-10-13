import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InstallNotPermittedError, NpmAuthenticationError, type NpmUser } from '../errors/npm-auth.errors';
import { UserDbService } from './user-db.service';

@Injectable()
export class NpmAuthService {
  constructor(private readonly db: UserDbService) {}

  async authenticate(authorization: string | undefined): Promise<NpmUser> {
    const match = /^Bearer (whs_npm_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? '');
    if (!match) throw new NpmAuthenticationError();
    const hash = createHash('sha256').update(match[1]).digest('hex');
    // 역할/활성 상태로 행을 걸러 버리면 401과 403을 구분할 수 없다.
    const result = await this.db.getPool().query<{
      id: string; username: string | null; role: string | null; active: boolean;
    }>(`SELECT u.id, u.username, u.role,
          (u.banned IS NOT TRUE OR (u.ban_expires IS NOT NULL AND u.ban_expires <= now())) AS active
        FROM npm_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.expires_at > now()`, [hash]);
    const row = result.rows[0];
    if (!row) throw new NpmAuthenticationError();
    const user = { userId: row.id, username: row.username };
    if (!row.active || !['developer', 'editor', 'admin'].includes(row.role ?? '')) {
      throw new InstallNotPermittedError(user);
    }
    return user;
  }
}
