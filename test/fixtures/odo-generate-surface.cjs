const fs = require('node:fs');
const path = require('node:path');

const output = process.argv[2];
if (!output) {
  process.stderr.write('usage: odo-generate-surface.cjs OUTPUT\n');
  process.exit(2);
}
const html = '<!doctype html><html><body><h1>Portable ODO result</h1></body></html>\n';
fs.writeFileSync(output, html);
process.stdout.write(`${JSON.stringify({
  status: 'ok',
  artifact: path.basename(output),
  url: 'https://fixture.test/reports/portable-odo',
})}\n`);
