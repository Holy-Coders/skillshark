# SkillShark — Product & Engineering Specification

> **Share an agent skill like you'd share a file.** No new accounts, no registry, no servers — the GitHub you already have is the infrastructure. One command in, one command out, unlisted revocable links by default.

This document is written to be handed to one engineer who can build v0.1 in a weekend. It is opinionated. Where the brief asked a question, I picked an answer and said why. Assumptions I think are wrong are challenged inline and gathered at the end.

*Revision v0.2 — audited end-to-end by a second pass against the original brief. Bugs, gaps, and newly committed decisions are catalogued in Appendix C. Revision v0.3 — architectural pivot to gh-native transport (no servers at all); premise, gains, and honest costs in Appendix D.*

---

## 0. Decisions at a glance

| Question | Decision | Why |
|---|---|---|
| Verb for sharing | `share` (alias `send`) | You're making something shareable; recipient is unknown. `push`/`send` imply a remote you own or a named recipient. |
| Verb for receiving | `install` (alias `get`, `add`) | Matches the user's mental model: you install a skill. |
| Binary name | `skillshark`, ship a `shark` alias | `skillshark share` is 16 chars before the verb — anti-friction for a tool whose pitch is frictionlessness. |
| Auto-copy link to clipboard | Yes, by default; `--no-clipboard` to disable | The single biggest "feels like a file" win. |
| Prompt before install | Yes, always, unless `--yes` | The payload is *instructions an AI will obey*. Consent is the product's credibility. |
| Inspect before install | First-class command **and** shown inline during install | See above. |
| Run scripts on install | **Never.** SkillShark only copies files. | Avoid npm `postinstall` class of attacks entirely. |
| Manifest authored by humans | No. Generated automatically at share time. | Requiring a manifest is friction, which is death. |
| Package format | `.tar.gz` with a generated `skillshark.json` at root | Terminal-native, streamable; CLI owns extraction so Windows is fine. |
| Dependencies | Excluded from MVP (recorded as informational metadata only) | Resolving a dep graph = a registry + versioning = the thing we refuse to build. |
| Backend | **None** — `gh` + secret gists (ephemeral) + GitHub repos (durable) | v0.3 pivot: GitHub already operates unguessable unlisted URLs, anonymous reads, deletion, private repos, GHES, and an abuse team. Ship a CLI; run nothing. |
| Who needs what | Sender: `gh` authed. Receiver: **nothing** for public links (plain HTTPS); `gh` only for private repos | The asymmetry is the product — receiving stays frictionless. |
| Expiry | Advisory `--expires` (default 7d) + real `revoke`/`prune` | GitHub can't enforce TTL. Installers refuse past expiry; senders delete. The v0.2 audit already found auto-expiry hurt more than it helped — this leans into durable-until-revoked. |
| Trust model | Out-of-band trust + **self-verifying links** (`#fp=` checked on install) | You trust the *person*; the link now carries its own integrity check. Signing is emergent via signed git tags on the repo transport. |
| Agent support at launch | Claude Code **skills + commands** first, Cursor **rules** second | These have clear, stable on-disk conventions. "Install to any agent" is over-promised — a Claude skill is not a Cursor rule. |

The ruthless MVP cut line is in the Appendix. Everything outside it is polish.

*(The v0.2 vanity-domain question is now moot: there is no domain. Links are gist/GitHub URLs — longer, but more trusted by this audience than an unknown short domain, and they outlive any renewal.)*

---

## 1. CLI Design

### 1.1 UX principles

1. **Two commands carry the product.** `share` and `install`. Everything else is convenience. A new user should succeed having read one line.
2. **The terminal is the UI.** TTY → interactive prompts. Piped / non-TTY / `--json` / `--yes` → silent and scriptable. Detect, don't ask which mode you're in.
3. **`--quiet` prints only the payload.** `skillshark share j -q` prints exactly the URL and nothing else, so `URL=$(skillshark share j -q)` just works.
4. **Confirmation is the default for anything that writes or executes-adjacent.** Sharing is low-stakes (print + confirm optional). Installing is high-stakes (always confirm).
5. **Never surprise the filesystem.** Always print the exact target path before writing. Never run code. Never write outside the shown path.
6. **Errors tell you what to do next**, not just what went wrong ("This link expired. Ask the sender to run `skillshark share j`").
7. **Color and glyphs are decoration, not information.** Everything works with `NO_COLOR=1` and on a dumb pipe.

### 1.2 Commands

| Command | Purpose |
|---|---|
| `skillshark share <path\|name>` | Package a local artifact, upload it as a **secret gist**, return an unlisted link. |
| `skillshark install <source>` | Download, verify, inspect, and install — from a gist link/id or **any GitHub repo path** (`gh:owner/repo[/path][@ref]`). |
| `skillshark inspect <url\|id>` | Show everything about a link without installing. |
| `skillshark list` (`ls`) | List artifacts SkillShark can find locally (so you know what you can share). |
| `skillshark revoke <id\|name>` | Delete a share you created (deletes the underlying gist via your gh auth). |
| `skillshark prune` | Delete your own *expired* skillshark gists — advisory expiry, real cleanup. |
| `skillshark doctor` | Print detected agents, install paths, config, and `gh` auth status. |
| `skillshark update [name]` | Re-install from source. **Real** for repo sources (re-resolves the ref against the recorded SHA, §8.2); gist sources only while the gist lives. |
| `skillshark upgrade` | Update the `skillshark` CLI itself. |
| `skillshark help [command]` | Help. |

> **MVP surface:** `share` (gist), `install` (gist + public repo), `inspect`, `revoke`. Everything else is v0.2 (Appendix A).

### 1.3 Global flags

```
-y, --yes            Skip prompts (non-interactive)
    --json           Machine-readable output to stdout
-q, --quiet          Print only the essential result (URL or path)
    --host <name>    GitHub hostname (default github.com; GHES supported via gh)
    --no-color       Disable color (also honors NO_COLOR)
-h, --help           Show help
-V, --version        Show version
```

### 1.4 `share` flags

