// The interactive session: `skillshark` with no arguments (TTY only) drops
// into a guided menu; bare `share`/`install`/`inspect`/`revoke` run their
// wizard one-shot. Built on @clack/prompts — every flow ends in the same
// audited pipelines as the flag-driven CLI; the wizard only collects answers.
import { CliError } from './errors.js';
import { discoverAll } from './discover.js';
import { parseSource } from './source.js';
import { runShare, runRevoke, runShares } from './share.js';
import { runInstall, runInspect } from './install.js';
import { loadConfig } from './config.js';
import { displayPath } from './ui.js';
import { AGENTS } from './agents.js';
import { VERSION } from './version.js';

const FIN = [
  '     |\\',
  '     | \\',
  '  ~~~;~~\\~~~~',
];

async function ux() {
  const clack = await import('@clack/prompts');
  const pc = (await import('picocolors')).default;
  return { clack, pc };
}

function bail(clack, value) {
  return value === null || value === undefined || clack.isCancel(value);
}

// --- share wizard --------------------------------------------------------------

async function wizardShare(deps, { clack, pc }) {
  const found = await deps.ui.spin('Scanning for shareable artifacts', () => discoverAll(deps));
  if (!found.length) {
    clack.log.warn('Nothing shareable here or in your home directory. Create a skill first (e.g. .claude/skills/<name>/SKILL.md).');
    return { status: 'cancelled' };
  }
  const pick = await clack.select({
    message: `Share which artifact? ${pc.dim(`(${found.length} found)`)}`,
    maxItems: 12,
    options: found.map((a) => ({
      value: a.root,
      label: a.name,
      hint: `${AGENTS[a.agent]?.label ?? a.agent} ${a.type} · ${a.scope === 'global' ? '~' : displayPath(a.root, deps)}`,
    })),
  });
  if (bail(clack, pick)) return { status: 'cancelled' };

  const expires = await clack.select({
    message: 'Advisory expiry (installers refuse after this; the gist lives until you revoke):',
    initialValue: '7d',
    options: [
      { value: '30m', label: '30 minutes' },
      { value: '6h', label: '6 hours' },
      { value: '24h', label: '24 hours' },
      { value: '7d', label: '7 days', hint: 'default' },
      { value: '30d', label: '30 days' },
    ],
  });
  if (bail(clack, expires)) return { status: 'cancelled' };

  return runShare(pick, { expires }, deps);
}

// --- install / inspect wizards ----------------------------------------------------

async function askSource(deps, { clack }) {
  for (;;) {
    const source = await clack.text({
      message: 'Paste the link (gist URL, bare id, or gh:owner/repo[/path][@ref]):',
      placeholder: 'https://gist.github.com/…#fp=…',
    });
    if (bail(clack, source)) return null;
    try {
      parseSource(String(source).trim());
      return String(source).trim();
    } catch (err) {
      if (err instanceof CliError) {
        clack.log.error(err.message);
        continue;
      }
      throw err;
    }
  }
}

async function wizardInstall(deps, u) {
  const source = await askSource(deps, u);
  if (source === null) return { status: 'cancelled' };
  // runInstall itself offers "read it first?" interactively, so just hand off.
  return runInstall(source, {}, deps);
}

async function wizardInspect(deps, u) {
  const { clack } = u;
  const source = await askSource(deps, u);
  if (source === null) return { status: 'cancelled' };
  await runInspect(source, {}, deps);
  for (;;) {
    const next = await clack.select({
      message: 'And now?',
      options: [
        { value: 'preview', label: 'Preview the markdown', hint: 'read SKILL.md in the terminal' },
        { value: 'install', label: 'Install it' },
        { value: 'done', label: 'Done' },
      ],
    });
    if (bail(clack, next) || next === 'done') return { status: 'inspected' };
    if (next === 'install') return runInstall(source, {}, deps);
    await runInspect(source, { preview: true }, deps); // preview, then ask again
  }
}

// --- my-shares wizard ----------------------------------------------------------------

