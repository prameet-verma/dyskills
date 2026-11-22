#!/usr/bin/env bash
# Objective static checks for the conventions suite.
# Usage: checks.sh <repo-dir> <task-id>      (task-id: g1 | g2 | g3)
# Prints one "name<TAB>pass|fail" line per check that applies to the task. Deterministic:
# plain grep over the files under packages/orders/src, hidden-* specs excluded.
set -u

repo="${1:?usage: checks.sh <repo-dir> <task-id>}"
task="${2:?usage: checks.sh <repo-dir> <task-id>}"
src="$repo/packages/orders/src"

case "$task" in
  g1) fn=updateOrder ;;
  g2) fn=cancelOrder ;;
  g3) fn=listOrdersByStatus ;;
  *) echo "unknown task: $task" >&2; exit 2 ;;
esac

# Non-spec and spec sources of the orders package (agent-written files only).
src_files() { /usr/bin/find "$src" -type f -name '*.ts' ! -name '*.spec.ts' ! -name 'hidden-*' 2>/dev/null | sort; }
spec_files() { /usr/bin/find "$src" -type f -name '*.spec.ts' ! -name 'hidden-*' 2>/dev/null | sort; }
# Print the lines of the given files with whole-line comments dropped.
code() { [ "$#" -gt 0 ] && /usr/bin/grep -hvE '^[[:space:]]*(//|\*|/\*)' "$@" 2>/dev/null; return 0; }

# shellcheck disable=SC2046
SRC=$(src_files)
SPECS=$(spec_files)
# Files that declare the task's function.
FN_FILES=$(for f in $SRC; do /usr/bin/grep -qE "(function|const)[[:space:]]+$fn\\b" "$f" && echo "$f"; done)

report() { printf '%s\t%s\n' "$1" "$2"; }
check() { local name=$1; shift; if "$@"; then report "$name" pass; else report "$name" fail; fi; }

