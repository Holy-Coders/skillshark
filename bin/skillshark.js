#!/usr/bin/env node
// Arg parsing + dispatch. Kept tiny: every behavior lives in src/.
import process from 'node:process';
import os from 'node:os';
import { CliError } from '../src/errors.js';
import { VERSION } from '../src/version.js';
import { getConfigDir } from '../src/config.js';
import { makeUi, realPrompts, attachSpinner } from '../src/ui.js';
import { makeGhApi } from '../src/gh.js';
import { copyToClipboard } from '../src/clipboard.js';
import { runShare, runRevoke, runShares, runPrune } from '../src/share.js';
import { runInstall, runInspect } from '../src/install.js';
import { runInteractive } from '../src/interactive.js';

const HELP = `skillshark — share agent skills like files

USAGE
  skillshark                 interactive session (pick, share, install — guided)
  skillshark <command> [options]

COMMANDS
  share    <path|name>   Package a skill and upload it as an encrypted secret gist
  install  <source>      Download, verify, preview, and install a shared skill
  inspect  <source>      Preview a shared skill without installing anything
  shares   [name|id]     Recall links you've shared — re-copies the one-liner
  revoke   <id|name>     Delete a share you created (deletes the gist)
  prune                  Delete your own shares that are past advisory expiry

SOURCES (install / inspect)
  https://gist.github.com/<id>#fp=<hex>    a SkillShark link
  <gist id>                                bare 20-32 char hex id
  gh:owner/repo[/path][@ref]               any public GitHub repo path

GLOBAL OPTIONS
  -y, --yes        Skip prompts (non-interactive)
  -q, --quiet      Print only the essential result (URL or path)
      --json       Machine-readable output
      --host <h>   GitHub Enterprise hostname (default github.com; also
                   honors GH_HOST). Enterprise links carry their host, so
                   receivers usually don't need this flag.
      --no-color   Disable color (NO_COLOR is also honored)
  -h, --help       Show help (try: skillshark help <command>)
  -V, --version    Show version

ENTERPRISE (privacy)
  skillshark share j --host ghe.corp.com    share on your GHES — never leaves it
  Enterprise links are fetched through YOUR gh auth (gh auth login --hostname
  ghe.corp.com); no anonymous request ever touches an enterprise host.

EXAMPLES
  skillshark                                interactive: menus for everything below
  skillshark share /j                       share the "j" skill (secret gist)
  skillshark install <gist-url|id>          install a shared skill
  skillshark install <link> --name jmp      install under a different name
  skillshark install <link> --agent codex   convert for another tool
  skillshark install gh:acme/skills/review  install straight from a repo path
  skillshark inspect <gist-url> --cat SKILL.md
  skillshark revoke j                       delete the share

AGENTS (share from and install to)
  claude-code (skills, commands) · cursor (rules, commands) · codex (prompts)
  copilot (prompt files) · windsurf (rules, workflows) · gemini (commands)
  opencode (commands). Cross-agent installs convert the instructions to the
  target's dialect; a skill's bundled scripts can't follow it (warned loudly).

Shares are encrypted by default: GitHub stores ciphertext, the only key rides
in the link (#k=). Anyone with the full link can decrypt — treat the link like
the content itself. SkillShark never executes package content; install only
copies files.`;

