import { restoreStructure } from './structure-restorer';

describe('restoreStructure', () => {
  it('CommonJS Scanner에서 webcrack 구조 복원을 실행한다', async () => {
    const source = [
      'const _0xabc=["log","hello"];',
      'console[_0xabc[0]](_0xabc[1]);',
    ].join('');

    const result = await restoreStructure(source);

    expect(result).toMatchObject({
      status: 'COMPLETED',
      code: expect.stringContaining('console.log("hello")'),
      durationMs: expect.any(Number),
    });
    expect(result.lineMapping).toMatchObject({
      status: expect.stringMatching(/MAPPED|UNMAPPED/u),
      version: '0.1.0',
    });
  });
});
