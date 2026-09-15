import * as fs from 'fs';

/**
 * Typed handle on node's promise-based `fs` API.
 *
 * The extension runs on VS Code's Electron node, which has shipped
 * `fs.promises` since node 10, but the installed `@types/node` predates it and
 * declares neither `fs.promises` nor `Dirent`. Declaring the few signatures we
 * use here keeps call sites typed without pulling a newer `@types/node`, which
 * this TypeScript version cannot consume.
 *
 * Going through `fs` rather than `vscode.workspace.fs` is deliberate: jest can
 * swap `fs` for memfs (`jest.mock('fs')`), which is how the modules built on
 * this are tested.
 */

export interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface FsPromises {
  readdir(dir: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
  lstat(fsPath: string): Promise<fs.Stats>;
  stat(fsPath: string): Promise<fs.Stats>;
  readFile(fsPath: string, encoding: string): Promise<string>;
  writeFile(fsPath: string, data: string, encoding: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<void>;
  unlink(fsPath: string): Promise<void>;
  /** the directory must be empty */
  rmdir(dir: string): Promise<void>;
  realpath(fsPath: string): Promise<string>;
}

const fsPromises: FsPromises = (fs as any).promises;

export default fsPromises;
