/* global process, console, setTimeout */
// `npm run dev`: the API and the worker together, each restarting on change.
//
// They are two processes on purpose (CLAUDE.md section 3), but starting only one is a trap: without the
// worker, pictures never leave "Processing" and no email goes out, and nothing says why. In production they
// are separate containers; in development this keeps them from being forgotten. `npm run dev:api` and
// `npm run worker:dev` still start one each.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const services = [
  { name: 'api', color: '\x1b[36m', entry: 'src/main.ts' },
  { name: 'worker', color: '\x1b[35m', entry: 'src/worker.ts' },
];

const children = services.map(({ name, color, entry }) => {
  const child = spawn(process.execPath, [tsx, 'watch', entry], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `${color}[${name}]\x1b[0m `;
  const forward = (stream, out) => {
    let pending = '';
    stream.on('data', (chunk) => {
      const lines = (pending + chunk.toString()).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${tag}stopped (code ${code})`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
