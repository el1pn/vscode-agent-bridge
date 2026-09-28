#!/usr/bin/env bash
set -u

window_title=""
out=""
min_count=1
attempts=3

while (($#)); do
  case "$1" in
    --window-title)
      window_title=${2:?missing value for --window-title}
      shift 2
      ;;
    --out)
      out=${2:?missing value for --out}
      shift 2
      ;;
    --min-count)
      min_count=${2:?missing value for --min-count}
      shift 2
      ;;
    --attempts)
      attempts=${2:?missing value for --attempts}
      shift 2
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$window_title" ]]; then
  printf '%s\n' 'Missing required --window-title' >&2
  exit 2
fi
if ! [[ "$min_count" =~ ^[0-9]+$ && "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' '--min-count must be non-negative and --attempts must be positive' >&2
  exit 2
fi

clipboard_backup=$(mktemp /tmp/vscode-clipboard.XXXXXX) || exit 1
pbpaste > "$clipboard_backup"
restore_clipboard() {
  pbcopy < "$clipboard_backup"
  rm -f "$clipboard_backup"
}
trap restore_clipboard EXIT

for ((attempt = 1; attempt <= attempts; attempt++)); do
  candidate=$(mktemp /tmp/vscode-problems.XXXXXX) || exit 1

  if ! osascript - "$window_title" <<'APPLESCRIPT'
on run argv
    set targetTitle to item 1 of argv
    tell application "System Events"
        if not (exists process "Code") then error "Visual Studio Code is not running"
        tell process "Code"
            set matches to every window whose name is targetTitle
            if (count of matches) is 0 then
                set previousDelimiters to AppleScript's text item delimiters
                set AppleScript's text item delimiters to " — "
                set titleParts to text items of targetTitle
                set AppleScript's text item delimiters to previousDelimiters
                if (count of titleParts) is greater than 1 then
                    set targetSuffix to item -1 of titleParts
                    set matches to every window whose name ends with targetSuffix
                end if
            end if
            if (count of matches) is not 1 then error "Expected one VS Code window matching: " & targetTitle
            set targetWindow to item 1 of matches
            perform action "AXRaise" of targetWindow
            set frontmost to true
            delay 2
            repeat 2 times
                keystroke "p" using {command down, shift down}
                delay 2
                keystroke "Focus Problems (Errors, Warnings, Infos)"
                delay 2
                key code 36
                delay 4
            end repeat
            keystroke "a" using {command down}
            delay 2
            keystroke "c" using {command down}
            delay 3
        end tell
    end tell
end run
APPLESCRIPT
  then
    rm -f "$candidate"
    exit 1
  fi

  pbpaste > "$candidate"
  if python3 - "$candidate" "$min_count" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
minimum = int(sys.argv[2])
required = {"resource", "startLineNumber", "startColumn", "severity", "message"}
try:
    data = json.loads(path.read_text())
except Exception as exc:
    print(f"invalid JSON: {exc}", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(data, list):
    print("root value is not an array", file=sys.stderr)
    raise SystemExit(1)
missing = [index for index, item in enumerate(data) if not isinstance(item, dict) or required - item.keys()]
if len(data) < minimum or missing:
    print(f"incomplete diagnostics array: count={len(data)} missing_required={len(missing)}", file=sys.stderr)
    raise SystemExit(1)
counts = {}
for item in data:
    counts[item["severity"]] = counts.get(item["severity"], 0) + 1
print(
    f"diagnostics={len(data)} errors={counts.get(8, 0)} warnings={counts.get(4, 0)} "
    f"information={counts.get(2, 0)} hints={counts.get(1, 0)}"
)
PY
  then
    if [[ -n "$out" ]]; then
      parent=${out%/*}
      [[ "$parent" == "$out" ]] && parent=.
      if [[ ! -d "$parent" ]]; then
        printf 'Output directory does not exist: %s\n' "$parent" >&2
        rm -f "$candidate"
        exit 1
      fi
      target_tmp=$(mktemp "${out}.tmp.XXXXXX") || { rm -f "$candidate"; exit 1; }
      cp "$candidate" "$target_tmp" && mv "$target_tmp" "$out"
      rm -f "$candidate"
      printf 'saved=%s\n' "$out"
    else
      printf 'candidate=%s\n' "$candidate"
    fi
    exit 0
  fi

  rm -f "$candidate"
  printf 'Problems export attempt %d/%d was partial; retrying\n' "$attempt" "$attempts" >&2
done

printf 'Failed to export a complete Problems array after %d attempts\n' "$attempts" >&2
exit 1
