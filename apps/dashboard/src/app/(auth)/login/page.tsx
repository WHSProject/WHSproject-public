import { redirect } from 'next/navigation'

import { loginNotice, safeCallbackURL } from '@/lib/auth/common/routes'
import { getSession } from '@/lib/auth/server/session'
import { LoginPage } from '@/features/auth'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

// 이미 로그인했으면(DB로 확인) 원래 가려던 화면으로 보냅니다. 쿠키만 보고 보내면 만료된 쿠키에서 무한 반복됩니다.
// ?notice=는 정해 둔 안내(예: 비밀번호 변경 후 다시 로그인)만 보여 줍니다.
export default async function Page({ searchParams }: Props) {
  const params = await searchParams
  const callbackURL = safeCallbackURL(params.callbackURL)
  if (await getSession()) redirect(callbackURL)
  return <LoginPage callbackURL={callbackURL} notice={loginNotice(params.notice)} />
}