# --- predicates (each returns 0 for pass) ---------------------------------------------------
p_task_function_exists() { [ -n "$FN_FILES" ]; }
p_exported_from_index() {
  [ -n "$FN_FILES" ] || return 1
  local f base
  for f in $FN_FILES; do
    base=$(basename "$f" .ts)
    [ "$base" = index ] && continue
    /usr/bin/grep -qE "from [\"']\./$base[\"']" "$src/index.ts" 2>/dev/null && return 0
  done
  /usr/bin/grep -qE "\\b$fn\\b" "$src/index.ts" 2>/dev/null
}
p_no_throw() { ! code $SRC | /usr/bin/grep -qE '\bthrow\b'; }
p_no_console() { ! code $SRC $SPECS | /usr/bin/grep -qE '\bconsole\.'; }
p_spec_naming() {
  # no *.test.* files or test directories under packages, and at least one *.spec.ts mentions the task
  [ -z "$(/usr/bin/find "$repo/packages" \( -name node_modules -prune \) -o \( -name '*.test.*' -o -type d -name '__tests__' -o -type d -name test \) -print 2>/dev/null)" ] || return 1
  local f
  for f in $SPECS; do /usr/bin/grep -qE "\\b$fn\\b" "$f" && return 0; done
  return 1
}
p_tests_added() {
  # test cases in spec files that mention the task function; the stub's updateOrder.spec.ts
  # already has two, so g1 must exceed that.
  local min=2 f total=0 n
  [ "$task" = g1 ] && min=3
  for f in $SPECS; do
    /usr/bin/grep -qE "\\b$fn\\b" "$f" || continue
    n=$(/usr/bin/grep -cE '^[[:space:]]*(it|test)(\.each)?\(' "$f")
    total=$((total + n))
  done
  [ "$total" -ge "$min" ]
}
p_uses_result_import() {
  [ -n "$FN_FILES" ] || return 1
  /usr/bin/grep -qE 'from "@acme/result"' $FN_FILES && code $FN_FILES | /usr/bin/grep -qE '\b(ok|err)\('
}
p_tagged_errors() { ! code $SRC | /usr/bin/grep -qE '\berr\(([[:space:]]*["`'"'"']|new )|class [A-Za-z_]+ extends [A-Za-z]*Error|new [A-Za-z]*Error\('; }
p_uses_update_where_version() { code $SRC | /usr/bin/grep -qE 'updateWhereVersion'; }
p_no_unguarded_update() { ! code $SRC | /usr/bin/grep -qE '\.update[<(]'; }
p_uses_outbox_enqueue() { [ "$(code $SRC | /usr/bin/grep -cE 'outbox\.enqueue\(')" -ge 2 ]; }
p_enqueue_in_transaction() {
  # every file that enqueues does so with a transaction handle, inside db.transaction(...)
  local f any=1
  for f in $SRC; do
    /usr/bin/grep -qE 'outbox\.enqueue\(' "$f" || continue
    any=0
    /usr/bin/grep -qE '\.transaction(<[^>]*>)?\(' "$f" || return 1
    code "$f" | /usr/bin/grep -E 'outbox\.enqueue\(' | /usr/bin/grep -qE 'enqueue\((ctx\.)?db\b' && return 1
  done
  return $any
}
p_versioned_topic() {
  [ "$(code $SRC | /usr/bin/grep -cE '["`'"'"']orders\.v[0-9]+\.[a-z-]+["`'"'"']')" -ge 2 ] || return 1
  # every topic literal must be versioned and dotted
  ! code $SRC | /usr/bin/grep -E 'topic:[[:space:]]*["`'"'"']' | /usr/bin/grep -vE 'topic:[[:space:]]*["`'"'"'][a-z]+\.v[0-9]+\.[a-z-]+["`'"'"']'
}
p_topic_names_event() {
  case "$task" in
    g1) code $SRC | /usr/bin/grep -qE 'orders\.v[0-9]+\.updated' ;;
    g2) code $SRC | /usr/bin/grep -qE 'orders\.v[0-9]+\.cancel' ;;
  esac
}
p_idempotency_key() {
  [ "$(code $SRC | /usr/bin/grep -cE 'idempotencyKey')" -ge 2 ] || return 1
  ! code $SRC | /usr/bin/grep -E 'idempotencyKey' | /usr/bin/grep -qE 'randomUUID|Math\.random|Date\.now|newId\('
}
p_ids_via_newid() { ! code $SRC | /usr/bin/grep -qE 'randomUUID|Math\.random|\buuid|crypto\.'; }
p_uses_testkit() {
  local f seen=1
  for f in $SPECS; do
    /usr/bin/grep -qE "\\b$fn\\b" "$f" || continue
    seen=0
    /usr/bin/grep -qE 'from "@acme/testkit"' "$f" || return 1
  done
  return $seen
}
p_uses_drain_outbox() {
  local f
  for f in $SPECS; do
    /usr/bin/grep -qE "\\b$fn\\b" "$f" && /usr/bin/grep -qE 'drainOutbox' "$f" && return 0
  done
  return 1
}

# --- which checks apply to which task --------------------------------------------------------
check task_function_exists p_task_function_exists
check exported_from_index p_exported_from_index
check no_throw p_no_throw
check no_console p_no_console
check spec_naming p_spec_naming
check tests_added p_tests_added
check uses_result_import p_uses_result_import
check tagged_errors p_tagged_errors
check uses_testkit p_uses_testkit
case "$task" in
  g1|g2)
    check uses_update_where_version p_uses_update_where_version
    check no_unguarded_update p_no_unguarded_update
    check uses_outbox_enqueue p_uses_outbox_enqueue
    check enqueue_in_transaction p_enqueue_in_transaction
    check versioned_topic p_versioned_topic
    check topic_names_event p_topic_names_event
    check idempotency_key p_idempotency_key
    check ids_via_newid p_ids_via_newid
    check uses_drain_outbox p_uses_drain_outbox
    ;;
esac
exit 0
