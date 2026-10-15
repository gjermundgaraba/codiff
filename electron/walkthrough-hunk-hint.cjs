// @ts-check

// zsh reads `$S:h1` as the `:h` modifier, so `path:$S:h1` collapses to `path:.1`.
const SHELL_MANGLED_HUNK_ID = /:\.\d+$/;

/** @param {unknown} value @returns {ReadonlyArray<any>} */
const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * Explains why no walkthrough stop resolved: shows one of the authored hunk ids next to a real one
 * from this diff, so the author can see what went wrong without opening Codiff.
 *
 * @param {unknown} input The authored walkthrough.
 * @param {ReadonlyMap<string, { id: string, path: string }>} hunkById The live diff's hunks.
 * @returns {string} A sentence to append to the error, or an empty string.
 */
const describeUnresolvedHunkIds = (input, hunkById) => {
  const authored = asArray(/** @type {any} */ (input)?.chapters).flatMap((chapter) =>
    asArray(chapter?.stops).flatMap((stop) =>
      asArray(stop?.hunkIds).filter((id) => typeof id === 'string'),
    ),
  );
  const unique = [...new Set(authored)];
  const unresolved = unique.filter((id) => !hunkById.has(id));
  if (unresolved.length === 0) {
    return '';
  }

  const [example] = unresolved;
  const hunks = [...hunkById.values()];
  const expected = hunks.find((hunk) => example.startsWith(`${hunk.path}:`)) ?? hunks.find(Boolean);
  let hint = ` ${unresolved.length} of its ${unique.length} hunk ids are not in this diff, e.g. \`${example}\``;
  hint += expected ? `; this diff has ids like \`${expected.id}\`.` : '.';
  if (unresolved.some((id) => SHELL_MANGLED_HUNK_ID.test(id))) {
    hint +=
      ' Ids ending in `:.<number>` were likely rewritten by the shell: zsh reads `$VAR:h1` as a' +
      ' modifier. Write the file without shell expansion.';
  }
  return hint;
};

module.exports = { describeUnresolvedHunkIds };
