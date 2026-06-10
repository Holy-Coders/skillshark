// Terminal output + interactive prompts. Glyphs and color are decoration,
// never information — everything must read fine on a dumb pipe.
import pc from 'picocolors';
import path from 'node:path';
import os from 'node:os';
import { formatFp8 } from './fingerprint.js';

export function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Show a path the way the user thinks of it: relative inside cwd, ~ for home.
export function displayPath(p, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const abs = path.resolve(p);
  if (abs === cwd) return '.';
  if (abs.startsWith(cwd + path.sep)) return path.relative(cwd, abs);
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep)) return `~${path.sep}${path.relative(home, abs)}`;
  return abs;
}

export function makeUi({ stdout = process.stdout, stderr = process.stderr, color = undefined } = {}) {
  const enabled = color ?? (Boolean(stdout.isTTY) && !process.env.NO_COLOR);
  const c = pc.createColors(enabled);
  const write = (stream, s) => stream.write(s + '\n');
  return {
    colors: c,
    out: (s = '') => write(stdout, s),
    raw: (s) => stdout.write(s),
    err: (s = '') => write(stderr, s),
    ok: (s) => write(stdout, `  ${c.green('✓')} ${s}`),
    warn: (s) => write(stdout, `  ${c.yellow('⚠')} ${s}`),
    info: (s) => write(stdout, `  ${c.cyan('ⓘ')} ${s}`),
    fail: (s) => write(stderr, `  ${c.red('✗')} ${s}`),
  };
}

// The install/inspect preview, rendered only from verified bytes (§4.2 step 5).
export function renderPreview(ui, { manifest, fingerprint, fpFromLink, externalRefs }) {
  const c = ui.colors;
  const typeLabel = manifest.type.charAt(0).toUpperCase() + manifest.type.slice(1);
  ui.out(`  ${typeLabel}:  ${c.bold(manifest.name)}`);
  ui.out(`  Type:   ${manifest.type.padEnd(14)} Agent: ${manifest.agent || '—'}`);
  ui.out(`  Size:   ${humanSize(manifest.totalSize ?? manifest.files.reduce((n, f) => n + (f.size ?? 0), 0)).padEnd(14)} Files: ${manifest.files.length}`);
  let fpLine = `  Fingerprint: ${formatFp8(fingerprint)}`;
  if (fpFromLink) fpLine += `  ${c.green('✓')} matches #fp in the link`;
  ui.out(fpLine);
  if (manifest.description) ui.out(`  ${c.dim(manifest.description)}`);
  ui.out('');
  renderFileTree(ui, manifest);
  ui.out('');
  const execs = manifest.files.filter((f) => f.executable);
  if (execs.length) {
    ui.warn(`${plural(execs.length, 'executable script')}: ${execs.map((f) => f.path).join(', ')}`);
    ui.out('    SkillShark will not run them and will install them without the executable');
    ui.out('    bit (re-run with --allow-exec to keep it).');
  }
  if (externalRefs?.length) {
    ui.warn(`references files outside the package (may not work standalone): ${externalRefs.join(', ')}`);
  }
  if (Array.isArray(manifest.dependencies) && manifest.dependencies.length) {
    ui.info(`declares dependencies (informational only, never auto-installed): ${JSON.stringify(manifest.dependencies)}`);
  }
}

export function renderFileTree(ui, manifest) {
  const c = ui.colors;
  ui.out(`    ${c.bold(manifest.name)}/`);
  const files = manifest.files;
  const width = Math.max(...files.map((f) => f.path.length)) + 3;
  files.forEach((f, i) => {
    const glyph = i === files.length - 1 ? '└──' : '├──';
    const exec = f.executable ? `   ${c.yellow('(executable)')}` : '';
    ui.out(`    ${glyph} ${f.path.padEnd(width)}${humanSize(f.size ?? 0)}${exec}`);
  });
}

// Interactive prompt seam — the install pipeline calls deps.prompts.* so tests
// can stub it; this is the real @clack implementation, loaded lazily so the
// receive path in non-TTY/CI never even imports it.
export async function realPrompts() {
  const clack = await import('@clack/prompts');
  return {
    async select({ message, options }) {
      const value = await clack.select({
        message,
        options: options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
      });
      if (clack.isCancel(value)) return null;
      return value;
    },
    async confirm({ message }) {
      const value = await clack.confirm({ message });
      if (clack.isCancel(value)) return null;
      return value;
    },
  };
}
