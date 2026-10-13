import type { Readable } from 'node:stream';

export interface VerdaccioForwardRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;

  // 파싱하지 않은 원본 요청 본문. GET처럼 본문이 없으면 undefined.
  body?: Buffer;
}

export interface VerdaccioForwardResult {
  status: number;

  // 응답 그대로 반환하기 위해 유지하는 Header
  headers: Record<string, string>;

  // 본문은 읽지 않고 스트림으로 전달한다.
  // tarball은 바이너리라 문자열로 변환하면 파일이 손상된다.
  body: Readable | null;
}
