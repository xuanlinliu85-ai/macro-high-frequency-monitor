[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)] [string] $ExpectedCommit,
    [Parameter(Mandatory = $true)] [string] $IfindLocalHome,
    [string] $RepoRoot,
    [string] $TaskName = "MacroHighFrequencyMonitorDaily",
    [string] $At = "15:20",
    [string] $NpmCommand = "npm.cmd",
    [string] $NodeCommand = "node.exe"
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$IfindLocalHome = (Resolve-Path -LiteralPath $IfindLocalHome).Path
$runner = Join-Path $RepoRoot "scripts\run-daily.ps1"
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Runner missing: $runner" }
if (-not (Test-Path -LiteralPath (Join-Path $IfindLocalHome "scripts\ifind-mcp-client.mjs") -PathType Leaf)) { throw "External iFinD capability is invalid" }
if ($ExpectedCommit -notmatch '^[0-9a-f]{40}$') { throw "ExpectedCommit must be a full 40-character Git SHA" }
if ($NpmCommand.EndsWith(".js", [System.StringComparison]::OrdinalIgnoreCase)) {
    $NpmCommand = (Resolve-Path -LiteralPath $NpmCommand).Path
    $NodeCommand = (Get-Command $NodeCommand -ErrorAction Stop).Source
} else {
    $NpmCommand = (Get-Command $NpmCommand -ErrorAction Stop).Source
    $NodeCommand = (Get-Command $NodeCommand -ErrorAction Stop).Source
}
function Quote-TaskArgument([string] $Value) { return '"' + $Value.Replace('"', '\"') + '"' }
$arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Quote-TaskArgument $runner), "-ExpectedCommit", $ExpectedCommit,
    "-RepoRoot", (Quote-TaskArgument $RepoRoot), "-IfindLocalHome", (Quote-TaskArgument $IfindLocalHome),
    "-NpmCommand", (Quote-TaskArgument $NpmCommand), "-NodeCommand", (Quote-TaskArgument $NodeCommand), "-AllowLegacyInsecureUpstream") -join " "
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $At
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
if ($PSCmdlet.ShouldProcess($TaskName, "Register weekday macro monitor task")) { Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Macro Monitor daily pipeline; explicit legacy local provider authorization" -Force | Out-Null }
Write-Host "TaskName=$TaskName"
Write-Host "Schedule=Monday-Friday $At"
Write-Host "ExpectedCommit=$ExpectedCommit"
