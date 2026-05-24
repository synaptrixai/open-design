#!/usr/bin/env bash
set -euo pipefail

real_codex="/usr/local/bin/codex-real"
sandbox="${OD_CODEX_SANDBOX:-}"

if [[ -n "$sandbox" && "${1:-}" == "exec" ]]; then
  args=()
  replaced_sandbox=0

  while (($# > 0)); do
    case "$1" in
      --sandbox)
        shift
        if (($# > 0)); then
          shift
        fi
        args+=(--sandbox "$sandbox")
        replaced_sandbox=1
        ;;
      -c)
        if [[ "${2:-}" == sandbox_workspace_write.* ]]; then
          shift 2
        else
          args+=("$1")
          shift
          if (($# > 0)); then
            args+=("$1")
            shift
          fi
        fi
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done

  if [[ "$replaced_sandbox" == "0" ]]; then
    args+=(--sandbox "$sandbox")
  fi

  exec "$real_codex" "${args[@]}"
fi

exec "$real_codex" "$@"
