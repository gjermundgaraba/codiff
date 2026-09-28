// @ts-check

const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');

/**
 * Attached reviews connect a Codiff window to the agent that opened it through a folder inbox per
 * repository. Codiff writes requests, the agent picks them up with `codiff review next`:
 *
 *   requests/<id>.json   a question (from Ask) or feedback (from Send to agent)
 *   replies/<id>.json    the agent's answer to a question
 *   delivered/<id>.json  feedback the agent has picked up
 *
 * Every file has a single writer and is written with a rename, so neither side needs locks or a
 * running server.
 *
 * @typedef {import('../core/types.ts').ReviewAssistantRequest} ReviewAssistantRequest
 * @typedef {import('../core/types.ts').ReviewAssistantResult} ReviewAssistantResult
 * @typedef {(ReviewAssistantRequest & { kind: 'question' }) | { kind: 'feedback', markdown: string }} AttachedRequest
 */

const POLL_INTERVAL_MS = 500;
const ASK_TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_ID_PATTERN = /^[\w-]+$/;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** @param {string} path */
const getRealPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** @param {string} path */
const getRepositoryRoot = (path) => {
  try {
    return getRealPath(
      execFileSync('git', ['-C', resolve(path), 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return getRealPath(path);
  }
};

/**
 * One inbox per repository, so the agent finds it from its working directory without an id.
 *
 * @param {string} repositoryPath
 * @param {string} [home]
 */
const getAttachedReviewDir = (
  repositoryPath,
  home = process.env.CODIFF_HOME || join(homedir(), '.codiff'),
) => {
  const root = getRepositoryRoot(repositoryPath);
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return join(home, 'attached', `${basename(root) || 'root'}-${hash}`);
};

/** @param {string} path @param {unknown} value */
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
};

/** @param {string} path */
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/** @param {string} dir @param {string} id */
const getRequestPath = (dir, id) => {
  if (!REQUEST_ID_PATTERN.test(id)) {
    throw new Error(`Invalid request id: ${id}`);
  }
  return join(dir, 'requests', `${id}.json`);
};

/** Drops whatever an earlier attached window left behind. @param {string} dir */
const resetAttachedReview = (dir) => {
  rmSync(dir, { force: true, recursive: true });
};

/** @param {string} dir @param {AttachedRequest} request */
const addRequest = (dir, request) => {
  // Timestamped ids keep the inbox in the order requests were sent.
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  writeJson(getRequestPath(dir, id), { id, ...request });
  return id;
};

/**
 * Returns the oldest pending request, optionally of one kind. Feedback is handled once it is handed
 * out; questions stay pending until they are answered, so an agent that restarts sees them again.
 *
 * @param {string} dir
 * @param {'feedback' | 'question'} [kind]
 */
const takeNextRequest = (dir, kind) => {
  const requestsDir = join(dir, 'requests');
  let names;
  try {
    names = readdirSync(requestsDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  for (const name of names) {
    const request = readJson(join(requestsDir, name));
    if (!request || (kind && request.kind !== kind)) {
      continue;
    }
    if (request.kind === 'feedback') {
      mkdirSync(join(dir, 'delivered'), { recursive: true });
      try {
        renameSync(join(requestsDir, name), join(dir, 'delivered', name));
      } catch (error) {
        // Another agent picked it up first.
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
    }
    return request;
  }
  return null;
};

/**
 * @param {string} dir
 * @param {string} id
 * @param {{ body: string } | { error: string }} reply
 */
const replyToRequest = (dir, id, reply) => {
  const requestPath = getRequestPath(dir, id);
  const request = readJson(requestPath);
  if (!request) {
    throw new Error(`No pending request ${id}. It may have been answered or withdrawn.`);
  }
  if (request.kind !== 'question') {
    throw new Error(`Request ${id} is feedback; only questions take a reply.`);
  }
  writeJson(join(dir, 'replies', `${id}.json`), reply);
  rmSync(requestPath, { force: true });
};

/**
 * Asks the attached agent and resolves in the shape of the built-in Ask, so the existing comment UI
 * shows the answer. The question is withdrawn when the window goes away or nobody answers in time.
 *
 * @param {string} dir
 * @param {ReviewAssistantRequest} request
 * @param {{ isCanceled?: () => boolean, pollIntervalMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<ReviewAssistantResult>}
 */
const askAttachedAgent = async (
  dir,
  request,
  { isCanceled = () => false, pollIntervalMs = POLL_INTERVAL_MS, timeoutMs = ASK_TIMEOUT_MS } = {},
) => {
  const id = addRequest(dir, { ...request, kind: 'question' });
  const requestPath = getRequestPath(dir, id);
  const replyPath = join(dir, 'replies', `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    // The agent writes the reply before it removes the request, so a missing request without a
    // reply means the inbox was reset.
    const reply = readJson(replyPath) ?? (existsSync(requestPath) ? null : readJson(replyPath));
    if (reply) {
      return typeof reply.body === 'string'
        ? { reply: reply.body, status: 'ready' }
        : { reason: reply.error || 'The agent could not answer.', status: 'unavailable' };
    }
    if (isCanceled() || Date.now() >= deadline || !existsSync(requestPath)) {
      rmSync(requestPath, { force: true });
      return {
        reason: 'No agent answered. Ask your agent to run `codiff review next`.',
        status: 'unavailable',
      };
    }
    await sleep(pollIntervalMs);
  }
};

/** @param {string} dir @param {unknown} markdown */
const sendAttachedFeedback = (dir, markdown) => {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new Error('There are no review comments to send.');
  }
  addRequest(dir, { kind: 'feedback', markdown });
};

module.exports = {
  askAttachedAgent,
  getAttachedReviewDir,
  replyToRequest,
  resetAttachedReview,
  sendAttachedFeedback,
  takeNextRequest,
};
