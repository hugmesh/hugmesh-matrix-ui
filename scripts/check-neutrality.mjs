#!/usr/bin/env node
// Neutrality guard: this repository is public, so no file in it may name a
// deployment-private brand, organisation or domain. Placeholders only
// (mesh.example, exampleorg). A pre-rebrand brand that live rooms still carry
// is injected at runtime instead (see projects/matrix/src/app/legacy-read.ts).
//
// The forbidden stem is assembled from PARTS so this file does not spell it
// (this file is checked too). It is one short stem: a substring check on it
// catches every longer spelling (the domain, the organisation slug), so the
// longer spellings are deliberately not written here. Extra private strings
// can be supplied from OUTSIDE the repository: set HUGMESH_PRIVATE_NAMES to a
// file with one string per line (# starts a comment).
//
// Every file git knows about (tracked, plus new files not ignored) is read as
// raw bytes and compared case-insensitively, so a NUL byte or a binary file
// cannot hide a match the way it does from grep.
//
// Exit 0 = clean, 1 = a forbidden string was found, 2 = the check could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? process.cwd();
const forbidden = ['snap' + 'dragon'];

const extra = process.env.HUGMESH_PRIVATE_NAMES?.trim();
if (extra) {
  try {
    for (const line of readFileSync(extra, 'utf8').split('\n')) {
      const s = line.trim().toLowerCase();
      if (s && !s.startsWith('#')) forbidden.push(s);
    }
  } catch (err) {
    console.error(`check-neutrality: cannot read HUGMESH_PRIVATE_NAMES (${err.message})`);
    process.exit(2);
  }
}

let files;
try {
  files = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
} catch (err) {
  console.error(`check-neutrality: git ls-files failed in ${root} (${err.message})`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`check-neutrality: no files found under ${root}; refusing to pass an empty check`);
  process.exit(2);
}

const needles = forbidden.map((s) => Buffer.from(s, 'utf8'));
const hits = [];
let scanned = 0;
for (const rel of files) {
  const path = join(root, rel);
  let st;
  try { st = statSync(path); } catch { continue; } // deleted in the work tree
  if (!st.isFile()) continue;
  const lower = Buffer.from(readFileSync(path));
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i];
    if (c >= 0x41 && c <= 0x5a) lower[i] = c + 0x20; // ASCII lower-case, byte-wise
  }
  scanned++;
  needles.forEach((n, k) => {
    if (lower.indexOf(n) !== -1) hits.push(`${rel}: contains forbidden string #${k + 1}`);
  });
}

if (hits.length) {
  console.error('check-neutrality: FAILED, a private name is in the tree:');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-neutrality: OK (${scanned} files, ${forbidden.length} forbidden string(s))`);
