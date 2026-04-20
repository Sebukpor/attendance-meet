const API_BASE = "http://localhost:7860/api/v1";
const LOCAL_MODEL_URL = "/models";
const CDN_MODEL_URL = "https://cdn.jsdelivr.net/gh/vladmandic/face-api/model";
const ENROLLMENT_POSES = ["front", "left", "right", "up", "down"];
const PASSIVE_FLUSH_MS = 10_000;
const CHECKPOINT_MIN_MS = 8 * 60 * 1000;
const CHECKPOINT_MAX_MS = 15 * 60 * 1000;
const CHECKPOINT_PIN = "2468";
const SSD_OPTIONS = { minConfidence: 0.5, maxResults: 1 };

const state = {
  modelsLoaded: false,
  stream: null,
  enrollmentCaptures: [],
  enrollmentIndex: 0,
  sessionId: null,
  sessionStartedAt: null,
  passive: {
    visibleSeconds: 0,
    totalSeconds: 0,
    interactionCount: 0,
  },
  passiveIntervalId: null,
  passiveTickId: null,
  checkpointTimeoutId: null,
  checkpointAudioContext: null,
};

const elements = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  healthStatus: document.getElementById("healthStatus"),
  healthHint: document.getElementById("healthHint"),
  enrollmentPrompt: document.getElementById("enrollmentPrompt"),
  enrollmentProgress: document.getElementById("enrollmentProgress"),
  enrollmentCount: document.getElementById("enrollmentCount"),
  startEnrollmentBtn: document.getElementById("startEnrollmentBtn"),
  loginBtn: document.getElementById("loginBtn"),
  startAttendanceBtn: document.getElementById("startAttendanceBtn"),
  endSessionBtn: document.getElementById("endSessionBtn"),
  sessionBadge: document.getElementById("sessionBadge"),
  sessionIdValue: document.getElementById("sessionIdValue"),
  identityValue: document.getElementById("identityValue"),
  focusValue: document.getElementById("focusValue"),
  interactionValue: document.getElementById("interactionValue"),
  resultCard: document.getElementById("resultCard"),
  toast: document.getElementById("toast"),
  cameraHint: document.getElementById("cameraHint"),
  enrollUserId: document.getElementById("enrollUserId"),
  enrollFullName: document.getElementById("enrollFullName"),
  loginUserId: document.getElementById("loginUserId"),
  meetingUrl: document.getElementById("meetingUrl"),
  meetingTitle: document.getElementById("meetingTitle"),
};

async function boot() {
  bindUI();
  await Promise.all([loadModels(), checkHealth()]);
  await ensureCamera();
}

function bindUI() {
  elements.startEnrollmentBtn.addEventListener("click", handleEnrollmentFlow);
  elements.loginBtn.addEventListener("click", handleLoginStatus);
  elements.startAttendanceBtn.addEventListener("click", handleAttendanceStart);
  elements.endSessionBtn.addEventListener("click", () => endSession("user"));

  ["mousemove", "keydown", "click", "scroll"].forEach((eventName) => {
    window.addEventListener(
      eventName,
      () => {
        if (state.sessionId) {
          state.passive.interactionCount += 1;
          elements.interactionValue.textContent = String(state.passive.interactionCount);
        }
      },
      { passive: true }
    );
  });

  document.addEventListener("visibilitychange", () => {
    updateBadge(document.hidden ? "Tab hidden" : state.sessionId ? "Session active" : "Idle");
  });

  window.addEventListener("beforeunload", () => {
    if (!state.sessionId) {
      return;
    }

    const payload = JSON.stringify({
      session_id: state.sessionId,
      ended_by: "beforeunload",
    });
    navigator.sendBeacon(`${API_BASE}/exit`, new Blob([payload], { type: "application/json" }));
  });
}

async function loadModels() {
  try {
    const modelBase = await resolveModelBase();
    await faceapi.nets.ssdMobilenetv1.loadFromUri(modelBase);
    await faceapi.nets.faceLandmark68Net.loadFromUri(modelBase);
    await faceapi.nets.faceRecognitionNet.loadFromUri(modelBase);
    state.modelsLoaded = true;
    showToast(`Face models loaded from ${modelBase.startsWith("/") ? "local assets" : "CDN"}.`);
  } catch (error) {
    console.error(error);
    showToast("Could not load face models. Add local model assets under frontend/models or check network access.", true);
  }
}

