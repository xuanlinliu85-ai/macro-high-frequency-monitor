[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $ExpectedCommit,
    [string] $RepoRoot,
    [string] $IfindLocalHome = $env:IFIND_LOCAL_HOME,
    [string] $NpmCommand = $(if ($env:MACRO_NPM_COMMAND) { $env:MACRO_NPM_COMMAND } else { "npm.cmd" }),
    [string] $NodeCommand = $(if ($env:MACRO_NODE_COMMAND) { $env:MACRO_NODE_COMMAND } else { "node.exe" }),
    [switch] $AllowLegacyInsecureUpstream,
    [switch] $PublishHandoff
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$logRoot = Join-Path $RepoRoot "work\logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$logPath = Join-Path $logRoot ("daily-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
function Protect-LogLine([string] $Line) {
    $safe = $Line -replace '(?i)(Bearer\s+)[A-Za-z0-9._~-]+', '$1[REDACTED]'
    $safe = $safe -replace '(?i)([?&](?:api_key|token|access_token|key)=)[^&\s]+', '$1[REDACTED]'
    if ($env:IFIND_API_KEY) { $safe = $safe -replace [regex]::Escape($env:IFIND_API_KEY), '[REDACTED]' }
    return $safe
}
function Write-RunLog([string] $Message) {
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), (Protect-LogLine $Message)
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Write-Host $line
}
function Invoke-Logged([string] $Step, [string] $File, [string[]] $Arguments) {
    Write-RunLog "START $Step"
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $File @Arguments 2>&1 | ForEach-Object { Write-RunLog ([string] $_) }
        $nativeExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($nativeExitCode -ne 0) { throw "$Step failed with exit code $nativeExitCode" }
    Write-RunLog "PASS $Step"
}
try {
    if (-not $IfindLocalHome) { throw "IFIND_LOCAL_HOME is required" }
    $IfindLocalHome = (Resolve-Path -LiteralPath $IfindLocalHome).Path
    if (-not (Test-Path -LiteralPath (Join-Path $IfindLocalHome "scripts\ifind-mcp-client.mjs") -PathType Leaf)) { throw "External iFinD capability is missing scripts\ifind-mcp-client.mjs" }
    if (-not $AllowLegacyInsecureUpstream -and $env:IFIND_ALLOW_LEGACY_INSECURE_UPSTREAM -ne "1") { throw "LEGACY_INSECURE_UPSTREAM requires explicit -AllowLegacyInsecureUpstream" }
    $safeRoot = $RepoRoot.Replace('\', '/')
    $actualCommit = (& git -c "safe.directory=$safeRoot" -C $RepoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Unable to read source commit" }
    if ($actualCommit -ne $ExpectedCommit) { throw "Source commit mismatch: expected $ExpectedCommit, actual $actualCommit" }
    $dirty = (& git -c "safe.directory=$safeRoot" -C $RepoRoot status --porcelain --untracked-files=no) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Unable to read source status" }
    if ($dirty) { throw "Tracked sourceDirty=true" }
    if ($NpmCommand.EndsWith(".js", [System.StringComparison]::OrdinalIgnoreCase)) {
        $npmFile = (Get-Command $NodeCommand -ErrorAction Stop).Source
        $npmPrefix = @((Resolve-Path -LiteralPath $NpmCommand).Path)
    } else { $npmFile = (Get-Command $NpmCommand -ErrorAction Stop).Source; $npmPrefix = @() }
    $env:IFIND_PROVIDER = "local"
    $env:IFIND_LOCAL_HOME = $IfindLocalHome
    $env:IFIND_ALLOW_LEGACY_INSECURE_UPSTREAM = "1"
    $env:IFIND_ALLOW_INSECURE_HTTP = "1"
    $env:MACRO_MODE = "daily"
    Write-RunLog "RUN sourceCommit=$actualCommit provider=local classification=LEGACY_INSECURE_UPSTREAM"
    foreach ($script in @("collect", "snapshot", "report", "workbench", "handoff", "check-handoff")) { Invoke-Logged "npm run $script" $npmFile ($npmPrefix + @("run", $script)) }
    if ($PublishHandoff) { Invoke-Logged "npm run publish-handoff" $npmFile ($npmPrefix + @("run", "publish-handoff")) }
    Write-RunLog "RUN PASS"
} catch { Write-RunLog ("RUN FAIL: {0}" -f $_.Exception.Message); exit 1 }
