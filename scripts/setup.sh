#!/usr/bin/env bash
# AI Factory setup for Ubuntu (incl. Windows WSL) and macOS.
# Safe to run again: every step checks first and skips what's already done.
#   ./scripts/setup.sh            full setup
#   ./scripts/setup.sh --no-keys  don't ask for API keys (add them to ~/.factory/.env later)
set -euo pipefail

ASK_KEYS=1
for a in "$@"; do [ "$a" = "--no-keys" ] && ASK_KEYS=0; done

REPO_URL="${FACTORY_REPO_URL:-https://github.com/im-ahsan/ai-factory.git}"
FACTORY_DIR="${FACTORY_DIR:-$HOME/ai-factory}"
NODE_MAJOR=22
SDK_IMAGE="mcr.microsoft.com/dotnet/sdk:8.0"
IMAGES=("node:22-alpine" "postgres:16-alpine" "$SDK_IMAGE")

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '  \033[33m•\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
tty_ok() { [ -r /dev/tty ] && [ -w /dev/tty ]; }
LOG="${TMPDIR:-/tmp}/ai-factory-setup.log"
: > "$LOG"
# quiet installs; the full output goes to $LOG and is shown only on failure
quiet() { "$@" >>"$LOG" 2>&1 || { tail -25 "$LOG" >&2; die "Failed: $* (full log: $LOG)"; }; }
apt_install() { quiet sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"; }

OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM=linux; grep -qi microsoft /proc/version 2>/dev/null && PLATFORM=wsl
          # testing only: a plain Linux container on a WSL kernel isn't WSL
          [ "${FACTORY_SETUP_PLATFORM:-}" = linux ] && PLATFORM=linux ;;
  Darwin) PLATFORM=mac ;;
  *) die "Unsupported system: $OS. Use macOS, Ubuntu, or Windows with WSL (run install.ps1 on Windows)." ;;