```
-e, --expires <dur>     Advisory: installers refuse past this (default 7d).
                        The gist persists until revoke/prune — GitHub can't enforce TTL.
    --public            (v0.2) Public, discoverable gist instead of a secret one
    --name <name>       Override the inferred name
    --type <type>       skill | command | rule | prompt | workflow | bundle
    --encrypt           (v0.2) End-to-end encrypt; key lives in the URL fragment, never sent to the server
    --qr                Also print a QR code of the link (for phone / second machine)
    --no-clipboard      Don't copy the link
    --dry-run           Show exactly what would be packaged; upload nothing
```

### 1.5 `install` flags

```
-y, --yes            Install without prompting (documented as dangerous)
    --agent <id>     Force target agent (claude-code | cursor | codex)
    --project        Install into ./ (project scope) — default if cwd is a project
    --global         Install into ~/ (all projects)
    --force          Overwrite an existing artifact without the conflict prompt
    --dir <path>     Install into an explicit directory (overrides agent detection)
    --dry-run        Download + verify + inspect, but write nothing
    --allow-exec     Preserve executable bits (default: stripped)
```

Accepted sources: a gist URL, a bare 32-hex gist id, or `gh:owner/repo[/path][@ref]` to install straight from any GitHub repo (public anonymously; private via your `gh` auth).

### 1.6 `inspect` flags

```
    --cat <path>     Print one file from the package
    --files          File listing only
    --json           Machine-readable summary
```

`inspect` always downloads and verifies the full package — they're kilobytes — so what you read is ground truth from checksummed bytes, never sender-declared metadata. (Consequence: an inspect counts as a download.)

### 1.7 Canonical `share` transcript

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

### 1.8 Help output

```
$ skillshark help
skillshark — share agent skills like files

USAGE
  skillshark <command> [options]

COMMANDS
  share    <path|name>   Package a skill and get a temporary link
  install  <url|id>      Download and install a shared skill
  inspect  <url|id>      Preview a shared skill without installing
  list                   List skills SkillShark can find here
  revoke   <id|name>     Delete a share you created (deletes the gist)
  prune                  Delete your own expired shares
  doctor                 Show detected agents and config
  update   [name]        Re-install a skill (if its link is still live)
  upgrade                Update the skillshark CLI

  Run "skillshark help <command>" for command-specific options.

EXAMPLES
  skillshark share /j                        share the "j" skill (secret gist)
  skillshark share ./prompts --public        share a folder as a public gist
  skillshark install <gist-url|id>           install a shared skill
  skillshark install gh:acme/skills/review   install straight from a repo path
  skillshark inspect <gist-url>              look before you leap
```

### 1.9 Interactive vs non-interactive

- **Interactive (TTY):** `share` confirms the inferred name/type if ambiguous; `install` always shows the preview and asks for scope + proceed.
- **Non-interactive (piped, CI, `--yes`, `--json`):** no prompts. `share` uses defaults and prints the link (or JSON). `install` requires `--yes`; scope auto-resolves to project when the cwd contains the agent's directory or `.git`, otherwise an explicit `--project`/`--global`/`--dir` is required — exit non-zero with a clear message rather than guess.
- `--json` implies non-interactive and emits a single JSON object:
  - `share` → `{ "id", "url", "revision", "expiresAt", "fingerprint", "size", "files" }` (no token — your gh auth is ownership)
  - `install` → `{ "name", "type", "agent", "installedPath", "filesWritten", "fingerprint", "source" }`

### 1.10 Error handling

| Situation | Exit | Message |
|---|---|---|
| Name not found locally | 2 | `No skill named "j" found. Run "skillshark list" to see what's here.` + nearest matches |
| Multiple matches | 0 (interactive) / 2 (`--yes`) | Disambiguation prompt, or "ambiguous; pass a path" |
| Past advisory expiry | 1 | `The sender marked this share as expired <n>d ago. The files persist until they prune — ask for a fresh link.` |
| Gist deleted (404) | 1 | `This share was deleted by the sender.` |
| Link not found | 1 | `No package at that link.` |
| Checksum mismatch | 1 | `Download failed integrity check. Did not install anything.` |
| No agent detected | 1 (interactive offers `--dir`) | `No supported agent detected. Use --dir to choose where to install.` |
| Conflict, non-interactive, no `--force` | 1 | `"j" already exists. Re-run with --force or --yes to overwrite.` |
| Clipboard unavailable | 0 | Try OSC52 (works over SSH), then fall back to printing the URL; warn once. |
| `gh` missing / unauthed (sender ops only) | 2 | `Sharing needs the GitHub CLI: https://cli.github.com, then "gh auth login". (Receivers don't need gh for public links.)` |
| Payload too large | 2 | `That folder is 8.2 MB (gist limit ~5 MB). Put it in a repo and share gh:owner/repo/path instead.` |

---

## 2. Skill Discovery

The hard part of `skillshark share /j` is not uploading — it's knowing that `/j` is a Claude Code skill living at `.claude/skills/j/` and that it consists of three files. This is the product's actual intelligence.

### 2.1 The argument can be three things

1. **A path** — `skillshark share ./.claude/skills/j` or `skillshark share notes.md`. Unambiguous; package it.
2. **A bare name / slash token** — `j` or `/j`. Resolve against known locations. (Leading `/` is stripped; people think in slash-commands.)
3. **Nothing** — `skillshark share` opens an interactive picker over everything `list` would show.

### 2.2 Adapters: the registry of agent conventions

SkillShark ships a small set of **adapters**. Each adapter encodes one agent's on-disk convention for one artifact type. This is the only place agent-specific knowledge lives.

```ts
type ArtifactType = "skill" | "command" | "rule" | "prompt" | "workflow" | "bundle";
type Scope = "project" | "global";

interface Adapter {
  id: string;            // "claude-code/skills"
  agent: string;         // "claude-code"
  artifactType: ArtifactType;

  detect(ctx: Ctx): boolean;                       // is this agent present (here or globally)?
  discover(ctx: Ctx): Discovered[];                // all artifacts of this type, locally
  resolve(name: string, ctx: Ctx): Discovered | null; // does this adapter own a "j"?
  targetPath(name: string, scope: Scope, ctx: Ctx): string; // where an install goes
  readMetadata(dir: string): Partial<Manifest>;    // pull name/description from frontmatter
}
```

### 2.3 Known locations (launch set)

