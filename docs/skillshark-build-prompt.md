# Build SkillShark v0.1 — instructions for Claude Code

You are building **SkillShark**: a CLI that shares Claude Code skills as secret GitHub gists and installs them safely. Sender needs an authenticated `gh`; receivers need nothing for public links. There is **no server** — GitHub is the entire backend.

Build it end-to-end in this session. You are not done until the **Definition of Done** at the bottom is fully green, including a real network round trip.

If `skillshark-spec.md` is present in this repo, read it for background and rationale. **This document is authoritative for v0.1 scope** — where they conflict, this wins.

---

## 0. Pass criteria, up front

You will know you are done when ALL of these hold:

1. `npm test` — green. Unit + integration suite, offline, including every security case in §8.
2. `npm run acceptance` — prints `ACCEPTANCE PASSED`. A real end-to-end run: share → real secret gist → install → tamper-detect → revoke → install fails. Cleans up after itself.
3. Receive path provably never invokes `gh` for public sources (enforced by a test, not by promise).
4. A final live demo: you run `share` on a sample skill, leave that gist **alive**, and print its URL so I can immediately run `skillshark install <url>` on another machine.
5. README.md exists and is accurate enough to onboard a stranger.

Everything else in this document exists to make those five true.

---

## 1. Preflight (do this first)

Run and report:

```
node --version          # must be >= 20
gh --version
gh auth status          # must succeed
gh api user -q .login   # capture login for later assertions
```

If `gh` is missing or unauthenticated, **stop and tell me** — the acceptance tests cannot run without it. Do not mock your way past this.

---

## 2. Hard rules — violating any one means the build has failed

1. **Never execute, eval, source, or import any content from a package.** Install = copy files. No postinstall hooks, no scripts, ever.
2. **Never write outside the previewed target path** (or explicit `--dir`). Stage in a sibling temp dir, then rename. An aborted install leaves **zero** trace — partial state is a bug.
3. **Never interpolate user input into a shell string.** `execFile` with argument arrays only.
4. **Never read, store, or handle GitHub tokens.** `gh` owns auth for sender operations; receivers use anonymous `fetch`.
5. **Any interactive prompt when `!process.stdout.isTTY` is a bug** — exit 2 with guidance instead of hanging.
6. **Exit codes:** `0` success or benign no-op · `1` runtime/remote failure (expired, deleted, integrity, network) · `2` usage/local error (bad args, not found, gh missing, too large).

---

## 3. Tech constraints

- Node ≥ 20, **ESM, plain JavaScript, no build step.** Single package: `"bin": { "skillshark": "./bin/skillshark.js" }`, `"engines": { "node": ">=20" }`, version `0.1.0`.
- **Allowed dependencies:** `tar`, `@clack/prompts`, `picocolors`. Everything else is built-in (`node:crypto`, `node:test`, global `fetch`, `node:child_process`). Ask before adding anything else.
- **Clipboard:** shell out — `pbcopy` (darwin) → `wl-copy`/`xclip` (linux) → `clip.exe` (WSL) → OSC52 to `/dev/tty` → give up with a one-line warning. Must never block longer than ~500 ms. No clipboard dependency.
- **`gh` interaction:** only via `execFile("gh", [...])`. Used exclusively by `share` and `revoke`.
- **Distribution for v0.1:** `npm link` / `npx .` from the checkout. Do **not** attempt `npm publish` (the name may be taken; not your problem today).
- Config dir: `$SKILLSHARK_CONFIG_DIR` if set, else `~/.config/skillshark/`. (The env override exists so tests never touch my real config.)
- macOS/Linux are the targets. Don't gratuitously break Windows, but don't test it.

---

## 4. Commands in scope (and nothing else)

`share`, `install`, `inspect`, `revoke`. Global flags: `-y/--yes`, `-q/--quiet`, `--json`, `--no-color` (also honor `NO_COLOR`), `-h/--help`, `-V/--version`.

### 4.1 `skillshark share <path|name>`

**Resolve the argument.** An existing path wins. Otherwise treat it as a name (strip one leading `/`), searched in order: `./.claude/skills/<name>/` → `./.claude/commands/<name>.md` → `~/.claude/skills/<name>/` → `~/.claude/commands/<name>.md`. Multiple hits: TTY → picker; non-TTY → exit 2 listing the matches. No hit: exit 2, suggest nearest names.

