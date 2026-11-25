#!/usr/bin/env bash
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${RC_BROWSER_CORE:-}" && -f "$here/../../src/browser-tools.mjs" ]]; then
 export RC_BROWSER_CORE="$(cd "$here/../../src" && pwd)/browser-tools.mjs"
fi
exec node "$here/cli.mjs" "$@"
