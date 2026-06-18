#!/usr/bin/env bash
# evo benchmark: score = passing tests (max), outputs JSON
cd "$(dirname "$0")/.."

OUTPUT=$(node --experimental-sqlite --import tsx --test $(ls tests/*.test.ts | tr '\n' ' ') 2>&1 || true)

PASS=$(echo "$OUTPUT" | awk '/^ℹ pass/ {sum+=$3} END {print sum+0}')
FAIL=$(echo "$OUTPUT" | awk '/^ℹ fail/ {sum+=$3} END {print sum+0}')

RESULT="{\"score\": $PASS, \"pass\": $PASS, \"fail\": $FAIL}"
echo "$RESULT"
if [ -n "$EVO_RESULT_PATH" ]; then
  echo "$RESULT" > "$EVO_RESULT_PATH"
fi
