---
title: MLAVS Production
emoji: 🧠
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
---

# MLAVS Production

MLAVS is a privacy-first attendance verification system that keeps face processing in the browser, sends only 128-dimensional embeddings to a FastAPI backend, and forwards structured audit events to Google Sheets through Google Apps Script.

## Project Structure

```text
mlavs-production/
├── .dockerignore
├── Dockerfile
├── requirements.txt
├── backend/
│   ├── main.py
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── app.js
│   ├── models/
│   │   └── README.md
│   └── styles.css
├── google-apps-script/
│   └── code.gs
└── README.md
```

## What This Implements

- Multi-image enrollment with five guided poses and local face embedding generation.
- Session start verification against multiple reference embeddings using cosine similarity.
- Random attendance checkpoints every 8 to 15 minutes with browser confirmation and PIN fallback.
- Passive monitoring with tab visibility and interaction counts batched every 10 seconds.
- Final scoring using the required weights:
  - `40%` identity confidence
  - `30%` checkpoint completion rate
  - `20%` session duration ratio normalized to a 3-hour cap
  - `10%` behavioral consistency
- Async Google Apps Script webhook dispatch for enrollment, verification failure, session start, checkpoint, and session end events.

## Privacy and Security Notes

- Raw images and video never leave the browser. Only numeric embeddings and session metadata are sent to the backend.
- The backend uses a single allowed CORS origin via `FRONTEND_ORIGIN`. Set this to your deployed frontend origin before production use.
- Add HTTPS everywhere in deployment. Browser camera APIs and sensitive attendance events should never run over plain HTTP in production.
- This starter keeps users and sessions in memory for portability. Do not use the in-memory stores for multi-instance or long-lived production deployments.

## Backend Setup

1. Create a virtual environment and install dependencies.

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

2. Set environment variables.

```powershell
$env:FRONTEND_ORIGIN="https://your-frontend.example"
$env:GS_WEB_APP_URL="https://script.google.com/macros/s/your-web-app-id/exec"
$env:DRIVE_FOLDER_ID="your_google_drive_folder_id"
$env:MATCH_THRESHOLD="0.6"
```

3. Run the API locally.

```bash
uvicorn main:app --host 0.0.0.0 --port 7860
```

Available routes:

- `POST /api/v1/enroll`
- `POST /api/v1/login`
- `POST /api/v1/start`
- `POST /api/v1/checkpoint`
- `POST /api/v1/passive`
- `POST /api/v1/exit`
- `GET /api/v1/health`

## Frontend Setup

1. Update `API_BASE` in [frontend/app.js](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/frontend/app.js:1) to your Hugging Face Space or local backend URL.
2. Serve the `frontend/` directory with any static file server.

```bash
cd frontend
python -m http.server 5500
```

3. Open `http://localhost:5500`.

Notes:

- The app now uses the maintained `@vladmandic/face-api` browser bundle and the accuracy-oriented `ssdMobilenetv1` detector together with `faceLandmark68Net` and `faceRecognitionNet`.
- The frontend first looks for local model assets under `frontend/models/` and falls back to the official CDN if they are missing.
- The checkpoint PIN is hardcoded in the client as a demonstration fallback. Replace it with a server-issued one-time code flow before real deployment.

## Google Apps Script Setup

1. Open a new Apps Script project bound to a Google Sheet.
2. Paste in [google-apps-script/code.gs](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/google-apps-script/code.gs:1).
3. Create or note a Drive folder for audit JSON files.
4. Deploy the script as:
   - Execute as: `Me`
   - Who has access: `Anyone with the link`
5. Copy the deployed web app URL into `GS_WEB_APP_URL`.

The script will:

- Create the `MLAVS_Attendance` sheet if missing.
- Freeze the header row.
- Append a structured row for each event.
- Write a lightweight JSON audit file to Drive when `drive_folder_id` is provided.

## Hugging Face Spaces Deployment

This repo is now prepared for a Docker Space. Hugging Face expects the YAML block at the top of this README and a root-level `Dockerfile`.

### Files added for Space deployment

- [Dockerfile](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/Dockerfile:1)
- [requirements.txt](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/requirements.txt:1)
- [frontend/models/README.md](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/frontend/models/README.md:1)

### How it works

- The container installs Python dependencies from the root `requirements.txt`.
- FastAPI serves both the API and the static frontend on port `7860`.
- If you include the model files inside `frontend/models/`, the Space can run without depending on the model CDN at runtime.

Recommended environment variables in the Space settings:

- `FRONTEND_ORIGIN`
- `GS_WEB_APP_URL`
- `DRIVE_FOLDER_ID`
- `MATCH_THRESHOLD`

Use port `7860` for compatibility with Space defaults.

### Deploy steps

1. Create a new Hugging Face Space with `Docker` as the SDK.
2. Push this project into the Space repo.
3. Add secrets for `FRONTEND_ORIGIN`, `GS_WEB_APP_URL`, and `DRIVE_FOLDER_ID`.
4. Optionally vendor the face model files into `frontend/models/` before pushing.
5. Once built, your Space will serve the UI at `/` and the API under `/api/v1/*`.

## Production Migration Path

Move the demo in-memory stores to durable services before production:

- Replace `users_store` with PostgreSQL plus `pgvector`, Pinecone, Weaviate, or another encrypted vector-capable store.
- Replace `sessions_store` with PostgreSQL and Redis for distributed session state and checkpoint scheduling.
- Add authentication and authorization with JWT or your SSO provider.
- Move PIN fallback issuance and validation to the backend.
- Add rate limiting, audit alerting, and observability with Prometheus, Grafana, and Sentry.
- Add a real task queue for external logging retries if webhook delivery matters operationally.

## Known Constraints

- Browser `confirm()` dialogs are intentionally simple and portable, but they are not a polished UX. Replace them with accessible in-page modals for production.
- `face-api.js` descriptor size may differ by model family. This implementation assumes 128-dimensional vectors per your specification.
- `beforeunload` logging is best-effort. `navigator.sendBeacon()` improves reliability, but unexpected tab or browser crashes can still cause event loss.

## Validation Checklist

- Endpoints are typed with Pydantic v2 models and structured HTTP error handling.
- Verification compares one live embedding against multiple stored reference embeddings.
- Scoring weights exactly match `40/30/20/10`.
- Passive monitoring relies on standard browser APIs only.
- Checkpoints randomize between 8 and 15 minutes and include a PIN fallback path.
- Google Apps Script creates the sheet automatically and logs all events without storing raw media.
