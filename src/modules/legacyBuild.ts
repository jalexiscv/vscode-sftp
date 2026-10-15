import * as vscode from 'vscode';
import logger from '../logger';
import { executeCommand, showInformationMessage, showWarningMessage, reloadWindow } from '../host';

/**
 * Retires the build this extension was published as before it reached the
 * Visual Studio Marketplace.
 *
 * Up to 1.30.1 the fork was distributed as vsix files only, with the id
 * `jalexiscv.sftp`. On the Marketplace the display name "SFTP" is taken, so
 * from 1.30.2 the extension is `jalexiscv.sftp-forge` ("SFTP Forge"). VS Code
 * treats a new id as another extension: the update check of an installed
 * 1.30.1, or a manual install, leaves both side by side, registering the same
 * `sftp.*` commands, views and settings. The first activation of SFTP Forge
 * uninstalls the old build and offers the reload; the configuration
 * (`sftp.json`, the `sftp.*` settings) is shared and nothing has to be redone.
 *
 * Key lifecycle methods:
 * - {@link retireLegacyBuild} runs at activation and never blocks it.
 */

/** the id the fork was distributed with before the Marketplace */
export const LEGACY_EXTENSION_ID = 'jalexiscv.sftp';

const BUTTON_RELOAD = 'Reload Window';

export type LegacyBuildOutcome = 'self' | 'absent' | 'removed' | 'failed';

export interface LegacyBuildDeps {
  isInstalled(id: string): boolean;
  uninstall(id: string): Thenable<any>;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  reloadWindow(): any;
}

const defaultDeps: LegacyBuildDeps = {
  isInstalled: id => Boolean(vscode.extensions.getExtension(id)),
  uninstall: id => executeCommand('workbench.extensions.uninstallExtension', id),
  showInformationMessage,
  showWarningMessage,
  reloadWindow,
};

/** `context.extension.id` (vscode 1.55+); undefined on older hosts. */
export function extensionIdOf(context: any): string | undefined {
  const extension = context && context.extension;
  const id = extension && extension.id;
  return typeof id === 'string' && id ? id : undefined;
}

function sameId(a: string | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Uninstalls {@link LEGACY_EXTENSION_ID} when it is installed next to this
 * extension. `currentId` is `context.extension.id`; the old build running
 * this code (it never does, but a local build with the old name might) leaves
 * itself alone.
 */
export async function retireLegacyBuild(
  currentId: string | undefined,
  deps: LegacyBuildDeps = defaultDeps
): Promise<LegacyBuildOutcome> {
  if (sameId(currentId, LEGACY_EXTENSION_ID)) {
    return 'self';
  }
  if (!deps.isInstalled(LEGACY_EXTENSION_ID)) {
    return 'absent';
  }

  try {
    await deps.uninstall(LEGACY_EXTENSION_ID);
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    logger.warn(`[legacy] could not uninstall ${LEGACY_EXTENSION_ID}: ${reason}`);
    deps.showWarningMessage(
      `SFTP Forge replaces the earlier "SFTP" build (${LEGACY_EXTENSION_ID}), which could not be uninstalled (${reason}). ` +
        'Uninstall it from the Extensions view: both register the same commands.'
    );
    return 'failed';
  }

  logger.info(`[legacy] ${LEGACY_EXTENSION_ID} uninstalled: SFTP Forge (jalexiscv.sftp-forge) replaces it`);
  const choice = await deps.showInformationMessage(
    `SFTP Forge replaces the earlier "SFTP" build (${LEGACY_EXTENSION_ID}), which was uninstalled. ` +
      'Your sftp.json and settings are kept. Reload the window to finish.',
    BUTTON_RELOAD
  );
  if (choice === BUTTON_RELOAD) {
    deps.reloadWindow();
  }
  return 'removed';
}