esac
[ "$(id -u)" = 0 ] && die "Run this as your normal user, not root/sudo. It asks for your password only when needed."
case "$PWD" in /mnt/[a-z]/*) cd "$HOME" ;; esac

bold "AI Factory setup ($PLATFORM)"

# ---------- 1. base tools ----------
bold "1/7 Base tools"
if [ "$PLATFORM" = mac ]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    note "Installing Apple's command line tools (a window opens; click Install, then run this script again)"
    xcode-select --install || true
    exit 0
  fi
  if ! have brew; then
    note "Installing Homebrew (asks for your Mac password)"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
  ok "Homebrew $(brew --version | head -1 | cut -d' ' -f2)"
else
  need=()
  for p in git curl ca-certificates; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
  if [ ${#need[@]} -gt 0 ]; then
    note "Installing ${need[*]} (asks for your Linux password)"
    quiet sudo apt-get update -qq && apt_install "${need[@]}"
  fi
  if [ "$PLATFORM" = wsl ] && ! grep -q "systemd=true" /etc/wsl.conf 2>/dev/null; then
    note "Turning on systemd for WSL"
    printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf >/dev/null
    die "Done. Now run 'wsl --shutdown' in Windows PowerShell, open Ubuntu again, and re-run this script."
  fi
fi
ok "git $(git --version | cut -d' ' -f3)"

# ---------- 2. Node 22 ----------
bold "2/7 Node.js $NODE_MAJOR"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node_major() { have node && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  if ! have nvm; then
    note "Installing nvm"
    curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash >>"$LOG" 2>&1
    . "$NVM_DIR/nvm.sh"
    # load nvm in new terminals (zsh is the Mac default, bash elsewhere)
    [ "$PLATFORM" = mac ] && touch "$HOME/.zshrc"
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      [ -f "$rc" ] || continue
      grep -q 'NVM_DIR' "$rc" || printf '\nexport NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n' >> "$rc"
    done
  fi
  note "Installing Node $NODE_MAJOR"
  quiet nvm install "$NODE_MAJOR" && quiet nvm alias default "$NODE_MAJOR"
fi
ok "Node $(node -v)"

# ---------- 3. container runtime ----------
bold "3/7 Containers (the sealed rooms where builds, tests and the coding agent run)"
DOCKER=docker
if [ "$PLATFORM" = mac ]; then
  # Colima = free Docker Engine in a small Linux VM. Docker Desktop is not used (licence).
  for f in colima docker docker-buildx; do brew list "$f" >/dev/null 2>&1 || { note "Installing $f"; brew install -q "$f"; }; done
  mkdir -p "$HOME/.docker/cli-plugins"
  ln -sfn "$(brew --prefix)/opt/docker-buildx/bin/docker-buildx" "$HOME/.docker/cli-plugins/docker-buildx"
  if ! colima status >/dev/null 2>&1; then
    note "Starting Colima (4 CPUs, 8 GB RAM, 60 GB disk; first start takes a minute)"
    colima start --cpu 4 --memory 8 --disk 60 --vm-type vz --mount-type virtiofs >/dev/null 2>&1 \
      || colima start --cpu 4 --memory 8 --disk 60
  fi
  brew services list 2>/dev/null | grep -q '^colima.*started' || brew services start colima >/dev/null 2>&1 || true
  docker context use colima >/dev/null 2>&1 || true
  DOCKER="$(brew --prefix)/bin/docker"
else
  if [ ! -x /usr/bin/docker ]; then
    note "Installing Docker Engine (asks for your Linux password)"
    . /etc/os-release
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    quiet sudo apt-get update -qq && apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  fi
  # start the service only if Docker isn't already answering (it may run without systemd)
  if ! /usr/bin/docker info >/dev/null 2>&1 && ! sg docker -c "/usr/bin/docker info" >/dev/null 2>&1; then
    systemctl is-active --quiet docker 2>/dev/null || sudo systemctl enable --now docker
  fi
  DOCKER=/usr/bin/docker
  if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
    sudo usermod -aG docker "$USER"
    note "Added you to the docker group"
  fi
  # the group applies to new logins; use it for the rest of this script without logging out
  if ! "$DOCKER" info >/dev/null 2>&1; then DOCKER_SG=1; fi
fi
d() { if [ "${DOCKER_SG:-0}" = 1 ]; then sg docker -c "$DOCKER $(printf '%q ' "$@")"; else "$DOCKER" "$@"; fi; }
d info >/dev/null 2>&1 || die "Docker isn't answering. Linux: 'sudo systemctl start docker'. Mac: 'colima start'."
DOS="$(d info --format '{{.OperatingSystem}}' 2>/dev/null)"
case "$DOS" in *"Docker Desktop"*) die "Docker Desktop is answering, but the factory doesn't use it (licence). Mac: 'docker context use colima'. WSL: in Docker Desktop settings untick Ubuntu under WSL integration." ;; esac
ok "Docker $(d version --format '{{.Server.Version}}' 2>/dev/null) ($DOS)"

# ---------- 4. the factory ----------
bold "4/7 AI Factory"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && cd .. && pwd || true)"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/package.json" ] && grep -q '"name": "ai-factory"' "$SELF_DIR/package.json"; then
  FACTORY_DIR="$SELF_DIR"
elif [ ! -d "$FACTORY_DIR/.git" ]; then
  note "Downloading the factory to $FACTORY_DIR"
  git clone -q "$REPO_URL" "$FACTORY_DIR"
fi
cd "$FACTORY_DIR"
case "$FACTORY_DIR" in /mnt/[a-z]/*) die "The factory folder is on a Windows drive ($FACTORY_DIR). Clone it inside Ubuntu, e.g. ~/ai-factory." ;; esac
note "Installing packages and building (a minute)"
quiet npm ci --no-audit --no-fund --loglevel=error
npm run -s build
npm link --loglevel=error >/dev/null 2>&1 || npm link
have factory || die "The 'factory' command wasn't installed (npm link failed)."
ok "factory $(factory --version) at $FACTORY_DIR"

# ---------- 5. secrets ----------
bold "5/7 Your keys (stored only in ~/.factory/.env, readable only by you)"
mkdir -p "$HOME/.factory/projects" && chmod 700 "$HOME/.factory"
ENV_FILE="$HOME/.factory/.env"
[ -f "$ENV_FILE" ] || printf '# AI Factory secrets. Never commit or share this file.\n' > "$ENV_FILE"
chmod 600 "$ENV_FILE"
has_key() { grep -q "^$1=." "$ENV_FILE"; }
ask_key() { # name, description
  has_key "$1" && { ok "$1 already set"; return; }
  if [ "$ASK_KEYS" = 1 ] && tty_ok; then
    printf '  %s (%s)\n  Paste it and press Enter, or just press Enter to skip. Typing is hidden: ' "$1" "$2" > /dev/tty
    IFS= read -rs val < /dev/tty || val=""
    printf '\n' > /dev/tty
    if [ -n "$val" ]; then printf '%s=%s\n' "$1" "$val" >> "$ENV_FILE"; ok "$1 saved"; else note "$1 skipped; add it later to $ENV_FILE"; fi
    unset val
  else
    note "$1 not set; add it later to $ENV_FILE"
  fi
}
ask_key ANTHROPIC_API_KEY "required: console.anthropic.com → API Keys"
ask_key OPENAI_API_KEY "optional: a second model family for the critic and review"

# ---------- 6. images ----------
bold "6/7 Container images (first time: several GB, takes a few minutes)"
for img in "${IMAGES[@]}"; do
  if d image inspect "$img" >/dev/null 2>&1; then ok "$img"; else note "pulling $img"; d pull -q "$img" >/dev/null && ok "$img"; fi
done
if d image inspect factory-agent:dotnet8 >/dev/null 2>&1; then ok "factory-agent:dotnet8"; else
  note "building the coding-agent image"
  d build -q --build-arg "DOTNET_SDK=$SDK_IMAGE" -t factory-agent:dotnet8 "$FACTORY_DIR/docker/agent" >/dev/null && ok "factory-agent:dotnet8"
fi

# ---------- 7. Claude Code (MCP) ----------
bold "7/7 Claude Code integration"
if have claude; then
  if claude mcp get ai-factory >/dev/null 2>&1; then ok "MCP server 'ai-factory' already registered"
  else
    claude mcp add -s user ai-factory -- "$(command -v node)" "$FACTORY_DIR/dist/cli/index.js" mcp >/dev/null && ok "MCP server 'ai-factory' registered for Claude Code"
  fi
else
  note "Claude Code not installed; skipping (the factory works without it)"
fi

bold "Check"
factory doctor || true

cat <<EOF

Done. Next:
  1. Open a NEW terminal (so Docker permissions and Node apply).
  2. Add a project:   factory init <path-to-your-repo-or-git-url>
  3. Baseline it:     factory baseline --project <name>
  4. First run:       factory start "what to change" --project <name>
EOF
