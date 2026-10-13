import { usernameClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

// 브라우저용 인증 클라이언트입니다. 같은 주소의 /api/auth로 요청합니다.
export const authClient = createAuthClient({ plugins: [usernameClient()] })
