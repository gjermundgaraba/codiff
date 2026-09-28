import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { runReviewCommand } from '../../bin/review-cli.js';
import { createFakeCommandLogger, createFakeOpenLogger } from '../../core/__tests__/helpers/cli.ts';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import type { ReviewAssistantRequest, ReviewAssistantResult } from '../../core/types.ts';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

type AttachedRequest = {
  id: string;
  kind: 'feedback' | 'question';
  markdown?: string;
} & Partial<ReviewAssistantRequest>;

const {
  askAttachedAgent,
  getAttachedReviewDir,
  replyToRequest,
  resetAttachedReview,
  sendAttachedFeedback,
  takeNextRequest,
} = require('../attached-review.cjs') as {
  askAttachedAgent: (
    dir: string,
    request: ReviewAssistantRequest,
    options?: { isCanceled?: () => boolean; pollIntervalMs?: number; timeoutMs?: number },
  ) => Promise<ReviewAssistantResult>;
  getAttachedReviewDir: (repositoryPath: string, home?: string) => string;
  replyToRequest: (dir: string, id: string, reply: { body: string } | { error: string }) => void;
  resetAttachedReview: (dir: string) => void;
  sendAttachedFeedback: (dir: string, markdown: unknown) => void;
  takeNextRequest: (dir: string, kind?: 'feedback' | 'question') => AttachedRequest | null;
};
const { getCommandLineLaunchOptions } = require('../main/command-line.cjs') as {
  getCommandLineLaunchOptions: (commandLine: ReadonlyArray<string>) => { attach?: boolean };
};

const question: ReviewAssistantRequest = {
  comment: { body: 'Why is this async?', filePath: 'src/a.ts', lineNumber: 3, sectionId: 's1' },
};

const waitForRequest = async (dir: string, kind?: 'feedback' | 'question') => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const request = takeNextRequest(dir, kind);
    if (request) {
      return request;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error('No request arrived.');
};

const runCli = async (args: ReadonlyArray<string>, options: { cwd: string; stdin?: string }) => {
  let stdout = '';
  let stderr = '';
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
  const code = await runReviewCommand(args, {
    cwd: options.cwd,
    pollIntervalMs: 5,
    stderr: { write: (text: string) => (stderr += text) },
    stdin,
    stdout: { write: (text: string) => (stdout += text) },
  });
  return { code, stderr, stdout };
};

test('keys the inbox by repository root, so subdirectories find the same review', async () => {
  await using directory = await createTemporaryDirectory('codiff-attached-root-');
  const repository = join(directory.path, 'repo');
  await mkdir(join(repository, 'src'), { recursive: true });
  await execFileAsync('git', ['init', '-q', repository], { env: getGitTestEnvironment() });

  const dir = getAttachedReviewDir(repository, directory.path);
  expect(getAttachedReviewDir(join(repository, 'src'), directory.path)).toBe(dir);
  expect(dir.startsWith(join(directory.path, 'attached', 'repo-'))).toBe(true);
});

test('answers a question through the inbox in the shape of the built-in Ask', async () => {
  await using directory = await createTemporaryDirectory('codiff-attached-ask-');
  const dir = join(directory.path, 'inbox');

  const answer = askAttachedAgent(dir, question, { pollIntervalMs: 5 });
  const request = await waitForRequest(dir);
  expect(request).toMatchObject({ ...question, kind: 'question' });
  // Unanswered questions stay pending, so a restarted agent sees them again.
  expect(takeNextRequest(dir)?.id).toBe(request.id);

  replyToRequest(dir, request.id, { body: 'It awaits the file read.' });

  await expect(answer).resolves.toEqual({ reply: 'It awaits the file read.', status: 'ready' });
  expect(takeNextRequest(dir)).toBeNull();
});

test('reports agent errors and withdraws questions nobody will see', async () => {
  await using directory = await createTemporaryDirectory('codiff-attached-withdraw-');
  const dir = join(directory.path, 'inbox');

  const failed = askAttachedAgent(dir, question, { pollIntervalMs: 5 });
  replyToRequest(dir, (await waitForRequest(dir)).id, { error: 'Out of context.' });
  await expect(failed).resolves.toEqual({ reason: 'Out of context.', status: 'unavailable' });

  let canceled = false;
  const canceledAsk = askAttachedAgent(dir, question, {
    isCanceled: () => canceled,
    pollIntervalMs: 5,
  });
  await waitForRequest(dir);
  canceled = true;
  await expect(canceledAsk).resolves.toMatchObject({ status: 'unavailable' });
  expect(takeNextRequest(dir)).toBeNull();

  const resetAsk = askAttachedAgent(dir, question, { pollIntervalMs: 5 });
  await waitForRequest(dir);
  resetAttachedReview(dir);
  await expect(resetAsk).resolves.toMatchObject({ status: 'unavailable' });
});

