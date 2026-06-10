// The gh helper — the ONLY module (besides the clipboard) that touches
// child_process. Used exclusively by sender operations (share, revoke).
// Receivers never come through here. execFile with argument arrays only;
// user input is never interpolated into a shell string (hard rule 3).
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError, MSG } from './errors.js';

const execFileP = promisify(execFileCb);

// Default runner; tests inject their own to capture or forbid calls.
export async function defaultGhRunner(args) {
  const { stdout } = await execFileP('gh', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// Run `gh api ...` and map the usual failure modes onto exit-code-2 guidance.
export function makeGhApi(runner = defaultGhRunner) {
  return async function ghApi(args) {
    try {
      return await runner(['api', ...args]);
    } catch (err) {
      if (err instanceof CliError) throw err;
      if (err?.code === 'ENOENT') throw new CliError(MSG.ghMissing, 2);
      const stderr = String(err?.stderr ?? '');
      if (/not logged in|authentication|HTTP 401|gh auth login/i.test(stderr)) {
        throw new CliError(MSG.ghMissing, 2);
      }
      if (/HTTP 404/.test(stderr)) throw new CliError('GitHub returned 404 for that id.', 1);
      const detail = stderr.trim().split('\n')[0] || err.message;
      throw new CliError(`gh failed: ${detail}`, 1);
    }
  };
}
