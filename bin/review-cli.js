import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const {
  getAttachedReviewDir,
  isAttachedSessionOpen,
  readAttachedSession,
  replyToRequest,
  takeNextRequest,
} = require('../electron/attached-review.cjs');

// How long `next` waits for Codiff to open a review before it gives up.
const STARTUP_TIMEOUT_MS = 60 * 1000;

const guidePath = resolve(dirname(fileURLToPath(import.meta.url)), 'attached-review-guide.md');

const readText = async (file, stdin) => {
  if (file !== '-') {
    return readFile(resolve(file), 'utf8');
  }
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const parseWaitMs = (value) => {
  if (value == null) {
    return Infinity;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('--wait must be a number of seconds.');
  }
  return seconds * 1000;
};

/**
 * `codiff review <guide|next|reply>`: the agent side of an attached review. `next` checks the
 * inbox on disk instead of holding a connection, so it costs nothing while it waits. It follows one
 * session, named by `--session` or the first open one it sees, and reports `closed` once that
 * session's window closes, Codiff exits, or a newer attached review replaces it.
 *
 * @param {ReadonlyArray<string>} args Arguments after `codiff review`.
 * @param {{
 *   cwd?: string,
 *   isProcessRunning?: (pid: number) => boolean,
 *   pollIntervalMs?: number,
 *   startupTimeoutMs?: number,
 *   stderr?: { write: (text: string) => unknown },
 *   stdin?: AsyncIterable<string | Uint8Array>,
 *   stdout?: { write: (text: string) => unknown },
 * }} [options]
 */
export const runReviewCommand = async (
  args,
  {
    cwd = process.cwd(),
    isProcessRunning,
    pollIntervalMs = 500,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    stderr = process.stderr,
    stdin = process.stdin,
    stdout = process.stdout,
  } = {},
) => {
  const [command, ...rest] = args;
  try {
    if (!command || command === 'guide' || command === 'help' || command === '--help') {
      stdout.write(readFileSync(guidePath, 'utf8'));
      return 0;
    }

    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args: rest,
      options: {
        body: { type: 'string' },
        error: { type: 'string' },
        file: { type: 'string' },
        kind: { type: 'string' },
        path: { type: 'string' },
        session: { type: 'string' },
        wait: { type: 'string' },
      },
    });
    const dir = getAttachedReviewDir(resolve(cwd, values.path ?? '.'));

    if (command === 'next') {
      if (values.kind != null && values.kind !== 'question' && values.kind !== 'feedback') {
        throw new Error('--kind must be question or feedback.');
      }
      const startedAt = Date.now();
      const deadline = startedAt + parseWaitMs(values.wait);
      let sessionId = values.session;
      while (true) {
        const session = readAttachedSession(dir);
        // Without --session, follow the open session. A session that closed before this wait began
        // belongs to an earlier review, so keep waiting for the window that is about to open.
        if (
          !sessionId &&
          session &&
          (isAttachedSessionOpen(session, isProcessRunning) || (session.closedAt ?? 0) >= startedAt)
        ) {
          sessionId = session.id;
        }
        // A different session means a newer attached review replaced the one being followed.
        const replaced = sessionId != null && session?.id !== sessionId;
        // Pending requests come first, including feedback sent just before the window closed.
        const request = replaced ? null : takeNextRequest(dir, values.kind);
        const now = Date.now();
        const closed = sessionId
          ? replaced || !session || !isAttachedSessionOpen(session, isProcessRunning)
          : now - startedAt >= startupTimeoutMs;
        const result =
          request ?? (closed ? { kind: 'closed' } : now >= deadline ? { kind: 'idle' } : null);
        if (result) {
          const output = sessionId ? { ...result, session: sessionId } : result;
          stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          return 0;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
      }
    }

    if (command === 'reply') {
      const [id] = positionals;
      if (!id) {
        throw new Error('codiff review reply requires a request id.');
      }
      if (values.error != null) {
        replyToRequest(dir, id, { error: values.error });
        return 0;
      }
      const body = values.file == null ? values.body : await readText(values.file, stdin);
      if (!body?.trim()) {
        throw new Error('codiff review reply requires --body, --file, or --error.');
      }
      replyToRequest(dir, id, { body: body.trimEnd() });
      return 0;
    }

    throw new Error(`Unknown review command: ${command}. Run \`codiff review guide\`.`);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