| Agent | Type | Project path | Global path |
|---|---|---|---|
| Claude Code | skill | `.claude/skills/<name>/` | `~/.claude/skills/<name>/` |
| Claude Code | command | `.claude/commands/<name>.md` | `~/.claude/commands/<name>.md` |
| Cursor | rule | `.cursor/rules/<name>.mdc` (also legacy `.cursorrules`) | *(MVP: project-scoped only — Cursor's global rules location is not stable)* |
| Codex CLI | prompt | — | `~/.codex/prompts/<name>.md` *(adapter ships v0.2; verify against current Codex docs at build time — this layout has moved before)* |
| Generic | agents file | `AGENTS.md`, `CLAUDE.md` (treated as a single-file `prompt`) | — |

**Resolution order for a bare name:** project paths before global; skills before commands before rules before generic. First match wins; ties prompt.

### 2.4 Manifests vs. inference — infer, always

Requiring an author to write a manifest is the friction we exist to remove. So **authors never write anything.** SkillShark infers at share time and *generates* a manifest into the package so the installer doesn't have to re-infer.

Inference rules:
- **name** — SKILL.md/`.mdc` frontmatter `name:` → else directory or file basename.
- **type** — from the adapter that matched (location implies type).
- **agent** — from the adapter.
- **description** — frontmatter `description:` → else first `#` heading or first paragraph → else empty.
- **files** — everything under the artifact, minus the exclude list below.

**Default excludes** (never packaged): `.git/`, `node_modules/`, `.DS_Store`, `*.log`, `.env`, `.env.*`, anything matching common secret patterns (`*.pem`, `id_rsa`, `*token*`, `*secret*` — flagged, and excluded unless `--force`). Excludes protect the *sender* from leaking credentials into a public-ish link.

**External-reference detection (cheap, high value):** scan SKILL.md for relative paths that escape the artifact (`../shared/util.md`) and warn — *"this skill references files it can't carry; it may not work standalone."* This directly addresses the "a skill ripped from its repo is incomplete" failure mode (see §10).

**No adapter matched?** An explicit path still shares: a single file packages as type `prompt`, a directory as `bundle`, installable only via `--dir`. Symlinks are skipped at pack time with a warning (and rejected at install, §5.2). This closes the loop on the `prompt`/`workflow`/`bundle` types that appear in the enum but have no agent convention of their own.

---

## 3. Skill Packaging

### 3.1 Format

A **gzipped tarball** (`.tar.gz`) containing the artifact's files plus a generated `skillshark.json` at the archive root. The on-the-wire format is an implementation detail: the CLI ships its own tar/gzip and extractor, so there is **no dependency on system `tar`** and Windows works identically. (Tar over zip because it preserves file modes and streams cleanly through `curl | tar` for the power-user path; zip's only real edge is native Windows Explorer, which we don't need.) On the gist transport the tarball travels base64-encoded inside one gist file (§6.2); the tarball remains the canonical artifact and the unit of fingerprinting.

### 3.2 The generated manifest — `skillshark.json`

```json
{
  "skillshark": "2",
  "name": "j",
  "type": "skill",
  "agent": "claude-code",
  "source": { "adapter": "claude-code/skills", "relativePath": ".claude/skills/j" },
  "description": "Jump to a recently used directory.",
  "files": [
    { "path": "SKILL.md",        "size": 1132, "sha256": "9f2c…", "mode": "0644" },
    { "path": "scripts/jump.sh", "size": 487,  "sha256": "ab71…", "mode": "0755", "executable": true },
    { "path": "README.md",       "size": 203,  "sha256": "0d4e…", "mode": "0644" }
  ],
  "totalSize": 1822,
  "createdAt": "2026-06-09T14:32:00Z",
  "expiresAt": "2026-06-16T14:32:00Z",
  "tool": { "name": "skillshark", "version": "0.1.0" },
  "dependencies": [],
  "fingerprint": "sha256:3f9a7c21…"
}
```

- **`fingerprint`** is the sha256 of the *file tree* (sorted `path + sha256` lines, hashed). It's deterministic, independent of tar/gzip framing, and is what sender and receiver compare over a second channel. Surfaced as a short `3f9a-7c21` for humans.
- **`files[].sha256`** lets the installer verify each file after extraction and refuse on mismatch.
- **`dependencies`** is informational for MVP — populated only if the author declared something (e.g., an `mcp:` or `requires:` key in frontmatter). **Never auto-resolved.** Shown to the installer as a note, nothing more.
- **`expiresAt`** — advisory: installers refuse past it; the bytes persist until the sender revokes or prunes (§6.2).

### 3.3 Dependencies — deliberately out of scope

Skills can reference other skills, MCP servers, CLIs, or env. Resolving that means naming, versioning, and a registry — exactly what SkillShark refuses to be. For MVP a package is **self-contained**; if a skill needs a sibling, the author shares both links or (roadmap) a **bundle**. Declared deps are recorded and displayed; that's the entire feature.

---

## 4. Installation Experience

### 4.1 Algorithm

```
1. Resolve the source: gist URL/id → `GET api.github.com/gists/:id` (anonymous is fine);
   `gh:owner/repo[@ref]` → codeload tarball (public) or `gh api …/tarball/:ref` (private).
2. Fetch the payload over TLS (base64-decode on the gist transport), enforcing the transfer-size
   cap while streaming (the decompression-bomb cap applies at extraction, step 3).
3. Extract into a temp dir. For every entry:
     - normalize the path; reject "..", absolute paths, drive letters, and symlinks → ABORT.
     - verify sha256 against the manifest → mismatch ABORTS the whole install.
     - if the link carried `#fp=`, verify the tree fingerprint against it → mismatch ABORTS
       ("this share changed since the link was made, or the link was altered").
4. PREVIEW — rendered from the verified, extracted bytes, never from the gist's browser-facing
   copies (which are sender-declared and unauthenticated): name, type, agent, file tree, sizes; flag executables
   and external refs.
5. CHOOSE AGENT:
     a. manifest.agent installed locally        → use it
     b. manifest.agent NOT installed, others are → warn loudly, offer install-anyway or cancel
     c. multiple installed + ambiguous           → prompt which (respect --agent)
6. CHOOSE SCOPE: project if cwd looks like a project (has the agent's dir or .git), else prompt.
   Always print the exact absolute target path.
7. CONFLICT CHECK at the target (see 4.3).
8. CONFIRM (skipped only with --yes).
9. WRITE atomically: build the final tree in temp, strip exec bits unless --allow-exec, then
   rename into place (the staging dir is created adjacent to the target so the rename is
   same-filesystem atomic). Never partially write the target.
10. Print where it went and how to use it.
```

SkillShark **never executes anything** from the package at any step. Install = copy.

### 4.2 Transcript — happy path

```
$ skillshark install 8a1bc94ef23d4b6a9c01e57f8d2a4b3c
  Fetching 8a1bc94ef23d4b6a9c01e57f8d2a4b3c …

  Skill:  j
  Type:   skill          Agent: claude-code
  Size:   1.8 KB         Files: 3
  Fingerprint: 3f9a-7c21  ✓ matches #fp in the link

    j/
    ├── SKILL.md           1.1 KB
    ├── scripts/jump.sh    0.5 KB   (executable)
    └── README.md          0.2 KB

  ⚠ 1 executable script. SkillShark will not run it and will install it
    without the executable bit (re-run with --allow-exec to keep it).

  Install to:
  › .claude/skills/j        (this project)
    ~/.claude/skills/j      (all projects)
    cancel

  ? Proceed?  ›

  ✓ Verified checksums
  ✓ Installed to .claude/skills/j
  Available in Claude Code as the "j" skill — restart the session to pick it up.
```

### 4.3 Transcript — already installed, identical

```
$ skillshark install 8a1bc94ef23d4b6a9c01e57f8d2a4b3c
  Fetching …
  ⓘ "j" is already installed at .claude/skills/j and is identical (3f9a-7c21).
    Nothing to do.
```

### 4.4 Transcript — conflict, contents differ

There is no version concept in MVP, so an "upgrade" is just an overwrite after you've seen the diff.

```
$ skillshark install 8a1bc94ef23d4b6a9c01e57f8d2a4b3c
  ⚠ "j" already exists at .claude/skills/j and differs:
      ~ SKILL.md         (changed)
      + scripts/new.sh   (added)
      - old-helper.md    (removed)

  What now?
  › Overwrite .claude/skills/j
    Install side-by-side as "j-2"
    Show diff
    Cancel
```

### 4.5 Transcript — multiple agents present

```
  ⓘ This is a claude-code skill. You also have cursor here.
    Installing for claude-code (pass --agent cursor to change, though a
    claude-code skill is unlikely to work as a cursor rule).
```

### 4.6 Transcript — target agent not installed

```
$ skillshark install 8a1bc94ef23d4b6a9c01e57f8d2a4b3c
  ⚠ This skill targets claude-code, which isn't detected here.
    Detected: cursor
    A claude-code skill may not behave as a cursor rule.

  › Install anyway to ~/.claude/skills/j (create the directory)
    Cancel
```

### 4.7 Transcripts — advisory expiry vs deleted

```
$ skillshark install https://gist.github.com/8a1bc94ef23d4b6a9c01e57f8d2a4b3c#fp=3f9a7c21
  ✗ The sender marked this share as expired 3 days ago.
    The files still exist until they prune — ask for a fresh link:  skillshark share j
```

```
$ skillshark install 8a1bc94ef23d4b6a9c01e57f8d2a4b3c
  ✗ This share was deleted by the sender (gist not found).
```

### 4.8 Transcript — inspect (no install)

```
$ skillshark inspect https://gist.github.com/8a1bc94ef23d4b6a9c01e57f8d2a4b3c --cat SKILL.md
  Skill: j · claude-code · 3 files · 1.8 KB · shared by @aaron-dt · advisory expiry in 6d
  Fingerprint 3f9a-7c21 ✓ matches the link

  ── SKILL.md ─────────────────────────────────────────────
  ---
  name: j
  description: Jump to a recently used directory.
  ---
  # j
  …
  ─────────────────────────────────────────────────────────
```

Or skip the CLI entirely: the link opens in a browser, where GitHub renders `SKILLSHARK.json` and `SKILL.md` — the gist page is a free inspection UI, better than anything v0.2's info page could have offered.

---

## 5. Security

### 5.1 The threat model, stated honestly

SkillShark distributes **code and instructions that an AI agent will execute or obey.** Installing a stranger's skill is, in the worst case, equivalent to running their script and pasting their prompt into your agent — including prompt-injection that exfiltrates your context or tool output. **No MVP security model removes that risk.** The honest framing, which the product should adopt in its copy and docs:

> SkillShark is for sharing between people who already trust each other. The service is the courier, not the guarantor. Trust the person who gave you the link.

Everything below is **informed consent + harm reduction**, not a safety guarantee.

### 5.2 Client-side controls

- **Inspect by default.** The preview is shown inline on every install; `inspect`/`--cat` lets you read any file before writing. For a skill, SKILL.md *is* the payload, so reading it is reading the risk.
- **Zero execution at install.** No post-install hooks, ever. Install only copies files. This is the single most important property and should be stated loudly in docs.
- **Executable bits stripped by default.** Any executable file is flagged in the preview; `--allow-exec` is required to keep the bit.
- **Path-traversal & symlink defense.** Reject any entry whose normalized path escapes the target (`..`, absolute, drive letters), and reject symlinks entirely in MVP. Enforced on both pack and unpack.
- **Decompression-bomb defense.** Stream extraction with a hard cap on decompressed bytes and file count; abort if exceeded.
- **Integrity.** Per-file sha256 verified post-extraction; any mismatch aborts the whole install with nothing written.
- **Secret-leak guard for senders.** The exclude list keeps `.env`, keys, and token-shaped files out of packages; flagged if present.

### 5.3 What GitHub provides (was: server-side controls)

The v0.2 server-side section is deleted along with the server. TLS, storage, deletion, DDoS absorption, rate limiting, and — significantly — the terms-of-service and abuse machinery that the critical review flagged as a standing legal/operational cost for a solo maintainer: all GitHub's now. What the client must still respect:

- **Caps:** ~5 MB encoded per gist payload. Gist behavior degrades past ~1 MB via the API (fetch full content via `raw_url`); ceilings are soft and under-documented, so verify at build time. Anything bigger belongs in a repo (`install gh:`).
- **Anonymous read budget:** 60 requests/hour/IP unauthenticated — ample for humans; CI should authenticate to lift it.
- **Gist truths the UX must state plainly:** *secret ≠ private* — anyone with the URL can read it, so the §2.4 secret-scanner matters even more; gists keep *revision history* — never "fix" a leaked credential by editing, revoke the gist and rotate the secret; gist pages *attribute your GitHub identity* — a trust feature, an anonymity non-feature.

### 5.4 Trust & verification model

- **MVP: trust is out-of-band, unchanged.** You trust the person who sent the link, not the platform.
- **Self-verifying links (new, in MVP).** `share` appends `#fp=<fp8>` to the URL; `install` and `inspect` recompute the tree fingerprint and hard-fail on mismatch. Tampering with the gist after sharing is caught automatically. The read-the-fingerprint-aloud ritual survives for channels that strip URL fragments.
- **Attribution as soft trust.** The gist page shows the sender's GitHub identity; "is this really from Aaron?" is now answerable by looking.
- **`--encrypt` (v0.2), sharpened tradeoff.** Same design — ciphertext payload, key in the fragment beside `fp`. On gists the browser-inspection benefit disappears (the page shows only ciphertext) and content moderation becomes impossible; takedown-by-id only.
- **Signing — now emergent, not built.** On the repo transport, signed tags/commits plus GitHub's verification API give author-signing with zero SkillShark key infrastructure. Surfacing `verified` in the install preview is a v0.2 line item, not a key-management project.

### 5.5 URL entropy — resolved by the platform

The v0.2 design hand-rolled ~71-bit ids and argued the brief's 6-char example was enumerable. Gist ids are 32 hex characters — 128 bits — and repo installs are addressed by name plus commit SHA. The entropy question is closed; there is nothing left to design. Links are longer, but the audience pastes links, it doesn't memorize them.

---

## 6. Transport — GitHub *is* the backend

v0.2 designed a Worker + R2 + D1 + Cron. v0.3 deletes all of it. The unlock: the sender already has `gh` installed and authenticated, and GitHub already operates everything the backend existed to provide — unguessable unlisted URLs (secret gists), anonymous HTTPS reads, deletion, revision history, private repos, enterprise hosts, and an abuse team. SkillShark becomes pure client software. The receiver still needs nothing: public links are fetched over plain HTTPS, no `gh`, no account.

### 6.1 The transport interface

One small seam keeps this honest and future-proof:

```ts
interface Transport {
  share(pkg: BuiltPackage, opts: ShareOpts): Promise<{ url: string; ref: string }>;
  fetch(ref: SourceRef): Promise<{ tarball: Bytes; meta: FetchMeta }>;
  revoke(ref: SourceRef): Promise<void>;
}
// MVP: GistTransport (read+write). v0.2: RepoTransport gains write. 
// The deleted hosted design remains a possible third implementation; see §7 for its resurrection triggers.
```

### 6.2 Gist transport — ephemeral person-to-person

**Share, exactly:**

1. Build the tarball + manifest (§3, unchanged).
2. `POST /gists` via `gh api gists --input body.json` (a JSON body avoids shell-escaping the payload) with `"public": false` and three files:
   - `SKILLSHARK.json` — a verbatim copy of the in-tarball manifest, so the gist page shows humans what this is. The installer never trusts this copy; it trusts only the manifest inside the verified tarball.
   - `SKILL.md` (or the artifact's primary document) — verbatim, for browser preview. The gist page becomes the inspection UI.
   - `package.tgz.b64` — the canonical tarball, base64-encoded. Gists are flat (no directories) and text-oriented, so path-encoding tricks and per-file uploads break on real trees and binaries; one encoded blob keeps the §3 integrity model intact at a +33% size cost.
   - description: `skillshark: j (claude-code skill) · fp 3f9a7c21` — makes `list --shared` and `prune` possible via the gists API.
3. Capture the gist `id` and `history[0].version` (revision SHA) for the local share record.
4. Canonical link → clipboard: `https://gist.github.com/<id>#fp=<fp8>` (the username-less form redirects; both forms are accepted on install).

**Install (no `gh` required):** `GET https://api.github.com/gists/<id>` anonymously → read `raw_url`s → fetch → base64-decode → the unchanged §4 pipeline (checksums, `#fp=` verification, preview, consent, atomic write).

**Revoke:** `gh api -X DELETE gists/<id>`. Ownership *is* your GitHub auth — v0.2's delete-token scheme is deleted.

**Expiry is advisory.** The manifest carries `expiresAt`; installers refuse past it with an honest message ("the files still exist until the sender prunes"). The bytes persist until deleted — that's physics on someone else's storage. The honest cleanup story is `skillshark prune`: list your gists, filter `skillshark:` descriptions past expiry, confirm, delete. A 10-line GitHub Action running nightly makes it self-hosted cron — your repo, your token, still zero SkillShark servers.

### 6.3 Repo transport — durable, versioned, team (install-only in MVP)

```
skillshark install gh:owner/repo[/path/to/skill][@ref]
```

- Public repo: `https://codeload.github.com/owner/repo/tar.gz/<ref>` — anonymous.
- Private repo: `gh api repos/{owner}/{repo}/tarball/{ref}` — the one case where a receiver needs `gh`.
- The subtree at `path` is extracted client-side; since repos carry no `skillshark.json`, the §2 inference engine runs install-side — the same code that runs share-side, just at the other end.
- `@<commit-sha>` is a pinned, content-addressed install; a branch or tag resolves to a SHA that's recorded in the install record (§8.2), which is what makes `update` real.

This one feature is the cold-start solver: SkillShark is useful on day one with zero network effects, because every skill already sitting in a public repo is now one command from installed.

### 6.4 GitHub Enterprise — the actual self-hosted story

`gh` already speaks to GHES hosts (`gh auth login --hostname ghe.corp.example`). SkillShark inherits it: detect the host from the URL or `--host`, pass through to `gh`. An enterprise gets private, on-prem skill sharing with zero SkillShark servers. "Self-hostable" here doesn't mean "run my Docker image" — it means **there is nothing of mine to run.**

---

## 7. Deployment

There is nothing to deploy. No domain, no Worker, no database, no cron, no abuse inbox, no bill. Publish the CLI to npm and you are in production.

Two consequences worth savoring. First, **links outlive the maintainer**: a gist works for as long as GitHub does, which is strictly more durable than a hobby Worker behind a vanity domain someone has to keep renewing. Second, the moderation burden — which the critical review called a standing operational and legal cost — transfers wholesale to GitHub's ToS and abuse machinery.

When the hosted v0.2 design would earn resurrection: you need true server-enforced expiry, download gating or real metrics, short vanity URLs, or an audience that doesn't live on GitHub. None of those gate the MVP. The full Workers + R2 + D1 design survives in this document's git history at v0.2.

---

## 8. Data Model

### 8.1 Client config (`~/.config/skillshark/config.json`)

```json
{
  "host": "github.com",
  "defaults": { "expires": "7d", "clipboard": true, "confirmInstall": true, "allowExec": false },
  "shares": [
    { "id": "8a1bc94ef23d4b6a9c01e57f8d2a4b3c", "name": "j",
      "revision": "c0ffee…", "expiresAt": "2026-06-16T14:32:00Z" }
  ]
}
```

`shares` is a convenience cache so `revoke j` can resolve name → gist id offline. The source of truth is `gh api gists` filtered on the `skillshark:` description prefix — the cache can always be rebuilt, and there is no `deleteToken` because your gh auth is ownership.

### 8.2 Local install records (`~/.config/skillshark/installs.json`)

```json
[
  { "name": "j", "agent": "claude-code", "path": ".claude/skills/j",
    "fingerprint": "3f9a7c21…", "installedAt": "2026-06-09T14:40:00Z",
    "source": "gist:8a1bc94ef23d4b6a9c01e57f8d2a4b3c@c0ffee…" },
  { "name": "review", "agent": "claude-code", "path": "~/.claude/skills/review",
    "fingerprint": "77ab19…", "installedAt": "2026-06-02T10:05:00Z",
    "source": "gh:acme/agent-skills/review@9f31c0d" }
]
```

The new `source` field is what makes `update` honest at last: for repo sources, re-resolve the ref, diff against the recorded SHA, show the §4.4 conflict flow, confirm — a real update. For gist sources it works only while the gist lives, which the v0.2 critique already conceded. Install records remain **client-side by design**; nothing in this architecture can attribute installs to people, and nothing should.

### 8.3 Server schema

Deleted. There is no server. (v0.2's D1 schema — including the `max_downloads` semantics the audit fixed — remains in this document's git history.)

---

## 9. Future Roadmap

The pivot's biggest effect lands here: most of the v0.2 roadmap stops being things to *build* and becomes things GitHub already does.

**Emergent — document, don't build:** permanent links (a gist you don't delete; any repo path), versioning (`@tag` / `@sha` on repo installs, with content-addressed integrity for SHAs), teams and organizations (private repos + gh auth; a `skills/` monorepo per team), self-hosting (GHES via gh hosts), discovery (GitHub code search, topics, awesome-lists), and signing (signed tags/commits + the verification API).

**Still real work, in order:**

1. **Bundles** — one share, several artifacts. Unchanged rationale, and now also the natural unit for "install my whole `.claude/` setup."
2. **Repo write-side** — `skillshark share --repo acme/agent-skills` commits a skill into a repo you own via `gh api`. This turns any repo into a team's living skill library and pairs with the now-real `update`. This is the team/monetization-adjacent direction, built on rails GitHub already laid.
3. **`--encrypt`** — unchanged design, sharpened tradeoff (§5.4).
4. **Surface signature verification** (`verified` badge from the API) in the install preview.
5. **Agent-environment bundles** — unchanged; still the sticky end-game.

**Avoid — and the gravity is stronger now:** building any central index. "Search GitHub for topic:skillshark" will tempt you to wrap it in a `skillshark search` command, and that command is the first brick of the registry this product exists not to be. Curate an awesome-list at most. Accounts: delightfully, there is no server to keep them on. The hosted transport: only if one of §7's triggers actually fires.

---

## 10. Critical Review — brutally honest

### Assumptions I think are wrong

- **"Sharing friction is the bottleneck."** It probably isn't. People already share skills via GitHub, gists, and copy-paste, and those mostly work. The real scarcity is *which skills are any good* and *can I trust this one* — neither of which SkillShark solves (by design). That makes it a **vitamin, not a painkiller**: pleasant, easy to skip.
- **"Temporary links are what people want."** The "feels like a file" metaphor cuts both ways — files don't self-destruct. You Slack a link Friday, a teammate clicks Monday, it's dead, and now SkillShark made sharing *worse* than a gist. The 24h default would frustrate as often as it delights — **this audit changed the default to 7d** — and demand for permanence will still arrive on day one. (v0.3's answer: permanence is now the default physics — gists persist until revoked, and repo installs are permanent by nature.)
- **"No accounts is purely good."** v0.3 settles this differently: the sender's GitHub account *is* the accountability — shares are attributable, revocable, and subject to GitHub's ToS — and the standing abuse/legal cost the hosted design carried transfers wholesale to GitHub's machinery. The price: senders need GitHub. Defensible for this audience, but be honest that the founding principle bent to "no *new* accounts."
- **"Installing a skill is basically safe."** It is not. The payload is *code plus instructions an AI will obey.* Inspect-before-install and never-execute are the right harm-reduction moves, but they don't make installing a stranger's skill safe — they make it *informed*. If the product is ever positioned as "discover skills from anyone," that framing is dangerous. Position it as **trusted sharing between people who already know each other.**
- **"Cross-agent install matters early."** It mostly doesn't work: a Claude Code skill is not a Cursor rule and can't be auto-translated into one. "Install to whichever agent you have" is over-promised. Be honest that the launch is **Claude Code skills + commands**, with Cursor rules as the obvious second, and treat true cross-agent as research, not a feature.

### Overengineered (for an MVP)

- An **adapter for every agent** on day one. Ship one or two; add the rest when someone actually asks.
- **The hosted backend itself** — v0.3 deleted the D1 + Cron + R2 lifecycle machinery (and `--max-downloads`) wholesale, which rather settles the question. What remains over-engineerable is QR codes and E2E ahead of demand. The honest 80/20 is unchanged: discover → `tar.gz` → gist → clipboard, and install → verify → preview → confirm → extract.
- The **full command set** (`doctor`, `update`, `revoke`, `list`). MVP is `share` + `install` + `inspect`. The rest is polish that can wait a week.

### Underengineered (the brief under-weights these)

- **Trust/verification is one section of ten, and it's the whole ballgame.** For a tool whose payload is "instructions an AI will follow," the consent-and-verification UX *is* the credibility. It deserves more than an unguessable URL — fingerprints in MVP, signing on the roadmap, and copy that's honest about the risk.
- **"Updates" contradict ephemerality.** If the link is dead, `update` can't fetch. Real update semantics require permanence; in MVP, "update" is just "ask the sender to re-share." Say so plainly rather than implying a capability that isn't there.
- **A skill ripped from its repo is often incomplete.** Skills depend on local context — sibling files, MCP servers, paths referenced in `CLAUDE.md`. "Feels like a file" implies the receiver gets a working thing; frequently they get a fragment. The external-reference scanner (§2.4) is the minimum honest mitigation and should be in MVP, not the roadmap.
- **Windows / WSL** (clipboard, paths, exec bits, tar) is hand-waved in the brief. Bundling tar/gzip in the CLI and testing the clipboard fallback is real work, and a chunk of the audience is on Windows.

### What would make developers actually adopt it

- **Zero-install trial.** `npx skillshark …` and a `curl | sh` installer. Asking someone to install a CLI *before* they can receive a shared file reintroduces the exact friction you're removing — the receive path especially must work with near-zero setup.
- **Genuinely one command, clipboard auto-copy.** The demo has to be `skillshark share /j` → it's on my clipboard → I paste it in Slack. If that's not the experience, nothing else matters.
- **Live inside the agent.** Ship SkillShark *as a Claude Code skill/command* (`/share`, `/install`) that dogfoods itself. That's both the best demo and the most credible distribution.
- **Be the obvious answer to "can you send me that skill?"** in the Claude Code and Cursor communities. Distribution is the moat here, not the tech.

### What would make them ignore it

- A gist or repo is good enough and already in their muscle memory.
- The expiry burns them once — then they never trust a SkillShark link again.
- Install feels opaque or risky, so they just ask for the files instead.
- It supports one agent and they use another.
- **Platform risk:** if Anthropic or Cursor ship native skill-sharing, this gets absorbed overnight. The defensibility of a thin wrapper over ephemeral blob storage is low — which is fine for a weekend bet, but means you should learn fast and lean toward the *bundles / environment-sharing / team* direction, where there's room to be more than a courier.

### Verdict

Solid weekend-to-fortnight project addressing a **real but modest** pain, with **low defensibility** as a pure transport. Build it tiny, frame it as **trusted sharing** (not discovery), and watch one metric: **does anyone share a second time?** The genuinely interesting upside isn't single-skill sharing — it's **bundles and one-command environment onboarding for teams**, which is sticky and monetizable. Use the MVP to earn the right to build that.

### v0.3 postscript — what the gh pivot changes in this review

Two founding principles bent, on purpose. **"No accounts required"** became "no *new* accounts": senders need GitHub, receivers still need nothing — and for an audience that is approximately 100% gh-equipped, that trade bought the deletion of the entire backend, the abuse burden, the domain, and the hosting bill. **"Temporary links are the primary mechanism"** became "unlisted, revocable, advisorily-expiring links": GitHub cannot enforce TTL, and the v0.2 audit had already concluded that hard auto-expiry hurt more than it helped.

What sharpened: SkillShark is now unmistakably *not* infrastructure. The share side is sugar over `gh gist create`; **the install side is the product** — local discovery, agent-aware placement, the consent-and-verify pipeline, conflict handling. If that isn't clearly better than "clone the repo and copy the files yourself," nothing else here saves it. What was gained beyond deletion: links outlive the maintainer (a gist works as long as GitHub does — strictly more durable than a hobby Worker behind a domain someone must keep renewing); repo installs give day-one utility with zero network effects; and GHES makes the enterprise story real without writing enterprise software. What was lost: true expiry, every central metric (adoption is now legible only through stars and issues on the skillshark repo), download gating, and sender anonymity. The new concentration risk is GitHub itself — ToS and rate limits are a non-issue at skill sizes, real if this ever moves megabytes.

---

## Appendix A — The ruthless MVP cut line

Ship this, and nothing else, first:

- `skillshark share <path|name>` — discover (Claude Code skills + commands only), tar.gz, secret gist via `gh`, **clipboard**, print the URL with `#fp=`. Advisory `expiresAt` ships in the manifest from day one so v0.2's `prune` has something to clean.
- `skillshark install <gist-url|id | gh:owner/repo[/path][@ref]>` — fetch (anonymous for anything public), decode, verify checksums **and the link fingerprint**, inline preview, confirm, place into the right `.claude/` path. Never execute. Public-repo install is *in* the MVP deliberately: it's the cold-start solver — useful on day one with zero network effects.
- `skillshark inspect <url|id>` — preview + `--cat`; and point people at the gist page itself, which is a free browser inspection UI.
- `skillshark revoke <id|name>` — `gh api -X DELETE gists/:id`; still the only remedy when the secret-scanner misses.
- Backend: **none.** `gh` for sender operations; plain HTTPS for receivers.
- Security non-negotiables even in the cut: never execute, strip exec bits, path-traversal/symlink rejection, per-file sha256 + tree fingerprint, `#fp=` enforcement, ~5 MB gist cap, secret-pattern excludes, and plain-language copy that secret ≠ private.
- Distribution non-negotiable: `npx skillshark install <link>` works with no prior setup and no `gh` for public links — receiving stays frictionless, which is the property the whole product hangs on.

Defer everything else: Cursor/Codex adapters, `list`/`doctor`/`update`/`prune`, private-repo installs, repo write-side, `--public`, QR, `--encrypt`, bundles.

## Appendix B — Questions the v0.1 draft left open, resolved in v0.2

*(The v0.3 pivot supersedes the enforcement half of #1 — expiry is now advisory by physics — and renders #4's runtime choice gh-adjacent. See Appendix D.)*

1. **Default TTL → 7 days** (max 30d). A deliberate deviation from the brief's "Expires in 24 hours" example: a link Slacked on Friday must survive to Monday, and one dead link teaches a recipient to never trust a SkillShark URL again. `--expires 24h` remains for the cautious.
2. **`--encrypt` → v0.2, not MVP.** It touches share, inspect, install, and the metadata model simultaneously — real scope, not an afternoon. Deferred to protect the weekend build, not because it isn't worth doing.
3. **Ship shape → standalone CLI first; the `/share` + `/install` Claude Code command wrapper the same week.** The wrapper is a SKILL.md that shells out to the CLI — near-zero cost, and it's the best possible demo (the tool distributing itself).
4. **Runtime → Node + `npx` for v0.1** (mature tar/clipboard libraries, fastest path to working software); revisit a static Go/Rust binary when the zero-dependency receive path matters more than iteration speed.
5. **Safety copy → loud once, quiet forever.** A one-time first-install explainer of what installing a skill means, then a permanent single-line footer on every install preview.

## Appendix C — v0.2 audit changelog

**Bugs fixed**
- **The server had no legal way to know the manifest.** §6 stored `name`/`type`/`agent` "from the manifest" while §5 promised uploads are "never introspected." Satisfying both was unspecified, and the obvious implementation — server untars the blob to read `skillshark.json` — is precisely the decompression-bomb exposure §5 warns about. Fixed: multipart upload (`manifest` JSON part + opaque blob); the server never opens the blob; install/inspect previews are always computed client-side from verified bytes, and server metadata is demoted to the browser info page.
- **`inspect --cat` was impossible as specified** — file contents don't exist in the metadata endpoint it was said to use. And `--max-installs` was incoherent: the draft suggested folding the install ping into the download endpoint, which would make *inspecting* a link consume its installs. Fixed: `inspect` always downloads (packages are kilobytes), the counter is honest (`--max-downloads`, v0.2), and the `/installs` endpoint is deleted.
- **ID entropy math was wrong.** "9 random bytes → base62 → ~12 chars": 9 bytes is 72 bits, which base62-encodes to 13 characters. Fixed to sampling 12 base62 chars directly (~71.4 bits). The draft's own transcripts also used 10-char ids after arguing for 12 — normalized everywhere.
- **Backend split-brain.** The body designed D1 (schema, transactions, revocation); Appendix A said start with KV and migrate later. A developer reading "build the first version immediately" got two different first versions. Committed: D1 from day one; KV only for rate-limit windows.

**Brief compliance**
- The brief's single canonical example — the output of `skillshark share /j` — was never shown. Six install transcripts, zero share transcripts. Added §1.7.
- "Every command, every flag": `inspect` used `--cat` in a transcript without its flags ever being defined. Added §1.6; §1.2 now states the MVP surface explicitly.
- "How does it find Codex skills?" was hand-waved into AGENTS.md. Added the `~/.codex/prompts/` global-prompts location (with an explicit verify-at-build caveat — this layout has moved before), and a fallback typing rule for the `prompt`/`workflow`/`bundle` types that existed in the enum with no on-disk convention.

**Decisions committed (the draft hedged)**
- Default TTL 7d / max 30d; `revoke` pulled **into** the MVP (one endpoint, and the only remedy when the secret-scanner misses); `--encrypt` firmly v0.2; install-ping endpoint deleted; `--max-installs` renamed `--max-downloads` and deferred; D1 day one; all five open questions answered (Appendix B).

**Hardening added**
- Envelope magic-byte check at upload (gzip `1f 8b` or `SSE1` header) so skill.sh can't host arbitrary foreign blobs.
- Same-filesystem staging directory so the final rename is genuinely atomic; symlinks explicitly skipped at pack time; transfer-cap vs decompression-cap wording untangled in the install algorithm; OSC52 clipboard fallback over SSH.
- Stated plainly that encrypted packages are unmoderatable by content (takedown-by-id only) and that install records are client-side by design.

**Audited and deliberately unchanged**
- The `share`/`install` verbs, zero-authored-manifest inference, tar.gz format, never-execute + strip-exec-bits, ≥12-char unguessable ids, the Workers + R2 egress economics, and the §10 verdict (vitamin not painkiller; position as trusted sharing between people who know each other; watch the second-share rate). I tried to break each of these and couldn't.

## Appendix D — v0.3 changelog: the gh-native pivot

**Premise.** Assume the sender has `gh` installed and authenticated, and make GitHub the entire infrastructure. SkillShark becomes pure client software: the thing that knows how to *find* skills locally, *package* them, and *install* them safely. Receivers still need nothing for public links — the frictionless half of the product is untouched.

**Deleted.** The §6 Worker/R2/D1 backend, §7 hosted deployment, the server schema, the delete-token scheme, `--max-downloads`, the vanity domain, and the abuse-report endpoint (GitHub's problem now). Also deleted, with some irony: the D1-vs-KV decision the v0.2 audit litigated. Moot.

**Added.** Gist transport with exact `gh api` calls and a wrapper layout (`SKILLSHARK.json` + `SKILL.md` preview + `package.tgz.b64` — gists are flat and text-oriented, so the canonical artifact stays a tarball, base64-wrapped); **self-verifying links** (`#fp=` fragment, enforced at install); advisory expiry + `prune` (+ an optional 10-line GitHub Action as self-hosted auto-prune); the **repo transport** `gh:owner/repo[/path][@ref]` with commit-SHA pinning; GHES support inherited from `gh`; `--host`; `--public` (v0.2); canonical example id is now a 32-hex gist id.

**Changed.** `revoke` = gist deletion via your gh auth (ownership without tokens); `update` becomes *real* for repo sources via the new `source` field in install records; the entropy section closed (128-bit ids come free from the platform); the roadmap largely converted from "build" to "emergent from GitHub" — permanence, versioning, teams, self-hosting, discovery, and signing all fall out of repos + refs + signed tags.

**Honest costs.** Senders require a GitHub account (principle bent to "no *new* accounts"); expiry is unenforceable, only advisory; zero central metrics of any kind; every share is attributable to a GitHub identity; secret ≠ private must be communicated relentlessly; gist size ceilings are soft and under-documented (capped conservatively at ~5 MB; verify at build).

**Net judgment.** This is the better architecture for this product. The v0.2 backend was already minimal; v0.3 makes it zero, transfers the abuse/legal burden to GitHub, makes links more durable than the maintainer, and gives the product day-one utility via repo installs. The identity it forces is also the correct one: the install pipeline is the product, the transport is borrowed.
