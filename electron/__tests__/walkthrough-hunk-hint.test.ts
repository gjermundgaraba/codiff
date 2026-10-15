import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { normalizeNarrativeWalkthrough } = require('../narrative-walkthrough.cjs') as {
  normalizeNarrativeWalkthrough: (
    input: unknown,
    files: ReadonlyArray<{
      path: string;
      sections: ReadonlyArray<{ id: string; kind: string; patch: string }>;
      status: string;
    }>,
  ) => unknown;
};

const files = [
  {
    path: '.clusterfuzzlite/build.sh',
    sections: [
      {
        id: '.clusterfuzzlite/build.sh:staged',
        kind: 'staged',
        patch: '@@ -1,2 +1,2 @@\n context\n-old\n+new\n',
      },
    ],
    status: 'modified',
  },
];

const walkthrough = (hunkIds: ReadonlyArray<string>) => ({
  chapters: [
    {
      blurb: 'Build.',
      icon: 'path',
      id: 'build',
      stops: [{ hunkIds, id: 's1', importance: 'normal', prose: 'Builds the fuzzers.' }],
      title: 'Build',
    },
  ],
  focus: 'Check the build.',
  kind: 'narrative',
  title: 'Fuzzing',
  version: 4,
});

const failure = (hunkIds: ReadonlyArray<string>) => {
  try {
    normalizeNarrativeWalkthrough(walkthrough(hunkIds), files);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected the walkthrough to be rejected.');
};

test('names an unresolved hunk id next to a real one from the same file', () => {
  expect(failure(['.clusterfuzzlite/build.sh:pull-request:1562:h1'])).toBe(
    'Narrative walkthrough has no chapters with resolvable stops. 1 of its 1 hunk ids are not in' +
      ' this diff, e.g. `.clusterfuzzlite/build.sh:pull-request:1562:h1`; this diff has ids like' +
      ' `.clusterfuzzlite/build.sh:staged:h1`.',
  );
});

test('points at the shell when hunk ids look rewritten by a zsh modifier', () => {
  expect(failure(['.clusterfuzzlite/build.sh:.1', '.clusterfuzzlite/build.sh:.1'])).toContain(
    '1 of its 1 hunk ids are not in this diff, e.g. `.clusterfuzzlite/build.sh:.1`; this diff' +
      ' has ids like `.clusterfuzzlite/build.sh:staged:h1`. Ids ending in `:.<number>` were' +
      ' likely rewritten by the shell',
  );
  expect(failure(['.clusterfuzzlite/build.sh:other:h1'])).not.toContain('shell');
});
