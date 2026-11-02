#!/bin/sh
# Installs the Swamp layout, its theme and its five mods into Herdr.
# It never overwrites: if a name is already taken, it stops and changes nothing.
# Usage: sh install.sh            (Herdr home ~/.config/herdr-app)
#        HERDR_APP_HOME=/path sh install.sh
set -eu

SRC=$(cd "$(dirname "$0")" && pwd)
HOME_DIR=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
MODS="swamp-approvals swamp-runs swamp-quickrun swamp-tabs swamp-status"

if [ ! -d "$HOME_DIR" ]; then
  echo "Herdr home not found: $HOME_DIR. Start Herdr once, then run this again." >&2
  exit 1
fi
command -v herdr-app >/dev/null 2>&1 || { echo "herdr-app is not on PATH. Start Herdr once, then run this again." >&2; exit 1; }
command -v swamp >/dev/null 2>&1 || [ -x "$HOME/.local/bin/swamp" ] || echo "Note: the swamp CLI was not found. The panels show an error until it is installed."

# 1. Stop if any name is taken.
taken=""
[ -e "$HOME_DIR/layouts/swamp.json" ] && taken="$taken layouts/swamp.json"
[ -e "$HOME_DIR/layouts/swamp.svg" ] && taken="$taken layouts/swamp.svg"
[ -e "$HOME_DIR/themes/swamp-club.json" ] && taken="$taken themes/swamp-club.json"
for m in $MODS; do [ -e "$HOME_DIR/mods/$m" ] && taken="$taken mods/$m"; done
if [ -n "$taken" ]; then
  echo "These already exist in $HOME_DIR:$taken" >&2
  echo "Nothing was copied. Remove or rename them first." >&2
  exit 1
fi

# 2. Copy. Mods first, so the layout finds them when it loads.
mkdir -p "$HOME_DIR/mods" "$HOME_DIR/layouts" "$HOME_DIR/themes"
for m in $MODS; do cp -R "$SRC/mods/$m" "$HOME_DIR/mods/$m"; done
cp "$SRC/themes/swamp-club.json" "$HOME_DIR/themes/"
cp "$SRC/layouts/swamp.svg" "$HOME_DIR/layouts/"
cp "$SRC/layouts/swamp.json" "$HOME_DIR/layouts/"

# 3. Check each mod.
fail=0
for m in $MODS; do
  if herdr-app check "$HOME_DIR/mods/$m" >/dev/null 2>&1; then echo "check passed: $m"; else echo "check FAILED: $m" >&2; fail=1; fi
done
[ "$fail" -eq 0 ] || { echo "Run: herdr-app check $HOME_DIR/mods/<name> to see the error." >&2; exit 1; }

# 4. Show the layout. Ctrl-Shift-L switches back.
herdr-app do layout.switch '{"name":"swamp"}' >/dev/null 2>&1 && echo "Switched to the swamp layout." \
  || echo "Installed. Herdr is not running: switch with Ctrl-Shift-L after it starts."
echo "Watched repos: every open space whose folder has a .swamp.yaml. To change, edit REPOS in mods/swamp-approvals, swamp-runs and swamp-quickrun main.js."
