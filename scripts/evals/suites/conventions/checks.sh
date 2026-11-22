#!/usr/bin/env bash
# Objective static checks for the conventions suite.
# Usage: checks.sh <repo-dir> <task-id>      (task-id: g1 | g2 | g3)
# The repo must be a git repository with a baseline commit. Checks grade ONLY the files the agent
# changed or added (git diff --name-only against the eval-baseline tag, or HEAD when it is absent,
# plus untracked files, under packages/). Every check
# is gated on the task's function having been written or changed by the agent, so an agent that
# did nothing scores 0. Prints one "name<TAB>pass|fail" line per applicable check. Deterministic.

repo="${1:-}"
task="${2:-}"
[ -n "$repo" ] && [ -n "$task" ] || { echo "usage: checks.sh <repo-dir> <task-id>" >&2; exit 2; }
[ -d "$repo" ] || { echo "checks.sh: no such directory: $repo" >&2; exit 2; }
cd "$repo" || exit 2
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "checks.sh: not a git repository: $repo" >&2; exit 2; }

case "$task" in
  g1) fn=updateOrder ;;
  g2) fn=cancelOrder ;;
  g3) fn=listOrdersByStatus ;;
  *) echo "unknown task: $task" >&2; exit 2 ;;
esac

# Diff against the harness's `eval-baseline` tag when it exists (so committed work still counts),
# else against HEAD.
BASE=HEAD
git rev-parse -q --verify refs/tags/eval-baseline >/dev/null 2>&1 && BASE=eval-baseline

# --- the agent's changed files ------------------------------------------------------------------
CHANGED=()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in
    packages/*.ts) ;;
    *) continue ;;
  esac
  case "$f" in */node_modules/*|*/hidden-*) continue ;; esac
  CHANGED+=("$f")
done < <({ git diff --relative --name-only --diff-filter=ACMR "$BASE"; git ls-files --others --exclude-standard; } | sort -u)

SRC=()   # changed source files
TESTS=() # changed spec/test files
for f in ${CHANGED[@]+"${CHANGED[@]}"}; do
  case "$f" in
    *.spec.ts|*.test.ts) TESTS+=("$f") ;;
    *) SRC+=("$f") ;;
  esac
done

# Source files that declare the task function.
FN_FILES=()
for f in ${SRC[@]+"${SRC[@]}"}; do
  grep -qE "(function|const)[[:space:]]+$fn\\b" "$f" && FN_FILES+=("$f")
done
# Changed tests that mention the task function.
FN_TESTS=()
for f in ${TESTS[@]+"${TESTS[@]}"}; do
  grep -qE "\\b$fn\\b" "$f" && FN_TESTS+=("$f")
done

# --- text helpers -------------------------------------------------------------------------------
# Source with comments removed (whole-line, block and trailing) but strings kept.
nocomments() {
  [ "$#" -gt 0 ] || return 0
  node -e '
    const fs = require("fs");
    process.stdout.on("error", () => {});
    for (const file of process.argv.slice(1)) {
      const s = fs.readFileSync(file, "utf8"); let out = ""; let i = 0;
      while (i < s.length) {
        const c = s[i], n = s[i + 1];
        if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
        if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
        if (c === "\"" || c === "\x27" || c === "`") {
          const q = c; out += c; i++;
          while (i < s.length && s[i] !== q) { if (s[i] === "\\") { out += s[i++]; } out += s[i++]; }
          out += q; i++; continue;
        }
        out += c; i++;
      }
      process.stdout.write(out + "\n");
    }' "$@"
}
# Same, with string literal contents blanked (so words inside strings never match).
nostrings() {
  nocomments "$@" | node -e '
    process.stdout.on("error", () => {});
    const s = require("fs").readFileSync(0, "utf8");
    process.stdout.write(s.replace(/"(?:[^"\\\n]|\\.)*"|\x27(?:[^\x27\\\n]|\\.)*\x27|`(?:[^`\\]|\\.)*`/g, "\"\""));'
}
src_code() { nocomments ${SRC[@]+"${SRC[@]}"}; }
src_nostr() { nostrings ${SRC[@]+"${SRC[@]}"}; }
test_nostr() { nostrings ${TESTS[@]+"${TESTS[@]}"}; }

