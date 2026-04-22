import asyncio
import base64
import hashlib
import io
import json
import logging
import math
import os
import secrets
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

import cv2
import httpx
import insightface
import numpy as np
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, field_validator

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mlavs")

APP_NAME = "MLAVS API"
API_PREFIX = "/api/v1"
EMBEDDING_DIM = 512  # InsightFace ArcFace produces 512-dim embeddings
MIN_ENROLLMENT_IMAGES = 3
MAX_ENROLLMENT_IMAGES = 10
DEFAULT_MATCH_THRESHOLD = float(os.getenv("MATCH_THRESHOLD", "0.6"))
MAX_SESSION_SECONDS = 3 * 60 * 60
CHECKPOINT_MINUTES_MIN = int(os.getenv("CHECKPOINT_MINUTES_MIN", "8"))
CHECKPOINT_MINUTES_MAX = int(os.getenv("CHECKPOINT_MINUTES_MAX", "15"))
GS_WEB_APP_URL = os.getenv("GS_WEB_APP_URL", "").strip()
DRIVE_FOLDER_ID = os.getenv("DRIVE_FOLDER_ID", "").strip()
FRONTEND_ORIGINS = [
    origin.strip()
    for origin in os.getenv("FRONTEND_ORIGINS", "http://localhost:5500,http://localhost:3000").split(",")
    if origin.strip()
]

# Initialize InsightFace model (ArcFace)
face_analyser = None


def get_face_analyser():
    global face_analyser
    if face_analyser is None:
        face_analyser = insightface.app.FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        face_analyser.prepare(ctx_id=0, det_size=(640, 640))
    return face_analyser


WEIGHT_IDENTITY = 40.0
WEIGHT_CHECKPOINTS = 30.0
WEIGHT_DURATION = 20.0
WEIGHT_BEHAVIOR = 10.0


class EmbeddingVector(BaseModel):
    model_config = ConfigDict(extra="forbid")
    values: list[float] = Field(..., min_length=EMBEDDING_DIM, max_length=EMBEDDING_DIM)

    @field_validator("values")
    @classmethod
    def validate_values(cls, values: list[float]) -> list[float]:
        if not all(math.isfinite(value) for value in values):
            raise ValueError("Embedding contains non-finite values.")
        return values


class EnrollmentCapture(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pose: Literal["front", "left", "right", "up", "down", "custom"]
    embedding: EmbeddingVector
    quality_score: float = Field(..., ge=0.0, le=1.0)
    detection_score: float = Field(..., ge=0.0, le=1.0)


class EnrollRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(..., min_length=3, max_length=128)
    full_name: str = Field(..., min_length=2, max_length=200)
    email: str = Field(..., min_length=5, max_length=254)
    password: str = Field(..., min_length=6, max_length=128)
    captures: list[EnrollmentCapture] = Field(
        ..., min_length=MIN_ENROLLMENT_IMAGES, max_length=MAX_ENROLLMENT_IMAGES
    )
    metadata: dict[str, Any] = Field(default_factory=dict)


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(..., min_length=3, max_length=128)
    password: str | None = Field(default=None, min_length=6, max_length=128)


class StartSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(..., min_length=3, max_length=128)
    meeting_url: str = Field(..., min_length=10, max_length=2000)
    live_embedding: EmbeddingVector
    meeting_title: str | None = Field(default=None, max_length=200)


class CheckpointRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    response_type: Literal["face", "pin", "missed"]
    success: bool
    similarity: float | None = Field(default=None, ge=0.0, le=1.0)
    pin_used: bool = False
    notes: str | None = Field(default=None, max_length=500)


class PassiveMonitoringRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    visible_seconds: float = Field(..., ge=0.0)
    total_seconds: float = Field(..., ge=0.0)
    interaction_count: int = Field(..., ge=0)


class ExitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    ended_by: Literal["user", "beforeunload", "timeout", "admin"] = "user"


class HealthResponse(BaseModel):
    status: str
    sessions: int
    gs_configured: bool
    drive_configured: bool
    checkpoint_window_minutes: tuple[int, int]
    allowed_origins: list[str]
    persistence_mode: str


class UserRecord(BaseModel):
    model_config = ConfigDict(extra="allow")
    user_id: str
    full_name: str
    embeddings: list[list[float]]
    average_quality_score: float
    active: bool = True
    created_at: datetime
    updated_at: datetime | None = None
    embedding_file_id: str | None = None
    embedding_file_url: str | None = None
    capture_count: int | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    # 🔐 Password fields - internal use only, never returned to frontend
    password_hash: str | None = None
    password_salt: str | None = None


class SessionRecord(BaseModel):
    session_id: str
    user_id: str
    meeting_url: str
    meeting_title: str | None = None
    identity_confidence: float
    best_similarity: float
    average_similarity: float
    consistency_score: float
    created_at: datetime
    updated_at: datetime
    ended_at: datetime | None = None
    active: bool = True
    checkpoint_total: int = 0
    checkpoint_completed: int = 0
    pin_fallback_count: int = 0
    interaction_count: int = 0
    visible_seconds: float = 0.0
    total_tracked_seconds: float = 0.0
    last_passive_at: datetime | None = None
    last_checkpoint_at: datetime | None = None


sessions_store: dict[str, SessionRecord] = {}
user_cache: dict[str, UserRecord] = {}

app = FastAPI(title=APP_NAME, version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def utc_now() -> datetime:
    return datetime.now(UTC)


def require_persistence_config() -> None:
    if not GS_WEB_APP_URL:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GS_WEB_APP_URL is required because Sheets and Drive are configured as the primary database.",
        )
    if not DRIVE_FOLDER_ID:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="DRIVE_FOLDER_ID is required because Drive stores enrolled embeddings.",
        )


