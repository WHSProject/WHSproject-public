import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// 의존 방향 규칙: app → features → components → lib (중간은 건너뛸 수 있음).
// 역방향 import와, 브라우저에서도 쓰는 코드가 서버 전용 모듈을 가져오는 것을 막습니다.
const reverseToFeaturesAndApp = {
  group: ['@/features', '@/features/**', '@/app', '@/app/**', '**/features/**', '**/app/**'],
  message: 'lib·components는 features·app을 import하지 않습니다(의존 방향: app → features → components → lib).',
}
const reverseToComponents = {
  group: ['@/components', '@/components/**', '**/components/**'],
  message: 'lib는 components를 import하지 않습니다(의존 방향: app → features → components → lib).',
}
const serverOnlyModules = {
  group: [
    '@/lib/db',
    '@/lib/auth/server',
    '@/lib/auth/server/**',
    '@/features/*/index.server',
    '**/server/**',
    '**/index.server',
  ],
  message: '브라우저에서도 쓰는 코드는 서버 전용 모듈(DB, 인증 서버, 기능의 server/)을 import하지 않습니다. 필요한 타입은 types/에서 가져옵니다.',
}

// lib 중 브라우저에서도 쓰는 파일
const browserLibFiles = [
  'src/lib/auth/client.ts',
  'src/lib/auth/common/**/*.ts',
  'src/lib/policy/common/**/*.ts',
  'src/lib/decision/*.ts',
  'src/lib/download-events/*.ts',
  'src/lib/format.ts',
  'src/lib/navigation.ts',
]
// 기능과 앱 공통 틀 중 브라우저에서도 쓰는 파일
const browserFeatureFiles = [
  'src/app/_shell/**/*.{ts,tsx}',
  'src/features/*/{components,api,model,types,data}/**/*.{ts,tsx}',
  'src/features/*/index.ts',
]

const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

export default tseslint.config(
  { ignores: ['.next/**', 'dist/**', 'coverage/**', 'next-env.d.ts'] },
  {
    files: ['**/*.{js,ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      '@next/next': nextPlugin,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  // 같은 파일에 여러 설정이 겹치면 뒤의 설정이 이 규칙을 덮어쓰므로, 뒤쪽 설정에는 앞의 금지 항목을 함께 넣습니다.
  { files: ['src/lib/**/*.{ts,tsx}'], rules: restrict(reverseToFeaturesAndApp, reverseToComponents) },
  { files: ['src/components/**/*.{ts,tsx}'], rules: restrict(reverseToFeaturesAndApp, serverOnlyModules) },
  { files: browserLibFiles, rules: restrict(reverseToFeaturesAndApp, reverseToComponents, serverOnlyModules) },
  { files: browserFeatureFiles, rules: restrict(serverOnlyModules) },
)
