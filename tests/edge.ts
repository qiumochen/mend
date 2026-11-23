// Edge cases read off SPEC.md sentence by sentence, beyond what the practice set shows.
// Run: node tests/edge.ts   (each case runs main.ts in a fresh directory through the kit's runner)

import { runCheck } from '../runner.ts';

interface Case {
  name: string;
  argv: string[];
  stdin?: string;
  files: Record<string, string>;
  exit: number;
  stdout: string;
  after?: Record<string, string | null>; // changed files: text, or null when deleted
}

const P = 'p.patch';
const cases: Case[] = [
  // section 1: usage
  { name: 'usage: option twice', argv: ['--check', '--check', P], files: { [P]: '' }, exit: 2, stdout: 'error: usage\n' },
  { name: 'usage: bad format', argv: ['--format=diff', P], files: {}, exit: 2, stdout: 'error: usage\n' },
  { name: 'usage beats no-patch', argv: ['-q', 'nope'], files: {}, exit: 2, stdout: 'error: usage\n' },
  { name: 'usage: two positionals', argv: ['a', 'b'], files: {}, exit: 2, stdout: 'error: usage\n' },
  { name: '-- ends options', argv: ['--', '--check'], files: { '--check': 'nothing here\n' }, exit: 2, stdout: 'error: format\n' },
  { name: 'dash reads stdin', argv: ['-'], stdin: '[{"command":"create","path":"n.txt","file_text":"x"}]', files: {}, exit: 0, stdout: 'A n.txt\nok: 1 file\n', after: { 'n.txt': 'x' } },
  { name: 'no-patch: missing file', argv: ['gone.diff'], files: {}, exit: 2, stdout: 'error: no-patch\n' },
  { name: 'format: auto finds none', argv: [P], files: { [P]: 'just prose\n' }, exit: 2, stdout: 'error: format\n' },
  { name: 'forced format with no edit', argv: ['--format=search-replace', P], files: { [P]: 'just prose\n' }, exit: 2, stdout: 'error: parse 1\n' },

  // section 5: tier 2 re-indent
  {
    name: 'sr tier 2 re-indents new lines',
    argv: [P],
    files: { [P]: 'a.py\n<<<<<<< SEARCH\nif x:\n  y()\n=======\nif x:\n  z()\n=======junk\n>>>>>>> REPLACE\n', 'a.py': 'def f():\n    if x:\n      y()\n' },
    exit: 0,
    stdout: 'M a.py\nok: 1 file\n',
    // P (the indent of O's first line) is empty, so every non-blank line of N starts with it and takes F.
    after: { 'a.py': 'def f():\n    if x:\n      z()\n    =======junk\n' },
  },
  {
    name: 'strict refuses drifted whitespace',
    argv: ['--strict', P],
    files: { [P]: 'a.txt\n<<<<<<< SEARCH\nfoo \n=======\nbar\n>>>>>>> REPLACE\n', 'a.txt': 'foo\n' },
    exit: 1,
    stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
  },

  // section 6: unified
  {
    name: 'unified: no newline at end, CRLF kept',
    argv: [P],
    files: { [P]: '--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n\\ No newline at end of file\n', 'x.txt': 'one\r\ntwo\r\n' },
    exit: 0,
    stdout: 'M x.txt\nok: 1 file\n',
    after: { 'x.txt': 'one\r\nTWO' },
  },
  {
    name: 'unified: hunk before any section',
    argv: ['--format=unified', P],
    files: { [P]: 'prose\n@@ -1 +1 @@\n-a\n+b\n' },
    exit: 2,
    stdout: 'error: parse 2\n',
  },
  {
    name: 'unified: --- without +++ in a git header',
    argv: [P],
    files: { [P]: 'diff --git a/x b/x\n--- a/x\nindex 123\n' },
    exit: 2,
    stdout: 'error: parse 3\n',
  },
  {
    name: 'unified: rename only',
    argv: [P],
    files: { [P]: 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n', 'old.txt': 'k\n' },
    exit: 0,
    stdout: 'R old.txt -> new.txt\nok: 1 file\n',
    after: { 'old.txt': null, 'new.txt': 'k\n' },
  },
  {
    name: 'unified: create without final break',
    argv: [P],
    files: { [P]: '--- /dev/null\n+++ b/c.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n' },
    exit: 0,
    stdout: 'A c.txt\nok: 1 file\n',
    after: { 'c.txt': 'a\nb' },
  },
  {
    name: 'unified: empty O inserts after A + d lines',
    argv: [P],
    files: { [P]: '--- a/f\n+++ b/f\n@@ -1,0 +2,1 @@\n+mid\n', f: 'one\ntwo\n' },
    exit: 0,
    stdout: 'M f\nok: 1 file\n',
    after: { f: 'one\nmid\ntwo\n' },
  },
  {
    name: 'unified: unsafe path names the stripped path',
    argv: [P],
    files: { [P]: '--- a/../up.txt\n+++ b/../up.txt\n@@ -1 +1 @@\n-a\n+b\n' },
    exit: 1,
    stdout: 'error: unsafe ../up.txt\nfailed: 1 of 1 edits\n',
  },

  // section 7: SEARCH/REPLACE
  {
    name: 'sr: path skips code fences, later block inherits it',
    argv: [P],
    files: { [P]: 'Change this:\n\nm.js\n```js\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n```\n```js\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n```\n', 'm.js': 'a\nb\n' },
    exit: 0,
    stdout: 'M m.js\nok: 1 file\n',
    after: { 'm.js': 'A\nB\n' },
  },
  {
    name: 'sr: first block without a path',
    argv: [P],
    files: { [P]: '```\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n' },
    exit: 2,
    stdout: 'error: parse 2\n',
  },

  // section 8: V4A
  {
    name: 'v4a: missing End Patch',
    argv: [P],
    files: { [P]: '*** Begin Patch\n*** Delete File: a\n\n' },
    exit: 2,
    stdout: 'error: parse 4\n',
  },
  {
    name: 'v4a: update with nothing',
    argv: [P],
    files: { [P]: '*** Begin Patch\n*** Update File: a\n*** End Patch\n' },
    exit: 2,
    stdout: 'error: parse 2\n',
  },
  {
    name: 'v4a: end-of-file chunk takes the last occurrence',
    argv: [P],
    files: { [P]: '*** Begin Patch\n*** Update File: t\n x\n-y\n+Y\n*** End of File\n*** End Patch\n', t: 'x\ny\nx\ny\n' },
    exit: 0,
    stdout: 'M t\nok: 1 file\n',
    after: { t: 'x\ny\nx\nY\n' },
  },
  {
    name: 'v4a: anchors move the cursor',
    argv: [P],
    files: { [P]: '*** Begin Patch\n*** Update File: t\n@@ def two\n-  pass\n+  return 2\n*** End Patch\n', t: 'def one\n  pass\ndef two\n  pass\n' },
    exit: 0,
    stdout: 'M t\nok: 1 file\n',
    after: { t: 'def one\n  pass\ndef two\n  return 2\n' },
  },

  // section 9: JSON
  {
    name: 'json array: a fault names the array line',
    argv: [P],
    files: { [P]: '\n  [\n {"command":"create","path":"a"}\n]\n' },
    exit: 2,
    stdout: 'error: parse 2\n',
  },
  {
    name: 'json lines: insert keeps a missing final break',
    argv: [P],
    files: { [P]: '{"command":"insert","path":"f","insert_line":2,"new_str":"c\\n"}\n', f: 'a\nb' },
    exit: 0,
    stdout: 'M f\nok: 1 file\n',
    after: { f: 'a\nb\nc' },
  },

  // section 10: order and atomicity
  {
    name: 'every failure reported, nothing written',
    argv: [P],
    files: { [P]: '{"command":"create","path":"new","file_text":"x"}\n{"command":"str_replace","path":"gone","old_str":"a"}\n{"command":"create","path":"/abs","file_text":""}\n' },
    exit: 1,
    stdout: 'error: missing gone\nerror: unsafe /abs\nfailed: 2 of 3 edits\n',
  },
  {
    name: 'later edit sees an earlier one',
    argv: [P],
    files: { [P]: '{"command":"create","path":"d/n","file_text":"a\\n"}\n{"command":"str_replace","path":"d/n","old_str":"a","new_str":"b"}\n' },
    exit: 0,
    stdout: 'A d/n\nok: 1 file\n',
    after: { 'd/n': 'b\n' },
  },
];

let passed = 0;
for (const c of cases) {
  const got = runCheck({ id: c.name, argv: c.argv, stdin: c.stdin ?? null, files: c.files });
  const want: Record<string, string> = { ...c.files };
  for (const [p, v] of Object.entries(c.after ?? {})) {
    if (v === null) delete want[p];
    else want[p] = v;
  }
  const why: string[] = [];
  if (got.exit !== c.exit) why.push(`exit ${got.exit}, expected ${c.exit}`);
  if (got.stdout !== c.stdout) why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(c.stdout)}`);
  for (const p of new Set([...Object.keys(want), ...Object.keys(got.files)])) {
    if (got.files[p] !== want[p]) why.push(`${p}: got ${JSON.stringify(got.files[p])}, expected ${JSON.stringify(want[p])}`);
  }
  if (why.length === 0) passed += 1;
  else process.stdout.write(`FAIL ${c.name}\n  ${why.join('\n  ')}\n`);
}
process.stdout.write(`${passed} of ${cases.length} edge cases passed\n`);
process.exitCode = passed === cases.length ? 0 : 1;
