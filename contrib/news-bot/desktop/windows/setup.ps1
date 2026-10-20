# News Radar for Windows: first-run setup. Called by "News Radar.bat".
#  1. Downloads a private copy of Node.js (nothing is installed on your computer, no admin rights).
#  2. Copies the News Radar program next to it.
#  3. Adds a News Radar shortcut to your desktop.
# Everything goes in %LOCALAPPDATA%\NewsRadar. To remove News Radar, delete that folder and the shortcut.

param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = 'Stop'
# Older Windows 10 builds offer only old TLS versions unless told otherwise; nodejs.org needs TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion = '22.22.2'
# SHA-256 of node-v22.22.2-win-x64.zip, as published at https://nodejs.org/dist/v22.22.2/SHASUMS256.txt
$NodeSha256 = '7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c'

$Source = [IO.Path]::GetFullPath($Source)
$Target = [IO.Path]::GetFullPath($Target)
$nodeDir = Join-Path $Target 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'
$program = Join-Path $Target 'program'
New-Item -ItemType Directory -Force -Path $Target | Out-Null

# 1. Node.js
if (-not (Test-Path -LiteralPath $nodeExe)) {
  Write-Host 'First start: downloading Node.js (about 35 MB). This happens only once...'
  $zip = Join-Path $Target 'node.zip'
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $zip
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
  if ($hash -ne $NodeSha256) {
    Remove-Item -Force -LiteralPath $zip
    throw 'The Node.js download did not match its checksum, so it was thrown away. Please try again later.'
  }
  $extract = Join-Path $Target 'node-extract'
  if (Test-Path -LiteralPath $extract) { Remove-Item -Recurse -Force -LiteralPath $extract }
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  if (Test-Path -LiteralPath $nodeDir) { Remove-Item -Recurse -Force -LiteralPath $nodeDir }
  Move-Item -LiteralPath (Join-Path $extract "node-v$NodeVersion-win-x64") -Destination $nodeDir
  Remove-Item -Recurse -Force -LiteralPath $extract
  Remove-Item -Force -LiteralPath $zip
  Write-Host 'Node.js is ready.'
}

# 2. The program (replaced on every start from the download folder, so a new download updates it)
if ($Source -ne $program) {
  if (Test-Path -LiteralPath $program) { Remove-Item -Recurse -Force -LiteralPath $program }
  Copy-Item -Recurse -Force -LiteralPath $Source -Destination $program
}

# 3. Launcher copy and desktop shortcut
$launcher = Join-Path $Target 'News Radar.bat'
$launcherSource = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $Source) 'News Radar.bat'))
if ((Test-Path -LiteralPath $launcherSource) -and ($launcherSource -ne $launcher)) {
  Copy-Item -Force -LiteralPath $launcherSource -Destination $launcher
}
# A missing shortcut never stops News Radar from starting.
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $shortcut = Join-Path $desktop 'News Radar.lnk'
    if ((Test-Path -LiteralPath $launcher) -and -not (Test-Path -LiteralPath $shortcut)) {
      $shell = New-Object -ComObject WScript.Shell
      $link = $shell.CreateShortcut($shortcut)
      $link.TargetPath = $launcher
      $link.WorkingDirectory = $Target
      $link.IconLocation = (Join-Path $program 'windows\news-radar.ico')
      $link.WindowStyle = 7   # start minimised
      $link.Description = 'News Radar'
      $link.Save()
      Write-Host 'Added a News Radar shortcut to your desktop.'
    }
  }
} catch {
  Write-Host "Could not add a desktop shortcut ($($_.Exception.Message)). News Radar still works: start it with News Radar.bat."
}