def normalize_embedding(values: list[float]) -> np.ndarray:
    vector = np.array(values, dtype=np.float32)
    norm = np.linalg.norm(vector)
    if norm == 0:
        raise HTTPException(status_code=400, detail="Embedding norm cannot be zero.")
    return vector / norm


def cosine_similarity(reference: np.ndarray, candidate: np.ndarray) -> float:
    return float(np.clip(np.dot(reference, candidate), -1.0, 1.0))


def extract_face_embedding_from_image(image_bytes: bytes) -> list[float]:
    """Extract face embedding from an image using InsightFace."""
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        image_np = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
        app = get_face_analyser()
        faces = app.get(image_np)
        if not faces:
            raise HTTPException(status_code=400, detail="No face detected in the image.")
        if len(faces) > 1:
            logger.warning("Multiple faces detected; using the largest one.")
        # Use the first (or largest) face
        face = sorted(faces, key=lambda f: f.bbox[2] * f.bbox[3], reverse=True)[0]
        embedding = face.embedding.astype(np.float32).tolist()
        if len(embedding) != EMBEDDING_DIM:
            raise HTTPException(status_code=500, detail=f"Unexpected embedding dimension: {len(embedding)}")
        return embedding
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to extract face embedding")
        raise HTTPException(status_code=500, detail=f"Face extraction failed: {str(e)}") from e


def verify_against_references(candidate: list[float], references: list[list[float]]) -> dict[str, float]:
    candidate_vector = normalize_embedding(candidate)
    scores = [cosine_similarity(normalize_embedding(ref), candidate_vector) for ref in references]
    best_match = max(scores)
    average_similarity = float(np.mean(scores))
    consistency_score = float(np.clip(1.0 - float(np.std(scores)), 0.0, 1.0))
    identity_confidence = float(np.clip((best_match * 0.7) + (average_similarity * 0.3), 0.0, 1.0))
    return {
        "best_match": best_match,
        "average_similarity": average_similarity,
        "consistency_score": consistency_score,
        "identity_confidence": identity_confidence,
    }


def quality_summary(captures: list[EnrollmentCapture]) -> float:
    quality_scores = [capture.quality_score for capture in captures]
    detection_scores = [capture.detection_score for capture in captures]
    return float(np.clip((np.mean(quality_scores) * 0.6) + (np.mean(detection_scores) * 0.4), 0.0, 1.0))


