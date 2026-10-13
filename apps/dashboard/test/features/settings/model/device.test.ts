// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { describeDevice, describeIp } from '@/features/settings/model/device'

describe('describeDevice', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0', 'Edge · Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Safari · macOS'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox · Linux'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['curl/8.0', '알 수 없는 기기'],
    [null, '알 수 없는 기기'],
  ])('%s → %s', (userAgent, expected) => {
    expect(describeDevice(userAgent)).toBe(expected)
  })
})

describe('describeIp', () => {
  it.each([
    ['0000:0000:0000:0000:0000:0000:0000:0000', '로컬 접속'],
    ['::1', '로컬 접속'],
    ['127.0.0.1', '로컬 접속'],
    ['203.0.113.7', '203.0.113.7'],
    ['2001:0db8:abcd:0012:0000:0000:0000:0000', '2001:0db8:abcd:0012:0000:0000:0000:0000'],
    [null, '-'],
  ])('%s → %s', (ipAddress, expected) => {
    expect(describeIp(ipAddress)).toBe(expected)
  })
})