async function ensureCamera() {
  if (state.stream) {
    return state.stream;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    elements.video.srcObject = state.stream;
    elements.cameraHint.textContent = "Camera ready. Embeddings are generated in-browser only.";
    return state.stream;
  } catch (error) {
    console.error(error);
    elements.cameraHint.textContent =
      "Camera unavailable. Enrollment and face verification need camera permission, but PIN fallback will remain available for checkpoints.";
    throw error;
  }
}

async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    const data = await response.json();
    elements.healthStatus.textContent = data.status.toUpperCase();
    elements.healthHint.textContent = `Users: ${data.users} | Sessions: ${data.sessions}`;
  } catch (error) {
    elements.healthStatus.textContent = "OFFLINE";
    elements.healthHint.textContent = "Backend unreachable. Update API_BASE if needed.";
  }
}

async function handleLoginStatus() {
  const userId = elements.loginUserId.value.trim();
  if (!userId) {
    showToast("Enter a user ID first.", true);
    return;
  }

  try {
    const response = await request("/login", {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    });
    showToast(`Enrollment found for ${response.full_name}.`);
  } catch (error) {
    handleError(error);
  }
}

async function handleEnrollmentFlow() {
  const userId = elements.enrollUserId.value.trim();
  const fullName = elements.enrollFullName.value.trim();
  if (!userId || !fullName) {
    showToast("Provide both user ID and full name before enrollment.", true);
    return;
  }

  await ensureCamera();
  state.enrollmentCaptures = [];
  state.enrollmentIndex = 0;
  elements.startEnrollmentBtn.disabled = true;
  elements.resultCard.classList.add("hidden");

  try {
    for (const pose of ENROLLMENT_POSES) {
      elements.enrollmentPrompt.textContent = `Align your face for the "${pose}" capture, then stay still for a moment.`;
      const detection = await captureFaceDescriptor();
      const qualityScore = scoreCaptureQuality(detection);

      state.enrollmentCaptures.push({
        pose,
        embedding: { values: Array.from(detection.descriptor) },
        quality_score: qualityScore,
        detection_score: detection.detection.score,
      });

      state.enrollmentIndex += 1;
      elements.enrollmentProgress.value = state.enrollmentIndex;
      elements.enrollmentCount.textContent = `${state.enrollmentIndex} / ${ENROLLMENT_POSES.length}`;
      await wait(800);
    }

    const response = await request("/enroll", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        full_name: fullName,
        captures: state.enrollmentCaptures,
        metadata: {
          user_agent: navigator.userAgent,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
    });

    elements.enrollmentPrompt.textContent = `Enrollment complete with quality score ${response.average_quality_score}.`;
    renderResult({
      title: "Enrollment complete",
      status: "Success",
      body: `Stored ${response.capture_count} reference embeddings for ${response.user_id}.`,
    });
  } catch (error) {
    handleError(error);
    elements.enrollmentPrompt.textContent = "Enrollment failed. Improve lighting and keep one face centered in frame.";
  } finally {
    elements.startEnrollmentBtn.disabled = false;
  }
}

async function handleAttendanceStart() {
  const userId = elements.loginUserId.value.trim();
  const meetingUrl = elements.meetingUrl.value.trim();
  const meetingTitle = elements.meetingTitle.value.trim();
  if (!userId || !meetingUrl) {
    showToast("Enter a user ID and meeting URL to start attendance.", true);
    return;
  }

  await ensureCamera();

  try {
    updateBadge("Verifying identity");
    const detection = await captureFaceDescriptor();
    const response = await request("/start", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        meeting_url: meetingUrl,
        meeting_title: meetingTitle || null,
        live_embedding: { values: Array.from(detection.descriptor) },
      }),
    });

    state.sessionId = response.session_id;
    state.sessionStartedAt = Date.now();
    resetPassiveMetrics();
    elements.sessionIdValue.textContent = state.sessionId;
    elements.identityValue.textContent = `${Math.round(response.identity_confidence * 100)}%`;
    elements.endSessionBtn.disabled = false;
    updateBadge("Session active");
    showToast("Attendance session started.");

    stopCameraStream();
    startPassiveMonitoring();
    scheduleNextCheckpoint();
  } catch (error) {
    handleError(error);
    updateBadge("Idle");
  }
}