def behavioral_consistency(session: SessionRecord) -> float:
    focus_ratio = 0.0 if session.total_tracked_seconds <= 0 else session.visible_seconds / session.total_tracked_seconds
    normalized_focus = float(np.clip(focus_ratio, 0.0, 1.0))
    normalized_interactions = float(np.clip(session.interaction_count / 180.0, 0.0, 1.0))
    return float(np.clip((normalized_focus * 0.7) + (normalized_interactions * 0.3), 0.0, 1.0))


def checkpoint_completion_rate(session: SessionRecord) -> float:
    if session.checkpoint_total == 0:
        return 1.0
    return float(np.clip(session.checkpoint_completed / session.checkpoint_total, 0.0, 1.0))


def session_duration_ratio(session: SessionRecord) -> float:
    end_time = session.ended_at or utc_now()
    duration_seconds = max((end_time - session.created_at).total_seconds(), 0.0)
    return float(np.clip(duration_seconds / MAX_SESSION_SECONDS, 0.0, 1.0))


def score_status(score: float) -> str:
    if score >= 85.0:
        return "Fully Present"
    if score >= 70.0:
        return "Partially Present"
    return "Non-Compliant"


def final_session_score(session: SessionRecord) -> dict[str, float | str]:
    identity_component = session.identity_confidence * WEIGHT_IDENTITY
    checkpoint_component = checkpoint_completion_rate(session) * WEIGHT_CHECKPOINTS
    duration_component = session_duration_ratio(session) * WEIGHT_DURATION
    behavioral_component = behavioral_consistency(session) * WEIGHT_BEHAVIOR
    total = round(identity_component + checkpoint_component + duration_component + behavioral_component, 2)
    return {
        "identity_component": round(identity_component, 2),
        "checkpoint_component": round(checkpoint_component, 2),
        "duration_component": round(duration_component, 2),
        "behavioral_component": round(behavioral_component, 2),
        "final_score": total,
        "status": score_status(total),
    }


# ✅ FIX #1: Add follow_redirects=True to handle Google Apps Script 302 redirects
async def gs_post(payload: dict[str, Any]) -> dict[str, Any]:
    require_persistence_config()
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            response = await client.post(GS_WEB_APP_URL, json=payload)
            response.raise_for_status()
            return response.json()
    except Exception as exc:
        logger.exception("Google Apps Script request failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Primary database request to Google Apps Script failed: {exc}",
        ) from exc


async def fetch_user_from_store(user_id: str) -> UserRecord | None:
    payload = await gs_post({"action": "get_user", "user_id": user_id})
    if not payload.get("ok"):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=payload.get("error", "Failed to read user record."))
    if not payload.get("found"):
        return None
    # ✅ FIX #2: Exclude password fields from response
    user_data = payload["user"].copy()
    user_data.pop("password_hash", None)
    user_data.pop("password_salt", None)
    user = UserRecord.model_validate(user_data)
    user_cache[user.user_id] = user
    return user


def hash_password(password: str) -> tuple[str, str]:
    """Hash a password with a random salt using SHA-256."""
    salt = secrets.token_hex(16)
    salted = f"{salt}{password}"
    password_hash = hashlib.sha256(salted.encode()).hexdigest()
    return password_hash, salt


async def upsert_user_in_store(payload: EnrollRequest, average_quality_score: float) -> dict[str, Any]:
    password_hash, password_salt = hash_password(payload.password)
    request_body = {
        "action": "upsert_user",
        "drive_folder_id": DRIVE_FOLDER_ID,
        "user": {
            "user_id": payload.user_id,
            "full_name": payload.full_name,
            "email": payload.email,
            "active": True,
            "average_quality_score": round(average_quality_score, 4),
            "capture_count": len(payload.captures),
            "metadata": payload.metadata,
            "embeddings": [capture.embedding.values for capture in payload.captures],
            "password_hash": password_hash,
            "password_salt": password_salt,
        },
    }
    result = await gs_post(request_body)
    if not result.get("ok"):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=result.get("error", "Failed to persist user record."))
    # ✅ FIX #3: Exclude password fields from returned user object
    user_data = result["user"].copy()
    user_data.pop("password_hash", None)
    user_data.pop("password_salt", None)
    user = UserRecord.model_validate(user_data)
    user_cache[user.user_id] = user
    return result


