import * as crypto from 'crypto';
import * as fs from 'fs';
import logger from '../logger';

/**
 * Content fingerprint of a local file: the digest that lets the sync index
 * tell a file that was rewritten with the same bytes from one that changed.
 *
 * Size and mtime are what a scan can afford to compare on tens of thousands
 * of files, but the mtime moves for reasons that are not edits — a checkout,
 * a `touch`, a copy, a formatter that produced the same text, a file restored
 * from a backup — and every one of those used to be reported as an external
 * change and uploaded again. With a fingerprint of the content the index
 * verified, a file whose size matches and whose mtime moved is read once and
 * compared; only different bytes make it `modified`.
 *
 * The digest is SHA-1: it is not a security boundary, only a way to tell two
 * versions of the same file apart, and it is the fastest of node's hashes
 * that never collides by accident on real files. A transfer computes it on
 * the bytes it streams (see transferTask), so a verified upload records it for
 * free; a scan, a rebuild or a "mark as uploaded" reads the file for it.
 *
 * Files above {@link MAX_FINGERPRINT_SIZE} are never fingerprinted: reading
 * hundreds of megabytes to save one upload is a poor trade, and such files
 * are rarely rewritten identically. They keep the size-and-mtime rule.
 *
 * Key lifecycle methods:
 * - {@link createFingerprinter} digests a stream chunk by chunk.
 * - {@link fingerprintFile} digests one file on disk.
 * - {@link fingerprintFiles} digests a list with bounded concurrency,
 *   progress and cooperative cancellation.
 */

export const FINGERPRINT_ALGORITHM = 'sha1';

/** Files larger than this keep the size-and-mtime rule; see the module notes. */
export const MAX_FINGERPRINT_SIZE = 64 * 1024 * 1024;

// files read at once by fingerprintFiles: enough to keep an SSD busy without
// starving the editor of file handles
const DEFAULT_CONCURRENCY = 4;

export interface Fingerprinter {
  update(chunk: Buffer): void;
  /** the hex digest; valid once, after the last update */
  digest(): string;
}

/** True when a file of `size` bytes is worth fingerprinting. */
export function canFingerprint(size: number): boolean {
  return typeof size === 'number' && size >= 0 && size <= MAX_FINGERPRINT_SIZE;
}

/** An incremental digester, for content that goes by as a stream. */
export function createFingerprinter(): Fingerprinter {
  const hash = crypto.createHash(FINGERPRINT_ALGORITHM);
  return {
    update: chunk => {
      hash.update(chunk);
    },
    digest: () => hash.digest('hex'),
  };
}

/**
 * Digests the file at `fsPath`. Streamed, so a large file never has to fit in
 * memory; rejects with the read error (ENOENT, EACCES, EBUSY…). Goes through
 * node's `fs` so jest can swap in memfs.
 */
export function fingerprintFile(fsPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fingerprinter = createFingerprinter();
    const stream = fs.createReadStream(fsPath);
    stream.on('data', (chunk: Buffer) => fingerprinter.update(chunk));
    // a stream that fails can report it more than once (the read, then the
    // close): keep listening or the second one would be an uncaught 'error'
    stream.on('error', reject);
    stream.once('end', () => resolve(fingerprinter.digest()));
  });
}

export interface FingerprintCandidate {
  fsPath: string;
  size: number;
}

export interface FingerprintFilesOptions {
  /** polled between files; once true no more files are read */
  isCancelled?: () => boolean;
  /** called after every file that was read, with how many were so far */
  onProgress?: (fingerprinted: number) => void;
  concurrency?: number;
}

export interface FingerprintFilesResult {
  /** fsPath → digest, for the files that could be read and were not above the size cap */
  fingerprints: Map<string, string>;
  cancelled: boolean;
}

/**
 * Digests every candidate that is not above the size cap, a few at a time.
 * A file that cannot be read (gone since the scan, locked, unreadable) is
 * left out and logged at debug level; one bad file never aborts the batch.
 */
export async function fingerprintFiles(
  candidates: FingerprintCandidate[],
  options: FingerprintFilesOptions = {}
): Promise<FingerprintFilesResult> {
  const fingerprints = new Map<string, string>();
  const isCancelled = options.isCancelled || (() => false);
  const eligible = candidates.filter(candidate => canFingerprint(candidate.size));
  let next = 0;
  let done = 0;
  let cancelled = false;

  const lanes = Array.from(
    { length: Math.max(1, Math.min(options.concurrency || DEFAULT_CONCURRENCY, eligible.length)) },
    async () => {
      while (next < eligible.length) {
        if (isCancelled()) {
          cancelled = true;
          return;
        }
        const candidate = eligible[next++];
        try {
          fingerprints.set(candidate.fsPath, await fingerprintFile(candidate.fsPath));
        } catch (error) {
          logger.debug(`[fingerprint] ${candidate.fsPath} not fingerprinted: ${error.message}`);
        }
        done++;
        if (options.onProgress) {
          options.onProgress(done);
        }
      }
    }
  );
  await Promise.all(lanes);

  return { fingerprints, cancelled };
}
