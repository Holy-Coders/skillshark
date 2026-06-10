#!/usr/bin/env bash
# SkillShark acceptance — real network, real gh (§9).
# share → real secret gist → install → tamper-detect → revoke → install fails.
# Cleans up after itself even on failure (trap deletes the gist + temp dirs).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLSHARK="node $ROOT/bin/skillshark.js"

CFG="$(mktemp -d)"
export SKILLSHARK_CONFIG_DIR="$CFG"
SENDER="$(mktemp -d)"
RECEIVER="$(mktemp -d)"
TAMPER_DIR="$(mktemp -d)"
HW_PARENT="$(mktemp -d)"
ID=""

step() { printf '\n== %s\n' "$*"; }
die() { printf 'ACCEPTANCE FAILED: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$ID" ]; then
    gh api --method DELETE "gists/$ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$CFG" "$SENDER" "$RECEIVER" "$TAMPER_DIR" "$HW_PARENT"
}
trap cleanup EXIT

# --- a. preflight ------------------------------------------------------------
step "a. gh auth"
gh auth status >/dev/null
LOGIN="$(gh api user -q .login)"
echo "   authenticated as @$LOGIN"

# --- b. craft a sender project ------------------------------------------------
step "b. sender fixture"
NAME="demo-$RANDOM"
SKILL="$SENDER/.claude/skills/$NAME"
mkdir -p "$SKILL/scripts"
cat > "$SKILL/SKILL.md" <<EOF
---
name: $NAME
description: Acceptance-test skill. Safe to delete.
---
# $NAME

Say hello when asked.
EOF
printf '#!/bin/sh\necho hello from %s\n' "$NAME" > "$SKILL/scripts/hello.sh"
chmod +x "$SKILL/scripts/hello.sh"
printf 'API_KEY=do-not-leak\n' > "$SKILL/.env"
echo "   created $NAME (SKILL.md, scripts/hello.sh +x, .env)"

# --- c. share ------------------------------------------------------------------
step "c. share → secret gist"
URL="$(cd "$SENDER" && $SKILLSHARK share "$NAME" -q --no-clipboard)"
echo "   $URL"
URL_RE='^https://gist\.github\.com/[0-9a-f]+#fp=[0-9a-f]{8}$'
[[ "$URL" =~ $URL_RE ]] || die "URL shape: $URL"

ID="${URL##*gist.github.com/}"; ID="${ID%%#*}"
FP="${URL##*#fp=}"

# --- d. it really is secret ------------------------------------------------------
step "d. gist is secret"
PUBLIC="$(gh api "gists/$ID" -q .public)"
[ "$PUBLIC" = "false" ] || die "gist.public = $PUBLIC, expected false"
echo "   public: $PUBLIC"

# --- e. .env must not have been packaged ------------------------------------------
step "e. .env excluded from the manifest"
MANIFEST="$(gh api "gists/$ID" -q '.files["SKILLSHARK.json"].content')"
[[ "$MANIFEST" != *'.env'* ]] || die ".env leaked into the package manifest"
[[ "$MANIFEST" == *'"SKILL.md"'* ]] || die "manifest is missing SKILL.md"
echo "   manifest files are clean"

# --- f. anonymous install into a fresh project -------------------------------------
step "f. install in a fresh receiver project"
( cd "$RECEIVER" && git init -q && $SKILLSHARK install "$URL" --yes )
INSTALLED="$RECEIVER/.claude/skills/$NAME"
[ -f "$INSTALLED/SKILL.md" ] || die "SKILL.md not installed"
cmp -s "$SKILL/SKILL.md" "$INSTALLED/SKILL.md" || die "SKILL.md does not byte-match the source"
[ -f "$INSTALLED/scripts/hello.sh" ] || die "hello.sh not installed"
[ ! -x "$INSTALLED/scripts/hello.sh" ] || die "hello.sh must NOT be executable (bit must be stripped)"
[ ! -e "$INSTALLED/.env" ] || die ".env must not be installed"
echo "   byte-identical, exec bit stripped, no .env"

# --- g. identical re-install is a benign no-op --------------------------------------
step "g. identical re-install"
OUT="$(cd "$RECEIVER" && $SKILLSHARK install "$URL" --yes)"
[[ "$OUT" == *"already installed"* ]] || die "expected 'already installed', got: $OUT"
echo "   no-op confirmed"

