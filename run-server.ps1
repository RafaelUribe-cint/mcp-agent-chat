# ──────────────────────────────────────────────────────────────────────────────
# run-server.ps1
# Clones (or updates) mcp-agent-chat, builds it, then opens two windows:
#   Window 1 — broker  (http://localhost:3456)
#   Window 2 — server-app  (listens on SSE, spawns claude for every message)
#
# Requirements: git, node >= 18, npm, claude CLI in PATH
# Run with:  powershell -ExecutionPolicy Bypass -File run-server.ps1
# ──────────────────────────────────────────────────────────────────────────────

$REPO_URL          = "https://github.com/RafaelUribe-cint/mcp-agent-chat.git"
$INSTALL_DIR       = "$env:USERPROFILE\mcp-agent-chat"
$PROJECT_DIR       = "C:\Users\rsalcedo\Desktop\repos\ACGME.Applications.Git"
$API_KEY           = "7b4c6905decf31848f058f0a9aacf0291f878ea89ccec7a4"
$SESSION_NAME      = "claude-server"
$STATUS_INTERVAL_MS = "10000"
$PORT              = "3456"

# ── 1. Clone or update the repo ───────────────────────────────────────────────
if (Test-Path "$INSTALL_DIR\.git") {
    Write-Host "[setup] Updating repo at $INSTALL_DIR"
    git -C $INSTALL_DIR pull --ff-only
} else {
    Write-Host "[setup] Cloning repo to $INSTALL_DIR"
    git clone $REPO_URL $INSTALL_DIR
}

# ── 2. Install dependencies and build ─────────────────────────────────────────
Write-Host "[setup] Installing dependencies..."
npm --prefix $INSTALL_DIR install --silent

Write-Host "[setup] Building..."
npm --prefix $INSTALL_DIR run build

# ── 3. Start broker in a new window ───────────────────────────────────────────
$brokerCmd = @"
`$env:PORT    = '$PORT'
`$env:API_KEY = '$API_KEY'
Write-Host '[broker] Starting on port $PORT'
node '$INSTALL_DIR\dist\index.js'
"@

Start-Process powershell -ArgumentList "-NoExit", "-Command", $brokerCmd

# Give the broker a moment to bind its port before the server-app connects
Start-Sleep -Seconds 2

# ── 4. Start server-app in a new window ───────────────────────────────────────
$serverAppCmd = @"
`$env:BROKER_URL          = 'http://localhost:$PORT'
`$env:API_KEY             = '$API_KEY'
`$env:SESSION_NAME        = '$SESSION_NAME'
`$env:PROJECT_DIR         = '$PROJECT_DIR'
`$env:STATUS_INTERVAL_MS  = '$STATUS_INTERVAL_MS'
Write-Host '[server-app] Starting — session: $SESSION_NAME'
Write-Host '[server-app] Project dir: $PROJECT_DIR'
node '$INSTALL_DIR\dist\server-app.js'
"@

Start-Process powershell -ArgumentList "-NoExit", "-Command", $serverAppCmd

Write-Host ""
Write-Host "Both processes started."
Write-Host "  Broker    -> http://localhost:$PORT"
Write-Host "  Session   -> $SESSION_NAME"
Write-Host "  MCP URL   -> http://localhost:$PORT/mcp"
Write-Host ""
Write-Host "Add to .mcp.json in any Claude Code project:"
Write-Host "  { `"agent-chat`": { `"type`": `"streamable-http`", `"url`": `"http://localhost:$PORT/mcp`", `"headers`": { `"Authorization`": `"Bearer $API_KEY`" } } }"
