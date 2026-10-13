import { toNextJsHandler } from 'better-auth/next-js'

import { getAuth } from '@/lib/auth/server/auth'

// Better Auth 인증 API(/api/auth/*)입니다. 요청이 올 때 인스턴스를 가져오므로
// next build가 이 파일을 읽어도 초기화(secret 검사, DB 연결)는 일어나지 않습니다.
export const { GET, POST } = toNextJsHandler((request) => getAuth().handler(request))