const COMMAND_HELP = {
  share: `skillshark share <path|name> — package a skill and get a private link

Shares are ENCRYPTED BY DEFAULT (AES-256-GCM): GitHub stores only ciphertext
and a metadata-free stub; the one decryption key rides in the link's #k=
fragment, which lands on your clipboard inside the install one-liner and is
never sent to any server. Anyone with the full link can decrypt — treat the
link like the content itself.

  -e, --expires <dur>   Advisory expiry: 30m | 6h | 24h | 7d | 30d (default 7d)
      --name <name>     Override the inferred name
      --force           Include secret-shaped files the scanner would skip
      --no-encrypt      Plaintext share: the gist page becomes a readable
                        browser preview (SKILL.md + manifest), like a pastebin
      --no-clipboard    Don't copy the one-liner to the clipboard
      --dry-run         Show exactly what would be packaged; upload nothing
  -q, --quiet           Print only the URL (key fragment included)
      --json            Print { id, url, installCommand, encrypted, ... }

Sharing needs an authenticated gh (https://cli.github.com). Undo with
"skillshark revoke <name>".`,
  install: `skillshark install <source> — download, verify, preview, confirm, copy

  -y, --yes             Install without prompting (documented as dangerous)
      --name <name>     Install under a different name (renames the artifact
                        and updates its frontmatter name)
      --agent <id>      Target agent: claude-code | cursor | codex | copilot |
                        windsurf | gemini | opencode. Crossing agents converts
                        the artifact's instructions to the target's dialect —
                        bundled support files can't come along (warned).
      --project         Install at project scope (where the agent supports it)
      --global          Install at user/global scope
      --dir <path>      Install verbatim into an explicit directory (required
                        for bundle packages; skips agent conventions)
      --force           Overwrite an existing, differing artifact
      --allow-exec      Keep executable bits (stripped by default)
  -q, --quiet           Print only the installed path
      --json            Print { name, type, agent, installedPath, ... }

SkillShark never executes anything from a package. Integrity: per-file sha256
+ tree fingerprint, and the #fp= fragment in the link is enforced.`,
  inspect: `skillshark inspect <source> — look before you leap (writes nothing)

      --cat <path>      Print one file from the package
      --files           File listing only
      --json            Machine-readable summary

Inspect downloads and verifies the full package, then shows you ground truth
from checksummed bytes. Expired shares still display (only install refuses).`,
  revoke: `skillshark revoke <id|name> — delete a share you created

  -y, --yes             Skip the confirmation prompt
      --json            Print { revoked: <id> }

Deletes the underlying gist via your gh auth. The link dies immediately.`,
  shares: `skillshark shares [name|id] — recall the links you've shared

  With no argument: list every share recorded on this machine (newest first).
  With a name or gist id: print that share's full link — decryption key
  included — and copy the paste-and-go install one-liner back to the clipboard.

      --no-clipboard    Don't copy the one-liner
  -q, --quiet           Print only the URL(s)
      --json            Machine-readable records

Links (keys included) live in your local config (chmod 600), so only the
machine that created a share can recall it. Lost everywhere? Just share again.`,
  prune: `skillshark prune — delete your own advisory-expired shares

Lists your skillshark gists, keeps only those past their advisory expiry
(read from your local cache, or the gist's own metadata), confirms, and
deletes them. Advisory expiry is the date installers refuse after; the bytes
persist on GitHub until you prune or revoke — this is that cleanup.

  -y, --yes             Skip the confirmation prompt
      --host <h>        Prune on a GitHub Enterprise host
      --json            Print { scanned, expired } then { deleted }`,
};

// flag spec: long name → { short, takesValue, key }
const GLOBAL_FLAGS = {
  yes: { short: 'y', key: 'yes' },
  quiet: { short: 'q', key: 'quiet' },
  json: { key: 'json' },
  host: { takesValue: true, key: 'host' },
  'no-color': { key: 'noColor' },
  help: { short: 'h', key: 'help' },
  version: { short: 'V', key: 'version' },
};
const COMMAND_FLAGS = {
  share: {
    expires: { short: 'e', takesValue: true, key: 'expires' },
    name: { takesValue: true, key: 'name' },
    force: { key: 'force' },
    'no-clipboard': { key: 'noClipboard' },
    'no-encrypt': { key: 'noEncrypt' },
    'dry-run': { key: 'dryRun' },
  },
  install: {
    project: { key: 'project' },
    global: { key: 'global' },
    force: { key: 'force' },
    dir: { takesValue: true, key: 'dir' },
    'allow-exec': { key: 'allowExec' },
    agent: { takesValue: true, key: 'agent' },
    name: { takesValue: true, key: 'name' },
  },
  inspect: {
    cat: { takesValue: true, key: 'cat' },
    files: { key: 'files' },
  },
  revoke: {},
  shares: {
    'no-clipboard': { key: 'noClipboard' },
  },
  prune: {},
};