async function captureFaceDescriptor() {
  if (!state.modelsLoaded) {
    throw new Error("Face models are not loaded yet.");
  }

  let lastDetection = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    lastDetection = await faceapi
      .detectSingleFace(elements.video, new faceapi.SsdMobilenetv1Options(SSD_OPTIONS))
      .withFaceLandmarks()
      .withFaceDescriptor();

    drawOverlay(lastDetection);
    if (lastDetection) {
      return lastDetection;
    }
    await wait(500);
  }

  throw new Error("No face detected. Make sure one face is centered and well lit.");
}

async function resolveModelBase() {
  try {
    const response = await fetch(`${LOCAL_MODEL_URL}/ssd_mobilenetv1_model-weights_manifest.json`, { method: "HEAD" });
    if (response.ok) {
      return LOCAL_MODEL_URL;
    }
  } catch (error) {
    console.warn("Local model assets unavailable, falling back to CDN.", error);
  }

  return CDN_MODEL_URL;
}

function drawOverlay(detection) {
  const canvas = elements.overlay;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!detection) {
    return;
  }

  const { box } = detection.detection;
  context.strokeStyle = "#36d399";
  context.lineWidth = 3;
  context.strokeRect(box.x, box.y, box.width, box.height);
}

function scoreCaptureQuality(detection) {
  const box = detection.detection.box;
  const descriptor = Array.from(detection.descriptor);
  const descriptorStdDev = standardDeviation(descriptor);
  const boxCoverage = Math.min((box.width * box.height) / (640 * 480), 1);

  const coverageScore = clamp(boxCoverage / 0.18, 0, 1);
  const varianceScore = clamp(descriptorStdDev / 0.12, 0, 1);
  const confidenceScore = clamp(detection.detection.score, 0, 1);
  return Number(((coverageScore * 0.4) + (varianceScore * 0.2) + (confidenceScore * 0.4)).toFixed(4));
}

function startPassiveMonitoring() {
  stopPassiveMonitoring();

  state.passiveTickId = window.setInterval(() => {
    state.passive.totalSeconds += 1;
    if (!document.hidden) {
      state.passive.visibleSeconds += 1;
    }
    updateFocusUI();
  }, 1000);

  state.passiveIntervalId = window.setInterval(async () => {
    if (!state.sessionId) {
      return;
    }

    try {
      const response = await request("/passive", {
        method: "POST",
        body: JSON.stringify({
          session_id: state.sessionId,
          visible_seconds: state.passive.visibleSeconds,
          total_seconds: state.passive.totalSeconds,
          interaction_count: state.passive.interactionCount,
        }),
      });
      elements.focusValue.textContent = `${Math.round(response.focus_ratio * 100)}%`;
      resetPassiveMetrics();
    } catch (error) {
      console.error("Passive monitoring flush failed", error);
    }
  }, PASSIVE_FLUSH_MS);
}

function stopPassiveMonitoring() {
  if (state.passiveTickId) {
    clearInterval(state.passiveTickId);
    state.passiveTickId = null;
  }
  if (state.passiveIntervalId) {
    clearInterval(state.passiveIntervalId);
    state.passiveIntervalId = null;
  }
}

function resetPassiveMetrics() {
  state.passive.visibleSeconds = 0;
  state.passive.totalSeconds = 0;
  state.passive.interactionCount = 0;
  elements.interactionValue.textContent = "0";
  elements.focusValue.textContent = "-";
}

function scheduleNextCheckpoint() {
  clearScheduledCheckpoint();
  const nextDelay = randomInt(CHECKPOINT_MIN_MS, CHECKPOINT_MAX_MS);
  state.checkpointTimeoutId = window.setTimeout(runCheckpoint, nextDelay);
}

