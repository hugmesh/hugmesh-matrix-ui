#!/bin/sh
# 50-snap-theme.sh — runtime login THEME injection (sibling of 40-snap-config.sh).
#
# Writes /usr/share/nginx/html/snap-theme.css from $SNAP_THEME_CSS at container
# start; index.html <link>s it, and its ":root:root { --hug-*: ... }" block beats
# the compiled :root fallbacks in styles.css by specificity. Rebrand = update the
# env (ConfigMap) + restart the pod — NO image rebuild.
#
# ZERO colour maths happens here — deliberately. $SNAP_THEME_CSS carries token
# text ALREADY derived by the single implementation (hugmesh-generator
# studio/hugmesh_studio/core/theme.py, via the Studio GUI or
# scripts/tooling/derive-theme.py). A shell re-derivation would be a second
# implementation whose drift makes the Studio preview lie, so this script only
# writes the text verbatim.
#
# Unset/empty => an EMPTY snap-theme.css: the <link> resolves with zero bytes and
# the compiled :root literals render the shipped default brand, byte-identically.
set -eu

OUT="${SNAP_THEME_OUT:-/usr/share/nginx/html/snap-theme.css}"

printf '%s' "${SNAP_THEME_CSS:-}" > "$OUT"

if [ -s "$OUT" ]; then
  echo "50-snap-theme.sh: wrote $OUT ($(wc -c < "$OUT") bytes)"
else
  echo "50-snap-theme.sh: wrote empty $OUT (no SNAP_THEME_CSS — shipped default brand)"
fi
