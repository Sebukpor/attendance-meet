# MLAVS - Multi-Layered Attendance Verification System

## 📋 Overview

MLAVS is a sophisticated face recognition-based attendance verification system designed to ensure authentic user presence during online sessions. The system uses InsightFace (ArcFace) for facial recognition, FastAPI for the backend, and Google Sheets/Drive for persistent storage.

---

## 🏗️ Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────────────┐
│   Frontend  │────▶│  FastAPI     │────▶│ Google Apps Script│
│  (HTML/JS)  │     │  Backend     │     │ (Google Sheets)   │
└─────────────┘     └──────────────┘     └───────────────────┘
                           │                      │
                           ▼                      ▼
                    ┌──────────────┐     ┌───────────────────┐
                    │  InsightFace │     │  Google Drive     │
                    │  (ArcFace)   │     │  (Embeddings)     │
                    └──────────────┘     └───────────────────┘
```

---

## 📁 Repository Structure

```
/workspace
├── backend-code/
│   ├── main.py              # FastAPI backend with all endpoints
│   ├── requirements.txt     # Python dependencies
│   ├── Dockerfile          # Container configuration
│   └── README.md           # Backend-specific docs
├── frontend/
│   ├── index.html          # Main HTML interface
│   ├── app.js              # Frontend JavaScript logic
│   ├── styles.css          # Styling
│   ├── config.js           # Configuration settings
│   └── vercel.json         # Vercel deployment config
├── google-apps-script/
│   └── code.gs             # Google Apps Script for Sheets/Drive integration
└── README.md               # This file
```

---

## 🔑 Key Features

### 1. **Multi-Factor Identity Verification**
- **Enrollment**: Requires 3-10 face images from different angles (front, left, right, up, down, custom)
- **Live Verification**: Compares live camera feed against enrolled embeddings
- **Continuous Checkpoints**: Random challenges during session to verify continued presence

### 2. **Scoring System**
Attendance is scored using four weighted components:

| Component | Weight | Description |
|-----------|--------|-------------|
| **Identity Confidence** | 40% | Face match quality against enrolled data |
| **Checkpoint Completion** | 30% | Successfully completed verification challenges |
| **Session Duration** | 20% | Time spent in session (max 3 hours) |
| **Behavioral Consistency** | 10% | Focus ratio and interaction count |

### 3. **Status Classification**
Based on final score:
- **Fully Present**: Score ≥ 85
- **Partially Present**: Score 70-84
- **Non-Compliant**: Score < 70

---

## 🚀 API Endpoints

### Base URL
- Local: `http://localhost:8000`
- Production: Configure via environment variables

### Health Check
```http
GET /api/v1/health
```
Returns system status, active sessions, and configuration info.

---

### 1. Enroll User (Sign Up)
```http
POST /api/v1/enroll
Content-Type: multipart/form-data
```

**Parameters:**
- `user_id` (string): Unique user identifier (3-128 chars)
- `full_name` (string): User's full name
- `email` (string): Email address
- `password` (string): Password (min 6 chars)
- `captures` (array): 3-10 JSON objects with pose, embedding, quality_score, detection_score
- `metadata` (object, optional): Additional user data

**Response:**
```json
{
  "message": "User enrolled successfully.",
  "user_id": "user123",
  "full_name": "John Doe",
  "enrolled_captures": 5,
  "average_quality_score": 0.92
}
```

---

### 2. Login
```http
POST /api/v1/login
Content-Type: application/json
```

**Body:**
```json
{
  "user_id": "user123",
  "password": "securepassword"
}
```

**Response:**
```json
{
  "message": "User is eligible to start attendance verification.",
  "user_id": "user123",
  "full_name": "John Doe",
  "email": "john@example.com",
  "enrolled_embeddings": 5,
  "average_quality_score": 0.92,
  "embedding_file_id": "file_id_from_drive"
}
```

> ⚠️ **Important**: Login does NOT mark attendance. It only authenticates the user and allows them to start a session.

---

### 3. Start Session
```http
POST /api/v1/start
Content-Type: multipart/form-data
```

**Parameters:**
- `user_id` (string): User identifier
- `meeting_url` (string): URL of the meeting/session
- `meeting_title` (string, optional): Meeting title
- `image` (file): Live photo for face verification

**Process:**
1. Extracts face embedding from uploaded image
2. Compares against enrolled embeddings
3. If similarity ≥ threshold (default 0.6), session starts
4. Logs `session_start` event to Google Sheets

