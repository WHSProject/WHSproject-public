const DEFAULT_NPM_REGISTRY_URL = 'https://registry.npmjs.org';

// 상위 npm Registry 주소를 결정한다.
//
// Gateway 자신을 가리키면 Registry 요청이 무한히 되돌아오므로,
// npm Registry를 조회하는 모든 지점이 이 함수를 통해 같은 값을 사용한다.
export function resolveNpmRegistryBaseUrl(): string {
  const configured = process.env.NPM_REGISTRY_URL?.trim();
  const baseUrl = configured || DEFAULT_NPM_REGISTRY_URL;

  return baseUrl.replace(/\/+$/, '');
}
