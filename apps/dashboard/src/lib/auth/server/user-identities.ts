import { getPool } from '@/lib/db'

/** Resolve Policy DB actor UUIDs against current Dashboard account names. */
export async function currentUsernames(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
  if (unique.length === 0) return new Map()
  const result = await getPool().query<{ id: string; username: string | null; display_username: string | null; name: string }>(
    `SELECT id, username, display_username, name FROM users WHERE id = ANY($1::uuid[])`,
    [unique],
  )
  return new Map(result.rows.map((row) => [row.id, row.display_username ?? row.username ?? row.name]))
}