async def send_event_to_gs(event_type: str, payload: dict[str, Any]) -> None:
    if not GS_WEB_APP_URL:
        logger.info("GS webhook not configured; skipped event=%s", event_type)
        return
    event_payload = {
        "action": "log_event",
        "event_type": event_type,
        "timestamp": utc_now().isoformat(),
        "drive_folder_id": DRIVE_FOLDER_ID,
        **payload,
    }
    try:
        await gs_post(event_payload)
    except HTTPException as exc:
        logger.warning("Failed to send event to Google Apps Script: %s", exc.detail)


# ✅ FIX #4: Make background_tasks optional
def dispatch_gs_event(event_type: str, payload: dict[str, Any], background_tasks: BackgroundTasks | None = None) -> None:
    if background_tasks is not None:
        background_tasks.add_task(send_event_to_gs, event_type, payload)
        return
    try:
        asyncio.get_running_loop().create_task(send_event_to_gs(event_type, payload))
    except RuntimeError:
        logger.warning("No running event loop for GS dispatch; event=%s", event_type)


@app.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {"message": f"{APP_NAME} is running.", "health": f"{API_PREFIX}/health"}


@app.get(f"{API_PREFIX}/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        sessions=len(sessions_store),
        gs_configured=bool(GS_WEB_APP_URL),
        drive_configured=bool(DRIVE_FOLDER_ID),
        checkpoint_window_minutes=(CHECKPOINT_MINUTES_MIN, CHECKPOINT_MINUTES_MAX),
        allowed_origins=FRONTEND_ORIGINS,
        persistence_mode="google_sheets_and_drive_primary",
    )


@app.post(f"{API_PREFIX}/enroll", status_code=status.HTTP_201_CREATED)
async def enroll_user(
    background_tasks: BackgroundTasks,
    user_id: str = Form(..., min_length=3, max_length=128),
    full_name: str = Form(..., min_length=2, max_length=200),
    email: str = Form(..., min_length=5, max_length=254),
    password: str = Form(..., min_length=6, max_length=128),
    image1: UploadFile = File(...),
    image2: UploadFile = File(...),
    image3: UploadFile = File(...),
    image4: UploadFile | None = File(None),
    image5: UploadFile | None = File(None),
) -> dict[str, Any]:
    require_persistence_config()
    # Collect all uploaded images
    image_files = [image1, image2, image3]
    if image4:
        image_files.append(image4)
    if image5:
        image_files.append(image5)
    if len(image_files) < MIN_ENROLLMENT_IMAGES or len(image_files) > MAX_ENROLLMENT_IMAGES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Please upload between {MIN_ENROLLMENT_IMAGES} and {MAX_ENROLLMENT_IMAGES} images.",
        )
    # Extract embeddings from each image
    captures = []
    for idx, img_file in enumerate(image_files):
        try:
            contents = await img_file.read()
            embedding = extract_face_embedding_from_image(contents)
            # Quality scores are simplified; in production, compute based on face detection confidence
            captures.append(
                EnrollmentCapture(
                    pose="custom",
                    embedding=EmbeddingVector(values=embedding),
                    quality_score=0.85,  # Default quality score
                    detection_score=0.90,  # Default detection score
                )
            )
        except HTTPException as e:
            raise HTTPException(status_code=e.status_code, detail=f"Image {idx+1}: {e.detail}") from e

    enrollment_quality = quality_summary(captures)
    if enrollment_quality < 0.55:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Enrollment quality too low. Capture clearer, better-lit reference samples.",
        )

    payload = EnrollRequest(
        user_id=user_id,
        full_name=full_name,
        email=email,
        password=password,
        captures=captures,
        metadata={},
    )
    store_result = await upsert_user_in_store(payload, enrollment_quality)

    dispatch_gs_event(
        "user_enrollment",
        {
            "user_id": payload.user_id,
            "full_name": payload.full_name,
            "capture_count": len(payload.captures),
            "average_quality_score": round(enrollment_quality, 4),
            "metadata": payload.metadata,
            "embedding_file_id": store_result["user"].get("embedding_file_id"),
            "embedding_file_url": store_result["user"].get("embedding_file_url"),
        },
        background_tasks,
    )

    return {
        "message": "Enrollment completed and persisted to Sheets/Drive.",
        "user_id": payload.user_id,
        "capture_count": len(payload.captures),
        "average_quality_score": round(enrollment_quality, 4),
        "embedding_file_id": store_result["user"].get("embedding_file_id"),
        "embedding_file_url": store_result["user"].get("embedding_file_url"),
    }


