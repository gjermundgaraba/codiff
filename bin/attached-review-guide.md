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

It waits until the user asks a question or sends feedback, prints it as JSON, and exits. The
command does not itself notify or resume the agent; that depends on the agent's execution tool.
A returned process or session ID is not evidence of automatic completion notifications.

Run it in the background only when the tool explicitly documents that completion will resume
you. Otherwise, keep the current turn active and collect the output by waiting on or polling the
existing command session. Do not end the turn while promising attached responses without that
resumption guarantee. If you cannot maintain the wait, open Codiff without `--attach`.

For bounded waits, pass `--wait 30` to return `{"kind": "idle"}` after 30 seconds and wait again
after an idle result. An idle result does not end the review. Pass `--kind question|feedback` to
only receive one kind. Keep one pending wait per review; collect it before starting another.

Once the review is open, every result names it in `session`. Pass that back on later waits as
`codiff review next --session <session>`, so you keep following your own review even if another
agent opens one for the same repository.

Handle each request, then run `codiff review next` again. Stop when the user says the review is
over, or when `next` returns `"kind": "closed"`.

- `"kind": "question"`: `comment` holds the question and the file and lines it is about. Answer
  with `codiff review reply <id> --body "<answer>"` (or `--file <path>`, `-` for stdin). If you
  cannot answer, use `codiff review reply <id> --error "<reason>"`. A question stays pending until
  you reply, so `next` returns it again after a restart.
- `"kind": "feedback"`: `markdown` holds the user's review comments. Picking it up is enough; act
  on it like any other user request. Re-check each comment against the current code.
- `"kind": "closed"`: the user closed the Codiff window, Codiff quit, or a newer attached review
  replaced this one. The review is over: do not run `next` again, and briefly tell the user you
  stopped listening. If you opened the newer review yourself, keep following that one instead.
  `next` also returns `closed` when no review opens within a minute of starting to wait.

Through the Codiff skill launcher, run these as `node scripts/open-codiff.mjs --review next` and
`node scripts/open-codiff.mjs --review reply <id> ...`.
