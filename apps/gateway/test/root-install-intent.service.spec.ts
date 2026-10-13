import { RootInstallIntentService } from '../src/services/root-install-intent.service';

describe('RootInstallIntentService', () => {
  let service: RootInstallIntentService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));

    service = new RootInstallIntentService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('consumes a matching intent once', () => {
    service.register('express');

    expect(service.consume('express')).toBe(true);
    expect(service.consume('express')).toBe(false);
  });

  it('does not consume an intent for another package', () => {
    service.register('express');

    expect(service.consume('lodash')).toBe(false);
    expect(service.consume('express')).toBe(true);
  });

  it('expires an intent after its TTL', () => {
    service.register('express', 1_000);

    jest.advanceTimersByTime(1_001);

    expect(service.consume('express')).toBe(false);
  });

  it('keeps the intent valid before its TTL expires', () => {
    service.register('express', 1_000);

    jest.advanceTimersByTime(999);

    expect(service.consume('express')).toBe(true);
  });

  it('rejects an invalid TTL', () => {
    expect(() => service.register('express', 0))
      .toThrow('ttlMs must be a positive number');
  });
});
