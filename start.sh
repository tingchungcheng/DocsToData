#!/usr/bin/env bash
# DocsToData: one-command setup and start.
#
#   ./start.sh            set up anything missing, then start the app on http://localhost:8000
#   ./start.sh --check    only report what is installed / missing, change nothing
#   ./start.sh --docker   run it in Docker instead (docker compose, http://localhost:8080)
#   ./start.sh --help
#
# Options can be combined with env vars: PORT=9000 ./start.sh, NO_BROWSER=1 ./start.sh
#
# What it does (each step is skipped when already done):
#   1. finds Python 3.10+ and creates .venv
#   2. installs requirements.txt (again only when the file changes)
#   3. creates .env from .env.example
#   4. installs Tesseract for OCR of scanned PDFs (macOS via Homebrew)
#   5. installs / starts Ollama and pulls the models named in .env (unless DISABLE_OLLAMA=true)
#   6. starts the FastAPI server, which also serves the web UI, and opens the browser
#
# Works with the bash that ships with macOS (3.2) and on Linux.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

MODE="run"
case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  --docker) MODE="docker" ;;
  -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Unknown option: $1 (try --help)"; exit 1 ;;
esac

PORT="${PORT:-8000}"
VENV="$ROOT/.venv"
OS="$(uname -s)"