# --- g2. rename on install (--name) ---------------------------------------------------
step "g2. install --name"
( cd "$RECEIVER" && $SKILLSHARK install "$URL" --yes --name "$NAME-renamed" >/dev/null )
RENAMED="$RECEIVER/.claude/skills/$NAME-renamed"
[ -f "$RENAMED/SKILL.md" ] || die "renamed skill not installed"
grep -q "name: $NAME-renamed" "$RENAMED/SKILL.md" || die "frontmatter name not rewritten"
echo "   installed as $NAME-renamed, frontmatter rewritten"

# --- g3. cross-agent install (claude skill → cursor command) ---------------------------
step "g3. install --agent cursor"
G3_OUT="$(cd "$RECEIVER" && $SKILLSHARK install "$URL" --yes --agent cursor --project)"
CURSOR_CMD="$RECEIVER/.cursor/commands/$NAME.md"
[ -f "$CURSOR_CMD" ] || die "converted cursor command not installed"
grep -q "hello" "$CURSOR_CMD" || die "converted body missing"
[[ "$G3_OUT" == *"Converting"* ]] || die "conversion warning not shown"
[[ "$G3_OUT" == *"hello.sh"* ]] || die "dropped bundled file not named in the warning"
echo "   converted to .cursor/commands, dropped files warned"

# --- h. tampered #fp must abort with nothing written ---------------------------------
step "h. tampered #fp aborts"
set +e
TAMPER_OUT="$(cd "$RECEIVER" && $SKILLSHARK install "${URL%%#*}#fp=deadbeef" --yes --dir "$TAMPER_DIR/x" 2>&1)"
TAMPER_CODE=$?
set -e
[ "$TAMPER_CODE" -eq 1 ] || die "tampered install exit code $TAMPER_CODE, expected 1"
[[ "$TAMPER_OUT" == *"integrity"* || "$TAMPER_OUT" == *"Integrity"* ]] || die "expected an integrity error, got: $TAMPER_OUT"
[ ! -e "$TAMPER_DIR/x" ] || die "tampered install left files behind"
[ -z "$(ls -A "$TAMPER_DIR")" ] || die "tamper target dir is not empty"
echo "   exit 1, integrity message, nothing written"

# --- i. inspect --cat ------------------------------------------------------------------
step "i. inspect --cat SKILL.md"
INSPECT_OUT="$($SKILLSHARK inspect "$URL" --cat SKILL.md)"
[[ "$INSPECT_OUT" == *"name: $NAME"* ]] || die "inspect --cat did not show the frontmatter name"
echo "   frontmatter visible"

# --- j. public-repo transport over anonymous codeload ------------------------------------
step "j. install gh:octocat/Hello-World@<sha>"
$SKILLSHARK install gh:octocat/Hello-World@7fd1a60b01f91b314f59955a4e4d4e80d8edf11d \
  --dir "$HW_PARENT/hw" --yes >/dev/null
[ -f "$HW_PARENT/hw/README" ] || die "README missing after repo install"
echo "   README installed from codeload"

# --- k. revoke ----------------------------------------------------------------------------
step "k. revoke"
$SKILLSHARK revoke "$ID" -y >/dev/null
if gh api "gists/$ID" >/dev/null 2>&1; then
  die "gist still exists after revoke"
fi
echo "   gist 404s"

# --- l. installing a revoked share fails honestly -------------------------------------------
# GitHub's anonymous API cache can serve a just-deleted gist for up to ~60s,
# so poll briefly until the 404 propagates.
step "l. install after revoke"
DEAD_CODE=-1
DEAD_OUT=""
for attempt in 1 2 3 4 5 6; do
  set +e
  DEAD_OUT="$(cd "$RECEIVER" && $SKILLSHARK install "$URL" --yes --force 2>&1)"
  DEAD_CODE=$?
  set -e
  if [ "$DEAD_CODE" -eq 1 ]; then break; fi
  echo "   (attempt $attempt: anonymous cache still serving the gist; waiting 15s)"
  sleep 15
done
[ "$DEAD_CODE" -eq 1 ] || die "post-revoke install exit code $DEAD_CODE, expected 1"
[[ "$DEAD_OUT" == *"deleted by the sender"* ]] || die "expected 'deleted by the sender', got: $DEAD_OUT"
echo "   exit 1, honest message"

ID="" # already deleted; don't re-delete in the trap

echo
echo "ACCEPTANCE PASSED"
