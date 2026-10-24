#!/bin/sh
# GitHub-primary WorkLoom helper; CNB remains a deferred mirror.
set -eu
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec python3 "$SCRIPT_DIR/workloom-context.py" context "$@"
