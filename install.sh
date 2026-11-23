#!/usr/bin/env bash
# Link this repo into the Herdr app home and bind the cockpit key.
# Safe to re-run: existing links are replaced, real files are moved aside.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS=(tabs-cockpit worktrees worktrees-menu worktrees-merge)

if [ ! -d "$APP" ]; then
  echo "No Herdr app home at $APP — start Herdr once, then run this again." >&2
  exit 1
fi

mkdir -p "$APP/layouts" "$APP/mods"

link() { # link <target> <path>
  local target="$1" path="$2"
  if [ -e "$path" ] && [ ! -L "$path" ]; then
    local backup="$path.bak-$(date +%Y%m%d%H%M%S)"
    mv "$path" "$backup"
    echo "moved aside: $backup"
  fi
  ln -sfn "$target" "$path"
  echo "linked: $path -> $target"
}

link "$REPO/layouts/cockpit.json" "$APP/layouts/cockpit.json"
link "$REPO/layouts/cockpit.svg" "$APP/layouts/cockpit.svg"
for m in "${MODS[@]}"; do
  link "$REPO/mods/$m" "$APP/mods/$m"
done

# keys.json is the person's whole keymap, so it is merged rather than linked.
python3 - "$APP/keys.json" <<'PY'
import json, os, sys

path = sys.argv[1]
try:
    keys = json.load(open(path)) if os.path.exists(path) else {}
except Exception as error:
    sys.exit(f"{path} is not valid JSON: {error}")

glob = keys.setdefault("global", {})
if glob.get("cmd-alt-w") == "worktrees.toggle":
    print("key already bound: cmd-alt-w -> worktrees.toggle")
else:
    glob["cmd-alt-w"] = "worktrees.toggle"
    json.dump(keys, open(path, "w"), indent=2)
    open(path, "a").write("\n")
    print("bound: cmd-alt-w -> worktrees.toggle")
PY

cat <<'EOF'

Done. Switch layouts with cmd-shift-l, or:
  herdr-app do layout.switch --name cockpit
EOF