**Response:**
```json
{
  "message": "Session started.",
  "session_id": "uuid-session-id",
  "identity_confidence": 0.95,
  "best_similarity": 0.92,
  "average_similarity": 0.89,
  "consistency_score": 0.94,
  "checkpoint_window_minutes": [8, 15]
}
```

---

### 4. Record Checkpoint
```http
POST /api/v1/checkpoint
Content-Type: application/json
```

**Body:**
```json
{
  "session_id": "uuid-session-id",
  "response_type": "face",
  "success": true,
  "similarity": 0.88,
  "pin_used": false,
  "notes": "Optional notes"
}
```

**Response Types:**
- `face`: Face verification challenge
- `pin`: PIN code fallback
- `missed`: Missed checkpoint

---

### 5. Update Passive Monitoring
```http
POST /api/v1/passive
Content-Type: application/json
```

**Body:**
```json
{
  "session_id": "uuid-session-id",
  "visible_seconds": 120.5,
  "total_seconds": 150.0,
  "interaction_count": 5
}
```

Tracks user visibility and engagement during session.

---

### 6. Exit Session
```http
POST /api/v1/exit
Content-Type: application/json
```

**Body:**
```json
{
  "session_id": "uuid-session-id",
  "ended_by": "user"
}
```

**Ended By Options:**
- `user`: User manually ended
- `beforeunload`: Browser closed
- `timeout`: Session timeout
- `admin`: Administrator ended

**Response:**
```json
{
  "message": "Session ended.",
  "session_id": "uuid-session-id",
  "identity_component": 38.0,
  "checkpoint_component": 30.0,
  "duration_component": 15.5,
  "behavioral_component": 8.2,
  "final_score": 91.7,
  "status": "Fully Present"
}
```

> ✅ **This is when attendance is officially marked!** The `status` field is recorded in the Google Sheet.

---

## 📊 Google Sheets Integration

### MLAVS_Attendance Sheet

Columns in the attendance sheet:

| Column | Name | Description |
|--------|------|-------------|
| A | Timestamp | Event timestamp (ISO format) |
| B | Event Type | `session_start`, `session_end`, `checkpoint`, etc. |
| C | User ID | User identifier |
| D | Session ID | Unique session UUID |
| E | Meeting URL | Meeting link |
| F | Meeting Title | Meeting name |
| G | **Status** | **"Fully Present", "Partially Present", or "Non-Compliant"** |
| H | Final Score | Numeric score (0-100) |
| I | Identity Confidence | Face match confidence |
| J | Checkpoint Completed | Number of passed checkpoints |
| K | Checkpoint Total | Total checkpoints issued |
| L | Visible Seconds | Time user was visible |
| M | Tracked Seconds | Total tracked time |
| N | Interactions | User interaction count |
| O | Audit File URL | Link to detailed JSON audit log in Drive |
| P | Metadata JSON | Full event payload |

### MLAVS_Users Sheet

Stores user registration data:

| Column | Name | Description |
|--------|------|-------------|
| A | User ID | Unique identifier |
| B | Username | Username |
| C | Email | Email address |
| D | Full Name | Full name |
| E | Active | Account status (true/false) |
| F | Metadata JSON | Additional data |
| G | Created At | Registration timestamp |
| H | Updated At | Last update timestamp |
| I | Embedding File ID | Google Drive file ID |
| J | Embedding File URL | Google Drive file URL |
| K | Average Quality Score | Enrollment image quality |
| L | Capture Count | Number of enrollment images |
| M | Password Hash | Hashed password (SHA-256) |
| N | Password Salt | Password salt |

---

## ❓ Attendance Marking Flow - Detailed Answer

### Question: "If a user logs in after sign up and the image possesses token corresponding with that used during registration, is their attendance marked as present?"

### Answer: **NO** - Login alone does NOT mark attendance.

Here's the complete flow:

```
1. SIGN UP (Enroll)
   └─▶ User submits 3-10 face images + password
   └─▶ Embeddings stored in Google Drive
   └─▶ User record created in MLAVS_Users sheet
   └─❌ NO attendance record created yet

2. LOGIN
   └─▶ User provides user_id + password
   └─▶ System verifies credentials
   └─▶ Returns: "User is eligible to start attendance verification"
   └─❌ STILL NO attendance record marked as present

3. START SESSION
   └─▶ User MUST upload a LIVE photo
   └─▶ System compares live photo against enrolled embeddings
   └─▶ If match ≥ 0.6 threshold → session starts
   └─▶ Logs "session_start" event to MLAVS_Attendance sheet
   └─⚠️ Status column is EMPTY at this point

4. DURING SESSION
   └─▶ Periodic checkpoints verify continued presence
   └─▶ Passive monitoring tracks visibility/engagement
   └─⚠️ Still no final attendance status

5. EXIT SESSION ✅
   └─▶ User ends session (or timeout/admin)
   └─▶ System calculates final score based on:
       • Identity confidence (40%)
       • Checkpoint completion (30%)
       • Duration (20%)
       • Behavior (10%)
   └─▶ Assigns status: "Fully Present", "Partially Present", or "Non-Compliant"
   └─✅ LOGS "session_end" event WITH STATUS to MLAVS_Attendance sheet
   └─✅ THIS IS WHEN ATTENDANCE IS OFFICIALLY MARKED
```

### Key Points:

1. **There IS a "Status" column** (Column G) in the `MLAVS_Attendance` sheet that marks presence.

2. **The status is ONLY set when the session ends**, not at login or session start.

3. **A user can log in successfully but still be marked as:**
   - "Fully Present" (score ≥ 85)
   - "Partially Present" (score 70-84)
   - "Non-Compliant" (score < 70)

4. **Even with matching face tokens**, if the user:
   - Doesn't complete checkpoints
   - Has poor visibility/focus
   - Ends session too early
   
   They may still be marked as "Non-Compliant".

5. **Multiple rows per session**: The attendance sheet will have multiple entries for each session:
   - One row for `session_start` (Status: empty)
   - Multiple rows for `checkpoint` events (Status: empty)
   - One row for `session_end` (Status: "Fully Present"/"Partially Present"/"Non-Compliant")

---

## 🔧 Environment Variables

Configure these before running the backend:

```bash
# Required
export GS_WEB_APP_URL="https://script.google.com/macros/s/.../exec"
export DRIVE_FOLDER_ID="your_google_drive_folder_id"

# Optional
export MATCH_THRESHOLD="0.6"           # Face match threshold
export CHECKPOINT_MINUTES_MIN="8"      # Min checkpoint interval
export CHECKPOINT_MINUTES_MAX="15"     # Max checkpoint interval
export FRONTEND_ORIGINS="http://localhost:5500,http://localhost:3000"
```

---

## 🛠️ Installation & Setup

### Backend Setup

```bash
cd backend-code
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend Setup

1. Update `config.js` with your backend URL
2. Open `index.html` in a browser or deploy to Vercel

### Google Apps Script Setup

1. Create a new Google Sheet
2. Go to Extensions → Apps Script
3. Copy contents of `google-apps-script/code.gs`
4. Update `SPREADSHEET_ID` with your sheet ID
5. Deploy as Web App with "Anyone" access
6. Copy the web app URL for `GS_WEB_APP_URL`

### Google Drive Setup

1. Create a folder for storing embeddings
2. Copy the folder ID for `DRIVE_FOLDER_ID`
3. Ensure the Apps Script has Drive API access

---

## 🔒 Security Features

- **Password Hashing**: SHA-256 with random salt
- **Embedding Storage**: Encrypted JSON files in private Drive folder
- **CORS Protection**: Configurable allowed origins
- **No Password Exposure**: Password fields never returned in API responses
- **Audit Logging**: All events stored in Drive with timestamps

---

## 📈 Scoring Algorithm

```python
def final_session_score(session):
    identity_component = session.identity_confidence * 40.0
    checkpoint_component = (completed/total) * 30.0
    duration_component = (duration/max_duration) * 20.0
    behavioral_component = focus_ratio * 10.0
    
    total = identity_component + checkpoint_component + \
            duration_component + behavioral_component
    
    if total >= 85:
        status = "Fully Present"
    elif total >= 70:
        status = "Partially Present"
    else:
        status = "Non-Compliant"
```

---

## 🐛 Troubleshooting

### Common Issues

1. **"No face detected"**
   - Ensure good lighting
   - Face should be centered and clearly visible
   - Only one face should be in frame

2. **"Identity verification failed"**
   - Live image quality may differ from enrollment
   - Re-enroll with better quality images
   - Adjust `MATCH_THRESHOLD` if needed

3. **"Google Apps Script request failed"**
   - Verify `GS_WEB_APP_URL` is correct
   - Check Apps Script deployment permissions
   - Ensure script is published as Web App

4. **"Drive folder not found"**
   - Confirm `DRIVE_FOLDER_ID` is valid
   - Check folder sharing permissions

---
