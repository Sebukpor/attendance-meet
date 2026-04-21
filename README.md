# MLAVS Split Deployment

This project is organized into three independent deployment units:

```text
mlavs-production/
|-- backend-huggingface/
|   |-- main.py
|   |-- Dockerfile
|   `-- requirements.txt
|-- frontend-vercel/
|   |-- index.html
|   |-- app.js
|   |-- config.js
|   |-- styles.css
|   |-- vercel.json
|   `-- models/
|       `-- README.md
|-- google-apps-script/
|   `-- code.gs
`-- README.md
```

## Deploy Each Part

### 1. Hugging Face backend

Deploy only [backend-huggingface/main.py](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/backend-huggingface/main.py:1), [backend-huggingface/Dockerfile](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/backend-huggingface/Dockerfile:1), and [backend-huggingface/requirements.txt](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/backend-huggingface/requirements.txt:1) to a Docker Space.

Set these Hugging Face secrets:

- `FRONTEND_ORIGINS=https://your-vercel-app.vercel.app,https://your-custom-domain.com`
- `GS_WEB_APP_URL=https://script.google.com/macros/s/your-web-app-id/exec`
- `DRIVE_FOLDER_ID=your_drive_folder_id`
- `MATCH_THRESHOLD=0.6`

Persistence model:

- Google Sheets is the primary user registry.
- Google Drive stores each user's biometric embedding file as private JSON.
- The backend reads user records from Apps Script on registration, login, enrollment, and session verification.
- Users now register with `username`, `email`, and `password`.
- The backend auto-generates a copyable `user_id` for future login.

### 2. Vercel frontend

Deploy only the contents of [frontend-vercel](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/frontend-vercel:1) to Vercel as a static site.

Before deploying, update [frontend-vercel/config.js](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/frontend-vercel/config.js:1):

```js
window.MLAVS_CONFIG = {
  apiBase: "https://your-huggingface-space.hf.space/api/v1",
  modelBase: "/models",
  checkpointPin: "2468",
};
```

User flow:

1. Register with username, email, and password.
2. Copy the generated `user_id`.
3. Enroll biometrics once with that `user_id`.
4. Log in later with `user_id + password`.

### 3. Google Apps Script

Paste [google-apps-script/code.gs](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/google-apps-script/code.gs:1) into a Google Apps Script project bound to a Google Sheet and deploy it as a Web App.

If your spreadsheet is not bound to the Apps Script project, that is now supported too:

- open [google-apps-script/code.gs](/C:/Users/divin/OneDrive%20-%20Chandigarh%20University/Documents/New%20project/mlavs-production/google-apps-script/code.gs:1)
- set `SPREADSHEET_ID` to the target spreadsheet ID
- make sure the Google account executing the Apps Script web app has edit access to that spreadsheet
- make sure the same account also has access to the Drive folder referenced by `DRIVE_FOLDER_ID`

Apps Script actions:

- `register_user`
- `upsert_user`
- `get_user`
- `log_event`

Stored data:

- `MLAVS_Users` sheet:
  - `user_id`
  - `username`
  - `email`
  - `full_name`
  - `active`
  - `metadata JSON`
  - `created_at`
  - `updated_at`
  - `embedding_file_id`
  - `embedding_file_url`
  - `average_quality_score`
  - `capture_count`
  - `password_hash`
  - `password_salt`
- Drive:
  - one private JSON file per user for biometric embeddings
- `MLAVS_Attendance` sheet:
  - session and audit events

## Camera and Google Meet

- The app uses the webcam only during biometric enrollment and initial session verification.
- Immediately after enrollment or successful verification, the frontend stops its own camera stream.
- During the meeting itself, passive monitoring uses only tab visibility and interaction tracking, not the webcam.
- If Google Meet is already holding the webcam and the browser/device does not allow sharing, the user should:
  1. verify before turning Meet video on, or
  2. briefly disable Meet video, complete verification, then continue after the app releases the camera.

This means the web app should not continuously fight with Meet for webcam access during the actual meeting.

## Important Note About Spreadsheet URL

You are correct: you do not need to insert a spreadsheet URL anywhere in the code.

What is required:

- the Google Apps Script web app URL in `GS_WEB_APP_URL`
- the Drive folder ID in `DRIVE_FOLDER_ID`

Why:

- the Apps Script is bound to its spreadsheet and uses that spreadsheet internally
- the backend talks only to the Apps Script web app, not to the spreadsheet directly

If you are using a non-bound spreadsheet:

- you still do not need the spreadsheet URL
- you need the spreadsheet ID in `code.gs`
- the script accesses it with `SpreadsheetApp.openById(SPREADSHEET_ID)`

## Hosting Notes

- The frontend uses the maintained `@vladmandic/face-api` browser package with `ssdMobilenetv1`, `faceLandmark68Net`, and `faceRecognitionNet`.
- The frontend checks `/models` first and falls back to the official CDN if the model files are not present.
- The checkpoint PIN remains demo-only in the frontend config. For production, move PIN generation and verification to the backend.
- Because the frontend and backend are now on different origins, `FRONTEND_ORIGINS` must exactly include your Vercel origin.
- Enrollment persistence depends on both `GS_WEB_APP_URL` and `DRIVE_FOLDER_ID`.

## Recommended Deployment Flow

1. Deploy the Google Apps Script web app and copy its URL.
2. Add the Apps Script URL and Drive folder ID to Hugging Face secrets.
3. Deploy the backend to Hugging Face.
4. Put the Hugging Face Space URL into `frontend-vercel/config.js`.
5. Deploy the frontend to Vercel.
6. Register a user, copy the generated user ID, enroll once, and then test a full session flow.
