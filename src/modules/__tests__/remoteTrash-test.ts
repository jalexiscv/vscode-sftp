jest.mock('fs');

import {
  resolveTrashRoot,
  isInsideTrash,
  trashBatchStamp,
  parseBatchStamp,
} from '../remoteTrash';

/**
 * The trash is only a safety net if emptying it can't destroy real data, so the
 * path validation is the part worth pinning down.
 */

const config = (remoteTrash?: any, remotePath = '/var/www/html') =>
  ({ remotePath, remoteTrash } as any);

describe('resolveTrashRoot', () => {
  test('defaults to .sftp-trash under remotePath', () => {
    expect(resolveTrashRoot(config())).toBe('/var/www/html/.sftp-trash');
  });

  test('keeps an absolute path as-is, so the trash can live outside the docroot', () => {
    expect(resolveTrashRoot(config({ path: '/var/tmp/trash' }))).toBe('/var/tmp/trash');
  });

  test('fills in the path when only enabled is given', () => {
    // mergedDefault is a shallow spread, so a partial object drops the rest
    expect(resolveTrashRoot(config({ enabled: true }))).toBe('/var/www/html/.sftp-trash');
  });

  test('accepts a nested relative path', () => {
    expect(resolveTrashRoot(config({ path: 'tmp/trash' }))).toBe('/var/www/html/tmp/trash');
  });

  describe('rejects a root that would make emptying the trash destructive', () => {
    // each of these resolves to remotePath or above it, which would turn
    // "Empty Remote Trash" into a recursive delete of real files
    test.each([['.'], ['./'], ['/'], ['/var/www/html'], ['/var/www'], ['/var']])(
      'path %s',
      badPath => {
        expect(() => resolveTrashRoot(config({ path: badPath }))).toThrow(/Unsafe/);
      }
    );
  });

  test('a sibling directory outside remotePath is fine', () => {
    expect(resolveTrashRoot(config({ path: '/var/www/trash' }))).toBe('/var/www/trash');
  });
});

describe('isInsideTrash', () => {
  test('matches the trash root and its contents', () => {
    expect(isInsideTrash('/var/www/html/.sftp-trash', config())).toBe(true);
    expect(isInsideTrash('/var/www/html/.sftp-trash/20260816-120000/a.php', config())).toBe(true);
  });

  test('does not match a sibling with the same prefix', () => {
    // the classic prefix bug: ".sftp-trash-old" is not inside ".sftp-trash"
    expect(isInsideTrash('/var/www/html/.sftp-trash-old/a.php', config())).toBe(false);
  });

  test('does not match ordinary files', () => {
    expect(isInsideTrash('/var/www/html/index.php', config())).toBe(false);
  });
});

describe('trashBatchStamp', () => {
  test('has second precision', () => {
    // a minute-granular stamp made two deletions of the same file within one
    // minute collide on the same trash path
    const stamp = trashBatchStamp(new Date(2026, 7, 16, 12, 34, 56));
    expect(stamp).toBe('20260816-123456');
  });

  test('pads single digits so names sort chronologically', () => {
    expect(trashBatchStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405');
  });
});

describe('parseBatchStamp', () => {
  test('round-trips a stamp produced by trashBatchStamp', () => {
    const when = new Date(2026, 7, 16, 12, 34, 56);
    expect(parseBatchStamp(trashBatchStamp(when))).toBe(when.getTime());
  });

  test('rejects names this extension did not create', () => {
    // the sweep deletes whole folders, so anything it cannot date must survive
    ['', 'notes', '2026-08-16', '20260816', '20260816-1234', 'backup-20260816-123456'].forEach(
      name => expect(parseBatchStamp(name)).toBeNull()
    );
  });

  test('rejects an impossible date', () => {
    expect(parseBatchStamp('20261345-995999')).toBeNull();
  });
});
