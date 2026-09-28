/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { SendToAgentButton } from '../app/components/SendToAgentButton.tsx';
import type { ReviewComment } from '../lib/app-types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact } from './helpers/react.tsx';

const file = createChangedFile('src/app.ts');

const comment = {
  body: 'Rename this helper.',
  filePath: file.path,
  id: 'comment-1',
  lineNumber: 1,
  sectionId: file.sections[0].id,
  side: 'additions',
} satisfies ReviewComment;

const mockSend = (send: (markdown: string) => Promise<void>) => {
  window.codiff = { sendAttachedFeedback: vi.fn(send) } as unknown as typeof window.codiff;
  return window.codiff.sendAttachedFeedback;
};

test('stays disabled until a comment with a body exists', async () => {
  await using app = await renderReact(
    <SendToAgentButton
      comments={[{ ...comment, body: '  ' }]}
      files={[file]}
      reviewCommentsPrefix=""
      showWhitespace={false}
    />,
  );

  const button = app.container.querySelector<HTMLButtonElement>('button');
  expect(button?.disabled).toBe(true);
  expect(button?.getAttribute('aria-label')).toBe(
    'Send review comments to your agent, no comments yet',
  );
});

test('sends the same Markdown as the copy button to the attached agent', async () => {
  const send = mockSend(async () => {});
  await using app = await renderReact(
    <SendToAgentButton
      comments={[comment]}
      files={[file]}
      reviewCommentsPrefix=""
      showWhitespace={false}
    />,
  );

  const button = app.container.querySelector<HTMLButtonElement>('button');
  expect(button?.getAttribute('aria-label')).toBe('Send 1 review comment to your agent');
  await act(async () => button?.click());

  expect(send).toHaveBeenCalledTimes(1);
  expect(vi.mocked(send).mock.calls[0][0]).toContain('Rename this helper.');
  expect(button?.classList.contains('copied')).toBe(true);
});

test('shows why sending failed', async () => {
  mockSend(async () => {
    throw new Error('This window is not attached to an agent.');
  });
  await using app = await renderReact(
    <SendToAgentButton
      comments={[comment]}
      files={[file]}
      reviewCommentsPrefix=""
      showWhitespace={false}
    />,
  );

  const button = app.container.querySelector<HTMLButtonElement>('button');
  await act(async () => button?.click());

  expect(button?.getAttribute('title')).toBe('This window is not attached to an agent.');
  expect(button?.classList.contains('copied')).toBe(false);
});
