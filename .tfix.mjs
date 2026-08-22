import fs from 'node:fs';
const F = 'server/src/piInstaller.test.ts';
let s = fs.readFileSync(F, 'utf8');
const crlf = s.includes(String.fromCharCode(13, 10));
const norm = (t) => (crlf ? t.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10)) : t);

const from = `  const shellProvided = new Set(['PATH', 'HOME', 'IFS', 'PWD', '1', '2', '@', '*', '?', '#', '$', '!', '0']);
  const used = new Set<string>();
  for (const m of ctl.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);`;

const to = `  const shellProvided = new Set(['PATH', 'HOME', 'IFS', 'PWD', '1', '2', '@', '*', '?', '#', '$', '!', '0']);
  const used = new Set<string>();
  // COMMENTS STRIPPED FIRST. This check reads code, and a comment that mentions a variable in order
  // to explain it is not code. It has now flagged a comment four separate times in this project —
  // a note about \`req.destroy()\`, one about \`gpu_mem=128\`, one about NODE_TLS_REJECT_UNAUTHORIZED,
  // and one explaining why \$PRETTY_NAME must NOT be read — and each time the fix was to reword
  // prose to appease a regex, which is backwards: the next person writing an honest comment hits it
  // again. Fixed here instead, once.
  const code = ctl
    .split(String.fromCharCode(10))
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join(String.fromCharCode(10));
  for (const m of code.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);`;

if (!s.includes(norm(from))) { console.error('MISSING'); process.exit(1); }
fs.writeFileSync(F, s.replace(norm(from), norm(to)));
console.log('comments stripped before the variable scan');
