// Exit codes (hard rule 6):
//   0 — success or benign no-op
//   1 — runtime/remote failure (expired, deleted, integrity, network)
//   2 — usage/local error (bad args, not found, gh missing, too large)
export class CliError extends Error {
  constructor(message, exitCode = 1, details = undefined) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }
}

export const MSG = {
  ghMissing:
    'Sharing needs the GitHub CLI: https://cli.github.com, then "gh auth login". (Receivers don\'t need gh for public links.)',
  gistDeleted: 'This share was deleted by the sender (gist not found).',
  downloadIntegrity: 'Download failed integrity check. Did not install anything.',
  linkIntegrity:
    'Link integrity check failed — this share changed since the link was made, or the link was altered. Nothing was installed.',
};
