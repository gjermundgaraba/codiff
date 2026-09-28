import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const {
  getAttachedReviewDir,
  replyToRequest,
  takeNextRequest,
} = require('../electron/attached-review.cjs');

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
 * inbox on disk instead of holding a connection, so it costs nothing while it waits and works
 * whether or not Codiff is running.
 *
 * @param {ReadonlyArray<string>} args Arguments after `codiff review`.
 * @param {{
 *   cwd?: string,
 *   pollIntervalMs?: number,
 *   stderr?: { write: (text: string) => unknown },
 *   stdin?: AsyncIterable<string | Uint8Array>,
 *   stdout?: { write: (text: string) => unknown },
 * }} [options]
 */
export const runReviewCommand = async (
  args,
  {
    cwd = process.cwd(),
    pollIntervalMs = 500,
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
        wait: { type: 'string' },
      },
    });
    const dir = getAttachedReviewDir(resolve(cwd, values.path ?? '.'));

    if (command === 'next') {
      if (values.kind != null && values.kind !== 'question' && values.kind !== 'feedback') {
        throw new Error('--kind must be question or feedback.');
      }
      const deadline = Date.now() + parseWaitMs(values.wait);
      while (true) {
        const request = takeNextRequest(dir, values.kind);
        if (request || Date.now() >= deadline) {
          stdout.write(`${JSON.stringify(request ?? { kind: 'idle' }, null, 2)}\n`);
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
