// The gh helper — the ONLY module (besides the clipboard) that touches
// child_process. Used by sender operations (share, revoke) and, for GitHub
// Enterprise hosts, by the receive path too: enterprise links are private by
// nature, so they ride the receiver's own gh auth — never anonymous HTTPS.
// execFile with argument arrays only; user input is never interpolated into
// a shell string (hard rule 3).
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError, MSG } from './errors.js';
import { DEFAULT_HOST } from './source.js';

const execFileP = promisify(execFileCb);

// Default runner; tests inject their own to capture or forbid calls.
// opts.binary returns a Buffer (repo tarballs); default is utf8 text.
export async function defaultGhRunner(args, opts = {}) {
  const { stdout } = await execFileP('gh', args, {
    maxBuffer: 96 * 1024 * 1024,
    encoding: opts.binary ? 'buffer' : 'utf8',
  });
  return stdout;
}

// Extra args to aim gh at a GitHub Enterprise host.
export function hostArgs(host) {
  return host && host !== DEFAULT_HOST ? ['--hostname', host] : [];
}

// Run `gh api ...` and map the usual failure modes onto exit-code-2 guidance.
export function makeGhApi(runner = defaultGhRunner) {
  return async function ghApi(args, opts = {}) {
    try {
      return await runner(['api', ...args], opts);
    } catch (err) {
      if (err instanceof CliError) throw err;
      const hostIdx = args.indexOf('--hostname');
      const host = hostIdx !== -1 ? args[hostIdx + 1] : null;
      if (err?.code === 'ENOENT') {
        throw new CliError(host ? enterpriseGhMsg(host) : MSG.ghMissing, 2);
      }
      const stderr = String(err?.stderr ?? '');
      if (/not logged in|authentication|HTTP 401|gh auth login/i.test(stderr)) {
        throw new CliError(host ? enterpriseGhMsg(host) : MSG.ghMissing, 2);
      }
      if (/HTTP 404/.test(stderr)) throw new CliError('GitHub returned 404 for that id.', 1);
      const detail = stderr.trim().split('\n')[0] || err.message;
      throw new CliError(`gh failed: ${detail}`, 1);
    }
  };
}

export function enterpriseGhMsg(host) {
  return (
    `This needs the GitHub CLI authenticated against ${host} (GitHub Enterprise):\n` +
    `  https://cli.github.com, then "gh auth login --hostname ${host}"`
  );
}
