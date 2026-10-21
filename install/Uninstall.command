#!/bin/zsh
# Double-click entry point for uninstalling the per-user bridge.
set -u

SCRIPT_DIR="$(cd "${0:A:h}" && pwd)"
cd "$SCRIPT_DIR" || exit 1
if [[ -f "$SCRIPT_DIR/install/uninstall.mjs" ]]; then
  INSTALL_ROOT="$SCRIPT_DIR"
else
  INSTALL_ROOT="${SCRIPT_DIR:h}"
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.local/bin/node"; do
  if [[ -z "$NODE_BIN" && -x "$candidate" ]]; then
    NODE_BIN="$candidate"
  fi
done
if [[ -z "$NODE_BIN" ]]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
    fi
  done
fi

if [[ -z "$NODE_BIN" ]]; then
  /usr/bin/osascript -e 'display dialog "Node.js is required to remove the MCP config entries. Install Node.js 20 or newer and run Uninstall.command again." buttons {"OK"} default button "OK" with title "Figma Local Bridge" with icon note' >/dev/null 2>&1
  exit 1
fi

/usr/bin/osascript -e 'display dialog "Remove Figma Local Bridge?\n\nThe app, its LaunchAgent and its MCP config entries will be removed. Config backups and daemon data are kept. Use --purge from the command line to remove the token too." buttons {"Cancel","Uninstall"} default button "Cancel" with title "Figma Local Bridge" with icon caution' >/dev/null 2>&1
if [[ $? -ne 0 ]]; then
  exit 0
fi

"$NODE_BIN" "$INSTALL_ROOT/install/uninstall.mjs" --gui --yes "$@"
STATUS=$?

if [[ $STATUS -ne 0 ]]; then
  printf '\nUninstall did not finish. The dialog contains the reason.\n'
fi
if [[ -t 0 ]]; then
  printf 'Press Return to close this window...'
  read -r _
fi
exit $STATUS
