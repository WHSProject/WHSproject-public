import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

const nextConfig: NextConfig = {
  output: 'standalone',
  // 저장소의 기존 에이전트 지침을 유지하고 개발 서버의 지침 파일 자동 생성을 막습니다.
  agentRules: false,
  // 저장소 루트의 pnpm lockfile 때문에 로컬/Docker 출력 경로가 달라지지 않도록 고정합니다.
  outputFileTracingRoot: projectRoot,
  turbopack: { root: projectRoot },
  // 권한이 없는 페이지에서 forbidden()으로 403 화면을 보여 주기 위해 켭니다(Next.js 실험 기능).
  experimental: { authInterrupts: true },
}

export default nextConfig
