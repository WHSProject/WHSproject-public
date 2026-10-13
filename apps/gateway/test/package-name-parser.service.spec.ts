import { InvalidPackageNameError } from '../src/errors/package-name.errors';
import { PackageNameParserService } from '../src/services/package-name-parser.service';

describe('PackageNameParserService', () => {
  const service = new PackageNameParserService();

  it('parses an unscoped package name', () => {
    expect(service.parse('express')).toEqual({
      packageName: 'express',
      scope: null,
      name: 'express',
    });
  });

  it('parses a scoped package name', () => {
    expect(service.parse('@babel/core')).toEqual({
      packageName: '@babel/core',
      scope: 'babel',
      name: 'core',
    });
  });

  it.each([
    'is-number',
    'lodash.merge',
    'left_pad',
    'a',
    '@scope/is-number',
    '@my_scope/pkg.name',
  ])('accepts a valid package name: %s', (packageName) => {
    expect(service.parse(packageName).packageName).toBe(packageName);
  });

  it('accepts a package name of exactly 214 characters', () => {
    const packageName = 'a'.repeat(214);

    expect(service.parse(packageName).packageName).toBe(packageName);
  });

  it('rejects a package name longer than 214 characters', () => {
    expect(() => service.parse('a'.repeat(215)))
      .toThrow('must not exceed 214 characters');
  });

  it.each([
    ['', 'package name is required'],
    ['React', 'must not contain uppercase characters'],
    ['@Scope/pkg', 'must not contain uppercase characters'],
    ['.hidden', 'must not start with "." or "_"'],
    ['_private', 'must not start with "." or "_"'],
    ['@scope/.hidden', 'must not start with "." or "_"'],
    ['a b', 'must only contain URL-safe characters'],
    ['pkg?x=1', 'must only contain URL-safe characters'],
    ['a/b', 'must only contain URL-safe characters'],
    ['@scope', 'must use the "@scope/name" form'],
    ['@scope/', 'must use the "@scope/name" form'],
    ['@/pkg', 'must use the "@scope/name" form'],
    ['@scope/a/b', 'must use the "@scope/name" form'],
  ])('rejects an invalid package name: %s', (packageName, reason) => {
    expect(() => service.parse(packageName)).toThrow(reason);
    expect(() => service.parse(packageName))
      .toThrow(InvalidPackageNameError);
  });

  it.each([
    [undefined],
    [null],
    [42],
    [{}],
  ])('rejects a non-string package name: %p', (packageName) => {
    expect(() => service.parse(packageName))
      .toThrow('package name must be a string');
  });
});
