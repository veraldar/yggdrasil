# shellcheck shell=bash disable=SC2034  # sourced: its variables are read by install.sh and join.sh
# model-step.sh — the model step: the same choices and the same words on every system (decision L15).
# Sourced by install.sh (the home computer) and join.sh (a computer that joins: Linux, WSL, macOS); the Windows
# installer shows the same step (win/veraldar.nsi — win/model-step-check.sh keeps the two in step).
# Plain sh-compatible bash 3.2 (macOS): no arrays of arrays, no ${x,,}.
#
#   model_preset PROVIDER       zai | openrouter | anthropic | openai | other  →  P_LABEL P_URL P_STYLE P_MODEL
#                               P_MODELS (the choices, the default first; '' = any) — returns 1 for another name
#   model_step home|join        ask, in a terminal. Sets MODEL_PROVIDER (same | a provider) and, unless "same",
#                               YGG_UPSTREAM_BASE_URL / _STYLE / _MODEL / _API_KEY (shell variables, not exported).
#                               "Same as the home root" is offered only when joining, and is the default there;
#                               Z AI comes first on a home install.
#   model_from_provider PROVIDER [MODEL]   no terminal (--model-provider): the provider's address and kind, MODEL
#                               or its default, the key from YGG_UPSTREAM_API_KEY. Returns 1 with MODEL_ERR set.
# The key is read without echo, kept in a variable, and written by the caller only to the brain's env file
# (mode 600). Nothing here prints it or logs it.

MODEL_PROVIDERS='zai openrouter anthropic openai other'
model_preset() {
  P_URL='' P_STYLE=openai P_MODEL='' P_MODELS=''
  case $1 in
    zai)        P_LABEL='Z AI';       P_URL=https://api.z.ai/api/anthropic; P_STYLE=anthropic
                P_MODEL=glm-5.3-flash;      P_MODELS='glm-5.3-flash glm-5.3 glm-5.2' ;;
    openrouter) P_LABEL='OpenRouter'; P_URL=https://openrouter.ai/api/v1;   P_STYLE=openai
                P_MODEL=openai/gpt-4o-mini ;;
    anthropic)  P_LABEL='Anthropic';  P_URL=https://api.anthropic.com;      P_STYLE=anthropic
                P_MODEL=claude-fable-5-2;   P_MODELS='claude-fable-5-2 claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5' ;;
    openai)     P_LABEL='OpenAI';     P_URL=https://api.openai.com/v1;      P_STYLE=openai
                P_MODEL=gpt-4o-mini ;;
    other)      P_LABEL='Other' ;;
    *) return 1 ;;
  esac
}

model_from_provider() { # PROVIDER [MODEL]
  MODEL_ERR=''
  model_preset "$1" || { MODEL_ERR="--model-provider: same, zai, openrouter, anthropic, openai or other (got $1)"; return 1; }
  MODEL_PROVIDER=$1
  if [ "$1" = other ]; then
    [ -n "${YGG_UPSTREAM_BASE_URL:-}" ] || { MODEL_ERR="--model-provider other needs its address: --upstream-env FILE (YGG_UPSTREAM_BASE_URL, _STYLE, _MODEL, _API_KEY lines)"; return 1; }
    return 0
  fi
  [ -n "${YGG_UPSTREAM_API_KEY:-}" ] || { MODEL_ERR="--model-provider $1 needs the $P_LABEL API key: YGG_UPSTREAM_API_KEY in the environment (never on the command line)"; return 1; }
  YGG_UPSTREAM_BASE_URL=$P_URL; YGG_UPSTREAM_STYLE=$P_STYLE; YGG_UPSTREAM_MODEL=${2:-$P_MODEL}
}

model_step() { # home|join
  local mode=$1 list n i p a also
  if [ "$mode" = join ]; then list="same $MODEL_PROVIDERS"; else list=$MODEL_PROVIDERS; fi
  echo "Model provider"
  n=0
  for p in $list; do
    n=$((n + 1))
    if [ "$p" = same ]; then printf '  %s  %s\n' "$n" "Same as the home root"; else model_preset "$p"; printf '  %s  %s\n' "$n" "$P_LABEL"; fi
  done
  while :; do
    read -r -p "Choose [1]: " a || return 1
    a=${a:-1}
    case $a in *[!0-9]*|'') ;; *) if [ "$a" -ge 1 ] && [ "$a" -le "$n" ]; then break; fi ;; esac
  done
  i=0; for p in $list; do i=$((i + 1)); [ "$i" = "$a" ] && { MODEL_PROVIDER=$p; break; }; done
  [ "$MODEL_PROVIDER" = same ] && return 0
  model_preset "$MODEL_PROVIDER"
  if [ "$MODEL_PROVIDER" = other ]; then
    while :; do
      read -r -p "Address: " YGG_UPSTREAM_BASE_URL || return 1
      case $YGG_UPSTREAM_BASE_URL in http://?*|https://?*) break ;; esac
      echo "  The address starts with https:// (or http:// for a model on your own network)."
    done
    read -r -p "Kind openai|anthropic [openai]: " YGG_UPSTREAM_STYLE || return 1
    case $YGG_UPSTREAM_STYLE in anthropic) ;; *) YGG_UPSTREAM_STYLE=openai ;; esac
    while :; do read -r -p "Model: " YGG_UPSTREAM_MODEL || return 1; [ -n "$YGG_UPSTREAM_MODEL" ] && break; done
    read -r -s -p "Key (not shown; empty for a model on your own network): " YGG_UPSTREAM_API_KEY || return 1; echo
    return 0
  fi
  YGG_UPSTREAM_BASE_URL=$P_URL; YGG_UPSTREAM_STYLE=$P_STYLE
  while :; do
    read -r -s -p "$P_LABEL API key (not shown): " YGG_UPSTREAM_API_KEY || return 1; echo
    [ -n "$YGG_UPSTREAM_API_KEY" ] && break
  done
  also=''; for p in $P_MODELS; do [ "$p" = "$P_MODEL" ] || also="$also${also:+, }$p"; done
  read -r -p "Model [$P_MODEL]${also:+ (or $also)}: " YGG_UPSTREAM_MODEL || return 1
  YGG_UPSTREAM_MODEL=${YGG_UPSTREAM_MODEL:-$P_MODEL}
}