def verify_password(password: str, password_hash: str, password_salt: str) -> bool:
    """Verify a password against its hash and salt."""
    salted = f"{password_salt}{password}"
    computed_hash = hashlib.sha256(salted.encode()).hexdigest()
    return secrets.compare_digest(computed_hash, password_hash)


@app.post(f"{API_PREFIX}/login")
async def login_user(payload: LoginRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    require_persistence_config()
    user = await fetch_user_from_store(payload.user_id)
    if not user or not user.active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found or inactive.")

    if payload.password:
        password_hash = getattr(user, "password_hash", None)
        password_salt = getattr(user, "password_salt", None)
        if not password_hash or not password_salt:
            logger.warning(
                "User %s has no password stored; allowing login without password verification.", payload.user_id
            )
        elif not verify_password(payload.password, password_hash, password_salt):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid password.")

    dispatch_gs_event(
        "login_lookup",
        {
            "user_id": user.user_id,
            "full_name": user.full_name,
            "email": getattr(user, "email", ""),
            "embedding_file_id": user.embedding_file_id,
        },
        background_tasks,
    )

    # ✅ FIX #5: Return user data without password fields
    return {
        "message": "User is eligible to start attendance verification.",
        "user_id": user.user_id,
        "full_name": user.full_name,
        "email": getattr(user, "email", ""),
        "enrolled_embeddings": len(user.embeddings),
        "average_quality_score": round(user.average_quality_score, 4),
        "embedding_file_id": user.embedding_file_id,
    }


@app.post(f"{API_PREFIX}/start", status_code=status.HTTP_201_CREATED)
async def start_session(
    background_tasks: BackgroundTasks,
    user_id: str = Form(..., min_length=3, max_length=128),
    meeting_url: str = Form(..., min_length=10, max_length=2000),
    meeting_title: str | None = Form(None, max_length=200),
    image: UploadFile = File(...),
) -> dict[str, Any]:
    require_persistence_config()
    user = await fetch_user_from_store(user_id)
    if not user or not user.active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found or inactive.")

    # Extract embedding from the uploaded image
    contents = await image.read()
    live_embedding = extract_face_embedding_from_image(contents)

    verification = verify_against_references(live_embedding, user.embeddings)
    if verification["best_match"] < DEFAULT_MATCH_THRESHOLD:
        dispatch_gs_event(
            "verification_failed",
            {
                "user_id": user_id,
                "best_similarity": round(verification["best_match"], 4),
                "average_similarity": round(verification["average_similarity"], 4),
                "consistency_score": round(verification["consistency_score"], 4),
                "meeting_url": meeting_url,
            },
            background_tasks,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Identity verification failed.",
                "best_similarity": round(verification["best_match"], 4),
                "threshold": DEFAULT_MATCH_THRESHOLD,
            },
        )

    now = utc_now()
    session = SessionRecord(
        session_id=str(uuid.uuid4()),
        user_id=user_id,
        meeting_url=meeting_url,
        meeting_title=meeting_title,
        identity_confidence=verification["identity_confidence"],
        best_similarity=verification["best_match"],
        average_similarity=verification["average_similarity"],
        consistency_score=verification["consistency_score"],
        created_at=now,
        updated_at=now,
    )
    sessions_store[session.session_id] = session

    dispatch_gs_event(
        "session_start",
        {
            "session_id": session.session_id,
            "user_id": session.user_id,
            "meeting_url": session.meeting_url,
            "meeting_title": session.meeting_title,
            "identity_confidence": round(session.identity_confidence, 4),
            "best_similarity": round(session.best_similarity, 4),
            "average_similarity": round(session.average_similarity, 4),
            "consistency_score": round(session.consistency_score, 4),
        },
        background_tasks,
    )

    return {
        "message": "Session started.",
        "session_id": session.session_id,
        "identity_confidence": round(session.identity_confidence, 4),
        "best_similarity": round(session.best_similarity, 4),
        "average_similarity": round(session.average_similarity, 4),
        "consistency_score": round(session.consistency_score, 4),
        "checkpoint_window_minutes": [CHECKPOINT_MINUTES_MIN, CHECKPOINT_MINUTES_MAX],
    }


