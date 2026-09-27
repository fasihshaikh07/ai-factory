# AI Factory installer for Windows 10/11.
# Run in PowerShell (the first run needs "Run as administrator" if WSL isn't installed yet):
#   powershell -ExecutionPolicy Bypass -File install.ps1            (asks for your API key at the end)
#   powershell -ExecutionPolicy Bypass -File install.ps1 -NoKeys    (add keys later to ~/.factory/.env)
# Safe to run again: it skips what's already done. It sets up WSL + Ubuntu, then runs
# scripts/setup.sh inside Ubuntu (Node, Docker Engine, the factory, images, keys, Claude Code MCP).
param([switch]$NoKeys)
$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/im-ahsan/ai-factory.git"
function Step($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  OK  $t" -ForegroundColor Green }
function Note($t) { Write-Host "  ..  $t" -ForegroundColor Yellow }

Write-Host "AI Factory setup (Windows)" -ForegroundColor White

# ---------- 1. WSL + Ubuntu ----------
Step "1/4 WSL + Ubuntu"
$distros = @((wsl.exe -l -q 2>$null) -replace "`0", "" | Where-Object { $_ -match '\S' } | ForEach-Object { $_.Trim() })
$distro = $distros | Where-Object { $_ -match '^Ubuntu' } | Select-Object -First 1
if (-not $distro) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Write-Host "Installing WSL needs admin rights. Right-click PowerShell > 'Run as administrator' and run this again." -ForegroundColor Red
    exit 1
  }
  Note "Installing WSL and Ubuntu"
  wsl.exe --install -d Ubuntu
  Write-Host "`nUbuntu is installing. When its window asks, create a Linux username and password (remember the password)." -ForegroundColor White
  Write-Host "If Windows asks you to restart, restart. Then run this script again (no admin needed)." -ForegroundColor White
  exit 0
}
Ok $distro

# ---------- 2. systemd (Docker needs it) ----------
Step "2/4 Ubuntu settings"
wsl.exe -d $distro -u root -- sh -c "grep -q 'systemd=true' /etc/wsl.conf 2>/dev/null"
if ($LASTEXITCODE -ne 0) {
  wsl.exe -d $distro -u root -- sh -c "printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf"
  Note "Turned on systemd; restarting Ubuntu"
  wsl.exe --shutdown
  Start-Sleep -Seconds 3
}
Ok "systemd on"

# ---------- 3. GitHub sign-in + VS Code ----------
Step "3/4 GitHub sign-in and VS Code"
$gcm = "C:\Program Files\Git\mingw64\bin\git-credential-manager.exe"
if (Test-Path $gcm) {
  wsl.exe -d $distro -- sh -c "git config --global credential.helper >/dev/null || git config --global credential.helper '/mnt/c/Program\ Files/Git/mingw64/bin/git-credential-manager.exe'"
  Ok "Ubuntu's git uses your Windows GitHub sign-in"
} else {
  Note "Git for Windows not found. If the repo is private, install it (winget install Git.Git) and run this again, or sign in when git asks."
}
if (Get-Command code -ErrorAction SilentlyContinue) {
  Push-Location $env:TEMP   # VS Code's CLI complains when started from a \\wsl$ folder
  cmd.exe /c "code --install-extension ms-vscode-remote.remote-wsl --force >nul 2>&1"
  Pop-Location
  Ok "VS Code WSL extension"
} else {
  Note "VS Code not found (optional)"
}

# ---------- 4. everything else, inside Ubuntu ----------
Step "4/4 Installing the factory inside Ubuntu (it may ask for your Linux password)"
$setupArgs = if ($NoKeys) { "--no-keys" } else { "" }
$cmd = "cd ~ && if [ ! -d ~/ai-factory/.git ]; then git clone '$RepoUrl' ~/ai-factory; fi && ~/ai-factory/scripts/setup.sh $setupArgs"
wsl.exe -d $distro -- bash -lc $cmd
if ($LASTEXITCODE -ne 0) { Write-Host "`nSetup stopped. Read the message above, fix it, and run this script again." -ForegroundColor Red; exit 1 }

Write-Host "`nAll set. Open the factory in VS Code with:" -ForegroundColor White
Write-Host "  wsl -d $distro -- code ~/ai-factory" -ForegroundColor White
Write-Host "and use the VS Code terminal (it's already Ubuntu)." -ForegroundColor White
