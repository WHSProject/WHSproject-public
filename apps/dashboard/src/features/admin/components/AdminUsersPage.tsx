import type { RoleOption } from '@/lib/auth/common/roles'

import type { AdminUserRow } from '../types/users'
import styles from './AdminPage.module.css'
import { CreateUserForm } from './CreateUserForm'
import { UsersTable } from './UsersTable'

type AdminUsersPageProps = {
  users: AdminUserRow[]
  roles: RoleOption[]
  currentUserId: string
}

export function AdminUsersPage({ users, roles, currentUserId }: AdminUsersPageProps) {
  return (
    <>
      <section className={styles.panel} aria-labelledby="admin-create-user-title">
        <h2 id="admin-create-user-title" className={styles.sectionTitle}>계정 만들기</h2>
        <CreateUserForm roles={roles} />
      </section>

      <section className={styles.panel} aria-labelledby="admin-user-list-title">
        <h2 id="admin-user-list-title" className={styles.sectionTitle}>사용자 {users.length}명</h2>
        <UsersTable users={users} roles={roles} currentUserId={currentUserId} />
        <p className={styles.managementNote}>
          계정은 Admin이 만들고, 사용자는 전달받은 링크(1시간)에서 비밀번호를 설정합니다. 비밀번호를 잊은 사용자에게는
          재설정 링크를 발급합니다. 권한을 낮추거나 비활성화하면 그 사용자의 로그인이 모두 끊깁니다. 자기 자신과 마지막
          Admin은 바꿀 수 없습니다.
        </p>
      </section>
    </>
  )
}