**Infer metadata.** `name`: frontmatter `name:` → else basename (`--name` overrides). `type`: `skill` or `command` from location; explicit path with no convention → `prompt` (single file) or `bundle` (directory). `agent`: `claude-code` (or empty for prompt/bundle). `description`: frontmatter `description:` → first `#` heading or paragraph → `""`.

**Excludes.** Never package: `.git/`, `node_modules/`, `.DS_Store`, `*.log`, `.env`, `.env.*`. Secret-shaped files (`*.pem`, `id_rsa*`, `*token*`, `*secret*`): skip with a ⚠ warning; `--force` includes them. Skip symlinks with a warning. Empty package → exit 2.

**Build the package.** tar.gz containing the files plus `skillshark.json` at the archive root:

```json
{
  "skillshark": "2",
  "name": "j", "type": "skill", "agent": "claude-code",
  "description": "…",
  "files": [{ "path": "SKILL.md", "size": 1132, "sha256": "…", "mode": "0644", "executable": false }],
  "totalSize": 1822,
  "createdAt": "<ISO now>", "expiresAt": "<ISO now + --expires>",
  "tool": { "name": "skillshark", "version": "0.1.0" },
  "dependencies": [],
  "fingerprint": "<see §7.1>"
}
```

`--expires` accepts exactly `30m|6h|24h|7d|30d` (default `7d`); anything else → exit 2. Encoded payload > 5 MB → exit 2 with: `That's <size> (gist limit ~5 MB). Put it in a repo and share gh:owner/repo/path instead.`

**Upload.** One `gh api gists --method POST --input <tmp.json>` call (JSON body avoids escaping pain): `"public": false`, `"description": "skillshark: <name> (<agent> <type>) · fp <fp8>"`, files: `SKILLSHARK.json` (the manifest, verbatim), the primary doc verbatim if one exists (`SKILL.md`, else the single `.md`), and `package.tgz.b64` (base64 of the tarball). Capture gist `id` and `history[0].version`; append `{id, name, revision, expiresAt}` to `shares[]` in config.

**Output.** Canonical link `https://gist.github.com/<id>#fp=<fp8>` → clipboard (unless `--no-clipboard`). `-q` prints **only** the URL. `--json` prints `{ id, url, revision, expiresAt, fingerprint, size, files }`. `--dry-run` prints the file list, sizes, and fingerprint; uploads nothing. Golden transcript:

```
$ skillshark share /j
  Found skill "j" (claude-code) at .claude/skills/j — 3 files, 1.8 KB
  ⚠ Skipped .env (secret pattern) — pass --force to include

  ✓ Uploaded as a secret gist (unlisted — anyone with the link can read it)
  ✓ Link copied to clipboard · advisory expiry in 7 days

  https://gist.github.com/8a1bc94ef23d4b6a9c01e57f8d2a4b3c#fp=3f9a7c21

  They run:   skillshark install <the link>     (no GitHub account needed)
  Undo:       skillshark revoke j               (deletes the gist)
```

### 4.2 `skillshark install <source>`

**Sources:** a gist URL (`gist.github.com/[user/]<id>`, optional `#fp=<hex>`) · a bare hex gist id (20–32 chars) · `gh:owner/repo[/sub/path][@ref]`.

**Gist fetch (anonymous — never via gh):** `GET https://api.github.com/gists/<id>` with `Accept: application/vnd.github+json`. If `files["package.tgz.b64"].truncated` → fetch its `raw_url`. HTTP 404 → exit 1: `This share was deleted by the sender (gist not found).` Base64-decode → tarball. Sender login from `owner.login` for display.

**Repo fetch (anonymous for public):** resolve ref — `@ref` given, else `GET /repos/:o/:r` → `default_branch`; resolve to a commit SHA via `GET /repos/:o/:r/commits/<ref>` (record it). Download `https://codeload.github.com/:o/:r/tar.gz/<sha>` (stream cap 50 MB). Extract only the subtree at `path`. No manifest exists, so run the same inference as share-side on the extracted tree and synthesize one in memory (hashes + fingerprint computed locally). `#fp=` doesn't apply here; the SHA is the integrity.

