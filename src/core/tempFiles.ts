/**
 * Patterns for local scratch files that must never reach a remote server.
 *
 * These are artifacts of editors, operating systems, merge tools, browsers and
 * of this extension itself. Uploading them is at best noise and at worst
 * harmful: a stale `.orig` next to a deployed file leaks the pre-merge source,
 * and an interrupted download (`*.part`) would publish a truncated file.
 *
 * The syntax is gitignore, matched against the path relative to the service
 * base dir by {@link FileService._createIgnoreFn}.
 */
export const DEFAULT_TEMP_FILE_PATTERNS: string[] = [
  // Generic temporary files. Spelled out rather than as `*.tmp*`, which also
  // swallowed real extensions that merely start with "tmp" — `.tmpl` templates
  // (Go, Smarty, Helm) are common enough that the silent skip read as a broken
  // upload.
  '*.tmp',
  '*.tmp.*',
  '*.tmp[0-9]*',
  '*.temp',
  '*.$$$',

  // this extension's own upload staging file, see TransferTask._transferFile.
  // A crashed transfer leaves one behind; a later sync must not ship it.
  '*.new',

  // vim / vi
  '*.swp',
  '*.swo',
  '*.swn',
  '.*.sw[a-p]',
  '*~',

  // emacs. The leading "#" has to be escaped: in gitignore syntax an unescaped
  // one starts a comment, so a bare "#*#" would be silently dropped.
  '.#*',
  '\\#*#',

  // Microsoft Office / LibreOffice lock and owner files
  '~$*',
  '.~lock.*#',

  // merge, patch and backup leftovers
  '*.orig',
  '*.rej',
  '*.bak',

  // partially written downloads
  '*.crdownload',
  '*.part',
  '*.partial',
  '*.download',

  // macOS
  '.DS_Store',
  '._*',
  '.Spotlight-V100',
  '.Trashes',

  // Windows
  'Thumbs.db',
  'ehthumbs.db',
  'desktop.ini',
];

/**
 * Resolves the temp-file ignore patterns for a config.
 *
 * `ignoreTempFiles` defaults to true — the safe direction, since a skipped
 * upload is recoverable and a published scratch file is not. `tempFilePatterns`
 * adds to the defaults rather than replacing them; to allow a specific pattern
 * back through, negate it there (gitignore `!` syntax), e.g. `"!*.bak"`.
 */
export function resolveTempFilePatterns(config: {
  ignoreTempFiles?: boolean;
  tempFilePatterns?: string[];
}): string[] {
  if (config.ignoreTempFiles === false) {
    return [];
  }

  const extra = Array.isArray(config.tempFilePatterns) ? config.tempFilePatterns : [];
  return DEFAULT_TEMP_FILE_PATTERNS.concat(extra);
}