async function wizardShares(deps, { clack }) {
  const cfg = await loadConfig(deps.configDir);
  if (!cfg.shares.length) {
    clack.log.warn('No shares recorded on this machine yet.');
    return { status: 'listed' };
  }
  const pick = await clack.select({
    message: 'Which share?',
    maxItems: 12,
    options: cfg.shares.map((s) => ({
      value: s.id,
      label: s.name,
      hint: `${s.encrypted === false ? 'plain' : 'encrypted'} · ${(s.createdAt ?? '').slice(0, 10) || s.id.slice(0, 8)}${s.host ? ` · ${s.host}` : ''}`,
    })),
  });
  if (bail(clack, pick)) return { status: 'cancelled' };
  const result = await runShares(pick, {}, deps);
  const next = await clack.select({
    message: 'And now?',
    options: [
      { value: 'done', label: 'Done', hint: 'the one-liner is on your clipboard' },
      { value: 'revoke', label: 'Revoke it', hint: 'delete the gist — the link dies' },
    ],
  });
  if (!bail(clack, next) && next === 'revoke') {
    return runRevoke(result.id, {}, deps);
  }
  return result;
}

// --- revoke wizard -----------------------------------------------------------------

async function wizardRevoke(deps, { clack, pc }) {
  const cfg = await loadConfig(deps.configDir);
  let idOrName = null;
  if (cfg.shares.length) {
    const pick = await clack.select({
      message: 'Revoke which share?',
      maxItems: 12,
      options: [
        ...cfg.shares.map((s) => ({
          value: s.id,
          label: s.name,
          hint: `${s.id.slice(0, 12)}… · expires ${s.expiresAt ? s.expiresAt.slice(0, 10) : 'never'}`,
        })),
        { value: '__manual', label: 'Enter a gist id or name…' },
      ],
    });
    if (bail(clack, pick)) return { status: 'cancelled' };
    idOrName = pick === '__manual' ? null : pick;
  }
  if (idOrName === null) {
    const entered = await clack.text({ message: 'Gist id (or share name):' });
    if (bail(clack, entered) || !String(entered).trim()) return { status: 'cancelled' };
    idOrName = String(entered).trim();
  }
  clack.log.warn(pc.yellow('Revoking deletes the gist — anyone holding the link loses access immediately.'));
  return runRevoke(idOrName, {}, deps);
}

// --- the session --------------------------------------------------------------------

const WIZARDS = {
  share: wizardShare,
  install: wizardInstall,
  inspect: wizardInspect,
  shares: wizardShares,
  revoke: wizardRevoke,
};

// action: run a single wizard (bare `skillshark share` etc.); null: full menu.
export async function runInteractive(deps, action = null) {
  const u = await ux();
  const { clack, pc } = u;

  clack.intro(`${pc.cyan(FIN.join('\n   '))}\n   ${pc.bold('skillshark')} ${pc.dim(`v${VERSION} — share agent skills like files`)}`);

  if (action) {
    const result = await WIZARDS[action](deps, u);
    clack.outro(outroFor(action, result));
    return 0;
  }

  for (;;) {
    const choice = await clack.select({
      message: 'What are we doing?',
      options: [
        { value: 'share', label: 'Share', hint: 'package a local skill → encrypted link' },
        { value: 'install', label: 'Install', hint: 'from a link or repo path' },
        { value: 'inspect', label: 'Inspect', hint: 'look before you leap' },
        { value: 'shares', label: 'My shares', hint: 'recall a link you already made' },
        { value: 'revoke', label: 'Revoke', hint: 'kill a link you shared' },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (bail(clack, choice) || choice === 'quit') break;
    try {
      const result = await WIZARDS[choice](deps, u);
      // Sharing ends with a fresh link on your clipboard — a natural stopping
      // point, so confirm and exit instead of looping back to the menu.
      if (choice === 'share' && result?.status === 'shared') {
        clack.outro(outroFor('share', result));
        return 0;
      }
    } catch (err) {
      if (err instanceof CliError) {
        clack.log.error(err.message);
      } else {
        throw err;
      }
    }
    clack.log.message('');
  }
  clack.outro('Swim safe. 🦈');
  return 0;
}

function outroFor(action, result) {
  if (result?.status === 'cancelled') return 'Nothing happened. 🦈';
  if (action === 'share' && result?.status === 'shared') {
    return result.copied
      ? 'Install one-liner copied to your clipboard — paste it to share. 🦈'
      : 'Share ready — copy the link above. 🦈';
  }
  return 'Done. 🦈';
}