**Pipeline — implement exactly in this order:**

1. Fetch (caps: 5 MB gist payload, 50 MB repo tarball).
2. Extract to a temp dir with guards (§7.2). Any violation aborts the whole install.
3. Verify per-file sha256 against the manifest → mismatch aborts. Compute tree fingerprint. If the link carried `#fp=` and it doesn't match → abort with: `Link integrity check failed — this share changed since the link was made, or the link was altered. Nothing was installed.`
4. If `expiresAt` is past → exit 1: `The sender marked this share as expired <n> days ago.` / `The files still exist until they prune — ask for a fresh link:  skillshark share <name>`
5. PREVIEW from the verified bytes (never from gist-page copies): name, type, agent, file tree with sizes, ⚠ each executable (`will be installed without the executable bit — re-run with --allow-exec to keep it`), ⚠ external refs (any `../` path mentioned in packaged `.md` files).
6. Target: `claude-code` → `.claude/skills/<name>` or `.claude/commands/<name>.md` per type. Project scope if cwd has `.claude/` or `.git`, else global (`~/.claude/...`). TTY → scope picker (project / global / cancel). `--yes` → project if detectable, else require `--project`/`--global`/`--dir`. `--dir <path>` overrides everything (and is the only target for `prompt`/`bundle` types).
7. Conflict: target exists → identical fingerprint: `ⓘ "<name>" is already installed at <path> and is identical (<fp8>). Nothing to do.` exit 0. Differs → show added/changed/removed summary; TTY options: Overwrite / Install as `<name>-2` / Show diff / Cancel. Non-TTY without `--force` → exit 1.
8. Confirm (skipped by `--yes`).
9. Atomic write: stage in a sibling temp dir (same filesystem), strip exec bits unless `--allow-exec`, single rename into place.
10. Record in `installs.json`: `{ name, agent, path, fingerprint, installedAt, source }` where source is `gist:<id>@<revision>` or `gh:o/r/path@<sha>`.
11. Print the installed path + `restart the session to pick it up`.

### 4.3 `skillshark inspect <source>`

Same fetch + verify as install; writes nothing. Summary line: `Skill: <name> · <agent> · <n> files · <size> · shared by @<login> · advisory expiry in <n>d · Fingerprint <fp8>` plus `✓ matches the link` when `#fp=` verified. Inspect **does** display expired shares (with the expiry notice) — only install refuses. Flags: `--cat <path>` (print one packaged file), `--files`, `--json`.

### 4.4 `skillshark revoke <id|name>`

Name → look up in `shares[]` cache; miss → `gh api gists --paginate` filtered on description prefix `skillshark: `. Confirm in TTY (skip with `-y`). `gh api -X DELETE gists/<id>`. Remove from cache. If `gh` is missing/unauthed (here or in share): exit 2 with: `Sharing needs the GitHub CLI: https://cli.github.com, then "gh auth login". (Receivers don't need gh for public links.)`

---

## 5. Suggested layout (adapt freely; behavior is what's graded)

```
bin/skillshark.js        arg parsing + dispatch (tiny)
src/discover.js          name resolution + metadata inference
src/pkg.js               build / extract / verify (the security core)
src/fingerprint.js       tree fingerprint (§7.1)
src/transports/gist.js   share via gh, fetch via anonymous API
src/transports/repo.js   gh: source parsing, codeload fetch, subtree
src/install.js           the §4.2 pipeline
src/ui.js                prompts, preview rendering, colors
src/config.js            config dir, shares cache, install records
test/*.test.js           node:test
test/fixtures/           crafted tarballs + recorded API JSON
scripts/acceptance.sh    the real-network E2E
```

npm scripts: `"test": "node --test test/"`, `"acceptance": "bash scripts/acceptance.sh"`.

---

## 6. Build order (work this way)