# ---------- output helpers ----------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '  %s✗ %s%s\n' "$R" "$1" "$N"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Read KEY from the shell env, then .env, then .env.example, then $2.
env_get() {
  local key="$1" default="${2:-}" file val
  # A variable already set in the shell wins over the files.
  if [ -n "${!key:-}" ]; then echo "${!key}"; return; fi
  for file in .env .env.example; do
    [ -f "$file" ] || continue
    val="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//')" || true
    if [ -n "$val" ]; then echo "$val"; return; fi
  done
  echo "$default"
}
is_true() { case "$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }

open_browser() {
  [ -n "${NO_BROWSER:-}" ] && return 0
  if have open; then open "$1" >/dev/null 2>&1 || true
  elif have xdg-open; then xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

# ---------- Docker mode ----------
if [ "$MODE" = "docker" ]; then
  step "Docker"
  have docker || die "Docker is not installed. Get Docker Desktop: https://www.docker.com/products/docker-desktop/"
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop and run this again."
  [ -f .env ] || { cp .env.example .env; ok "Created .env from .env.example"; }
  if ! is_true "$(env_get DISABLE_OLLAMA false)"; then
    curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1 \
      && ok "Ollama is running on this computer" \
      || warn "Ollama is not running on this computer; start it (ollama serve) or set DISABLE_OLLAMA=true in .env"
  fi
  docker compose up --build -d
  ok "Running at http://localhost:8080/   (logs: docker compose logs -f, stop: docker compose down)"
  open_browser "http://localhost:8080/"
  exit 0
fi

CHECK_FAILED=0
missing() { if [ "$MODE" = "check" ]; then warn "$1"; CHECK_FAILED=1; else die "$1"; fi; }

# ---------- 1. Python ----------
step "Python"
PYTHON=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if have "$cand" && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON="$(command -v "$cand")"; break
  fi
done
if [ -x "$VENV/bin/python" ]; then
  ok "Using existing .venv ($("$VENV/bin/python" --version 2>&1))"
elif [ -n "$PYTHON" ]; then
  if [ "$MODE" = "check" ]; then
    warn ".venv not created yet (will use $PYTHON)"
  else
    "$PYTHON" -m venv "$VENV"
    ok "Created .venv with $("$PYTHON" --version 2>&1)"
  fi
else
  if [ "$OS" = "Darwin" ]; then
    missing "Python 3.10+ not found. Install it with: brew install python@3.12   (or from https://www.python.org/downloads/)"
  else
    missing "Python 3.10+ not found. Install it with your package manager, e.g.: sudo apt install python3 python3-venv"
  fi
fi

# ---------- 2. Python packages ----------
step "Python packages"
REQ_STAMP="$VENV/.requirements.sha"
req_hash() { cat requirements.txt | { shasum 2>/dev/null || sha1sum; } | cut -d' ' -f1; }
if [ -x "$VENV/bin/python" ]; then
  if [ -f "$REQ_STAMP" ] && [ "$(cat "$REQ_STAMP")" = "$(req_hash)" ]; then
    ok "requirements.txt already installed"
  elif [ "$MODE" = "check" ]; then
    warn "requirements.txt not installed (or changed since last install)"
  else
    "$VENV/bin/python" -m pip install --quiet --upgrade pip
    "$VENV/bin/python" -m pip install --quiet -r requirements.txt
    req_hash > "$REQ_STAMP"
    ok "Installed requirements.txt"
  fi
fi

# ---------- 3. .env ----------
step "Settings (.env)"
if [ -f .env ]; then
  ok ".env exists"
elif [ "$MODE" = "check" ]; then
  warn ".env missing (will be copied from .env.example)"
else
  cp .env.example .env
  ok "Created .env from .env.example (edit it to change models, OpenAI key, etc.)"
fi
DISABLE_OLLAMA="$(env_get DISABLE_OLLAMA false)"
OPENAI_KEY="$(env_get OPENAI_API_KEY)"
if [ -z "$OPENAI_KEY" ] || [ "$OPENAI_KEY" = "your_openai_api_key_here" ]; then
  if is_true "$DISABLE_OLLAMA"; then
    missing "DISABLE_OLLAMA=true but OPENAI_API_KEY is not set in .env, so there is no model to use"
  else
    ok "No OpenAI key set: the app will use local Ollama models (add OPENAI_API_KEY to .env to use OpenAI too)"
  fi
else
  ok "OpenAI key is set"
fi

# ---------- 4. Tesseract (OCR) ----------
step "Tesseract (OCR for scanned PDFs)"
TESSERACT=""
# Prefer Homebrew's binary: an old Intel build in /usr/local can fail on Apple Silicon.
for cand in /opt/homebrew/bin/tesseract /usr/local/bin/tesseract /usr/bin/tesseract "$(command -v tesseract 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ] && "$cand" --version >/dev/null 2>&1; then TESSERACT="$cand"; break; fi
done
if ! is_true "$(env_get OCR_ENABLED true)"; then
  ok "OCR is turned off in .env (OCR_ENABLED=false)"
elif [ -z "$TESSERACT" ]; then
  if [ "$MODE" = "check" ]; then
    warn "Tesseract not installed (or not runnable): scanned / image-only PDF pages will be skipped"
  elif [ "$OS" = "Darwin" ] && have brew; then
    echo "  Installing Tesseract with Homebrew..."
    if brew install tesseract; then
      TESSERACT="$(brew --prefix)/bin/tesseract"; ok "Installed Tesseract"
    else
      warn "brew install tesseract failed: scanned PDF pages will be skipped"
    fi
  elif [ "$OS" = "Darwin" ]; then
    warn "Tesseract not installed. Install Homebrew (https://brew.sh), then: brew install tesseract. Scanned PDF pages are skipped until then."
  else
    warn "Tesseract not installed. Install it with: sudo apt install tesseract-ocr. Scanned PDF pages are skipped until then."
  fi
fi
if [ -n "$TESSERACT" ]; then
  # Tell PyMuPDF where the language files are, so it does not depend on PATH order.
  TESSDATA="$("$TESSERACT" --list-langs 2>&1 | head -n 1 | sed -n 's/.*"\(.*\)".*/\1/p')"
  [ -n "$TESSDATA" ] && export TESSDATA_PREFIX="$TESSDATA"
  ok "Tesseract $("$TESSERACT" --version 2>&1 | head -n 1 | awk '{print $2}') at $TESSERACT"
  OCR_LANG="$(env_get OCR_LANGUAGE eng)"
  LANGS="$("$TESSERACT" --list-langs 2>/dev/null | tail -n +2 || true)"
  for lang in $(echo "$OCR_LANG" | tr '+' ' '); do
    echo "$LANGS" | grep -qx "$lang" || warn "OCR language '$lang' is not installed (macOS: brew install tesseract-lang)"
  done
fi

# ---------- 5. Ollama ----------
step "Ollama (local models)"
OLLAMA_URL="$(env_get OLLAMA_BASE_URL http://localhost:11434)"
ollama_up() { curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; }
if is_true "$DISABLE_OLLAMA"; then
  ok "Skipped (DISABLE_OLLAMA=true, using OpenAI)"
else
  if ! have ollama; then
    if [ "$MODE" = "check" ]; then
      warn "Ollama not installed"
    elif [ "$OS" = "Darwin" ] && have brew; then
      echo "  Installing Ollama with Homebrew..."
      brew install ollama || die "brew install ollama failed. Install it from https://ollama.com/download"
    elif [ "$OS" = "Darwin" ]; then
      die "Ollama not installed. Download it from https://ollama.com/download, or set DISABLE_OLLAMA=true and OPENAI_API_KEY in .env"
    else
      die "Ollama not installed. Install it with: curl -fsSL https://ollama.com/install.sh | sh"
    fi
  fi
  if ollama_up; then
    ok "Ollama is running at $OLLAMA_URL"
  elif [ "$MODE" = "check" ]; then
    warn "Ollama is not running at $OLLAMA_URL"
  else
    echo "  Starting Ollama in the background (log: data/ollama.log)..."
    mkdir -p data
    nohup ollama serve >data/ollama.log 2>&1 &
    for _ in $(seq 1 30); do ollama_up && break; sleep 1; done
    ollama_up || die "Ollama did not start. See data/ollama.log, or open the Ollama app and run this again."
    ok "Ollama started"
  fi
  if ollama_up; then
    INSTALLED="$(ollama list 2>/dev/null | tail -n +2 | awk '{print $1}')"
    for model in "$(env_get OLLAMA_CHAT_MODEL qwen3.5:9b)" "$(env_get OLLAMA_EMBED_MODEL nomic-embed-text:latest)"; do
      base="${model%:latest}"
      if echo "$INSTALLED" | grep -qx -e "$model" -e "$base" -e "$base:latest"; then
        ok "Model $model is downloaded"
      elif [ "$MODE" = "check" ]; then
        warn "Model $model is not downloaded"
      else
        echo "  Downloading model $model (can be several GB the first time)..."
        ollama pull "$model" || die "Could not download $model"
        ok "Model $model downloaded"
      fi
    done
  fi
fi

if [ "$MODE" = "check" ]; then
  echo
  if [ "$CHECK_FAILED" = 0 ]; then echo "${G}Ready.${N} Run ./start.sh to start the app."; else echo "${Y}Some required pieces are missing (see above). Run ./start.sh to set them up.${N}"; fi
  exit 0
fi

# ---------- 6. Start ----------
step "Starting DocsToData"
URL="http://localhost:$PORT/"
if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then
  ok "Already running at $URL"
  open_browser "$URL"
  exit 0
fi
if have lsof && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "Port $PORT is used by another program. Pick another one: PORT=8001 ./start.sh"
fi
mkdir -p data
ok "Open $URL   (API docs: ${URL}docs). Press Ctrl+C to stop."
( for _ in $(seq 1 60); do curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1 && { open_browser "$URL"; break; }; sleep 1; done ) &
exec "$VENV/bin/python" -m uvicorn backend.app:app --host 127.0.0.1 --port "$PORT"
