import { DEFAULT_TEMP_FILE_PATTERNS, resolveTempFilePatterns } from '../tempFiles';

describe('resolveTempFilePatterns', () => {
  test('returns the defaults when ignoreTempFiles is not set', () => {
    expect(resolveTempFilePatterns({})).toEqual(DEFAULT_TEMP_FILE_PATTERNS);
  });

  test('returns the defaults when ignoreTempFiles is explicitly true', () => {
    expect(resolveTempFilePatterns({ ignoreTempFiles: true })).toEqual(
      DEFAULT_TEMP_FILE_PATTERNS
    );
  });

  test('returns nothing when ignoreTempFiles is exactly false', () => {
    expect(resolveTempFilePatterns({ ignoreTempFiles: false })).toEqual([]);
  });

  test('only the boolean false opts out; undefined keeps the defaults', () => {
    // the opt-out is an identity check against `false`, so a missing value must
    // not be treated as a disabled feature
    expect(resolveTempFilePatterns({ ignoreTempFiles: undefined }).length).toBe(
      DEFAULT_TEMP_FILE_PATTERNS.length
    );
  });

  test('appends tempFilePatterns after the defaults so a negation can win', () => {
    const result = resolveTempFilePatterns({ tempFilePatterns: ['!*.bak', '*.custom'] });

    expect(result.length).toBe(DEFAULT_TEMP_FILE_PATTERNS.length + 2);
    expect(result.slice(0, DEFAULT_TEMP_FILE_PATTERNS.length)).toEqual(
      DEFAULT_TEMP_FILE_PATTERNS
    );
    // order matters: in gitignore semantics the later rule wins, so a user
    // negation must sit *after* the default it negates
    expect(result.indexOf('!*.bak')).toBeGreaterThan(result.indexOf('*.bak'));
    expect(result[result.length - 1]).toBe('*.custom');
  });

  test('extra patterns are dropped when ignoreTempFiles is false', () => {
    expect(
      resolveTempFilePatterns({ ignoreTempFiles: false, tempFilePatterns: ['*.custom'] })
    ).toEqual([]);
  });

  test('tolerates a missing or non-array tempFilePatterns', () => {
    expect(resolveTempFilePatterns({ tempFilePatterns: undefined })).toEqual(
      DEFAULT_TEMP_FILE_PATTERNS
    );
    expect(resolveTempFilePatterns({ tempFilePatterns: '*.foo' } as any)).toEqual(
      DEFAULT_TEMP_FILE_PATTERNS
    );
    expect(resolveTempFilePatterns({ tempFilePatterns: null } as any)).toEqual(
      DEFAULT_TEMP_FILE_PATTERNS
    );
  });

  test('never hands out the shared defaults array', () => {
    const result = resolveTempFilePatterns({ tempFilePatterns: ['*.custom'] });
    expect(result).not.toBe(DEFAULT_TEMP_FILE_PATTERNS);

    // a caller mutating the result must not poison the next config
    result.push('*.poison');
    expect(DEFAULT_TEMP_FILE_PATTERNS).not.toContain('*.poison');
    expect(DEFAULT_TEMP_FILE_PATTERNS).not.toContain('*.custom');
  });
});

describe('DEFAULT_TEMP_FILE_PATTERNS', () => {
  test('covers the editor, OS, merge and download scratch files', () => {
    // a regression here silently ships scratch files to production
    [
      '*.tmp',
      '*.tmp.*',
      '*.new',
      '*.swp',
      '*~',
      '.#*',
      '~$*',
      '*.orig',
      '*.rej',
      '*.bak',
      '*.crdownload',
      '*.part',
      '.DS_Store',
      'Thumbs.db',
      'desktop.ini',
    ].forEach(pattern => expect(DEFAULT_TEMP_FILE_PATTERNS).toContain(pattern));
  });

  test('does not swallow extensions that merely start with tmp', () => {
    // `.tmpl` is a real template extension (Go, Smarty, Helm); the old `*.tmp*`
    // matched it and skipped the upload without a word
    expect(DEFAULT_TEMP_FILE_PATTERNS).not.toContain('*.tmp*');
  });

  test('does not blanket-ignore lock files', () => {
    // `composer.lock`, `package-lock.json`, `yarn.lock` and friends are real
    // deliverables; only the LibreOffice owner file is a scratch lock
    expect(DEFAULT_TEMP_FILE_PATTERNS).not.toContain('*.lock');
    expect(DEFAULT_TEMP_FILE_PATTERNS).not.toContain('*lock*');
    expect(DEFAULT_TEMP_FILE_PATTERNS).toContain('.~lock.*#');
  });

  test('has no duplicate patterns', () => {
    const unique = DEFAULT_TEMP_FILE_PATTERNS.filter(
      (p, i) => DEFAULT_TEMP_FILE_PATTERNS.indexOf(p) === i
    );
    expect(unique).toEqual(DEFAULT_TEMP_FILE_PATTERNS);
  });
});
