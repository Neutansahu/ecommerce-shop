# Replaces the app servers one by one so they pull the latest code from GitHub.
# Run this after you push backend changes (or after editing secrets in Secrets Manager).
#   powershell -ExecutionPolicy Bypass -File .\scripts\refresh-servers.ps1
param(
  [string]$StackName = "shop-stack",
  [string]$Region = "ap-south-1"
)

$asg = aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='AutoScalingGroupName'].OutputValue" --output text
if ($LASTEXITCODE -ne 0 -or -not $asg) { throw "Could not read the Auto Scaling group name" }

aws autoscaling start-instance-refresh --auto-scaling-group-name $asg --region $Region --preferences "MinHealthyPercentage=50,InstanceWarmup=120"
if ($LASTEXITCODE -ne 0) { throw "Could not start the refresh (one may already be running)" }
Write-Host "Refresh started. Watch it in EC2 > Auto Scaling groups > $asg > Instance refresh."
