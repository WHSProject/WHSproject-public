import {
  DEFAULT_MAX_TARBALL_BYTES,
  DEFAULT_OBFUSCATION_GPT_BASE_URL,
  DEFAULT_OBFUSCATION_GEMINI_BASE_URL,
  DEFAULT_OBFUSCATION_GEMINI_MODEL,
  DEFAULT_OBFUSCATION_GPT_MAX_OUTPUT_TOKENS,
  DEFAULT_OBFUSCATION_GPT_MODEL,
  DEFAULT_OBFUSCATION_GPT_TIMEOUT_MS,
  DEFAULT_OBFUSCATION_LLM_CACHE_ENABLED,
  DEFAULT_OBFUSCATION_LLM_CACHE_MAX_ENTRIES,
  DEFAULT_OBFUSCATION_LLM_CACHE_TTL_MS,
  DEFAULT_METADATA_MAX_RESPONSE_BYTES,
  DEFAULT_METADATA_TIMEOUT_MS,
  DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS,
  DEFAULT_POLICY_TIMEOUT_MS,
  DEFAULT_TARBALL_CONNECT_TIMEOUT_MS,
  DEFAULT_TARBALL_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_TARBALL_MAX_REDIRECTS,
  DEFAULT_GUARDDOG_KILL_GRACE_MS,
  DEFAULT_GUARDDOG_MAX_OUTPUT_BYTES,
  DEFAULT_GUARDDOG_TIMEOUT_MS,
  loadGuardDogEnvironment,
  loadObfuscationGptEnvironment,
  loadScannerEnvironment,
} from './scanner-environment';

