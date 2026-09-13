[CmdletBinding(SupportsShouldProcess = $true)]
param([string] $TaskName = "MacroHighFrequencyMonitorDaily")
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Host "Task not present: $TaskName"; exit 0 }
if ($PSCmdlet.ShouldProcess($TaskName, "Unregister macro monitor task")) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Write-Host "Task removed: $TaskName"
