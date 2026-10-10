# chaos-test.ps1
# Runs purchase flow and terminates an active service pod mid-traffic to demonstrate dropped requests and event gap.

$k6Path = "C:\Program Files\k6\k6.exe"
if (-not (Test-Path $k6Path)) {
    $k6Path = "k6"
}

Write-Host "Starting purchase-flow traffic stream..." -ForegroundColor Cyan
$proc = Start-Process $k6Path -ArgumentList "run", "scenarios/purchase-flow.js" -WorkingDirectory (Get-Location).Path -PassThru

Start-Sleep -Seconds 15
Write-Host "[CHAOS INJECTION] Killing orders pod mid-traffic..." -ForegroundColor Red
kubectl delete pod -l app=orders --wait=false

$proc.WaitForExit()
Write-Host "Chaos run finished with exit code $($proc.ExitCode)." -ForegroundColor Yellow
