[CmdletBinding()]
param(
  [string]$ClientId,
  [string]$ApplicationName = "Codex",
  [string]$InstallRoot = $HOME,
  [switch]$SkipConfig,
  [switch]$SkipMarketplace,
  [switch]$SkipStartup
)

$ErrorActionPreference = "Stop"
$pluginName = "codex-discord-presence"
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot ".codex-plugin\plugin.json"))) {
  throw ".codex-plugin\plugin.json was not found next to install.ps1."
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$localNodePath = if ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"
}
$nodePath = if ($localNodePath -and (Test-Path -LiteralPath $localNodePath)) {
  $localNodePath
} elseif ($nodeCommand) {
  $nodeCommand.Source
}

if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath)) {
  throw "Node.js 22.5 or newer is required. Install Node.js, then run install.ps1 again."
}
$nodeVersion = (& $nodePath --version).Trim()
$nodeSemver = $null
try {
  $nodeSemver = [version]($nodeVersion.TrimStart("v"))
} catch {
  throw "Could not parse the Node.js version: $nodeVersion"
}
if ($nodeSemver -lt [version]"22.5.0") {
  throw "Node.js 22.5 or newer is required. Found $nodeVersion."
}

$homeRoot = [IO.Path]::GetFullPath($InstallRoot)
$destRoot = [IO.Path]::GetFullPath((Join-Path $homeRoot ".codex\plugins\$pluginName"))
if (-not $destRoot.StartsWith($homeRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to install outside the selected install root."
}

New-Item -ItemType Directory -Force -Path $destRoot | Out-Null
Get-ChildItem -LiteralPath $sourceRoot -Force |
  Where-Object { $_.Name -notin @(".git", "node_modules", "test", "test-support") } |
  Copy-Item -Destination $destRoot -Recurse -Force

Remove-Item -LiteralPath (Join-Path $destRoot "plugin.json") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $destRoot "mcp.json") -Force -ErrorAction SilentlyContinue

$destMcpPath = Join-Path $destRoot ".mcp.json"
$destMcp = Get-Content -LiteralPath $destMcpPath -Raw | ConvertFrom-Json
$destMcp.mcpServers.'discord-presence'.command = $nodePath
$destMcp.mcpServers.'discord-presence'.args = @(
  (Join-Path $destRoot "server\index.js")
)
$destMcpJson = $destMcp | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText(
  $destMcpPath,
  "$destMcpJson`n",
  [Text.UTF8Encoding]::new($false)
)
Write-Host "Configured the plugin to launch with $nodePath" -ForegroundColor Green

if (-not $SkipConfig) {
  if (-not $ClientId) {
    Write-Host ""
    Write-Host "Discord Application ID (press Enter to configure later):" -ForegroundColor Cyan
    $ClientId = Read-Host
  }

  if ($ClientId) {
    $ClientId = $ClientId.Trim()
    $ApplicationName = $ApplicationName.Trim()
    if ($ClientId -notmatch "^\d{15,25}$") {
      throw "The Discord Application ID must contain 15-25 digits."
    }
    if (-not $ApplicationName -or $ApplicationName.Length -gt 64 -or $ApplicationName -match "[\x00-\x1f\x7f]") {
      throw "ApplicationName must be 1-64 characters without control characters."
    }

    $configDir = Join-Path $InstallRoot ".codex-discord-presence"
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    $configPath = Join-Path $configDir "config.json"
    $json = [ordered]@{
      clientId = $ClientId
      applicationName = $ApplicationName
    } | ConvertTo-Json
    [IO.File]::WriteAllText($configPath, "$json`n", [Text.UTF8Encoding]::new($false))
    Write-Host "Saved Discord Application ID to $configPath" -ForegroundColor Green
  }
}

if (-not $SkipMarketplace) {
  $marketplaceDir = Join-Path $InstallRoot ".agents\plugins"
  $marketplacePath = Join-Path $marketplaceDir "marketplace.json"
  New-Item -ItemType Directory -Force -Path $marketplaceDir | Out-Null

  $marketplace = $null
  if (Test-Path -LiteralPath $marketplacePath) {
    try {
      $marketplace = Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json
    } catch {
      throw "Could not parse the existing marketplace at $marketplacePath. Fix or remove that file, then run install.ps1 again."
    }
  }

  $entry = [ordered]@{
    name = $pluginName
    source = [ordered]@{
      source = "local"
      path = "./.codex/plugins/$pluginName"
    }
    policy = [ordered]@{
      installation = "AVAILABLE"
      authentication = "ON_INSTALL"
    }
    category = "Productivity"
  }

  $existingEntries = @()
  if ($marketplace -and $marketplace.plugins) {
    $existingEntries = @($marketplace.plugins | Where-Object { $_.name -ne $pluginName })
  }
  $existingEntries += [pscustomobject]$entry

  if ($marketplace) {
    if (-not $marketplace.name) {
      $marketplace | Add-Member -NotePropertyName name -NotePropertyValue "personal" -Force
    }
    if (-not $marketplace.interface) {
      $marketplace | Add-Member -NotePropertyName interface -NotePropertyValue ([pscustomobject]@{ displayName = "Personal Plugins" }) -Force
    } elseif (-not $marketplace.interface.displayName) {
      $marketplace.interface | Add-Member -NotePropertyName displayName -NotePropertyValue "Personal Plugins" -Force
    }
    $marketplace.plugins = @($existingEntries)
    $nextMarketplace = $marketplace
  } else {
    $nextMarketplace = [ordered]@{
      name = "personal"
      interface = [ordered]@{
        displayName = "Personal Plugins"
      }
      plugins = @($existingEntries)
    }
  }

  $marketplaceJson = $nextMarketplace | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText(
    $marketplacePath,
    "$marketplaceJson`n",
    [Text.UTF8Encoding]::new($false)
  )
  Write-Host "Updated personal marketplace at $marketplacePath" -ForegroundColor Green
}

if ($env:OS -eq "Windows_NT" -and -not $SkipStartup) {
  $startupDir = [Environment]::GetFolderPath("Startup")
  if (-not $startupDir) {
    $startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
  }
  New-Item -ItemType Directory -Force -Path $startupDir | Out-Null

  $liveScript = Join-Path $destRoot "server\live-presence.js"
  $startupScript = Join-Path $startupDir "CodexDiscordPresence.vbs"
  $vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run """$nodePath"" ""$liveScript""", 0, False
"@
  [IO.File]::WriteAllText(
    $startupScript,
    "$vbs`r`n",
    [Text.UnicodeEncoding]::new($false, $true)
  )
  Write-Host "Installed the hidden startup watcher at $startupScript" -ForegroundColor Green

  $configPath = Join-Path $InstallRoot ".codex-discord-presence\config.json"
  if (Test-Path -LiteralPath $configPath) {
    Remove-Item -LiteralPath (Join-Path $InstallRoot ".codex-discord-presence\live.stop") -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$startupScript`"" -WindowStyle Hidden
    Write-Host "Started the live presence watcher." -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "Installed Discord Codex Presence." -ForegroundColor Green
Write-Host "1. Restart the ChatGPT desktop app."
Write-Host "2. Open Plugins Directory -> Personal Plugins and install 'Discord Codex Presence'."
Write-Host "3. Start a new chat, type @, choose the plugin, and ask:"
Write-Host "   把 Discord 状态改成正在玩 Codex"
Write-Host ""
Write-Host "Keep the Discord desktop app open and enable 'Display current activity as a status message' in Discord settings."
