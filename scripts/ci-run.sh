#!/usr/bin/env bash
# Runs a CI step and, if it fails, turns the end of its output into an error annotation
# (readable from the checks API even where raw logs are not).
set -o pipefail
title="$1"; shift
out=$(mktemp)
if "$@" 2>&1 | tee "$out"; then exit 0; fi
body=$(tail -c 3500 "$out" | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g')
echo "::error title=${title}::${body}"
exit 1