function parseArgv(argv) {
  const [first, ...rest] = argv;
  if (!first) return { command: 'interactive', opts: {}, positionals: [] };
  if (first === 'help') {
    return { command: 'help', topic: rest[0] ?? null, opts: {}, positionals: [] };
  }
  if (first === '--help' || first === '-h') return { command: 'help', topic: null, opts: {}, positionals: [] };
  if (first === '--version' || first === '-V') return { command: 'version', opts: {}, positionals: [] };
  const command = first;
  const flagDefs = { ...GLOBAL_FLAGS, ...(COMMAND_FLAGS[command] ?? {}) };
  const shorts = {};
  for (const [long, def] of Object.entries(flagDefs)) {
    if (def.short) shorts[def.short] = long;
  }
  const opts = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    let long = null;
    if (tok.startsWith('--')) long = tok.slice(2);
    else if (tok.startsWith('-') && tok.length === 2) long = shorts[tok[1]] ?? null;
    else {
      positionals.push(tok);
      continue;
    }
    let inlineValue = null;
    if (long && long.includes('=')) {
      const eq = long.indexOf('=');
      inlineValue = long.slice(eq + 1);
      long = long.slice(0, eq);
    }
    const def = long ? flagDefs[long] : null;
    if (!def) throw new CliError(`Unknown option "${tok}" for "${command}". Try: skillshark help ${command}`, 2);
    if (def.takesValue) {
      const value = inlineValue ?? rest[++i];
      if (value === undefined) throw new CliError(`Option --${long} needs a value.`, 2);
      opts[def.key] = value;
    } else {
      opts[def.key] = true;
    }
  }
  return { command, opts, positionals };
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const color = parsed.opts.noColor || process.env.NO_COLOR ? false : undefined;
  const ui = makeUi({ color });

  if (parsed.command === 'help') {
    if (parsed.topic && COMMAND_HELP[parsed.topic]) ui.out(COMMAND_HELP[parsed.topic]);
    else ui.out(HELP);
    return 0;
  }
  if (parsed.command === 'version') {
    ui.out(VERSION);
    return 0;
  }
  if (parsed.opts.help) {
    ui.out(COMMAND_HELP[parsed.command] ?? HELP);
    return 0;
  }
  if (parsed.opts.version) {
    ui.out(VERSION);
    return 0;
  }

  const known = new Set(['share', 'install', 'inspect', 'revoke', 'shares', 'prune', 'interactive']);
  if (!known.has(parsed.command)) {
    throw new CliError(`Unknown command "${parsed.command}". Commands: share, install, inspect, shares, revoke, prune. Try: skillshark --help`, 2);
  }
  if (parsed.positionals.length > 1) {
    throw new CliError(`Too many arguments: ${parsed.positionals.slice(1).join(' ')}`, 2);
  }

  // --json is non-interactive by definition (§1.9)
  const effectiveTTY = parsed.opts.json ? false : isTTY;
  const deps = {
    fetch: globalThis.fetch,
    cwd: process.cwd(),
    home: os.homedir(),
    env: process.env,
    isTTY: effectiveTTY,
    configDir: getConfigDir(process.env),
    ui,
    prompts: effectiveTTY ? await realPrompts() : null,
    ghApi: makeGhApi(),
    clipboard: (text) => copyToClipboard(text),
  };
  if (effectiveTTY) await attachSpinner(ui);

  // no command (TTY) → the interactive session; piped → help text
  if (parsed.command === 'interactive') {
    if (!effectiveTTY) {
      ui.out(HELP);
      return 0;
    }
    return runInteractive(deps);
  }

  const arg = parsed.positionals[0];
  if (!arg && parsed.command !== 'shares' && parsed.command !== 'prune') {
    // bare subcommand in a TTY → that command's wizard; piped → usage error
    if (effectiveTTY) return runInteractive(deps, parsed.command);
    const noun = parsed.command === 'share' ? '<path|name>' : parsed.command === 'revoke' ? '<id|name>' : '<source>';
    throw new CliError(`Usage: skillshark ${parsed.command} ${noun}. Try: skillshark help ${parsed.command}`, 2);
  }

  switch (parsed.command) {
    case 'share':
      await runShare(arg, parsed.opts, deps);
      return 0;
    case 'install':
      await runInstall(arg, parsed.opts, deps);
      return 0;
    case 'inspect':
      await runInspect(arg, parsed.opts, deps);
      return 0;
    case 'revoke':
      await runRevoke(arg, parsed.opts, deps);
      return 0;
    case 'shares':
      await runShares(arg ?? null, parsed.opts, deps);
      return 0;
    case 'prune':
      await runPrune(parsed.opts, deps);
      return 0;
    default:
      return 2;
  }
}

try {
  const code = await main();
  process.exit(code);
} catch (err) {
  if (err instanceof CliError) {
    const stream = err.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(`${err.exitCode === 0 ? '' : '✗ '}${err.message}\n`);
    process.exit(err.exitCode);
  }
  process.stderr.write(`Unexpected error: ${err?.stack ?? err}\n`);
  process.exit(1);
}
