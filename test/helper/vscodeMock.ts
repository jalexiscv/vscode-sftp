// The default vscode mock (__mocks__/vscode.js) answers every lookup with
// "Nothing", a proxy that is truthy, callable and equal to nothing. That is
// enough for most modules, but two things break on it: `x instanceof Uri` is
// true for any x (the file handlers use it to tell a context from a Uri), and
// `UResource.from` needs `Uri.file`/`Uri.parse` to return real objects with a
// scheme, a path and a query. This builds a vscode mock with a minimal Uri
// class and "Nothing" for everything else. Use it from a jest.mock factory:
//
//   jest.mock('vscode', () =>
//     require('../../../test/helper/vscodeMock').createVscodeMock()
//   );

// requireActual: to jest that file *is* the 'vscode' module, so a plain
// require from inside a jest.mock('vscode') factory would re-enter the factory
// tslint:disable-next-line variable-name
const Nothing = jest.requireActual('../../__mocks__/vscode.js');

export class MockUri {
  static file(fsPath: string): MockUri {
    return new MockUri('file', '', fsPath, '');
  }

  static parse(value: string): MockUri {
    const match = /^([a-zA-Z][\w+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?/.exec(value);
    if (!match) {
      throw new Error(`MockUri.parse: unsupported uri ${value}`);
    }
    return new MockUri(
      match[1],
      match[2],
      decodeURIComponent(match[3] || ''),
      decodeURIComponent(match[4] || '')
    );
  }

  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly fsPath: string,
    readonly query: string
  ) {}

  get path(): string {
    return this.fsPath;
  }

  toString(): string {
    const query = this.query ? `?${encodeURIComponent(this.query)}` : '';
    return `${this.scheme}://${this.authority}${this.fsPath}${query}`;
  }
}

/** `extras` are exposed on the mock too, e.g. `{ window: { withProgress } }`. */
export function createVscodeMock(extras: { [key: string]: any } = {}): any {
  const target = { Uri: MockUri, ...extras };
  return new Proxy(target, {
    get: (object, key) => (key in object ? object[key as string] : Nothing),
  });
}
