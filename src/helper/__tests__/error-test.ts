// only the dialog is stubbed: the logger reads its settings through host too
jest.mock('../../host', () => ({
  ...jest.requireActual('../../host'),
  showErrorMessage: jest.fn(() => Promise.resolve(undefined)),
}));

import logger from '../../logger';
import { showErrorMessage } from '../../host';
import { reportError, markReported, isReported } from '../error';

const showErrorMessageMock = showErrorMessage as jest.Mock;

describe('markReported', () => {
  test('flags the error without making the flag enumerable', () => {
    const error = markReported(new Error('x'));

    expect(isReported(error)).toBe(true);
    expect(Object.keys(error)).not.toContain('reported');
    expect(JSON.stringify(error)).not.toContain('reported');
  });

  test('is idempotent: an error can cross several catch blocks', () => {
    const error = markReported(new Error('x'));

    expect(() => markReported(error)).not.toThrow();
    expect(isReported(error)).toBe(true);
  });

  test('returns the same instance so it can be thrown inline', () => {
    const error = new Error('x');
    expect(markReported(error)).toBe(error);
  });
});

describe('isReported', () => {
  test('is false for plain errors, strings and nothing', () => {
    expect(isReported(new Error('x'))).toBe(false);
    expect(isReported('x')).toBe(false);
    expect(isReported(undefined)).toBe(false);
    expect(isReported(null)).toBe(false);
  });
});

describe('reportError', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    showErrorMessageMock.mockClear();
    logSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('logs and shows an ordinary error', () => {
    reportError(new Error('boom'), 'ctx');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(showErrorMessageMock).toHaveBeenCalledWith('boom', 'Detail');
  });

  test('shows a plain string as is', () => {
    reportError('plain');

    expect(showErrorMessageMock).toHaveBeenCalledWith('plain', 'Detail');
  });

  test('logs but does not show an error already reported', () => {
    // the aggregated transfer error arrives after every failure it summarises
    // was shown one by one; a second dialog would only repeat them
    reportError(markReported(new Error('2 of 3 file(s) failed to upload')));

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(showErrorMessageMock).not.toHaveBeenCalled();
  });
});
