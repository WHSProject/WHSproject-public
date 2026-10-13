// Better Auth CLI(스키마 비교) 전용입니다. CLI는 `auth`로 내보낸 인스턴스를 찾습니다.
// 앱 코드에서는 import하지 않고 getAuth()를 사용합니다.
import { getAuth } from './auth'

export const auth = getAuth()