# --- predicates (return 0 for pass) --------------------------------------------------------------
p_exported_from_index() {
  local f base
  for f in "${FN_FILES[@]}"; do
    base=$(basename "$f" .ts)
    grep -qE "from [\"']\./$base[\"']" packages/orders/src/index.ts 2>/dev/null && return 0
  done
  grep -qE "\\b$fn\\b" packages/orders/src/index.ts 2>/dev/null
}
p_no_throw() { ! src_nostr | grep -qE '\bthrow\b'; }
p_no_console() { ! { src_nostr; test_nostr; } | grep -qE '\bconsole\.'; }
p_spec_naming() {
  # no changed/added *.test.* files, and the task's tests are *.spec.ts files
  local f
  for f in ${TESTS[@]+"${TESTS[@]}"}; do case "$f" in *.test.*) return 1 ;; esac; done
  for f in ${FN_TESTS[@]+"${FN_TESTS[@]}"}; do case "$f" in *.spec.ts) return 0 ;; esac; done
  return 1
}
p_tests_added() {
  local min=2 f total=0 n
  [ "$task" = g3 ] || min=3
  for f in ${FN_TESTS[@]+"${FN_TESTS[@]}"}; do
    n=$(nocomments "$f" | grep -cE '^[[:space:]]*(it|test)(\.each\([^)]*\))?\(')
    total=$((total + n))
  done
  [ "$total" -ge "$min" ]
}
p_uses_result_import() {
  grep -qE 'from "@acme/result"' "${FN_FILES[@]}" && nostrings "${FN_FILES[@]}" | grep -qE 'Result<|\berr\('
}
p_uses_define_error() { src_code | grep -qE '\bdefineError\('; }
p_tagged_errors() {
  ! src_nostr | grep -qE 'class[[:space:]]+[A-Za-z_]+[[:space:]]+extends[[:space:]]+[A-Za-z]*Error|new[[:space:]]+[A-Za-z]*Error\('
}
p_uses_update_where_version() { src_nostr | grep -qE '\bupdateWhereVersion\b'; }
p_no_unguarded_update() { ! src_nostr | grep -qE '\.update[<(]'; }
p_uses_outbox_enqueue() { src_nostr | grep -qE 'outbox\.enqueue\('; }
p_no_direct_publish() { ! src_nostr | grep -qE '\.publish\('; }
p_enqueue_in_transaction() {
  # every changed file that enqueues does so with a transaction handle, inside db.transaction(...)
  local f any=1
  for f in ${SRC[@]+"${SRC[@]}"}; do
    nostrings "$f" | grep -qE 'outbox\.enqueue\(' || continue
    any=0
    nostrings "$f" | grep -qE '\.transaction(<[^>]*>)?\(' || return 1
    nostrings "$f" | grep -E 'outbox\.enqueue\(' | grep -qE 'enqueue\((ctx\.)?db\b' && return 1
  done
  return $any
}
p_versioned_topic() {
  # every `topic:` value (literal, or a named const defined in the changed files) matches the house pattern
  src_code | node -e '
    process.stdout.on("error", () => {});
    const s = require("fs").readFileSync(0, "utf8");
    const house = /^[a-z]+\.v[0-9]+\.[a-z]+(-[a-z]+)*$/;
    const values = [...s.matchAll(/\btopic\s*:\s*("(?:[^"\\]|\\.)*"|\x27(?:[^\x27\\]|\\.)*\x27|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$.]*(?:\([^)]*\))?)/g)].map((m) => m[1].trim());
    for (const m of s.matchAll(/\btopic\s*[,}]/g)) values.push("topic");
    if (values.length === 0) process.exit(1);
    for (const v of values) {
      let lit = /^(["`\x27])(.*)\1$/.exec(v)?.[2];
      if (lit === undefined && /^[A-Za-z_$][\w$]*$/.test(v)) {
        lit = new RegExp("(?:const|let)\\s+" + v.replace("$", "\\$") + "\\s*(?::[^=]+)?=\\s*([\"`\x27])([^\"`\x27]*)\\1").exec(s)?.[2];
      }
      if (lit === undefined || !house.test(lit)) process.exit(1);
    }'
}
p_topic_names_event() {
  case "$task" in
    g1) src_code | grep -qE 'orders\.v[0-9]+\.updated' ;;
    g2) src_code | grep -qE 'orders\.v[0-9]+\.cancel' ;;
  esac
}
p_idempotency_key() {
  # an idempotencyKey property whose value (inline, or the variable it names) is deterministic and
  # contains a version component
  src_code | node -e '
    process.stdout.on("error", () => {});
    const s = require("fs").readFileSync(0, "utf8");
    const exprs = [];
    const def = (name) =>
      new RegExp("(?:const|let)\\s+" + name + "\\s*(?::[^=]+)?=\\s*([^;\\n]+)").exec(s)?.[1];
    for (const m of s.matchAll(/\bidempotencyKey\s*:\s*("(?:[^"\\]|\\.)*"|\x27(?:[^\x27\\]|\\.)*\x27|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$.]*(?:\([^)]*\))?)/g)) {
      const v = m[1].trim();
      exprs.push(/^[A-Za-z_$][\w$]*$/.test(v) ? (def(v) ?? "") : v);
    }
    for (const m of s.matchAll(/\bidempotencyKey\s*[,}]/g)) exprs.push(def("idempotencyKey") ?? "");
    if (exprs.length === 0) process.exit(1);
    const random = /randomUUID|Math\.random|Date\.now|newId\(/;
    if (exprs.some((e) => random.test(e))) process.exit(1);
    if (!exprs.some((e) => /ersion/.test(e))) process.exit(1);'
}
p_ids_via_newid() { ! src_nostr | grep -qE 'randomUUID|Math\.random|\buuid|crypto\.|Date\.now'; }
p_no_wall_clock() { ! src_nostr | grep -qE 'new[[:space:]]+Date\(|Date\.now\('; }
p_uses_log() {
  src_code | grep -qE 'from "@acme/log"' && src_nostr | grep -qE '\blog\.(info|warn|error)\('
}
p_uses_testkit() {
  local f
  [ "${#FN_TESTS[@]}" -gt 0 ] || return 1
  for f in "${FN_TESTS[@]}"; do grep -qE 'from "@acme/testkit"' "$f" || return 1; done
}
p_uses_expect_helpers() {
  [ "${#FN_TESTS[@]}" -gt 0 ] && nocomments "${FN_TESTS[@]}" | grep -qE '\bexpect(Ok|Err)\('
}
p_uses_drain_outbox() {
  [ "${#FN_TESTS[@]}" -gt 0 ] && nocomments "${FN_TESTS[@]}" | grep -qE '\bdrainOutbox\('
}

