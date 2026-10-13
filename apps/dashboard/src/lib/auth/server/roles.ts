import type { Queryable } from '../../db'
import type { RoleOption } from '../common/roles'

// 역할 목록(낮은 역할부터)입니다. Admin·개인 설정 화면이 씁니다. 서버에서만 import합니다.
export async function listRoles(db: Queryable): Promise<RoleOption[]> {
  const result = await db.query<RoleOption>('SELECT code, name, description, rank FROM roles ORDER BY rank')
  return result.rows
}
