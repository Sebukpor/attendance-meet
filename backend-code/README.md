---
title: MLAVS API
emoji: 🔐
colorFrom: indigo
colorTo: purple
sdk: docker
docker_port: 7860
pinned: false
---

# MLAVS API - Machine Learning Attendance Verification System

A FastAPI-based service for biometric attendance verification with:
- Face embedding enrollment & verification
- Session checkpointing & passive monitoring
- Google Apps Script webhook integration

## 🚀 Deployment

This Space runs via Docker. The container:
- Exposes port `7860`
- Runs Uvicorn with `main:app`
- Installs dependencies from `requirements.txt`

## 🔧 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MATCH_THRESHOLD` | Min similarity for identity verification | `0.6` |
| `CHECKPOINT_MINUTES_MIN` | Min checkpoint interval | `8` |
| `CHECKPOINT_MINUTES_MAX` | Max checkpoint interval | `15` |
| `GS_WEB_APP_URL` | Google Apps Script webhook URL | *(empty)* |
| `DRIVE_FOLDER_ID` | Google Drive folder for logs | *(empty)* |
| `FRONTEND_ORIGINS` | CORS allowed origins | `http://localhost:5500,http://localhost:3000` |

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Health check redirect |
| `GET` | `/api/v1/health` | System health & config |
| `POST` | `/api/v1/enroll` | Register new user |
| `POST` | `/api/v1/login` | Verify user eligibility |
| `POST` | `/api/v1/start` | Begin attendance session |
| `POST` | `/api/v1/checkpoint` | Record verification checkpoint |
| `POST` | `/api/v1/passive` | Update passive monitoring metrics |
| `POST` | `/api/v1/exit` | End session & compute final score |

## ⚙️ Local Development

```bash
# Build and run with Docker
docker build -t mlavs-api .
docker run -p 7860:7860 mlavs-api

# Or run directly (requires Python 3.11+)
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 7860