# --- run -----------------------------------------------------------------------------------------
GATE=1
[ "${#FN_FILES[@]}" -gt 0 ] && GATE=0
check() {
  local name=$1; shift
  if [ "$GATE" -eq 0 ] && "$@" >/dev/null 2>&1; then printf '%s\t%s\n' "$name" pass; else printf '%s\t%s\n' "$name" fail; fi
}

check task_function_written true
check exported_from_index p_exported_from_index
check no_throw p_no_throw
check no_console p_no_console
check spec_naming p_spec_naming
check tests_added p_tests_added
check uses_result_import p_uses_result_import
check uses_define_error p_uses_define_error
check tagged_errors p_tagged_errors
check uses_testkit p_uses_testkit
check uses_expect_helpers p_uses_expect_helpers
case "$task" in
  g1|g2)
    check uses_update_where_version p_uses_update_where_version
    check no_unguarded_update p_no_unguarded_update
    check uses_outbox_enqueue p_uses_outbox_enqueue
    check no_direct_publish p_no_direct_publish
    check enqueue_in_transaction p_enqueue_in_transaction
    check versioned_topic p_versioned_topic
    check topic_names_event p_topic_names_event
    check idempotency_key p_idempotency_key
    check ids_via_newid p_ids_via_newid
    check no_wall_clock p_no_wall_clock
    check uses_log p_uses_log
    check uses_drain_outbox p_uses_drain_outbox
    ;;
esac
exit 0
