# Codiff attached review

An attached review keeps a Codiff window connected to you, the agent that opened it, while the user
reviews. The user can:

- **Ask** about a comment. You answer in Codiff, and the answer shows under the comment.
- **Send to agent** all of their review comments as Markdown. Treat that as direction from the
  user, the same as if they had pasted it into the conversation.

## Open

Launch Codiff as usual with `--attach`, for example `codiff --attach -w --walkthrough-file <file>`.
Through the Codiff skill launcher, add `--attach` to the walkthrough command:
`node scripts/open-codiff.mjs --attach --file <file>`.

There is one attached review per repository. Opening it again replaces the previous one.

## Wait for requests

Run from the repository (or pass `--path <repo>`):

```bash
codiff review next
```

It waits until the user asks a question or sends feedback, prints it as JSON, and exits. Waiting
costs nothing, so run it as a background command when your tool supports that, and you are notified
when it exits. Pass `--wait <seconds>` to return `{"kind": "idle"}` after that long instead, and
`--kind question|feedback` to only receive one kind.

Handle each request, then run `codiff review next` again. Stop when the user says the review is
over.

- `"kind": "question"`: `comment` holds the question and the file and lines it is about. Answer
  with `codiff review reply <id> --body "<answer>"` (or `--file <path>`, `-` for stdin). If you
  cannot answer, use `codiff review reply <id> --error "<reason>"`. A question stays pending until
  you reply, so `next` returns it again after a restart.
- `"kind": "feedback"`: `markdown` holds the user's review comments. Picking it up is enough; act
  on it like any other user request. Re-check each comment against the current code.

Through the Codiff skill launcher, run these as `node scripts/open-codiff.mjs --review next` and
`node scripts/open-codiff.mjs --review reply <id> ...`.
