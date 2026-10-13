import { ResetPasswordPage } from '@/features/auth'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

// Admin이 발급한 링크(?token=…)로 들어옵니다. Better Auth 확인 경로를 거치면 만료 시 ?error=INVALID_TOKEN 으로 옵니다.
export default async function Page({ searchParams }: Props) {
  const { token, error } = await searchParams
  return (
    <ResetPasswordPage
      token={typeof token === 'string' ? token : undefined}
      error={typeof error === 'string' ? error : undefined}
    />
  )
}
