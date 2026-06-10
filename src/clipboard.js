// Clipboard helper — the second of exactly two modules allowed to touch
// child_process. Best effort, never blocks longer than ~500 ms, never fails
// the share: pbcopy → wl-copy → xclip → clip.exe → OSC52 → shrug.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const TIMEOUT_MS = 500;

function tryPipe(cmd, args, text) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout: TIMEOUT_MS }, (err) => resolve(!err));
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(text);
    }
  });
}

function tryOsc52(text) {
  try {
    // works over SSH when the terminal supports it; harmless otherwise
    writeFileSync('/dev/tty', `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
    return true;
  } catch {
    return false;
  }
}

export async function copyToClipboard(text, { platform = process.platform } = {}) {
  const candidates =
    platform === 'darwin'
      ? [['pbcopy', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['clip.exe', []]];
  for (const [cmd, args] of candidates) {
    if (await tryPipe(cmd, args, text)) return true;
  }
  return tryOsc52(text);
}
