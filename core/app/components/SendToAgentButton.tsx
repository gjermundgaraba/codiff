import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { PaperPlaneRightIcon as PaperPlaneRight } from '@phosphor-icons/react/PaperPlaneRight';
import { useCallback, useState } from 'react';
import type { ReviewComment } from '../../lib/app-types.ts';
import { buildReviewCommentsMarkdown } from '../../lib/review-comments.ts';
import type { ChangedFile } from '../../types.ts';
import { useCopiedState } from './useCopiedState.ts';

/**
 * Sends the same Markdown as the copy button to the agent attached with `codiff --attach`, which
 * receives it through `codiff review next`.
 */
export function SendToAgentButton({
  comments,
  files,
  reviewCommentsPrefix,
  showWhitespace,
}: {
  comments: ReadonlyArray<ReviewComment>;
  files: ReadonlyArray<ChangedFile>;
  reviewCommentsPrefix: string;
  showWhitespace: boolean;
}) {
  const [sent, markSent] = useCopiedState(2000);
  const [error, setError] = useState<string | null>(null);
  const pendingCommentCount = comments.filter(
    (comment) => !comment.isReadOnly && comment.body.trim(),
  ).length;

  const send = useCallback(async () => {
    const markdown = buildReviewCommentsMarkdown(
      files,
      comments,
      showWhitespace,
      reviewCommentsPrefix,
    );
    if (!markdown) {
      return;
    }
    try {
      await window.codiff.sendAttachedFeedback(markdown);
      setError(null);
      markSent();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [comments, files, markSent, reviewCommentsPrefix, showWhitespace]);

  return (
    <button
      aria-label={
        pendingCommentCount === 0
          ? 'Send review comments to your agent, no comments yet'
          : `Send ${pendingCommentCount} review ${
              pendingCommentCount === 1 ? 'comment' : 'comments'
            } to your agent`
      }
      className={`copy-comments-button${sent ? ' copied' : ''}`}
      disabled={pendingCommentCount === 0}
      onClick={() => void send()}
      title={error ?? 'Send review comments to your agent'}
      type="button"
    >
      {sent ? (
        <Check aria-hidden className="copy-comments-icon check" size={15} weight="bold" />
      ) : (
        // The copy icon is mirrored; the plane should keep pointing right.
        <PaperPlaneRight aria-hidden className="copy-comments-icon check" size={14} weight="bold" />
      )}
      <span className="copy-comments-count">{pendingCommentCount}</span>
    </button>
  );
}
