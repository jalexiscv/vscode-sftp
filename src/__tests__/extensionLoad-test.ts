/**
 * Load-order smoke test.
 *
 * The module graph has deliberate runtime cycles (serviceManager <-> fileHandlers,
 * activityLog <- createFileHandler). They are safe only as long as no module
 * reads an import at evaluation time. A new top-level use of a half-loaded
 * module compiles and bundles fine and only fails when the entry point is
 * evaluated, so this test evaluates the entry point and the orders that once
 * broke, under the default `vscode` mock.
 */
describe('extension load order', () => {
  test('the entry point evaluates and exports activate/deactivate', () => {
    jest.isolateModules(() => {
      const extension = require('../extension');
      expect(typeof extension.activate).toBe('function');
      expect(typeof extension.deactivate).toBe('function');
    });
  });

  test('activityLog can be loaded before the file handlers', () => {
    jest.isolateModules(() => {
      const activityLog = require('../modules/activityLog');
      const handlers = require('../fileHandlers');
      expect(activityLog.ActivityKind.Upload).toBe('upload');
      expect(typeof handlers.uploadFile).toBe('function');
    });
  });

  // createFileHandler itself must be reached through fileHandlers/index (or
  // serviceManager): it imports serviceManager, which imports the handlers
  // back, and the transfer handlers call createFileHandler() while loading.
  // The entry point guarantees that order (app -> serviceManager first).
  test('the transfer handlers can be loaded before serviceManager and activityLog', () => {
    jest.isolateModules(() => {
      const transfer = require('../fileHandlers/transfer');
      const activityLog = require('../modules/activityLog');
      expect(typeof transfer.uploadFile).toBe('function');
      expect(activityLog.ActivityKind.Download).toBe('download');
    });
  });

  test('serviceManager can be loaded first', () => {
    jest.isolateModules(() => {
      const serviceManager = require('../modules/serviceManager');
      expect(typeof serviceManager.createFileService).toBe('function');
    });
  });
});
