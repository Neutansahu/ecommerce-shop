# Multi-tier e-commerce on AWS

| Tier | What | AWS services |
|---|---|---|
| Presentation | React storefront (Vite) | CloudFront, S3 |
| Application | Node/Express REST API | ALB, Auto Scaling EC2, Secrets Manager |
| Data | Orders, users, products, images | RDS MySQL 8.4, S3 |

```
Browser -> CloudFront --/            -> S3 (React build)
                      --/images/*    -> S3 (product images)
                      --/api/*       -> ALB -> EC2 x2-4 (Express) -> RDS MySQL
```

## Folder layout

```
ecommerce-aws/
├── infra/ecommerce-stack.yaml     CloudFormation: the whole infrastructure
├── scripts/                       PowerShell helpers (deploy stack, deploy site, refresh servers)
├── server/                        Express API (auth, products, S3 upload, orders, Razorpay)
│   ├── server.js  init-db.js  make-admin.js  schema.sql  seed.sql  package.json
└── client/                        React app (Vite)
    └── src/  App.jsx  api.js  main.jsx  styles.css
```

## Quick start

1. Push this folder to a PUBLIC GitHub repo (the servers clone it when they boot).
2. `powershell -ExecutionPolicy Bypass -File .\scripts\deploy-stack.ps1 -RepoUrl https://github.com/<you>/<repo>`
3. Seed products and make an admin through EC2 Session Manager:
   ```
   sudo -i
   source /usr/local/bin/shop-env.sh
   cd /opt/shop/server
   node init-db.js --seed
   node make-admin.js you@example.com
   ```
4. `powershell -ExecutionPolicy Bypass -File .\scripts\deploy-frontend.ps1`
5. Open the SiteUrl printed in the stack outputs.

New backend code: push to GitHub, then run `scripts\refresh-servers.ps1`.
New frontend code: run `scripts\deploy-frontend.ps1`.

## Clean up

```
aws s3 rm s3://<FrontendBucketName> --recursive
aws s3 rm s3://<ImagesBucketName> --recursive
aws cloudformation delete-stack --stack-name shop-stack
```

Never commit `.env` files or any keys. On AWS all secrets live in Secrets Manager.
