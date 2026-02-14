# VibeCloud — Deployment Guide

## Service Details

| Field | Value |
|-------|-------|
| **Service Name** | `vibecloud-soundcloud-downloader` |
| **GCP Project ID** | `gen-lang-client-0831040732` |
| **GCP Project Name** | Primary Account - Free Credits |
| **Project Number** | `765441234018` |
| **Region** | `us-west1` |
| **Cloud Run URL** | https://vibecloud-soundcloud-downloader-765441234018.us-west1.run.app |
| **Custom Domain** | https://vibecloud.micahberkley.com |
| **Port** | `8080` |
| **GCP Account** | `micahberkley@gmail.com` |

## How to Deploy

### Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Docker (only needed for local testing, Cloud Build handles remote builds)

### One-Command Deploy

From the project root (`~/dev/VibeCloud`):

```bash
gcloud run deploy vibecloud-soundcloud-downloader \
  --source . \
  --region us-west1 \
  --project gen-lang-client-0831040732 \
  --allow-unauthenticated \
  --port 8080 \
  --quiet
```

This will:
1. Upload source to Cloud Build
2. Build the Docker image using `Dockerfile`
3. Push to Artifact Registry
4. Deploy new revision to Cloud Run
5. Route 100% traffic to the new revision

### What Gets Built

- **Build stage**: `node:20-alpine` runs `npm ci && npm run build` (Vite)
- **Serve stage**: `nginx:alpine` serves the static `dist/` folder on port 8080
- **Config**: `nginx.conf` handles SPA routing (`try_files` fallback to `index.html`)

### Files Involved

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build (Node build + Nginx serve) |
| `nginx.conf` | Nginx config for SPA routing and caching |
| `.dockerignore` | Excludes node_modules, .git, .env.local from build context |

## Custom Domain

The domain `vibecloud.micahberkley.com` is mapped to this Cloud Run service via Google Cloud Run domain mappings. It was set up on Dec 20, 2025. Redeploying the service does NOT affect the domain mapping — it stays pointed to the same service.

## Troubleshooting

### Permission Denied on Deploy

If you get `PERMISSION_DENIED` errors about the default service account:

```bash
gcloud projects add-iam-policy-binding gen-lang-client-0831040732 \
  --member="serviceAccount:765441234018-compute@developer.gserviceaccount.com" \
  --role="roles/storage.objectViewer"

gcloud projects add-iam-policy-binding gen-lang-client-0831040732 \
  --member="serviceAccount:765441234018-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder"
```

### Wrong Project

Make sure you're targeting the right project. The project number `765441234018` maps to project ID `gen-lang-client-0831040732`. Check with:

```bash
gcloud run services describe vibecloud-soundcloud-downloader \
  --region us-west1 \
  --project gen-lang-client-0831040732
```

### Check Logs

```bash
gcloud run services logs read vibecloud-soundcloud-downloader \
  --region us-west1 \
  --project gen-lang-client-0831040732 \
  --limit 50
```
