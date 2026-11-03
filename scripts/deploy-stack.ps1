# Creates or updates the CloudFormation stack.
# Run from the project root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\deploy-stack.ps1 -RepoUrl https://github.com/<you>/<repo>
param(
  [Parameter(Mandatory = $true)][string]$RepoUrl,
  [string]$StackName = "shop-stack",
  [string]$Region = "ap-south-1",
  [string]$Branch = "main",
  [string]$AlertEmail = ""
)

$template = Join-Path $PSScriptRoot "..\infra\ecommerce-stack.yaml"

Write-Host "Validating template..."
aws cloudformation validate-template --template-body "file://$template" --region $Region | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Template validation failed" }

$overrides = @("GitHubRepoUrl=$RepoUrl", "GitHubBranch=$Branch")
if ($AlertEmail) { $overrides += "AlertEmail=$AlertEmail" }

Write-Host "Deploying stack '$StackName' (15-25 minutes the first time)..."
aws cloudformation deploy `
  --template-file $template `
  --stack-name $StackName `
  --capabilities CAPABILITY_IAM `
  --region $Region `
  --parameter-overrides $overrides
if ($LASTEXITCODE -ne 0) { throw "Deploy failed. Open CloudFormation > $StackName > Events to see the first CREATE_FAILED row." }

aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs" --output table
