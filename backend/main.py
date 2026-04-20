import asyncio
import json
import logging
import math
import os
import uuid
from pathlib import Path
from datetime import UTC, datetime
from typing import Any, Literal

import httpx
import numpy as np
from fastapi import BackgroundTasks, FastAPI, HTTPException, status
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mlavs")


APP_NAME = "MLAVS API"
API_PREFIX = "/api/v1"
EMBEDDING_DIM = 128
MIN_ENROLLMENT_IMAGES = 3
MAX_ENROLLMENT_IMAGES = 10
DEFAULT_MATCH_THRESHOLD = float(os.getenv("MATCH_THRESHOLD", "0.6"))
MAX_SESSION_SECONDS = 3 * 60 * 60
CHECKPOINT_MINUTES_MIN = int(os.getenv("CHECKPOINT_MINUTES_MIN", "8"))
CHECKPOINT_MINUTES_MAX = int(os.getenv("CHECKPOINT_MINUTES_MAX", "15"))
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5500")
GS_WEB_APP_URL = os.getenv("GS_WEB_APP_URL", "").strip()
DRIVE_FOLDER_ID = os.getenv("DRIVE_FOLDER_ID", "").strip()
PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"

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
        if not values:
            raise ValueError("Embedding cannot be empty.")
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
    captures: list[EnrollmentCapture] = Field(
        ..., min_length=MIN_ENROLLMENT_IMAGES, max_length=MAX_ENROLLMENT_IMAGES
    )
    metadata: dict[str, Any] = Field(default_factory=dict)


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(..., min_length=3, max_length=128)


class StartSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(..., min_length=3, max_length=128)
    meeting_url: str = Field(..., min_length=10, max_length=2000)
    live_embedding: EmbeddingVector
    checkpoint_pin: str | None = Field(default=None, min_length=4, max_length=12)
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
    users: int
    sessions: int
    gs_configured: bool
    drive_configured: bool
    checkpoint_window_minutes: tuple[int, int]


class UserRecord(BaseModel):
    user_id: str
    full_name: str
    embeddings: list[list[float]]
    average_quality_score: float
    active: bool = True
    created_at: datetime
    metadata: dict[str, Any] = Field(default_factory=dict)


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


users_store: dict[str, UserRecord] = {}
sessions_store: dict[str, SessionRecord] = {}