1. Scaffold package + arg dispatch + `--help`.
2. **Security core first, with its tests:** `fingerprint.js` and `pkg.js` (build/extract/verify). Do not write a single transport line until §8 cases 1–8 are green. Note: `node-tar` has built-in protections — do **not** rely on them; implement your own entry filter (path normalization, type rejection) and a decompressed-byte counter on top.
3. Discovery + inference, with tests.
4. Gist transport, repo transport (integration tests on recorded fixtures, exec-spy test).
5. Install pipeline + conflict flow + atomic write.
6. `inspect`, `revoke`, UI polish, README.
7. Acceptance script; run it for real; fix until `ACCEPTANCE PASSED`.
8. The live demo share (§10) and final report.

Run `npm test` after every module. Never proceed on red.

---

## 7. Algorithms that must be exact

### 7.1 Tree fingerprint

```
entries  = files.map(f => `${f.path}\u0000${f.sha256hex}`)   // paths use "/" separators, relative to package root
canon    = entries.sort().join("\n")                          // lexicographic byte sort
fingerprint = sha256hex(utf8(canon))
fp8      = first 8 hex chars, displayed as XXXX-XXXX (e.g. 3f9a-7c21)
```

`skillshark.json` itself is excluded from `files` and from the fingerprint. The fingerprint is independent of tar framing, mtimes, and file order — shuffling input must not change it (tested).

### 7.2 Extraction guards (every entry, before writing anything)

- Normalize the entry path; reject if it contains `..` segments, starts with `/` or a drive letter, or normalizes outside the extraction root.
- Reject entry types other than regular file and directory (symlinks, hardlinks, devices, FIFOs → abort).
- Maintain a running decompressed-bytes counter (abort > 50 MB) and a file counter (abort > 500).
- Any rejection aborts the **entire** install: temp dir removed, target untouched, exit 1.

### 7.3 Source parsing

Accept: `https://gist.github.com/<id>`, `https://gist.github.com/<user>/<id>`, both with optional `#fp=<hex>` · bare `[0-9a-f]{20,32}` · `gh:owner/repo`, `gh:owner/repo@ref`, `gh:owner/repo/deep/path`, `gh:owner/repo/deep/path@ref` (ref = branch, tag, or SHA; split on the **last** `@`). Anything else → exit 2 with one example of each accepted form.

---

## 8. Required test suite (offline; `npm test`)

Security core — each of these is a named test that fails the build if absent:

1. **Fingerprint regression:** fixture tree → compute once, hard-code the hex, assert forever. Plus order-independence (shuffled input, same fp).
2. **Path traversal:** crafted tarball containing `../evil.txt` → extraction throws; assert nothing exists outside the temp root.
3. **Absolute path entry** → abort.
4. **Symlink entry** → abort.
5. **Decompression bomb:** small .gz expanding past 50 MB → aborts mid-stream (assert it doesn't fully inflate).
6. **File-count bomb** (>500 entries) → abort.
7. **sha256 mismatch** between manifest and content → abort; target untouched.
8. **Exec bits:** packaged `0755` script installs as `0644` by default; preserved with `allowExec`.
9. **Secret excludes:** `.env` and `id_rsa` skipped with warning; included with `--force`.
10. **Inference:** fixture skill with frontmatter → correct name/description/type/agent; bare dir → `bundle`.
11. **Source parsing:** every form in §7.3, including `#fp=` extraction and last-`@` splitting.
12. **Advisory expiry:** manifest with past `expiresAt` → install refuses (exit 1, exact string); inspect still displays.
13. **Conflict:** identical fingerprint → no-op exit 0; differing → correct added/changed/removed sets.
14. **Atomic abort:** inject a failure after staging, before rename → target absent/unchanged.
15. **`#fp=` mismatch** → abort with the exact integrity string.
16. **Receiver never shells out (exec spy):** install + inspect of a recorded public gist fixture and a recorded repo fixture run with a stubbed `execFile` that **throws if called** — proves public receive needs no `gh`.
17. **Non-TTY discipline:** install without `--yes` when `isTTY` is false → exit 2, no hang (drive via a child process with piped stdio).

Integration (mocked fetch/gh via dependency injection): share builds the exact gist JSON body (description format, `public:false`, three files); install consumes a recorded gist API response end-to-end into a temp dir.

---

## 9. Acceptance script (`scripts/acceptance.sh`) — real network, real gh

`set -euo pipefail`, a `trap` that always deletes the created gist and temp dirs, `SKILLSHARK_CONFIG_DIR` pointed at a temp dir, `--no-clipboard` on every share. Steps, each with an explicit assertion:

```
a. gh auth status; LOGIN=$(gh api user -q .login)
b. SENDER=$(mktemp -d); create $SENDER/.claude/skills/demo-$RANDOM/ with:
     SKILL.md (frontmatter name+description), scripts/hello.sh (chmod +x), .env (must be excluded)
c. URL=$(cd $SENDER && skillshark share demo-… -q --no-clipboard)
     assert URL matches ^https://gist\.github\.com/[0-9a-f]+#fp=[0-9a-f]{8}$
d. ID=…; gh api gists/$ID -q .public            → "false"   (it really is secret)
e. SKILLSHARK.json from the gist: files[] must NOT contain ".env"
f. RECEIVER=$(mktemp -d); cd $RECEIVER; git init -q
   skillshark install "$URL" --yes
     assert .claude/skills/demo-…/SKILL.md exists and byte-matches the source
     assert scripts/hello.sh exists and is NOT executable
g. re-run install --yes                          → exit 0, output contains "already installed"
h. skillshark install "${URL%%#*}#fp=deadbeef" --yes --dir $(mktemp -d)
     → exit 1, stderr contains "integrity", target dir is empty
i. skillshark inspect "$URL" --cat SKILL.md      → output contains the frontmatter name
j. skillshark install gh:octocat/Hello-World@7fd1a60b01f91b314f59955a4e4d4e80d8edf11d \
       --dir $(mktemp -d)/hw --yes
     → README exists in the target (public-repo transport over anonymous codeload;
        if this famous fixture ever 404s, substitute any public repo@sha)
k. skillshark revoke $ID -y; gh api gists/$ID    → 404
l. skillshark install "$URL" --yes               → exit 1, output contains "deleted by the sender"
m. echo "ACCEPTANCE PASSED"
```

---

## 10. Final live demo (the "use it right away" gate)

After acceptance passes, do this for real and put it in your final report:

1. Create `demo/` with a small real skill (`.claude/skills/hello/SKILL.md`).
2. `skillshark share hello` — **leave this gist alive.**
3. Print: the full link (with `#fp=`), the exact one-liner I can run anywhere — `npx <path-or-package> install <link>` — and the `skillshark revoke hello` command for when I'm done.
4. Paste the real share and install transcripts (run the install yourself in a fresh temp dir first to prove it).

## 11. README.md must cover

What it is (two sentences) · install (`npm link` for now; `npx` once published) · the four commands with one example each · **"secret gists are unlisted, not private — anyone with the link can read them"** stated prominently · the security model in five bullets (never executes; exec bits stripped; checksum + fingerprint verified; `#fp=` self-verifying links; receivers need no GitHub account) · uninstall = delete the directory.

---

## 12. Non-goals — do not build any of this

Cursor/Codex adapters · `list`/`doctor`/`update`/`prune` · private-repo installs · repo write-side (`share --repo`) · `--public` · `--encrypt` · QR · bundles-as-a-feature beyond the inference fallback · Windows testing · npm publish · any server, database, or domain.

---

## 13. Definition of Done — restate and verify each, in order

- [ ] Preflight reported (node ≥ 20, gh authed as `<login>`)
- [ ] `npm test` green; §8 cases 1–17 all present by name
- [ ] `npm run acceptance` → `ACCEPTANCE PASSED` (gist cleaned up by trap even on failure)
- [ ] Exec-spy test proves public receive never calls `gh`
- [ ] `node bin/skillshark.js --help` works from a clean checkout; `npm link` makes `skillshark` available globally
- [ ] `grep -rn "child_process" src/ bin/` shows only the gh helper and the clipboard helper
- [ ] No `eval`, no dynamic `import()` of package content, no postinstall scripts in package.json
- [ ] README per §11
- [ ] Live demo share printed: URL + install one-liner + revoke command
- [ ] Final report: what was built, test counts, the demo transcript, and anything you knowingly punted

Work autonomously. Don't ask me to confirm scope decisions that are already written here — only stop for a missing/unauthenticated `gh` or a genuine contradiction in this document.
