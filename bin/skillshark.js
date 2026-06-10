#!/usr/bin/env node
// Arg parsing + dispatch. Kept tiny: every behavior lives in src/.
import process from 'node:process';
import os from 'node:os';
import { CliError } from '../src/errors.js';
import { VERSION } from '../src/version.js';
import { getConfigDir } from '../src/config.js';
import { makeUi, realPrompts } from '../src/ui.js';
import { makeGhApi } from '../src/gh.js';
import { copyToClipboard } from '../src/clipboard.js';
import { runShare, runRevoke } from '../src/share.js';
import { runInstall, runInspect } from '../src/install.js';

const HELP = `skillshark — share agent skills like files

USAGE
  skillshark <command> [options]

COMMANDS
  share    <path|name>   Package a skill and upload it as a secret gist
  install  <source>      Download, verify, preview, and install a shared skill
  inspect  <source>      Preview a shared skill without installing anything
  revoke   <id|name>     Delete a share you created (deletes the gist)

SOURCES (install / inspect)
  https://gist.github.com/<id>#fp=<hex>    a SkillShark link
  <gist id>                                bare 20-32 char hex id
  gh:owner/repo[/path][@ref]               any public GitHub repo path

GLOBAL OPTIONS
  -y, --yes        Skip prompts (non-interactive)
  -q, --quiet      Print only the essential result (URL or path)
      --json       Machine-readable output
      --no-color   Disable color (NO_COLOR is also honored)
  -h, --help       Show help (try: skillshark help <command>)
  -V, --version    Show version

EXAMPLES
  skillshark share /j                       share the "j" skill (secret gist)
  skillshark install <gist-url|id>          install a shared skill
  skillshark install gh:acme/skills/review  install straight from a repo path
  skillshark inspect <gist-url> --cat SKILL.md
  skillshark revoke j                       delete the share

Secret gists are unlisted, NOT private — anyone with the link can read them.
SkillShark never executes package content; install only copies files.`;

const COMMAND_HELP = {
  share: `skillshark share <path|name> — package a skill and get an unlisted link

  -e, --expires <dur>   Advisory expiry: 30m | 6h | 24h | 7d | 30d (default 7d)
      --name <name>     Override the inferred name
      --force           Include secret-shaped files the scanner would skip
      --no-clipboard    Don't copy the link to the clipboard
      --dry-run         Show exactly what would be packaged; upload nothing
  -q, --quiet           Print only the URL
      --json            Print { id, url, revision, expiresAt, fingerprint, size, files }

Sharing needs an authenticated gh (https://cli.github.com). The link is
unlisted, not private: anyone holding it can read the gist. Undo with
"skillshark revoke <name>".`,
  install: `skillshark install <source> — download, verify, preview, confirm, copy

  -y, --yes             Install without prompting (documented as dangerous)
      --project         Install into ./.claude/... (default when cwd is a project)
      --global          Install into ~/.claude/... (all projects)
      --dir <path>      Install into an explicit directory (required for
                        prompt/bundle packages; overrides agent detection)
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
};

// flag spec: long name → { short, takesValue, key }
const GLOBAL_FLAGS = {
  yes: { short: 'y', key: 'yes' },
  quiet: { short: 'q', key: 'quiet' },
  json: { key: 'json' },
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
    'dry-run': { key: 'dryRun' },
  },
  install: {
    project: { key: 'project' },
    global: { key: 'global' },
    force: { key: 'force' },
    dir: { takesValue: true, key: 'dir' },
    'allow-exec': { key: 'allowExec' },
    agent: { takesValue: true, key: 'agent' },
  },
  inspect: {
    cat: { takesValue: true, key: 'cat' },
    files: { key: 'files' },
  },
  revoke: {},
};

function parseArgv(argv) {
  const [first, ...rest] = argv;
  if (!first || first === 'help') {
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

  const known = new Set(['share', 'install', 'inspect', 'revoke']);
  if (!known.has(parsed.command)) {
    throw new CliError(`Unknown command "${parsed.command}". Commands: share, install, inspect, revoke. Try: skillshark --help`, 2);
  }
  if (parsed.opts.agent && parsed.opts.agent !== 'claude-code') {
    throw new CliError(`Only --agent claude-code is supported in v0.1 (got "${parsed.opts.agent}").`, 2);
  }

  const arg = parsed.positionals[0];
  if (!arg) {
    const noun = parsed.command === 'share' ? '<path|name>' : parsed.command === 'revoke' ? '<id|name>' : '<source>';
    throw new CliError(`Usage: skillshark ${parsed.command} ${noun}. Try: skillshark help ${parsed.command}`, 2);
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