function clearScheduledCheckpoint() {
  if (state.checkpointTimeoutId) {
    clearTimeout(state.checkpointTimeoutId);
    state.checkpointTimeoutId = null;
  }
}

async function runCheckpoint() {
  if (!state.sessionId) {
    return;
  }

  playCheckpointTone();
  const confirmed = window.confirm("Attendance checkpoint: click OK to confirm you are still present.");

  if (confirmed) {
    try {
      await request("/checkpoint", {
        method: "POST",
        body: JSON.stringify({
          session_id: state.sessionId,
          response_type: "face",
          success: true,
          pin_used: false,
          notes: "Browser confirm acknowledged.",
        }),
      });
      showToast("Checkpoint confirmed.");
    } catch (error) {
      handleError(error);
    } finally {
      scheduleNextCheckpoint();
    }
    return;
  }

  const enteredPin = window.prompt("Camera unavailable or confirmation skipped. Enter your attendance PIN:");
  const pinSuccess = enteredPin === CHECKPOINT_PIN;

  try {
    await request("/checkpoint", {
      method: "POST",
      body: JSON.stringify({
        session_id: state.sessionId,
        response_type: pinSuccess ? "pin" : "missed",
        success: pinSuccess,
        pin_used: true,
        notes: pinSuccess ? "PIN fallback accepted." : "Checkpoint missed or invalid PIN.",
      }),
    });

    if (!pinSuccess) {
      showToast("Checkpoint failed. This will affect the final attendance score.", true);
    } else {
      showToast("PIN fallback accepted.");
    }
  } catch (error) {
    handleError(error);
  } finally {
    scheduleNextCheckpoint();
  }
}

async function endSession(reason) {
  if (!state.sessionId) {
    return;
  }

  clearScheduledCheckpoint();
  stopPassiveMonitoring();

  try {
    const response = await request("/exit", {
      method: "POST",
      body: JSON.stringify({
        session_id: state.sessionId,
        ended_by: reason,
      }),
    });

    renderResult({
      title: response.status,
      status: `${response.final_score}%`,
      body: `Identity ${response.identity_component} | Checkpoints ${response.checkpoint_component} | Duration ${response.duration_component} | Behavior ${response.behavioral_component}`,
    });
    showToast("Session closed.");
  } catch (error) {
    handleError(error);
  } finally {
    state.sessionId = null;
    elements.endSessionBtn.disabled = true;
    elements.sessionIdValue.textContent = "Not started";
    elements.identityValue.textContent = "-";
    updateBadge("Idle");
    resetPassiveMetrics();
  }
}

function stopCameraStream() {
  if (!state.stream) {
    return;
  }
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  elements.video.srcObject = null;
  elements.cameraHint.textContent = "Camera released after verification. Passive monitoring remains active without video.";
}

function playCheckpointTone() {
  try {
    const context = state.checkpointAudioContext || new AudioContext();
    state.checkpointAudioContext = context;
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 880;
    gainNode.gain.value = 0.05;
    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.35);
  } catch (error) {
    console.warn("Audio notification unavailable.", error);
  }
}

function renderResult({ title, status, body }) {
  elements.resultCard.classList.remove("hidden");
  elements.resultCard.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <strong>${escapeHtml(status)}</strong>
    <p>${escapeHtml(body)}</p>
  `;
}

function updateBadge(label) {
  elements.sessionBadge.textContent = label;
}

function updateFocusUI() {
  if (state.passive.totalSeconds <= 0) {
    return;
  }
  const ratio = Math.round((state.passive.visibleSeconds / state.passive.totalSeconds) * 100);
  elements.focusValue.textContent = `${ratio}%`;
}

async function request(path, options) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      typeof payload === "object"
        ? payload.detail?.message || payload.detail || payload.message || "Request failed."
        : payload || "Request failed.";
    throw new Error(message);
  }

  return payload;
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  elements.toast.classList.toggle("error", isError);
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => elements.toast.classList.add("hidden"), 3500);
}

function handleError(error) {
  console.error(error);
  showToast(error.message || "Something went wrong.", true);
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function standardDeviation(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

boot();
