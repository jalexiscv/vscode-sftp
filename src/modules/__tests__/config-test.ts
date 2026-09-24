import { validateConfig, mergedDefault } from '../config';

/**
 * The two upload verification keys: their defaults are what every user gets
 * without touching sftp.json, so they must be exactly what TransferTask
 * assumes, and a typo must be rejected rather than silently ignored.
 */

const base = {
  host: 'example.org',
  username: 'deploy',
  remotePath: '/var/www',
};

const validate = (extra: object) => validateConfig({ ...base, ...extra });

describe('config: verifyUpload / uploadRetries', () => {
  test('defaults to verifying every upload and retrying twice', () => {
    const config = mergedDefault({});

    expect(config.verifyUpload).toBe('stat');
    expect(config.uploadRetries).toBe(2);
    expect(validateConfig(mergedDefault(base))).toBeNull();
  });

  test.each([['none'], ['stat']])('accepts verifyUpload %s', level => {
    expect(validate({ verifyUpload: level })).toBeNull();
  });

  test.each([['foo'], [true], [1]])('rejects verifyUpload %p', level => {
    const error = validate({ verifyUpload: level });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/verifyUpload/);
  });

  test.each([[0], [2], [10]])('accepts uploadRetries %p', retries => {
    expect(validate({ uploadRetries: retries })).toBeNull();
  });

  test.each([[-1], [1.5], ['2'], [true]])('rejects uploadRetries %p', retries => {
    const error = validate({ uploadRetries: retries });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/uploadRetries/);
  });

  test("accepts verifyUpload 'hash' without making it the default", () => {
    expect(validate({ verifyUpload: 'hash' })).toBeNull();
    expect(mergedDefault({}).verifyUpload).toBe('stat');
  });
});

describe('config: externalChanges / watcher.pollInterval', () => {
  test('defaults to scanning on startup and resume, asking above 20 files, no polling', () => {
    const config = mergedDefault({});

    expect(config.externalChanges).toEqual({
      scanOnStartup: true,
      scanOnResume: true,
      confirmThreshold: 20,
      maxPlanItems: 2000,
      compareContent: true,
    });
    // the watcher block stays absent by default, so polling is off
    expect(config.watcher).toBeUndefined();
    expect(validateConfig(mergedDefault(base))).toBeNull();
  });

  test('accepts a complete and a partial externalChanges block', () => {
    expect(
      validate({
        externalChanges: {
          scanOnStartup: false,
          scanOnResume: true,
          confirmThreshold: 0,
          maxPlanItems: 0,
          compareContent: false,
        },
      })
    ).toBeNull();
    expect(validate({ externalChanges: { confirmThreshold: 5 } })).toBeNull();
    expect(validate({ externalChanges: { maxPlanItems: 50000 } })).toBeNull();
    expect(validate({ externalChanges: { compareContent: true } })).toBeNull();
  });

  test.each([
    [{ scanOnStartup: 'yes' }],
    [{ scanOnResume: 1 }],
    [{ confirmThreshold: -1 }],
    [{ confirmThreshold: 1.5 }],
    [{ confirmThreshold: '20' }],
    [{ maxPlanItems: -1 }],
    [{ maxPlanItems: 2.5 }],
    [{ maxPlanItems: '2000' }],
    [{ compareContent: 'yes' }],
    [{ compareContent: 1 }],
  ])('rejects externalChanges %p', block => {
    const error = validate({ externalChanges: block });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/externalChanges/);
  });

  test.each([[0], [5000], [60000]])('accepts watcher.pollInterval %p', interval => {
    expect(validate({ watcher: { files: '**/*', pollInterval: interval } })).toBeNull();
  });

  test.each([[-1], [1.5], ['5000'], [true]])('rejects watcher.pollInterval %p', interval => {
    const error = validate({ watcher: { files: '**/*', pollInterval: interval } });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/pollInterval/);
  });
});

describe('config: uploadExclude', () => {
  test('defaults to an empty list', () => {
    expect(mergedDefault({}).uploadExclude).toEqual([]);
    expect(validateConfig(mergedDefault(base))).toBeNull();
  });

  test.each([[[]], [['/storage']], [['/storage', 'uploads/', '*.env']]])(
    'accepts uploadExclude %p',
    list => {
      expect(validate({ uploadExclude: list })).toBeNull();
    }
  );

  test.each([['/storage'], [true], [[1]], [[null]]])('rejects uploadExclude %p', value => {
    const error = validate({ uploadExclude: value });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/uploadExclude/);
  });
});
