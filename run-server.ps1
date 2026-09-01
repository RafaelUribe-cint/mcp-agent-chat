# ──────────────────────────────────────────────────────────────────────────────
# run-server.ps1
# Clones (or updates) mcp-agent-chat and starts the server-app.
# The broker runs on Railway — no local broker process needed.
#
# Requirements: git, node >= 18, npm, claude CLI in PATH
# Run with:  powershell -ExecutionPolicy Bypass -File run-server.ps1
# ──────────────────────────────────────────────────────────────────────────────

$REPO_URL           = "https://github.com/RafaelUribe-cint/mcp-agent-chat.git"
$INSTALL_DIR        = "$env:USERPROFILE\mcp-agent-chat"
$BROKER_URL         = "https://mcp-agent-chat-production.up.railway.app"
$API_KEY            = "7b4c6905decf31848f058f0a9aacf0291f878ea89ccec7a4"
$PROJECT_DIR        = "C:\Users\rsalcedo\Desktop\repos\ACGME.Applications.Git"
$SESSION_NAME       = "claude-server"
$STATUS_INTERVAL_MS = "10000"

# ── 1. Clone or update the repo ───────────────────────────────────────────────
if (Test-Path "$INSTALL_DIR\.git") {
    Write-Host "[setup] Updating repo at $INSTALL_DIR"
    git -C $INSTALL_DIR pull --ff-only
} else {
    Write-Host "[setup] Cloning repo to $INSTALL_DIR"
    git clone $REPO_URL $INSTALL_DIR
}

# ── 2. Install dependencies and tsx globally ──────────────────────────────────
Write-Host "[setup] Installing dependencies..."
npm --prefix $INSTALL_DIR install

Write-Host "[setup] Installing tsx globally..."
npm install -g tsx

# ── 3. Start server-app via tsx (no build/tsc required) ──────────────────────
$TSX = "tsx"

$serverAppCmd = @"
`$env:BROKER_URL         = '$BROKER_URL'
`$env:API_KEY            = '$API_KEY'
`$env:SESSION_NAME       = '$SESSION_NAME'
`$env:PROJECT_DIR        = '$PROJECT_DIR'
`$env:STATUS_INTERVAL_MS = '$STATUS_INTERVAL_MS'
Write-Host '[server-app] Connecting to $BROKER_URL'
Write-Host '[server-app] Session:  $SESSION_NAME'
Write-Host '[server-app] Project:  $PROJECT_DIR'
& '$TSX' '$INSTALL_DIR\src\server-app.ts'
"@

Start-Process powershell -ArgumentList "-NoExit", "-Command", $serverAppCmd

Write-Host ""
Write-Host "Server-app started."
Write-Host "  Broker  -> $BROKER_URL"
Write-Host "  Session -> $SESSION_NAME"
Write-Host ""
Write-Host "Add to .mcp.json to send messages from Claude Code:"
Write-Host "  { `"agent-chat`": { `"type`": `"streamable-http`", `"url`": `"$BROKER_URL/mcp`", `"headers`": { `"Authorization`": `"Bearer $API_KEY`" } } }"
