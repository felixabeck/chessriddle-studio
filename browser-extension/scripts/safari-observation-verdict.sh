#!/usr/bin/env bash
# Classifies Safari's unified-log lines (standard input) for the release's Safari observation.
# Prints the lines that concern web extensions (at most 150), then one verdict line:
#   BLOCK OBSERVED
#   no block observed
#   observation unavailable: Safari logged nothing about web extensions
# Written for bash 3.2 and for the grep of macOS and of Linux alike.
set -euo pipefail

# What counts as a line about web extensions:
# - "web extension", "web-extension", "WebExtension": Safari's name for this kind of extension. A
#   bare "extension" also matches the share sheet's and the sandbox's lines, which Safari writes
#   in every run and which say nothing about a web extension (release rehearsal 45101297031).
# - "blocking extension" and "code signing dictionary": the two symptoms of a blocked Developer
#   ID build (Apple developer forum threads 667859 and 695373).
# - "chessriddle": a line that names the application or its extension in clear text. macOS
#   usually masks such names as <private>, so nothing below depends on it.
relevant=$(grep -i \
  -e 'web.\{0,1\}extension' \
  -e 'blocking extension' \
  -e 'code signing dictionary' \
  -e 'chessriddle' || true)

if [ -z "$relevant" ]; then
  echo "observation unavailable: Safari logged nothing about web extensions"
  exit 0
fi
printf '%s\n' "$relevant" | tail -n 150

# A block counts without naming the extension: the name is masked, and the runner holds no other
# web extension.
if printf '%s\n' "$relevant" | grep -i -e 'blocking extension' -e 'code signing dictionary failed' > /dev/null; then
  echo "BLOCK OBSERVED"
else
  echo "no block observed"
fi
