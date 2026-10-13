import { InvalidTarballPathError } from '../src/errors/tarball-path.errors';
import { TarballPathParserService } from '../src/services/tarball-path-parser.service';

describe('TarballPathParserService', () => {
  const service = new TarballPathParserService();

  it('parses an unscoped tarball file name', () => {
    expect(service.parse('express', 'express-5.2.1.tgz')).toEqual({
      packageName: 'express',
      version: '5.2.1',
    });
  });

  // Scoped Package의 파일명에는 Scope가 들어가지 않는다 (실측)
  it('parses a scoped tarball file name without the scope', () => {
    expect(service.parse('@babel/core', 'core-8.0.1.tgz')).toEqual({
      packageName: '@babel/core',
      version: '8.0.1',
    });
  });

  it('parses a version with a hyphen in the package name', () => {
    expect(service.parse('is-number', 'is-number-7.0.0.tgz')).toEqual({
      packageName: 'is-number',
      version: '7.0.0',
    });
  });

  it('parses a prerelease version', () => {
    expect(service.parse('example', 'example-1.0.0-beta.1.tgz').version)
      .toBe('1.0.0-beta.1');
  });

  it.each([
    ['express', 'express-5.2.1.tar.gz', 'must end with ".tgz"'],
    ['express', 'express-5.2.1', 'must end with ".tgz"'],
    ['express', 'lodash-4.17.21.tgz', 'does not match package'],
    ['@babel/core', 'babel-core-8.0.1.tgz', 'does not match package'],
    ['express', 'express-.tgz', 'is not an exact semantic version'],
    ['express', 'express-latest.tgz', 'is not an exact semantic version'],
    ['express', 'express-5.2.tgz', 'is not an exact semantic version'],
    ['express', 'express-^5.2.1.tgz', 'is not an exact semantic version'],
    ['express', 'express-file:%2Ftmp.tgz', 'is not an exact semantic version'],
  ])('rejects %s / %s', (packageName, file, reason) => {
    expect(() => service.parse(packageName, file)).toThrow(reason);
    expect(() => service.parse(packageName, file))
      .toThrow(InvalidTarballPathError);
  });

  it.each([
    ['', 'express-5.2.1.tgz', 'package name is required'],
    ['express', '', 'file name is required'],
  ])('rejects empty input: %p / %p', (packageName, file, reason) => {
    expect(() => service.parse(packageName, file)).toThrow(reason);
  });
});