app = FastAPI(title=APP_NAME, version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def utc_now() -> datetime:
    return datetime.now(UTC)


def normalize_embedding(values: list[float]) -> np.ndarray:
    vector = np.array(values, dtype=np.float32)
    norm = np.linalg.norm(vector)
    if norm == 0:
        raise HTTPException(status_code=400, detail="Embedding norm cannot be zero.")
    return vector / norm


def cosine_similarity(reference: np.ndarray, candidate: np.ndarray) -> float:
    return float(np.clip(np.dot(reference, candidate), -1.0, 1.0))


def verify_against_references(candidate: list[float], references: list[list[float]]) -> dict[str, float]:
    candidate_vector = normalize_embedding(candidate)
    scores = [cosine_similarity(normalize_embedding(ref), candidate_vector) for ref in references]

    best_match = max(scores)
    average_similarity = float(np.mean(scores))
    consistency_score = 1.0 - float(np.std(scores))
    consistency_score = float(np.clip(consistency_score, 0.0, 1.0))
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
    if session.total_tracked_seconds <= 0:
        focus_ratio = 0.0
    else:
        focus_ratio = session.visible_seconds / session.total_tracked_seconds

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


async def send_to_gs(event_type: str, payload: dict[str, Any]) -> None:
    if not GS_WEB_APP_URL:
        logger.info("GS webhook not configured; skipped event=%s", event_type)
        return

    event_payload = {
        "event_type": event_type,
        "timestamp": utc_now().isoformat(),
        "drive_folder_id": DRIVE_FOLDER_ID,
        **payload,
    }

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(GS_WEB_APP_URL, json=event_payload)
            response.raise_for_status()
    except Exception as exc:
        logger.warning("Failed to send event to Google Apps Script: %s", exc)


def dispatch_gs_event(event_type: str, payload: dict[str, Any], background_tasks: BackgroundTasks | None = None) -> None:
    if background_tasks is not None:
        background_tasks.add_task(send_to_gs, event_type, payload)
        return

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(send_to_gs(event_type, payload))
    except RuntimeError:
        logger.warning("No running event loop for GS dispatch; event=%s", event_type)


@app.get(f"{API_PREFIX}/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        users=len(users_store),
        sessions=len(sessions_store),
        gs_configured=bool(GS_WEB_APP_URL),
        drive_configured=bool(DRIVE_FOLDER_ID),
        checkpoint_window_minutes=(CHECKPOINT_MINUTES_MIN, CHECKPOINT_MINUTES_MAX),
    )


@app.post(f"{API_PREFIX}/enroll", status_code=status.HTTP_201_CREATED)
async def enroll_user(payload: EnrollRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    enrollment_quality = quality_summary(payload.captures)
    if enrollment_quality < 0.55:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Enrollment quality too low. Capture clearer, better-lit reference samples.",
        )

    embeddings = [capture.embedding.values for capture in payload.captures]
    users_store[payload.user_id] = UserRecord(
        user_id=payload.user_id,
        full_name=payload.full_name,
        embeddings=embeddings,
        average_quality_score=enrollment_quality,
        created_at=utc_now(),
        metadata=payload.metadata,
    )

    dispatch_gs_event(
        "user_enrollment",
        {
            "user_id": payload.user_id,
            "full_name": payload.full_name,
            "capture_count": len(payload.captures),
            "average_quality_score": round(enrollment_quality, 4),
            "metadata": payload.metadata,
        },
        background_tasks,
    )

    return {
        "message": "Enrollment completed.",
        "user_id": payload.user_id,
        "capture_count": len(payload.captures),
        "average_quality_score": round(enrollment_quality, 4),
        "production_note": "In production, move user embeddings to PostgreSQL + pgvector or another encrypted vector store.",
    }


@app.post(f"{API_PREFIX}/login")
async def login_user(payload: LoginRequest) -> dict[str, Any]:
    user = users_store.get(payload.user_id)
    if not user or not user.active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found or inactive.")

    return {
        "message": "User is eligible to start attendance verification.",
        "user_id": user.user_id,
        "full_name": user.full_name,
        "enrolled_embeddings": len(user.embeddings),
        "average_quality_score": round(user.average_quality_score, 4),
    }


@app.post(f"{API_PREFIX}/start", status_code=status.HTTP_201_CREATED)
async def start_session(payload: StartSessionRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    user = users_store.get(payload.user_id)
    if not user or not user.active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found or inactive.")

    verification = verify_against_references(payload.live_embedding.values, user.embeddings)
    if verification["best_match"] < DEFAULT_MATCH_THRESHOLD:
        dispatch_gs_event(
            "verification_failed",
            {
                "user_id": payload.user_id,
                "best_similarity": round(verification["best_match"], 4),
                "average_similarity": round(verification["average_similarity"], 4),
                "consistency_score": round(verification["consistency_score"], 4),
                "meeting_url": payload.meeting_url,
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
        user_id=payload.user_id,
        meeting_url=payload.meeting_url,
        meeting_title=payload.meeting_title,
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

    focus_ratio = 0.0
    if session.total_tracked_seconds > 0:
        focus_ratio = session.visible_seconds / session.total_tracked_seconds

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

    return {
        "message": "Session ended.",
        "session_id": session.session_id,
        **score_breakdown,
    }


@app.get("/", include_in_schema=False)
async def root() -> FileResponse:
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend not found.")
    return FileResponse(index_path)


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "7860")), reload=False)
