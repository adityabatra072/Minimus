#!/usr/bin/env bash
# Run a sequence of prompts through the phone and print what appeared.
#   scripts/qa/seq.sh "hello" "turn on the flashlight"
QA="/Users/aditya/Minimus/scripts/qa/qa.mjs"
for m in "$@"; do
  echo "## $m"
  node "$QA" ask "$m" | python3 -c "import json,sys
d=json.load(sys.stdin); x=d.get('data',{})
print('   %.1fs' % x.get('seconds',0))
for a in x.get('added',[]): print('   ',a)"
done
