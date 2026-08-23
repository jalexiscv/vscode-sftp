// The default vscode mock answers every lookup with "Nothing", which cannot
// be `new`-ed; the tree data provider builds EventEmitters, so give it a real
// minimal class and keep "Nothing" for the rest.
jest.mock('vscode', () => {
  const Nothing = jest.requireActual('../../../__mocks__/vscode.js');
  class EventEmitter {
    event = () => ({ dispose() {} });
    fire() {}
  }
  const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
  const target = { EventEmitter, TreeItemCollapsibleState };
  return new Proxy(target, { get: (t, key) => (key in t ? t[key] : Nothing) });
});
// the registry would drag the connection layer in; nothing here lists a server
jest.mock('../serviceManager', () => ({
  getAllFileService: jest.fn(() => []),
  getFileService: jest.fn(),
  getRunningTransformTasks: jest.fn(() => []),
}));

import RemoteTreeData from '../remoteExplorer/treeDataProvider';

/**
 * Every transfer command refreshes the Remote Explorer on its way out, whether
 * or not the view was ever opened. While it was not, no root exists: the
 * refresh must be a no-op, not an unhandled "Can't find config" error in the
 * host log.
 */

function item(fsPath: string, isDirectory: boolean) {
  const uri: any = {
    path: fsPath,
    query: `remoteId=1&fsPath=${fsPath}`,
    toString: () => fsPath,
    with: () => uri,
  };
  return { resource: { uri, fsPath }, isDirectory } as any;
}

describe('RemoteTreeData before the view is built', () => {
  let provider: RemoteTreeData;

  beforeEach(() => {
    provider = new RemoteTreeData();
  });

  test('getChildren of a node answers an empty list instead of throwing', async () => {
    await expect(provider.getChildren(item('/remote/dir', true))).resolves.toEqual([]);
  });

  test('getParent answers undefined instead of throwing', async () => {
    await expect(provider.getParent(item('/remote/dir/a.txt', false))).resolves.toBeUndefined();
  });

  test('refresh of a folder or a file resolves quietly', async () => {
    const fire = jest.spyOn((provider as any)._onDidChangeFolder, 'fire');

    await expect(provider.refresh(item('/remote/dir', true))).resolves.toBeUndefined();
    await expect(provider.refresh(item('/remote/dir/a.txt', false))).resolves.toBeUndefined();

    // the folder node itself is still announced; its parent (unknown) is not
    expect(fire).toHaveBeenCalledTimes(1);
  });

  test('findRoot is null until the roots exist', () => {
    expect(provider.findRoot({ query: 'remoteId=1' } as any)).toBeNull();
  });
});
