import fs from 'node:fs';
import path from 'node:path';
const found = [];
function check(p) {
  const b = fs.readFileSync(p);
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) found.push(p + ' BOM');
  const s = b.toString('utf8');
  if (s.includes('�')) found.push(p + ' U+FFFD');
}
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|json|md|html|css)$/.test(e.name)) check(p);
  }
}
if (fs.existsSync('src')) walk('src');
if (fs.existsSync('test')) walk('test');
if (fs.existsSync('public')) walk('public');
check('package.json');
console.log(found.length ? found.join('\n') : 'clean');
