# SkillShark 🦈

**[holy-coders.github.io/skillshark](https://holy-coders.github.io/skillshark/)** · [npm](https://www.npmjs.com/package/skillshark)

**Share an agent skill like you'd share a file.** SkillShark packages a Claude Code skill (or command) into a secret GitHub gist and hands you an unlisted, self-verifying link; the receiver installs it with one command and zero setup — no GitHub account, no server, no registry.

> ⚠️ **Secret gists are unlisted, NOT private — anyone with the link can read them.**
> SkillShark scans for secret-shaped files (`.env`, keys, tokens) and refuses to package
> them unless you `--force`. If you ever leak one anyway: `skillshark revoke` the share
> *and rotate the secret* — gists keep revision history.

## Install

Zero-install (stable, from npm):

```sh
npx skillshark install <link>
```

Want the **beta** — whatever is on `main` right now, ahead of the npm release?

```sh
npx github:Holy-Coders/skillshark install <link>
```

Both forms take the exact same commands and flags; the `github:` one just builds from the repo's latest commit instead of the published package. Or install globally:

```sh
npm install -g skillshark      # stable
npm install -g github:Holy-Coders/skillshark   # beta from main
```

Once it's on your PATH, running bare **`skillshark`** opens an interactive session — pick a local skill to share from a menu, paste a link to install, inspect, or revoke, all guided with previews and spinners. Every flag-driven form below works too (and is what you want in scripts/CI).

Requirements: Node ≥ 20. **Senders** also need the [GitHub CLI](https://cli.github.com) authenticated (`gh auth login`). **Receivers need nothing** — public links are fetched over plain anonymous HTTPS.

## The four commands

**share** — package a skill and get an unlisted link. Your clipboard receives the full **paste-and-go install one-liner**, so the receiver just pastes it into any terminal:

```sh
skillshark share /j
# clipboard → npx skillshark install 'https://gist.github.com/8a1bc94…#fp=3f9a7c21'
```

(`-q` still prints the bare URL for scripts; `--json` includes both `url` and `installCommand`.)

Accepts a name (`j`, `/j` — resolved across `./.claude/skills`, `./.claude/commands`, and their `~/` equivalents) or any path. Useful flags: `--expires 30m|6h|24h|7d|30d` (advisory, default 7d), `--dry-run`, `--name`, `--force`, `--no-clipboard`, `-q` (print only the URL).

**install** — download, verify, preview, confirm, copy:

```sh
skillshark install https://gist.github.com/<id>#fp=<fp8>   # a SkillShark link
skillshark install <gist-id>                               # bare id works too
skillshark install gh:acme/skills/review@main              # any public repo path
```

Skills land in `.claude/skills/<name>/`, commands in `.claude/commands/<name>.md` (project scope when the cwd looks like a project, else `--project`/`--global`/`--dir`). Useful flags: `--yes`, `--force`, `--allow-exec`, `--dir <path>`, and:

- `--name <name>` — install under a different name. The directory/filename changes and the artifact's frontmatter `name:` is rewritten to match, so two variants of the same skill can live side by side.
- `--agent <id>` — install for a different tool entirely (see below).

**inspect** — look before you leap (writes nothing):

```sh
skillshark inspect <link> --cat SKILL.md
```

Inspect downloads and verifies the full package, so what you read is ground truth from checksummed bytes — never sender-declared metadata. The gist page itself is also a free browser preview (`SKILLSHARK.json` + `SKILL.md`).

**revoke** — delete a share you created:

```sh
skillshark revoke j        # or the gist id
```

The gist dies immediately; anyone holding the link gets "deleted by the sender."
(GitHub's anonymous API cache can serve a just-deleted gist for up to ~a minute
before the 404 propagates everywhere.)

## Cross-agent sharing (v0.2)

SkillShark speaks seven tools' on-disk dialects. You can **share from** any of them (bare names resolve across all of these locations) and **install to** any of them with `--agent <id>`:

| `--agent` | Artifacts | Where they land |
|---|---|---|
| `claude-code` | skills, commands | `.claude/skills/<n>/`, `.claude/commands/<n>.md` (project or `~/`) |
| `cursor` | rules, commands | `.cursor/rules/<n>.mdc` (project), `.cursor/commands/<n>.md` |
| `codex` | prompts | `~/.codex/prompts/<n>.md` (Codex only reads global) |
| `copilot` | prompt files | `.github/prompts/<n>.prompt.md` (project) |
| `windsurf` | rules, workflows | `.windsurf/rules/<n>.md`, `.windsurf/workflows/<n>.md` (project) |
| `gemini` | commands | `.gemini/commands/<n>.toml` (TOML, project or `~/`) |
| `opencode` | commands | `.opencode/command/<n>.md`, `~/.config/opencode/command/<n>.md` |

```sh
skillshark share draftpr                  # found in ~/.codex/prompts/draftpr.md
skillshark install <link> --agent cursor  # lands as .cursor/commands/draftpr.md
```

Crossing agents **converts** the artifact: the instructions (frontmatter + body) are re-rendered in the target's dialect — YAML frontmatter for Claude/Copilot/opencode, `.mdc` for Cursor rules, TOML `prompt`/`description` for Gemini, plain markdown where the tool wants it. Two honest limits, stated loudly at install time:

- **Bundled files don't cross.** A Claude skill's `scripts/` and reference files have no equivalent elsewhere; converting installs the instructions only and names every file left behind.
- **Conversion is best-effort.** A skill written for one tool may assume features another doesn't have. Read the result.

Same-agent installs are always byte-verbatim — conversion only happens when you cross.

## GitHub Enterprise (v0.3)

If your company runs GitHub Enterprise (GHES or `*.ghe.com`), SkillShark works entirely inside it — nothing touches public github.com:

```sh
gh auth login --hostname ghe.corp.com        # once, sender and receivers alike
skillshark share j --host ghe.corp.com       # gist lives on YOUR GitHub
skillshark install 'https://ghe.corp.com/gist/<id>#fp=<hex>'
```

- **Links carry their host.** Receivers don't need `--host` — an enterprise URL routes itself. `GH_HOST` (or `SKILLSHARK_HOST`) sets the default for bare ids and `gh:owner/repo` sources.
- **The privacy property:** enterprise links are fetched exclusively through the receiver's own `gh` auth. No anonymous request ever leaves for an enterprise host (enforced by tests), and unauthenticated users get a clear `gh auth login --hostname …` pointer instead of a leak.
- **One honest limit:** the gists API truncates inline content at ~1 MB and enterprise receivers can't fetch around it anonymously, so enterprise *gist* shares are capped at ~900 KB encoded. Bigger skills: put them in a repo on your GHES and share `gh:owner/repo/path` with `--host`.
- `revoke` remembers which host a share went to and deletes it there.

Public github.com behavior is completely unchanged: receivers still need no account and the receive path still never invokes `gh`.

## Security model

- **SkillShark never executes package content.** Install = copy files. No postinstall hooks, no scripts, ever.
- **Executable bits are stripped by default.** Executables are flagged in the preview; `--allow-exec` is required to keep them.
- **Everything is verified.** Per-file sha256 checksums and a tree fingerprint are checked after extraction; path traversal, symlinks, absolute paths, decompression bombs, and oversized payloads all abort the install with nothing written.
- **Links are self-verifying.** `share` appends `#fp=<fingerprint>` to the URL; `install` recomputes the fingerprint from the downloaded bytes and hard-fails on mismatch — if the gist was edited after sharing, you'll know.
- **Receivers need no GitHub account** for public github.com links — that receive path uses anonymous HTTPS only and provably never invokes `gh` (enforced by tests). GitHub Enterprise links are the deliberate inverse: they ride *only* the receiver's own `gh` auth, so nothing private ever travels anonymously.

The honest framing: a skill is *instructions an AI will obey*. SkillShark is for sharing between people who already trust each other — it makes installs informed and tamper-evident, not safe-from-strangers. Read the preview.

## Odds and ends

- **Uninstall** = delete the directory (`rm -rf .claude/skills/<name>`). Install records live in `~/.config/skillshark/installs.json` (override the location with `$SKILLSHARK_CONFIG_DIR`).
- **Expiry is advisory.** GitHub can't enforce TTLs: installers refuse past the expiry, but the bytes persist until you `revoke`.
- **Too big for a gist (~5 MB)?** Put it in a repo and share `gh:owner/repo/path` instead.
- Exit codes: `0` success/benign no-op · `1` runtime or remote failure · `2` usage error.

## Development

```sh
npm test              # offline unit + integration suite (includes all security cases)
npm run acceptance    # real-network end-to-end: share → install → tamper → revoke
```
