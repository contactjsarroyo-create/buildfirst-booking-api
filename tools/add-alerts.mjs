// One-time helper. Run from the repo folder:  node tools\add-alerts.mjs
// Wraps every route in api\ (not api\_lib) with withAlerts so a server error
// sends an email. Safe to run twice: files that are already done are skipped.
import fs from 'fs';
import path from 'path';

const root = path.join(process.cwd(), 'api');
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '_lib' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.js')) files.push(full);
  }
}
walk(root);

let done = 0;
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const rel = path.relative(process.cwd(), f);
  if (raw.includes('withAlerts')) {
    console.log('already done: ' + rel);
    continue;
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const re = /export default async function\s*(\w*)\s*\(/g;
  const hits = raw.match(re) || [];
  if (hits.length !== 1) {
    console.log('SKIPPED (needs a look): ' + rel);
    continue;
  }
  const route = path.basename(f, '.js');
  const depth = path.relative(root, path.dirname(f)) ? '../' : './';
  let out = raw.replace(re, (m, n) => 'async function ' + (n || 'handler') + '(');
  const fn = (/export default async function\s*(\w*)/.exec(raw)[1]) || 'handler';
  out =
    "import { withAlerts } from '" + depth + "_lib/alerts.js';" + eol + out.replace(/\s*$/, eol) +
    eol + "export default withAlerts('" + route + "', " + fn + ');' + eol;
  fs.writeFileSync(f, out);
  console.log('wrapped: ' + rel);
  done += 1;
}
console.log(done + ' file(s) changed. Next: run git status --short, then dir /s /b api (still 12 files outside _lib).');