describe('loadScannerEnvironment', () => {
  it('uses the metadata defaults when variables are not configured', () => {
    expect(loadScannerEnvironment({})).toEqual({
      POLICY_URL: 'http://policy:8000',
      POLICY_TIMEOUT_MS: DEFAULT_POLICY_TIMEOUT_MS,
      SCANNER_PACKAGE_TIMEOUT_MS: DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS,
      OBFUSCATION_GPT_MODE: 'off',
      METADATA_TIMEOUT_MS: DEFAULT_METADATA_TIMEOUT_MS,
      METADATA_MAX_RESPONSE_BYTES: DEFAULT_METADATA_MAX_RESPONSE_BYTES,
      TARBALL_CONNECT_TIMEOUT_MS: DEFAULT_TARBALL_CONNECT_TIMEOUT_MS,
      TARBALL_DOWNLOAD_TIMEOUT_MS: DEFAULT_TARBALL_DOWNLOAD_TIMEOUT_MS,
      MAX_TARBALL_BYTES: DEFAULT_MAX_TARBALL_BYTES,
      TARBALL_MAX_REDIRECTS: DEFAULT_TARBALL_MAX_REDIRECTS,
    });
  });

  it('parses configured positive integers', () => {
    expect(
      loadScannerEnvironment({
        POLICY_URL: 'http://policy.internal:8000',
        POLICY_TIMEOUT_MS: '5000',
        SCANNER_PACKAGE_TIMEOUT_MS: '45000',
        OBFUSCATION_GPT_MODE: 'off',
        METADATA_TIMEOUT_MS: '2500',
        METADATA_MAX_RESPONSE_BYTES: '4096',
        TARBALL_CONNECT_TIMEOUT_MS: '1500',
        TARBALL_DOWNLOAD_TIMEOUT_MS: '30000',
        MAX_TARBALL_BYTES: '52428800',
        TARBALL_MAX_REDIRECTS: '2',
      }),
    ).toEqual({
      POLICY_URL: 'http://policy.internal:8000',
      POLICY_TIMEOUT_MS: 5000,
      SCANNER_PACKAGE_TIMEOUT_MS: 45000,
      OBFUSCATION_GPT_MODE: 'off',
      METADATA_TIMEOUT_MS: 2500,
      METADATA_MAX_RESPONSE_BYTES: 4096,
      TARBALL_CONNECT_TIMEOUT_MS: 1500,
      TARBALL_DOWNLOAD_TIMEOUT_MS: 30000,
      MAX_TARBALL_BYTES: 52428800,
      TARBALL_MAX_REDIRECTS: 2,
    });
  });

  it.each(['', '0', '-1', '1.5', 'NaN'])(
    'rejects invalid METADATA_TIMEOUT_MS value %j',
    (value) => {
      expect(() =>
        loadScannerEnvironment({ METADATA_TIMEOUT_MS: value }),
      ).toThrow();
    },
  );

  it('requires an API key when GPT Shadow mode is enabled', () => {
    expect(() => loadObfuscationGptEnvironment({
      OBFUSCATION_GPT_MODE: 'shadow',
    })).toThrow();

    expect(loadObfuscationGptEnvironment({
      OBFUSCATION_GPT_MODE: 'shadow',
      OPENAI_API_KEY: 'test-key',
    })).toMatchObject({
      OBFUSCATION_GPT_MODE: 'shadow',
      OPENAI_API_KEY: 'test-key',
    });
  });

  it('선택한 LLM 제공자의 API 키만 요구한다', () => {
    expect(() => loadObfuscationGptEnvironment({
      OBFUSCATION_GPT_MODE: 'shadow',
      OBFUSCATION_LLM_PROVIDER: 'gemini',
      OPENAI_API_KEY: '사용하지-않는-키',
    })).toThrow();

    expect(loadObfuscationGptEnvironment({
      OBFUSCATION_GPT_MODE: 'shadow',
      OBFUSCATION_LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: '시험용-키',
    })).toMatchObject({
      OBFUSCATION_GPT_MODE: 'shadow',
      OBFUSCATION_LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: '시험용-키',
    });
  });

  it('uses safe GPT Shadow defaults while the mode is off', () => {
    expect(loadObfuscationGptEnvironment({})).toEqual({
      OBFUSCATION_GPT_MODE: 'off',
      OBFUSCATION_LLM_PROVIDER: 'gpt',
      OBFUSCATION_GPT_MODEL: DEFAULT_OBFUSCATION_GPT_MODEL,
      OBFUSCATION_GPT_BASE_URL: DEFAULT_OBFUSCATION_GPT_BASE_URL,
      OBFUSCATION_GPT_TIMEOUT_MS: DEFAULT_OBFUSCATION_GPT_TIMEOUT_MS,
      OBFUSCATION_GPT_MAX_OUTPUT_TOKENS: DEFAULT_OBFUSCATION_GPT_MAX_OUTPUT_TOKENS,
      OBFUSCATION_GEMINI_MODEL: DEFAULT_OBFUSCATION_GEMINI_MODEL,
      OBFUSCATION_GEMINI_BASE_URL: DEFAULT_OBFUSCATION_GEMINI_BASE_URL,
      OBFUSCATION_LLM_CACHE_ENABLED: DEFAULT_OBFUSCATION_LLM_CACHE_ENABLED,
      OBFUSCATION_LLM_CACHE_TTL_MS: DEFAULT_OBFUSCATION_LLM_CACHE_TTL_MS,
      OBFUSCATION_LLM_CACHE_MAX_ENTRIES: DEFAULT_OBFUSCATION_LLM_CACHE_MAX_ENTRIES,
    });
  });

  it('parses bounded Obfuscation LLM cache settings', () => {
    expect(loadObfuscationGptEnvironment({
      OBFUSCATION_LLM_CACHE_ENABLED: 'false',
      OBFUSCATION_LLM_CACHE_TTL_MS: '1200',
      OBFUSCATION_LLM_CACHE_MAX_ENTRIES: '8',
    })).toMatchObject({
      OBFUSCATION_LLM_CACHE_ENABLED: false,
      OBFUSCATION_LLM_CACHE_TTL_MS: 1200,
      OBFUSCATION_LLM_CACHE_MAX_ENTRIES: 8,
    });
  });

  it.each(['', '0', '-1', '1.5', 'NaN'])(
    'rejects invalid Obfuscation LLM cache bounds %j',
    (value) => {
      expect(() => loadObfuscationGptEnvironment({ OBFUSCATION_LLM_CACHE_TTL_MS: value })).toThrow();
      expect(() => loadObfuscationGptEnvironment({ OBFUSCATION_LLM_CACHE_MAX_ENTRIES: value })).toThrow();
    },
  );

  it.each(['', '0', '-1', '1.5', 'NaN'])(
    'rejects invalid SCANNER_PACKAGE_TIMEOUT_MS value %j',
    (value) => {
      expect(() =>
        loadScannerEnvironment({ SCANNER_PACKAGE_TIMEOUT_MS: value }),
      ).toThrow();
    },
  );

  it.each(['', '0', '-1', '1.5', 'NaN'])(
    'rejects invalid METADATA_MAX_RESPONSE_BYTES value %j',
    (value) => {
      expect(() =>
        loadScannerEnvironment({ METADATA_MAX_RESPONSE_BYTES: value }),
      ).toThrow();
    },
  );

  it.each([
    'TARBALL_CONNECT_TIMEOUT_MS',
    'TARBALL_DOWNLOAD_TIMEOUT_MS',
    'MAX_TARBALL_BYTES',
    'TARBALL_MAX_REDIRECTS',
  ] as const)('rejects invalid %s values', (variableName) => {
    for (const value of [
      '',
      '0',
      '-1',
      '1.5',
      'NaN',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(() =>
        loadScannerEnvironment({ [variableName]: value }),
      ).toThrow();
    }
  });
});

describe('loadGuardDogEnvironment', () => {
  it('uses safe GuardDog runtime defaults', () => {
    expect(loadGuardDogEnvironment({})).toMatchObject({
      GUARDDOG_BIN: 'guarddog',
      GUARDDOG_VERSION: '3.1.0',
      GUARDDOG_TIMEOUT_MS: DEFAULT_GUARDDOG_TIMEOUT_MS,
      GUARDDOG_KILL_GRACE_MS: DEFAULT_GUARDDOG_KILL_GRACE_MS,
      GUARDDOG_MAX_OUTPUT_BYTES: DEFAULT_GUARDDOG_MAX_OUTPUT_BYTES,
      GUARDDOG_SANDBOX_MODE: 'REQUIRED',
    });
  });

  it('parses configured GuardDog runtime values', () => {
    expect(loadGuardDogEnvironment({
      GUARDDOG_BIN: '/opt/guarddog/bin/guarddog',
      GUARDDOG_VERSION: '3.1.0',
      GUARDDOG_TIMEOUT_MS: '20000',
      GUARDDOG_KILL_GRACE_MS: '1500',
      GUARDDOG_MAX_OUTPUT_BYTES: '4096',
      GUARDDOG_SANDBOX_MODE: 'DISABLED',
      SCANNER_TEMP_DIR: '/tmp/scanner-tests',
    })).toEqual({
      GUARDDOG_BIN: '/opt/guarddog/bin/guarddog',
      GUARDDOG_VERSION: '3.1.0',
      GUARDDOG_TIMEOUT_MS: 20000,
      GUARDDOG_KILL_GRACE_MS: 1500,
      GUARDDOG_MAX_OUTPUT_BYTES: 4096,
      GUARDDOG_SANDBOX_MODE: 'DISABLED',
      SCANNER_TEMP_DIR: '/tmp/scanner-tests',
    });
  });

  it.each([
    'GUARDDOG_TIMEOUT_MS',
    'GUARDDOG_KILL_GRACE_MS',
    'GUARDDOG_MAX_OUTPUT_BYTES',
  ] as const)('rejects invalid %s values', (variableName) => {
    expect(() => loadGuardDogEnvironment({ [variableName]: '0' })).toThrow();
  });

  it('rejects an unsupported GuardDog Sandbox Mode', () => {
    expect(() => loadGuardDogEnvironment({
      GUARDDOG_SANDBOX_MODE: 'OPTIONAL',
    })).toThrow();
  });
});