@app.post(f"{API_PREFIX}/checkpoint")
async def record_checkpoint(payload: CheckpointRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    session = sessions_store.get(payload.session_id)
    if not session or not session.active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Active session not found.")

    session.checkpoint_total += 1
    if payload.success:
        session.checkpoint_completed += 1
    if payload.pin_used:
        session.pin_fallback_count += 1
    session.last_checkpoint_at = utc_now()
    session.updated_at = utc_now()

    dispatch_gs_event(
        "checkpoint",
        {
            "session_id": session.session_id,
            "user_id": session.user_id,
            "response_type": payload.response_type,
            "success": payload.success,
            "similarity": payload.similarity,
            "pin_used": payload.pin_used,
            "notes": payload.notes,
            "checkpoint_total": session.checkpoint_total,
            "checkpoint_completed": session.checkpoint_completed,
        },
        background_tasks,
    )

    return {
        "message": "Checkpoint recorded.",
        "checkpoint_total": session.checkpoint_total,
        "checkpoint_completed": session.checkpoint_completed,
        "completion_rate": round(checkpoint_completion_rate(session), 4),
    }


@app.post(f"{API_PREFIX}/passive")
async def update_passive_monitoring(payload: PassiveMonitoringRequest) -> dict[str, Any]:
    session = sessions_store.get(payload.session_id)
    if not session or not session.active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Active session not found.")

    session.visible_seconds += payload.visible_seconds
    session.total_tracked_seconds += payload.total_seconds
    session.interaction_count += payload.interaction_count
    session.last_passive_at = utc_now()
    session.updated_at = utc_now()

    focus_ratio = 0.0 if session.total_tracked_seconds <= 0 else session.visible_seconds / session.total_tracked_seconds
    return {
        "message": "Passive metrics updated.",
        "focus_ratio": round(float(np.clip(focus_ratio, 0.0, 1.0)), 4),
        "interaction_count": session.interaction_count,
        "behavioral_consistency": round(behavioral_consistency(session), 4),
    }


@app.post(f"{API_PREFIX}/exit")
async def exit_session(payload: ExitRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    session = sessions_store.get(payload.session_id)
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found.")

    if session.active:
        session.active = False
        session.ended_at = utc_now()
        session.updated_at = utc_now()
        score_breakdown = final_session_score(session)

        dispatch_gs_event(
            "session_end",
            {
                "session_id": session.session_id,
                "user_id": session.user_id,
                "ended_by": payload.ended_by,
                "meeting_url": session.meeting_url,
                "meeting_title": session.meeting_title,
                "identity_confidence": round(session.identity_confidence, 4),
                "best_similarity": round(session.best_similarity, 4),
                "average_similarity": round(session.average_similarity, 4),
                "consistency_score": round(session.consistency_score, 4),
                "checkpoint_total": session.checkpoint_total,
                "checkpoint_completed": session.checkpoint_completed,
                "interaction_count": session.interaction_count,
                "visible_seconds": round(session.visible_seconds, 2),
                "total_tracked_seconds": round(session.total_tracked_seconds, 2),
                "score_breakdown": score_breakdown,
            },
            background_tasks,
        )

    return {"message": "Session ended.", "session_id": session.session_id, **final_session_score(session)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "7860")), reload=False)