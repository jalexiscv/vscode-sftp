import * as path from 'path';
import { testHooks } from '../localDeleteMonitor';

const { collapseDescendants, markRenamedAway, wasRenamedAway, isNotFound } = testHooks;

const p = (...segments: string[]) => segments.join(path.sep);
const isWindows = process.platform === 'win32';

describe('localDeleteMonitor', () => {
  describe('collapseDescendants', () => {
    test('drops paths covered by a queued ancestor', () => {
      const input = [p('c:', 'a'), p('c:', 'a', 'b'), p('c:', 'a', 'b', 'c.txt'), p('c:', 'd.txt')];

      expect(collapseDescendants(input).sort()).toEqual([p('c:', 'a'), p('c:', 'd.txt')].sort());
    });

    test('keeps siblings', () => {
      const input = [p('c:', 'a', 'x.txt'), p('c:', 'a', 'y.txt')];
      expect(collapseDescendants(input).sort()).toEqual(input.sort());
    });

    test('a shared name prefix is not containment', () => {
      // the classic string-prefix bug: "ab" must not swallow "abc"
      const input = [p('c:', 'ab'), p('c:', 'abc', 'file.txt')];
      expect(collapseDescendants(input).sort()).toEqual(input.sort());
    });

    test('is order independent', () => {
      const deepFirst = [p('c:', 'a', 'b', 'c.txt'), p('c:', 'a')];
      expect(collapseDescendants(deepFirst)).toEqual([p('c:', 'a')]);
    });

    test('handles an empty list', () => {
      expect(collapseDescendants([])).toEqual([]);
    });

    if (isWindows) {
      test('ignores casing on windows', () => {
        const input = [p('C:', 'Project', 'Src'), p('c:', 'project', 'src', 'main.ts')];
        expect(collapseDescendants(input)).toEqual([p('C:', 'Project', 'Src')]);
      });
    }
  });

  describe('rename suppression', () => {
    test('a marked path is recognised', () => {
      const file = p('c:', 'proj', 'old.ts');
      expect(wasRenamedAway(file)).toBe(false);

      markRenamedAway(file);
      expect(wasRenamedAway(file)).toBe(true);
    });

    test('an unmarked sibling is unaffected', () => {
      markRenamedAway(p('c:', 'proj', 'one.ts'));
      expect(wasRenamedAway(p('c:', 'proj', 'two.ts'))).toBe(false);
    });

    if (isWindows) {
      test('matches regardless of casing on windows', () => {
        markRenamedAway(p('C:', 'Proj', 'File.ts'));
        expect(wasRenamedAway(p('c:', 'proj', 'file.ts'))).toBe(true);
      });
    }

    test('expires so a later real deletion is not swallowed', () => {
      const file = p('c:', 'proj', 'temporary.ts');
      const realNow = Date.now;
      markRenamedAway(file);

      try {
        Date.now = () => realNow() + 6000;
        expect(wasRenamedAway(file)).toBe(false);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('isNotFound', () => {
    test.each([
      ['sftp status code', { code: 2 }],
      ['node errno', { code: 'ENOENT' }],
      ['sftp message', new Error('No such file')],
      ['ftp reply', new Error('550 File not found')],
    ])('treats %s as not-found', (_label, error) => {
      expect(isNotFound(error)).toBe(true);
    });

    test.each([
      ['null', null],
      ['undefined', undefined],
      ['permission error', new Error('Permission denied')],
      ['network error', new Error('read ECONNRESET')],
      ['generic failure', new Error('Something went wrong')],
    ])('does not treat %s as not-found', (_label, error) => {
      // misclassifying these would silently swallow a failed deletion
      expect(isNotFound(error)).toBe(false);
    });
  });
});
