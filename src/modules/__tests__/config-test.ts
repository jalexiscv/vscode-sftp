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

  test.each([['foo'], ['hash'], [true], [1]])('rejects verifyUpload %p', level => {
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
});
