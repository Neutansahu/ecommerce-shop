# Builds the React app, uploads it to the frontend bucket and clears the CloudFront cache.
#   powershell -ExecutionPolicy Bypass -File .\scripts\deploy-frontend.ps1
param(
  [string]$StackName = "shop-stack",
  [string]$Region = "ap-south-1"
)

function Get-StackOutput($key) {
  $v = aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" --output text
  if ($LASTEXITCODE -ne 0 -or -not $v) { throw "Could not read output $key from stack $StackName" }
  return $v
}

$bucket = Get-StackOutput "FrontendBucketName"
$dist = Get-StackOutput "DistributionId"
$site = Get-StackOutput "SiteUrl"

Push-Location (Join-Path $PSScriptRoot "..\client")
try {
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  aws s3 sync dist/ "s3://$bucket" --delete --region $Region
  if ($LASTEXITCODE -ne 0) { throw "S3 upload failed" }
  aws cloudfront create-invalidation --distribution-id $dist --paths "/*" | Out-Null
} finally {
  Pop-Location
}

Write-Host "Done. Open $site"
