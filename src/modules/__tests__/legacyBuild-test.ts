import { extensionIdOf, LEGACY_EXTENSION_ID, retireLegacyBuild } from '../legacyBuild';

/**
 * The build published before the Marketplace (jalexiscv.sftp) is uninstalled
 * by SFTP Forge, once, and only when it is there.
 */

function deps(options: { installed?: boolean; uninstallError?: Error; choice?: string } = {}) {
  return {
    isInstalled: jest.fn((id: string) => Boolean(options.installed) && id === LEGACY_EXTENSION_ID),
    uninstall: jest.fn((id: string) =>
      options.uninstallError ? Promise.reject(options.uninstallError) : Promise.resolve()
    ),
    showInformationMessage: jest.fn((..._args: any[]) => Promise.resolve(options.choice)),
    showWarningMessage: jest.fn((..._args: any[]) => Promise.resolve(undefined)),
    reloadWindow: jest.fn(),
  };
}

describe('retireLegacyBuild', () => {
  test('does nothing when the old build is not installed', async () => {
    const d = deps();
    await expect(retireLegacyBuild('jalexiscv.sftp-forge', d)).resolves.toBe('absent');
    expect(d.uninstall).not.toHaveBeenCalled();
    expect(d.showInformationMessage).not.toHaveBeenCalled();
  });

  test('uninstalls the old build and offers the reload', async () => {
    const d = deps({ installed: true });
    await expect(retireLegacyBuild('jalexiscv.sftp-forge', d)).resolves.toBe('removed');
    expect(d.uninstall).toHaveBeenCalledWith(LEGACY_EXTENSION_ID);
    expect(d.showInformationMessage.mock.calls[0][0]).toContain('was uninstalled');
    expect(d.reloadWindow).not.toHaveBeenCalled();
  });

  test('reloads when asked', async () => {
    const d = deps({ installed: true, choice: 'Reload Window' });
    await retireLegacyBuild('jalexiscv.sftp-forge', d);
    expect(d.reloadWindow).toHaveBeenCalledTimes(1);
  });

  test('a failed uninstall is reported with the way out', async () => {
    const d = deps({ installed: true, uninstallError: new Error('busy') });
    await expect(retireLegacyBuild('jalexiscv.sftp-forge', d)).resolves.toBe('failed');
    expect(d.showWarningMessage.mock.calls[0][0]).toContain('could not be uninstalled (busy)');
    expect(d.showInformationMessage).not.toHaveBeenCalled();
  });

  test('the old build running this code leaves itself alone, whatever the casing', async () => {
    const d = deps({ installed: true });
    await expect(retireLegacyBuild('JAlexisCV.sftp', d)).resolves.toBe('self');
    expect(d.uninstall).not.toHaveBeenCalled();
  });

  test('an unknown current id still retires the old build', async () => {
    const d = deps({ installed: true });
    await expect(retireLegacyBuild(undefined, d)).resolves.toBe('removed');
  });
});

describe('extensionIdOf', () => {
  test('reads the id of the running extension', () => {
    expect(extensionIdOf({ extension: { id: 'jalexiscv.sftp-forge' } })).toBe('jalexiscv.sftp-forge');
  });

  test('is undefined on hosts without context.extension', () => {
    expect(extensionIdOf({})).toBeUndefined();
    expect(extensionIdOf(undefined)).toBeUndefined();
    expect(extensionIdOf({ extension: { id: '' } })).toBeUndefined();
  });
});
