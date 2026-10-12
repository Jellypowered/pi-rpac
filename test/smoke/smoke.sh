#!/usr/bin/env bash
# Smoke test: verify the RPAC extension loads and its /rpac command dispatches
# in the *installed* Pi (not a mock). It runs in an isolated temp git repo so it
# never touches your real project.
#
# Usage:
#   bash test/smoke/smoke.sh                 # uses your configured default model
#   bash test/smoke/smoke.sh --model X/Y     # force a specific model
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../" && pwd)"
EXT="$ROOT/extensions/rpac.ts"

# Resolve the pi binary (PATH first, then the global install).
PI="$(command -v pi || true)"
if [[ -z "$PI" ]]; then
  for c in /root/.hermes/node/bin/pi "$HOME/.hermes/node/bin/pi" "$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent/dist/bundle/cli.js"; do
    if [[ -x "$c" || -f "$c" ]]; then PI="$c"; break; fi
  done
fi
if [[ -z "$PI" ]]; then echo "ERROR: could not find the pi binary" >&2; exit 1; fi

WORK="$(mktemp -d /tmp/rpac-smoke.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q
git config user.email smoke@test
git config user.name smoke
echo "hello" > app.txt
git add -A && git commit -qm init

MODEL_ARGS=()
if [[ "${1:-}" == "--model" ]]; then
  MODEL_ARGS=(--model "${2:?--model needs a value}")
fi

echo "==> pi binary: $PI"
echo "==> working dir: $WORK"

# 1) /rpac start — should create the index (.pi/rpac/state.json) and a
#    per-workflow directory (.pi/rpac/<id>/workflow.json) in refine phase.
echo "==> running: pi -e <rpac> /rpac start 'add a greeting function'"
"$PI" -e "$EXT" "${MODEL_ARGS[@]}" --no-tools --print "/rpac start add a greeting function" \
  >/dev/null 2>"$WORK/stderr.log" || true

IDX="$WORK/.pi/rpac/state.json"
if [[ ! -f "$IDX" ]]; then
  echo "FAIL: .pi/rpac/state.json (index) was not created" >&2
  sed 's/^/  stderr: /' "$WORK/stderr.log" >&2
  exit 1
fi

WID="$(python3 -c "import json;print(json.load(open('$IDX')).get('active') or '')")"
if [[ -z "$WID" || "$WID" == "None" ]]; then
  echo "FAIL: index has no active workflow" >&2
  sed 's/^/  stderr: /' "$WORK/stderr.log" >&2
  exit 1
fi
WF="$WORK/.pi/rpac/$WID/workflow.json"
if [[ ! -f "$WF" ]]; then
  echo "FAIL: per-workflow state $WF was not created" >&2
  sed 's/^/  stderr: /' "$WORK/stderr.log" >&2
  exit 1
fi

PHASE="$(python3 -c "import json;print(json.load(open('$WF'))['phase'])")"
TASK="$(python3 -c "import json;print(json.load(open('$WF'))['task'])")"
BASELINE="$(python3 -c "import json;print(bool(json.load(open('$WF')).get('baseline')))")"

echo "    workflow=$WID phase=$PHASE task='$TASK' git_baseline=$BASELINE"
if [[ "$PHASE" != "refine" ]]; then echo "FAIL: expected phase 'refine', got '$PHASE'" >&2; exit 1; fi
if [[ "$TASK" != "add a greeting function" ]]; then echo "FAIL: task not recorded" >&2; exit 1; fi

echo "PASS: RPAC extension loaded and /rpac start dispatched correctly in the installed Pi."
# Note: a 'turn_end could not resolve the persisted assistant entry ID' line in
# stderr is a known Pi-core quirk for follow-up messages in --print mode (reproduces
# with any extension that calls sendUserMessage), not an RPAC bug.
