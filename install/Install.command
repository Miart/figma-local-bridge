#!/bin/zsh
# Double-click entry point for the macOS release zip.
# The actual installation is done by install/install.mjs.
set -u

SCRIPT_DIR="$(cd "${0:A:h}" && pwd)"
cd "$SCRIPT_DIR" || exit 1
if [[ -f "$SCRIPT_DIR/install/install.mjs" ]]; then
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

dialog() {
  /usr/bin/osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with title \"Figma Local Bridge\" with icon note" >/dev/null 2>&1 || true
}

if [[ -z "$NODE_BIN" ]]; then
  /usr/bin/osascript -e 'display dialog "Figma Local Bridge needs Node.js 20 or newer.\n\nInstall the LTS version from nodejs.org, then double-click Install.command again." buttons {"Open nodejs.org","Cancel"} default button "Open nodejs.org" with title "Figma Local Bridge" with icon note' >/dev/null 2>&1
  if [[ $? -eq 0 ]]; then
    /usr/bin/open "https://nodejs.org/en/download"
  fi
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  dialog "Node.js $("$NODE_BIN" -v 2>/dev/null) is too old. Install Node.js 20 or newer from nodejs.org, then run Install.command again."
  /usr/bin/open "https://nodejs.org/en/download"
  exit 1
fi

"$NODE_BIN" "$INSTALL_ROOT/install/install.mjs" --gui "$@"
STATUS=$?

if [[ $STATUS -ne 0 ]]; then
  printf '\nInstallation did not finish. The message above and the dialog contain the reason.\n'
fi
if [[ -t 0 ]]; then
  printf 'Press Return to close this window...'
  read -r _
fi
exit $STATUS
