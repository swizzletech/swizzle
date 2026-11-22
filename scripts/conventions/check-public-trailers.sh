set -eu

count_public_trailers() {
  awk 'tolower($0) ~ /^public-(title|change)[[:blank:]]*:/ { count++ } END { print count + 0 }'
}

declared=$(count_public_trailers < "$1")
[ "$declared" -gt 0 ] || exit 0

trailers=$(git interpret-trailers --parse -- "$1")
parsed=$(printf '%s\n' "$trailers" | count_public_trailers)
if [ "$declared" -ne "$parsed" ]; then
  printf '%s\n' 'Move all Public-Title: and Public-Change: lines into the final trailer block. Keep other trailers in the same block, without blank lines between them.' >&2
  exit 1
fi
