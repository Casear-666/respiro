$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force artifacts/tmp | Out-Null
$env:TEMP = (Resolve-Path artifacts/tmp).Path
$env:TMP = $env:TEMP
$files = Get-ChildItem tests/native/*.test.js | Where-Object Name -ne 'calendar-rendering.test.js' | ForEach-Object FullName
& node --test --test-timeout=45000 @files
if ($LASTEXITCODE -ne 0) { throw 'Core regression failed' }
# Existing hover/drag tests have a documented OOM; keep this gate on the two stable rendering tests.
& node --test --test-name-pattern='actual calendar|month view drops' --test-timeout=45000 tests/native/calendar-rendering.test.js
if ($LASTEXITCODE -ne 0) { throw 'Calendar rendering failed' }
& node scripts/check-package.cjs
if ($LASTEXITCODE -ne 0) { throw 'Packaged program differs from source' }
& node scripts/desktop-sync-smoke.js 'release/win-unpacked/精力日历.exe'
if ($LASTEXITCODE -ne 0) { throw 'Packaged desktop sync smoke failed' }
