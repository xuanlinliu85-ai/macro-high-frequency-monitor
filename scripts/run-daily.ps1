[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $ExpectedCommit,
    [string] $RepoRoot,
    [string] $IfindLocalHome = $env:IFIND_LOCAL_HOME,
    [string] $NpmCommand = $(if ($env:MACRO_NPM_COMMAND) { $env:MACRO_NPM_COMMAND } else { "npm.cmd" }),
    [string] $NodeCommand = $(if ($env:MACRO_NODE_COMMAND) { $env:MACRO_NODE_COMMAND } else { "node.exe" }),
    [string] $AiRuntimeDir = $env:AI_RUNTIME_DIR,
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
function Invoke-AiRuntimeGit([string[]] $Arguments) {
    $safeRuntime = $AiRuntimeDir.Replace('\', '/')
    $output = & git -c "safe.directory=$safeRuntime" -C $AiRuntimeDir @Arguments
    if ($LASTEXITCODE -ne 0) { throw "ai-runtime git failed: git $($Arguments -join ' ')" }
    return ($output -join "`n").Trim()
}
function Write-PublishSummary {
    $metaPath = Join-Path $AiRuntimeDir "AI_HANDOFF_META.json"
    if (-not (Test-Path -LiteralPath $metaPath -PathType Leaf)) { throw "Published metadata missing: $metaPath" }
    $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
    $remoteCommit = Invoke-AiRuntimeGit -Arguments @("rev-parse", "HEAD")
    Write-Host "MACRO DAILY PUBLISHED"
    Write-Host "tradingDataAsOf: $($meta.tradingDataAsOf)"
    Write-Host "coverage: $($meta.dateQuality.coverage)"
    Write-Host "verify: $($meta.validation.verify.status) $($meta.validation.verify.passed)/$($meta.validation.verify.total)"
    Write-Host "handoff: $($meta.validation.handoff.status) $($meta.validation.handoff.passed)/$($meta.validation.handoff.total)"
    Write-Host "remote branch: ai-runtime"
    Write-Host "remote commit: $remoteCommit"
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
    $sourceBranch = (& git -c "safe.directory=$safeRoot" -C $RepoRoot branch --show-current).Trim()
    if ($sourceBranch -ne "main") { throw "Production runner requires main; actual branch=$sourceBranch" }
    $dirty = (& git -c "safe.directory=$safeRoot" -C $RepoRoot status --porcelain --untracked-files=no) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Unable to read source status" }
    if ($dirty) { throw "Tracked sourceDirty=true" }
    if ($NpmCommand.EndsWith(".js", [System.StringComparison]::OrdinalIgnoreCase)) {
        $NodeCommand = (Get-Command $NodeCommand -ErrorAction Stop).Source
        $npmFile = $NodeCommand
        $npmPrefix = @((Resolve-Path -LiteralPath $NpmCommand).Path)
    } else { $npmFile = (Get-Command $NpmCommand -ErrorAction Stop).Source; $npmPrefix = @(); $NodeCommand = (Get-Command $NodeCommand -ErrorAction Stop).Source }
    $nodeDirectory = Split-Path -Parent $NodeCommand
    $env:PATH = "$nodeDirectory;$env:PATH"
    $env:IFIND_PROVIDER = "local"
    $env:IFIND_LOCAL_HOME = $IfindLocalHome
    $env:IFIND_ALLOW_LEGACY_INSECURE_UPSTREAM = "1"
    $env:IFIND_ALLOW_INSECURE_HTTP = "1"
    $env:MACRO_MODE = "daily"
    if ($PublishHandoff) {
        if (-not $AiRuntimeDir) { throw "AI_RUNTIME_DIR is required for production publish" }
        $AiRuntimeDir = (Resolve-Path -LiteralPath $AiRuntimeDir).Path
        if (-not (Test-Path -LiteralPath (Join-Path $AiRuntimeDir ".git"))) { throw "AI_RUNTIME_DIR must be an existing git worktree" }
        $env:AI_RUNTIME_DIR = $AiRuntimeDir
        $runtimeBranch = Invoke-AiRuntimeGit -Arguments @("branch", "--show-current")
        if ($runtimeBranch -ne "ai-runtime") { throw "AI runtime branch must be ai-runtime; actual=$runtimeBranch" }
        [int] $pendingCount = Invoke-AiRuntimeGit -Arguments @("rev-list", "--count", "origin/ai-runtime..HEAD")
        if ($pendingCount -gt 0) {
            Write-RunLog "PENDING PUBLISH detected commits=$pendingCount; retry before collect"
            Invoke-Logged "retry pending ai-runtime publish" $npmFile ($npmPrefix + @("run", "publish-handoff", "--", "--retry-pending-only"))
            $pendingMetaPath = Join-Path $AiRuntimeDir "AI_HANDOFF_META.json"
            if (Test-Path -LiteralPath $pendingMetaPath) {
                $pendingMeta = Get-Content -LiteralPath $pendingMetaPath -Raw | ConvertFrom-Json
                $today = Get-Date -Format "yyyy-MM-dd"
                if ($pendingMeta.version -eq "2.0.0" -and $pendingMeta.runDate -eq $today -and $pendingMeta.validationStatus -eq "PASS") {
                    Write-RunLog "RUN PASS pending publication completed for current runDate"
                    Write-PublishSummary
                    exit 0
                }
            }
        }
    }
    Write-RunLog "RUN sourceCommit=$actualCommit provider=local classification=LEGACY_INSECURE_UPSTREAM"
    foreach ($script in @("collect", "snapshot", "report", "workbench", "handoff")) { Invoke-Logged "npm run $script" $npmFile ($npmPrefix + @("run", $script)) }
    Invoke-Logged "npm run check-handoff" $npmFile ($npmPrefix + @("run", "check-handoff", "--", "--output", "work/macro/handoff-check-result.json"))
    Invoke-Logged "npm run verify" $npmFile ($npmPrefix + @("run", "verify", "--", "--output", "work/macro/verify-result.json"))
    if ($PublishHandoff) { Invoke-Logged "npm run publish-handoff" $npmFile ($npmPrefix + @("run", "publish-handoff")) }
    Write-RunLog "RUN PASS"
    if ($PublishHandoff) { Write-PublishSummary }
} catch { Write-RunLog ("RUN FAIL: {0}" -f $_.Exception.Message); exit 1 }