test('hands out feedback once and in order, and filters by kind', async () => {
  await using directory = await createTemporaryDirectory('codiff-attached-feedback-');
  const dir = join(directory.path, 'inbox');

  expect(() => sendAttachedFeedback(dir, '  ')).toThrow('no review comments');
  sendAttachedFeedback(dir, 'First batch.');
  void askAttachedAgent(dir, question, { pollIntervalMs: 5, timeoutMs: 1000 });
  await waitForRequest(dir, 'question');
  sendAttachedFeedback(dir, 'Second batch.');

  expect(takeNextRequest(dir, 'feedback')?.markdown).toBe('First batch.');
  expect(takeNextRequest(dir, 'feedback')?.markdown).toBe('Second batch.');
  expect(takeNextRequest(dir, 'feedback')).toBeNull();
  expect(await readdir(join(dir, 'delivered'))).toHaveLength(2);
  expect(takeNextRequest(dir)?.kind).toBe('question');
  expect(() => replyToRequest(dir, '../escape', { body: 'x' })).toThrow('Invalid request id');
});

test('codiff review next and reply talk to the inbox for the working directory', async () => {
  await using directory = await createTemporaryDirectory('codiff-attached-cli-');
  const home = join(directory.path, 'home');
  const repository = join(directory.path, 'repo');
  await mkdir(repository);
  using _environment = createTemporaryEnvironment({ CODIFF_HOME: home });
  expect(await runCli(['next', '--wait', '0'], { cwd: repository })).toMatchObject({
    code: 0,
    stdout: '{\n  "kind": "idle"\n}\n',
  });

  const dir = getAttachedReviewDir(repository, home);
  const answer = askAttachedAgent(dir, question, { pollIntervalMs: 5 });
  const next = await runCli(['next'], { cwd: repository });
  const request = JSON.parse(next.stdout) as AttachedRequest;
  expect(request).toMatchObject({ comment: question.comment, kind: 'question' });

  expect(await runCli(['reply', request.id], { cwd: repository })).toMatchObject({
    code: 1,
    stderr: 'codiff review reply requires --body, --file, or --error.\n',
  });
  expect(
    await runCli(['reply', request.id, '--file', '-'], {
      cwd: repository,
      stdin: 'Because of the read.',
    }),
  ).toMatchObject({ code: 0 });
  await expect(answer).resolves.toEqual({ reply: 'Because of the read.', status: 'ready' });

  expect((await runCli(['guide'], { cwd: repository })).stdout).toContain('codiff review next');
  expect(await runCli(['nope'], { cwd: repository })).toMatchObject({ code: 1 });
});

test('parses the attach launch flag', () => {
  expect(getCommandLineLaunchOptions(['codiff', '--attach', '/repo']).attach).toBe(true);
  expect(getCommandLineLaunchOptions(['codiff', '/repo']).attach).toBeUndefined();
});

test('packaged terminal helper forwards --attach to Electron', async () => {
  await using logger = await createFakeOpenLogger();
  const repositoryPath = join(logger.directory, 'repo');
  await mkdir(repositoryPath);

  await execFileAsync(resolve('bin/codiff-app'), ['--attach', repositoryPath], {
    env: logger.env,
  });

  expect(await logger.readArgs()).toEqual([
    '-n',
    resolve('bin/../../../..'),
    '--args',
    '--attach',
    repositoryPath,
  ]);
});

test('packaged terminal helper runs review commands through the bundled Node entry point', async () => {
  await using logger = await createFakeCommandLogger('codiff-packaged-review-', 'runtime');

  await execFileAsync(resolve('bin/codiff-app'), ['review', 'next', '--wait', '0'], {
    env: { ...logger.env, CODIFF_NODE_COMMAND: logger.commandPath },
  });

  expect(await logger.readArgs()).toEqual([
    resolve('bin/codiff.js'),
    'review',
    'next',
    '--wait',
    '0',
  ]);
});

test('skill launchers forward review commands from the session directory', async () => {
  await using logger = await createFakeCommandLogger('codiff-review-launcher-', 'codiff');
  const repositoryPath = join(logger.directory, 'repo');
  await mkdir(repositoryPath);

  await execFileAsync(
    process.execPath,
    [resolve('codex/skills/codiff/scripts/open-codiff.mjs'), '--review', 'next', '--wait', '0'],
    {
      cwd: resolve('codex/skills/codiff'),
      env: {
        ...logger.env,
        CODEX_SESSION_CWD: repositoryPath,
        CODEX_THREAD_ID: '',
        CODIFF_COMMAND: logger.commandPath,
      },
    },
  );

  expect(await logger.readArgs()).toEqual(['review', 'next', '--wait', '0']);
});
