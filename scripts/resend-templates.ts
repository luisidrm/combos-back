// The emails as Resend templates. Two commands (see docs/EMAIL-TEMPLATES.md):
//
//   npm run emails:export            writes email-templates/<alias>.html (+ templates.json) to import BY HAND in the dashboard
//   npm run emails:push              uploads every template through the API and publishes it (safe to run again: updates)
//   npm run emails:push -- --dry-run     shows what it would do, sends nothing
//   npm run emails:push -- --only=order-paid     only the templates whose alias contains that text
//
// `push` needs RESEND_API_KEY (from .env, or on the command line). It is meant to be run from your own computer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildResendTemplates, type ResendTemplateDef } from '../src/modules/notifications/notifications.resend-templates.js';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env here: the key may come from the command line.
}

const API = 'https://api.resend.com';
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--')) ?? 'export';
const dryRun = args.includes('--dry-run');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const templates = buildResendTemplates().filter((t) => !only || t.alias.includes(only));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function exportFiles(): void {
  const dir = join(process.cwd(), 'email-templates');
  mkdirSync(dir, { recursive: true });
  for (const t of templates) writeFileSync(join(dir, `${t.alias}.html`), t.html);
  writeFileSync(join(dir, 'templates.json'), JSON.stringify(templates, null, 2));
  const rows = templates
    .map((t) => `<tr><td><code>${t.alias}</code></td><td>${t.name}</td><td>${t.variables.map((v) => `<code>${v.key}</code>${v.fallback_value ? ` (default: ${v.fallback_value})` : ''}`).join(', ')}</td></tr>`)
    .join('\n');
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Resend templates</title><body style="font-family:system-ui;margin:32px"><h1>Resend templates (${templates.length})</h1><p>Import each <code>.html</code> into Resend and add the listed variables. See docs/EMAIL-TEMPLATES.md.</p><table cellpadding="8" border="1" style="border-collapse:collapse">${rows}</table></body>`,
  );
  console.log(`Wrote ${templates.length} templates to ${dir}`);
}

// One request, politely: Resend allows about 2 a second, and answers 429 (with retry-after) beyond that.
async function call(key: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(600);
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
      continue;
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  throw new Error(`Resend kept answering 429 for ${method} ${path}`);
}

const problem = (json: unknown): string => (json && typeof json === 'object' && 'message' in json ? String((json as { message: unknown }).message) : JSON.stringify(json));

async function push(): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key && !dryRun) throw new Error('Set RESEND_API_KEY (in .env, or on the command line).');
  let created = 0;
  let updated = 0;
  const failed: string[] = [];

  for (const t of templates) {
    const body = { name: t.name, subject: t.subject, html: t.html, variables: t.variables };
    if (dryRun || !key) {
      console.log(`[dry run] would create or update ${t.alias} (${t.variables.length} variables) and publish it`);
      continue;
    }
    try {
      const existing = await call(key, 'GET', `/templates/${t.alias}`);
      let step;
      if (existing.status === 200) {
        step = await call(key, 'PATCH', `/templates/${t.alias}`, body);
        if (step.status < 300) updated += 1;
      } else {
        step = await call(key, 'POST', '/templates', { alias: t.alias, ...body });
        if (step.status < 300) created += 1;
      }
      if (step.status >= 300) throw new Error(`${existing.status === 200 ? 'update' : 'create'}: ${problem(step.json)}`);
      // An update leaves the changes as an unpublished version, so every run publishes.
      const published = await call(key, 'POST', `/templates/${t.alias}/publish`);
      if (published.status >= 300) throw new Error(`publish: ${problem(published.json)}`);
      console.log(`ok   ${t.alias}`);
    } catch (err) {
      failed.push(t.alias);
      console.log(`FAIL ${t.alias}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!dryRun && key) console.log(`\nCreated ${created}, updated ${updated}, failed ${failed.length}.`);
  if (failed.length > 0) process.exitCode = 1;
}

if (command === 'export') exportFiles();
else if (command === 'push') await push();
else console.log('Usage: npm run emails:export | npm run emails:push [-- --dry-run] [-- --only=text]');

export type { ResendTemplateDef };
