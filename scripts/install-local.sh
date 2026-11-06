#!/usr/bin/env bash
# Install a ChessRiddle Studio build for daily use, separate from the build tree.
# provenance `reviewed` is written only when this invocation compiled from a clean
# tree whose HEAD is still on the branch's @{upstream}.
#
#   bash scripts/install-local.sh                 build from HEAD, then install
#   bash scripts/install-local.sh --no-build --force
#       install the build already in target/release as UNREVIEWED
#   bash scripts/install-local.sh --force         permit a dirty tree, unpushed HEAD, or a tree/HEAD change during the build
#
# The desktop entry launches current/bin/chessriddle-studio directly, because a GTK window takes its
# Wayland app id from argv[0] and Plasma matches a window to a launcher by that id. The entry is
# therefore named after the binary, not after productName. Tauri resolves resources from
# lib/ChessRiddle Studio (PackageInfo.name is productName verbatim, including the space).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${CHESSFABLE_INSTALL_DIR:-$HOME/.local/opt/chessriddle-studio}"
RELEASE_DIR="$REPO/src-tauri/target/release"
ICON="$REPO/src-tauri/icons/icon.png"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

build=1
force=0
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --force) force=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

mapfile -t identity < <(node -e '
  const c = require(process.argv[1]);
  const binary = c.mainBinaryName;
  const product = c.productName;
  if (typeof binary !== "string" || !/^[A-Za-z0-9_-]+$/.test(binary)) process.exit(2);
  if (typeof product !== "string" || !/^[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*$/.test(product)) process.exit(2);
  console.log(binary);
  console.log(product);
' "$REPO/src-tauri/tauri.conf.json")
[ "${#identity[@]}" -eq 2 ] || { echo "invalid product identity in tauri.conf.json" >&2; exit 1; }
binary="${identity[0]}"
product_name="${identity[1]}"
DESKTOP="$APPLICATIONS_DIR/$binary.desktop"

tree_dirty=0
tree_dirty_text=""
missing_upstream=0
unresolvable_upstream=0
not_ancestor=0
current_head=""
current_short=""
upstream=""

evaluate_tree() {
  local status_out
  current_head="$(git -C "$REPO" rev-parse HEAD)"
  current_short="$(git -C "$REPO" rev-parse --short "$current_head")"
  status_out="$(git -C "$REPO" status --porcelain)"
  if [ -n "$status_out" ]; then
    tree_dirty=1
    tree_dirty_text="$status_out"
  else
    tree_dirty=0
    tree_dirty_text=""
  fi
  missing_upstream=0
  unresolvable_upstream=0
  not_ancestor=0
  if ! upstream="$(git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
    missing_upstream=1
    return
  fi
  if ! git -C "$REPO" rev-parse --verify "$upstream^{commit}" >/dev/null 2>&1; then
    unresolvable_upstream=1
    return
  fi
  if ! git -C "$REPO" merge-base --is-ancestor "$current_head" "$upstream"; then
    not_ancestor=1
  fi
}

refuse_if_upstream_unusable() {
  if [ "$missing_upstream" -eq 1 ]; then
    echo "refusing: the current branch has no configured upstream" >&2
    exit 1
  fi
  if [ "$unresolvable_upstream" -eq 1 ]; then
    echo "refusing: configured upstream $upstream cannot be resolved" >&2
    exit 1
  fi
}

mkdir -p "$ROOT"
lock_file="$ROOT/.install.lock"
exec {lock_fd}>"$lock_file"
if ! flock "$lock_fd"; then
  echo "could not acquire installer lock $lock_file" >&2
  exit 1
fi

evaluate_tree
head="$current_head"
short="$current_short"
provenance="reviewed"
refuse_if_upstream_unusable
if [ "$tree_dirty" -eq 1 ]; then
  if [ "$force" -eq 1 ]; then
    provenance="UNREVIEWED (dirty tree, --force)"
  else
    echo "refusing: the worktree has modified or untracked files — the binary would not match any reviewed commit" >&2
    printf '%s\n' "$tree_dirty_text" >&2
    echo "commit, delete, or git stash -u first, or pass --force for a deliberate local trial" >&2
    exit 1
  fi
fi
if [ "$not_ancestor" -eq 1 ]; then
  if [ "$force" -eq 1 ]; then
    provenance="UNREVIEWED (HEAD not on $upstream, --force)"
  else
    echo "refusing: HEAD $short is not contained in $upstream — it has not passed the push review" >&2
    echo "run \$push first, or pass --force for a deliberate local trial" >&2
    exit 1
  fi
fi

if [ "$build" -eq 0 ]; then
  if [ "$force" -eq 0 ]; then
    echo "refusing: --no-build copies an unbound binary — rebuild, or pass --force for a deliberate local trial" >&2
    exit 1
  fi
  provenance="UNREVIEWED (prebuilt binary, --force)"
else
  echo "building release binary from $short …"
  (cd "$REPO" && pnpm build)
  evaluate_tree
  refuse_if_upstream_unusable
  if [ "$current_head" != "$head" ] || [ "$tree_dirty" -eq 1 ] || [ "$not_ancestor" -eq 1 ]; then
    if [ "$force" -eq 0 ]; then
      echo "refusing: tree or HEAD changed during build (was $short, now $current_short) — the binary is not bound to the reviewed commit" >&2
      [ -z "$tree_dirty_text" ] || printf '%s\n' "$tree_dirty_text" >&2
      exit 1
    fi
    if [ "$current_head" != "$head" ]; then
      provenance="UNREVIEWED (HEAD moved during build, --force)"
    elif [ "$tree_dirty" -eq 1 ]; then
      provenance="UNREVIEWED (dirty tree, --force)"
    else
      provenance="UNREVIEWED (HEAD not on $upstream, --force)"
    fi
  fi
fi
[ -x "$RELEASE_DIR/$binary" ] || { echo "no release binary in $RELEASE_DIR" >&2; exit 1; }
[ -d "$RELEASE_DIR/sound" ] || { echo "no bundled sound/ resources in $RELEASE_DIR — the build is incomplete" >&2; exit 1; }

mkdir -p "$ROOT/releases" "$APPLICATIONS_DIR"
staging=""
target="$ROOT/releases/$short-$(date +%Y%m%dT%H%M%S)-$$"
current_tmp=""
previous_tmp=""
desktop_tmp=""
invocation_id=""
managed_marker_name='.chessriddle-studio-managed-release'
managed_marker_value='ChessRiddle Studio local installer release v1'
current_committed=0
target_owned=0
original_current_present=0
original_previous_present=0
original_current=""
original_previous=""
[ ! -e "$ROOT/current" ] || [ -L "$ROOT/current" ] || { echo "refusing: current exists and is not a symlink" >&2; exit 1; }
[ ! -e "$ROOT/previous" ] || [ -L "$ROOT/previous" ] || { echo "refusing: previous exists and is not a symlink" >&2; exit 1; }
[ -L "$ROOT/current" ] && { original_current_present=1; original_current="$(readlink "$ROOT/current")"; }
[ -L "$ROOT/previous" ] && { original_previous_present=1; original_previous="$(readlink "$ROOT/previous")"; }

restore_link() {
  local path="$1" present="$2" value="$3" temporary="$4"
  if [ "$present" -eq 1 ]; then
    ln -s "$value" "$temporary" && mv -T "$temporary" "$path"
  else
    [ ! -e "$path" ] && [ ! -L "$path" ] || rm "$path"
  fi
}

cleanup() {
  local status="$?" promoted_by_this_invocation="$target_owned" current_target="" target_real=""
  trap - EXIT INT TERM HUP
  if [ "$promoted_by_this_invocation" -eq 0 ] && [ -n "$staging" ] &&
     [ ! -e "$staging" ] && [ -f "$target/$managed_marker_name" ] &&
     [ ! -L "$target/$managed_marker_name" ] &&
     [ "$(cat "$target/$managed_marker_name")" = "$managed_marker_value
invocation $invocation_id" ]; then
    promoted_by_this_invocation=1
  fi
  if [ "$status" -ne 0 ] && [ "$current_committed" -eq 0 ] &&
     [ "$promoted_by_this_invocation" -eq 1 ] && [ -L "$ROOT/current" ]; then
    current_target="$(readlink -f "$ROOT/current" || true)"
    target_real="$(readlink -f "$target" || true)"
    if [ -n "$target_real" ] && [ "$current_target" = "$target_real" ]; then
      current_committed=1
      echo "install interrupted after current publication: current=$target; rollback=$ROOT/previous" >&2
    fi
  fi
  [ -z "$staging" ] || rm -rf "$staging"
  [ -z "$current_tmp" ] || rm -f "$current_tmp"
  [ -z "$previous_tmp" ] || rm -f "$previous_tmp"
  [ -z "$desktop_tmp" ] || rm -f "$desktop_tmp"
  if [ "$status" -ne 0 ] && [ "$current_committed" -eq 0 ]; then
    if ! restore_link "$ROOT/current" "$original_current_present" "$original_current" "$current_tmp"; then
      echo "restoration failure: could not restore original current link" >&2
      status=1
    fi
    if ! restore_link "$ROOT/previous" "$original_previous_present" "$original_previous" "$previous_tmp"; then
      echo "restoration failure: could not restore original previous link" >&2
      status=1
    fi
    [ -z "$current_tmp" ] || rm -f "$current_tmp"
    [ -z "$previous_tmp" ] || rm -f "$previous_tmp"
  fi
  if [ "$promoted_by_this_invocation" -eq 1 ] && [ "$current_committed" -eq 0 ]; then
    local previous_target=""
    [ -L "$ROOT/current" ] && current_target="$(readlink -f "$ROOT/current" || true)"
    [ -L "$ROOT/previous" ] && previous_target="$(readlink -f "$ROOT/previous" || true)"
    if [ "$target" != "$current_target" ] && [ "$target" != "$previous_target" ]; then
      rm -rf "$target"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

staging="$(mktemp -d "$ROOT/releases/.staging-XXXXXXXX")"
invocation_id="${staging##*/}"
current_tmp="$(mktemp "$ROOT/.current-new-XXXXXXXX")"
previous_tmp="$(mktemp "$ROOT/.previous-new-XXXXXXXX")"
desktop_tmp="$(mktemp "$APPLICATIONS_DIR/.$binary.desktop.XXXXXXXX")"
rm "$current_tmp" "$previous_tmp"

mkdir -p "$staging/bin" "$staging/lib/$product_name"
cp "$RELEASE_DIR/$binary" "$staging/bin/$binary"
chmod 755 "$staging/bin/$binary"
cp -R "$RELEASE_DIR/sound" "$staging/lib/$product_name/sound"
cp "$ICON" "$staging/icon.png"
printf 'commit %s\nshort %s\nsubject %s\ninstalled %s\nprovenance %s\n' \
  "$head" "$short" "$(git -C "$REPO" log -1 --format=%s "$head")" \
  "$(date --iso-8601=seconds)" "$provenance" > "$staging/VERSION"
printf '%s\ninvocation %s\n' "$managed_marker_value" "$invocation_id" > "$staging/$managed_marker_name"
mv -T "$staging" "$target"
target_owned=1
staging=""

desktop_root="${ROOT//\\/\\\\}"
desktop_root="${desktop_root//\"/\\\"}"
desktop_icon_root="${desktop_root// /\\s}"
cat > "$desktop_tmp" <<EOF
[Desktop Entry]
Type=Application
Name=$product_name
GenericName=Chess analysis and database
GenericName[de]=Schachanalyse und Datenbank
Comment=Analyse games, search databases, play against engines
Comment[de]=Partien analysieren, Datenbanken durchsuchen, gegen Engines spielen
Exec="$desktop_root/current/bin/$binary"
Icon=$desktop_icon_root/current/icon.png
Terminal=false
StartupNotify=true
StartupWMClass=$binary
Categories=Game;BoardGame;
EOF
chmod 644 "$desktop_tmp"

ln -s "$target" "$current_tmp"
if [ "$original_current_present" -eq 1 ]; then
  ln -s "$original_current" "$previous_tmp"
  mv -T "$previous_tmp" "$ROOT/previous"
fi
if ! mv -T "$current_tmp" "$ROOT/current"; then
  echo "current publication failed; installed state will be restored" >&2
  exit 1
fi
current_committed=1

if ! mv -T "$desktop_tmp" "$DESKTOP"; then
  echo "desktop publication failed after install committed: current=$target; rollback=$ROOT/previous" >&2
  exit 1
fi
desktop_tmp=""

# Retire desktop entries a previous version of this installer published under a different
# basename. Without this, every rename of the binary leaves the old entry behind and the
# application menu lists the app twice, which is what productName-derived naming did on
# 2026-09-09. Only regular files whose Exec points into this install root are removed; a symlink
# is somebody else's file and is left alone.
for stale in "$APPLICATIONS_DIR"/*.desktop; do
  [ -f "$stale" ] && [ ! -L "$stale" ] || continue
  [ "$stale" != "$DESKTOP" ] || continue
  grep -E '^Exec=' "$stale" | grep -qF "$ROOT/current/bin/" || continue
  # Best-effort: current and the entry are already published, so a failed unlink must report
  # itself rather than abort a completed install through set -e.
  if rm -f "$stale"; then
    echo "retired superseded desktop entry $stale"
  else
    echo "could not retire superseded desktop entry $stale; the application menu may list $product_name twice" >&2
  fi
done

is_marked_managed_release() {
  local candidate="$1" header invocation extra
  [ -f "$candidate/$managed_marker_name" ] &&
    [ ! -L "$candidate/$managed_marker_name" ] || return 1
  {
    IFS= read -r header
    IFS= read -r invocation
    IFS= read -r extra || true
  } < "$candidate/$managed_marker_name"
  [ "$header" = "$managed_marker_value" ] || return 1
  [[ "$invocation" =~ ^invocation\ \.staging-[A-Za-z0-9]{8}$ ]] || return 1
  [ -z "$extra" ]
}

keep_current="$(readlink -f "$ROOT/current")"
keep_previous=""
[ ! -L "$ROOT/previous" ] || keep_previous="$(readlink -f "$ROOT/previous" || true)"
for candidate in "$ROOT/releases"/*; do
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || continue
  candidate_real="$(readlink -f "$candidate")"
  [ "$candidate_real" = "$keep_current" ] && continue
  [ "$candidate_real" = "$keep_previous" ] && continue
  if is_marked_managed_release "$candidate"; then
    rm -rf "$candidate"
  fi
done

echo "installed $short → $ROOT/current/bin/$binary (desktop entry: $DESKTOP; $provenance)"
