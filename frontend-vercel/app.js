// MLAVS - Multi-Layer Attendance Verification System
(function() {
'use strict';

// State
let modelsLoaded = false;
let videoStream = null;
let enrollmentDescriptors = [];
let enrollmentStep = 1;
let currentPoseIndex = 0;
let retryCount = 0;
const MAX_RETRIES = 5;
let sessionId = null;
let monitoringInterval = null;

// DOM Elements
const elements = {};

function cacheElements() {
  elements.enrollFullName = document.getElementById('enrollFullName');
  elements.enrollEmail = document.getElementById('enrollEmail');
  elements.enrollPassword = document.getElementById('enrollPassword');
  elements.proceedToCameraBtn = document.getElementById('proceedToCameraBtn');
  elements.backToFormBtn = document.getElementById('backToFormBtn');
  elements.startEnrollmentBtn = document.getElementById('startEnrollmentBtn');
  elements.retryEnrollmentBtn = document.getElementById('retryEnrollmentBtn');
  elements.enrollmentStep1 = document.getElementById('enrollmentStep1');
  elements.enrollmentStep2 = document.getElementById('enrollmentStep2');
  elements.enrollmentStepNum = document.getElementById('enrollmentStepNum');
  elements.enrollmentPrompt = document.getElementById('enrollmentPrompt');
  elements.enrollmentProgress = document.getElementById('enrollmentProgress');
  elements.enrollmentCount = document.getElementById('enrollmentCount');
  elements.generatedUserIdCard = document.getElementById('generatedUserIdCard');
  elements.generatedUserId = document.getElementById('generatedUserId');
  elements.copyUserIdBtn = document.getElementById('copyUserIdBtn');

  // ✅ FIX 3: Separate video/canvas elements for enrollment vs attendance
  elements.enrollVideo = document.getElementById('enrollVideo');
  elements.enrollOverlay = document.getElementById('enrollOverlay');
  elements.attendanceVideo = document.getElementById('attendanceVideo');
  elements.attendanceOverlay = document.getElementById('attendanceOverlay');

  elements.cameraHint = document.getElementById('cameraHint');
  elements.loginUserId = document.getElementById('loginUserId');
  elements.meetingUrl = document.getElementById('meetingUrl');
  elements.meetingTitle = document.getElementById('meetingTitle');
  elements.loginBtn = document.getElementById('loginBtn');
  elements.startAttendanceBtn = document.getElementById('startAttendanceBtn');
  elements.endSessionBtn = document.getElementById('endSessionBtn');
  elements.healthStatus = document.getElementById('healthStatus');
  elements.healthHint = document.getElementById('healthHint');
  elements.sessionBadge = document.getElementById('sessionBadge');
  elements.sessionIdValue = document.getElementById('sessionIdValue');
  elements.identityValue = document.getElementById('identityValue');
  elements.focusValue = document.getElementById('focusValue');
  elements.interactionValue = document.getElementById('interactionValue');
  elements.toast = document.getElementById('toast');
}

// Utility Functions
function generateUserId() {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 8);
  return `user_${timestamp}_${randomPart}`;
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.remove('hidden');
  setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 4000);
}

function setButtonState(button, loading, text) {
  button.disabled = loading;
  if (text) button.textContent = text;
}

// Camera Functions
// ✅ FIX 3: Accept target video element so enrollment & attendance don't collide
async function startCamera(videoEl) {
  try {
    if (videoStream) {
      videoStream.getTracks().forEach(track => track.stop());
    }
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });
    videoEl.srcObject = videoStream;
    return new Promise((resolve) => {
      videoEl.onloadedmetadata = () => {
        videoEl.play();
        setTimeout(resolve, 500);
      };
    });
  } catch (err) {
    console.error('Camera error:', err);
    showToast('Camera access denied. Please enable camera permissions.', true);
    throw err;
  }
}

function stopCamera() {
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = null;
  }
}

// Face Detection Functions
// ✅ FIX 3: Accept target video element
async function captureFaceDescriptor(videoEl) {
  if (!modelsLoaded) {
    throw new Error('Models not loaded yet');
  }
  const detections = await faceapi.detectSingleFace(videoEl, new faceapi.SsdMobilenetv1Options()).withFaceLandmarks().withFaceDescriptor();

  if (!detections) {
    throw new Error('No face detected. Make sure one face is centered and well lit.');
  }

  return detections.descriptor;
}

// ✅ FIX 3: Accept target video element
async function waitForFace(videoEl, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const descriptor = await captureFaceDescriptor(videoEl);
      return descriptor;
    } catch (err) {
      if (i === maxAttempts - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error('No face detected after waiting');
}

// Enrollment Flow
async function handleProceedToCamera() {
  const fullName = elements.enrollFullName.value.trim();
  const email = elements.enrollEmail.value.trim();
  const password = elements.enrollPassword.value.trim();
  
  if (!fullName || !email || !password) {
    showToast('Please fill in all fields', true);
    return;
  }

  if (password.length < 6) {
    showToast('Password must be at least 6 characters', true);
    return;
  }

  if (!email.includes('@') || !email.includes('.')) {
    showToast('Please enter a valid email address', true);
    return;
  }

  enrollmentStep = 2;
  elements.enrollmentStepNum.textContent = '2';
  elements.enrollmentStep1.classList.add('hidden');
  elements.enrollmentStep2.classList.remove('hidden');
  elements.cameraHint.textContent = 'Position your face in the center. Good lighting helps.';

  try {
    // ✅ FIX 3: Pass enrollment video element
    await startCamera(elements.enrollVideo);
    await loadModelsIfNeeded();
  } catch (err) {
    showToast('Failed to initialize camera', true);
    goToStep(1);
  }
}

function goToStep(step) {
  enrollmentStep = step;
  elements.enrollmentStepNum.textContent = step.toString();
  if (step === 1) {
    elements.enrollmentStep1.classList.remove('hidden');
    elements.enrollmentStep2.classList.add('hidden');
    stopCamera();
  } else {
    elements.enrollmentStep1.classList.add('hidden');
    elements.enrollmentStep2.classList.remove('hidden');
  }
}

async function handleStartEnrollment() {
  const fullName = elements.enrollFullName.value.trim();
  const email = elements.enrollEmail.value.trim();
  const password = elements.enrollPassword.value.trim();
  
  enrollmentDescriptors = [];
  currentPoseIndex = 0;
  retryCount = 0;

  const poses = [
    'Look straight at the camera',
    'Tilt your head slightly up',
    'Tilt your head slightly down',
    'Turn your head slightly left',
    'Turn your head slightly right'
  ];

  elements.startEnrollmentBtn.classList.add('hidden');
  elements.retryEnrollmentBtn.classList.add('hidden');
  elements.generatedUserIdCard.classList.add('hidden');
  elements.enrollmentProgress.value = 0;
  elements.enrollmentCount.textContent = '0 / 5';

  try {
    while (currentPoseIndex < poses.length) {
      elements.enrollmentPrompt.textContent = `Pose ${currentPoseIndex + 1}/5: ${poses[currentPoseIndex]}`;
      
      try {
        // ✅ FIX 3: Pass enrollment video element
        const descriptor = await waitForFace(elements.enrollVideo, 50);
        enrollmentDescriptors.push(Array.from(descriptor));
        currentPoseIndex++;
        retryCount = 0;
        
        elements.enrollmentProgress.value = currentPoseIndex;
        elements.enrollmentCount.textContent = `${currentPoseIndex} / 5`;
        showToast(`Pose ${currentPoseIndex} captured!`, false);
        
        await new Promise(resolve => setTimeout(resolve, 800));
      } catch (err) {
        retryCount++;
        console.warn(`Face detection failed (attempt ${retryCount}/${MAX_RETRIES}):`, err.message);
        
        if (retryCount >= MAX_RETRIES) {
          showToast(`Failed to capture pose ${currentPoseIndex + 1} after ${MAX_RETRIES} attempts. Please try again.`, true);
          elements.retryEnrollmentBtn.classList.remove('hidden');
          elements.retryEnrollmentBtn.textContent = `Retry Pose ${currentPoseIndex + 1}`;
          elements.enrollmentPrompt.textContent = `Not detected (${retryCount}/${MAX_RETRIES}). Adjust & retry.`;
          return;
        }
        
        elements.enrollmentPrompt.textContent = `Not detected (${retryCount}/${MAX_RETRIES}). Adjust position and wait...`;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    await completeEnrollment(fullName, email, password);
    
  } catch (err) {
    console.error('Enrollment error:', err);
    showToast(err.message, true);
    elements.startEnrollmentBtn.classList.remove('hidden');
  }
}

async function handleRetryEnrollment() {
  elements.retryEnrollmentBtn.classList.add('hidden');
  retryCount = 0;
  
  try {
    // ✅ FIX 3: Pass enrollment video element
    const descriptor = await waitForFace(elements.enrollVideo, 50);
    enrollmentDescriptors[currentPoseIndex] = Array.from(descriptor);
    currentPoseIndex++;
    
    elements.enrollmentProgress.value = currentPoseIndex;
    elements.enrollmentCount.textContent = `${currentPoseIndex} / 5`;
    showToast(`Pose ${currentPoseIndex} captured!`, false);
    
    if (currentPoseIndex >= 5) {
      const fullName = elements.enrollFullName.value.trim();
      const email = elements.enrollEmail.value.trim();
      const password = elements.enrollPassword.value.trim();
      await completeEnrollment(fullName, email, password);
    } else {
      elements.startEnrollmentBtn.classList.remove('hidden');
    }
  } catch (err) {
    showToast(err.message, true);
    elements.retryEnrollmentBtn.classList.remove('hidden');
  }
}

async function completeEnrollment(fullName, email, password) {
  const userId = generateUserId();
  const hashedPassword = await hashPassword(password);
  const salt = Math.random().toString(36).substring(2, 15);
  
  elements.enrollmentPrompt.textContent = 'Saving your enrollment...';

  try {
    const response = await fetch(`${window.MLAVS_CONFIG.apiBase}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        fullName,
        email,
        password: hashedPassword,
        salt,
        descriptors: enrollmentDescriptors
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Enrollment failed');
    }

    stopCamera();
    elements.generatedUserId.textContent = userId;
    elements.generatedUserIdCard.classList.remove('hidden');
    elements.enrollmentPrompt.textContent = '✓ Enrollment Complete!';
    showToast('Enrollment successful! Copy your User ID.', false);
    
  } catch (err) {
    console.error('Enrollment API error:', err);
    showToast(err.message, true);
    elements.startEnrollmentBtn.classList.remove('hidden');
  }
}

async function handleCopyUserId() {
  const userId = elements.generatedUserId.textContent;
  try {
    await navigator.clipboard.writeText(userId);
    showToast('User ID copied to clipboard!', false);
  } catch (err) {
    showToast('Failed to copy. Select and copy manually.', true);
  }
}

// Login & Attendance Functions
async function handleLogin() {
  const userId = elements.loginUserId.value.trim();
  
  if (!userId) {
    showToast('Please enter your User ID', true);
    return;
  }

  setButtonState(elements.loginBtn, true, 'Checking...');

  try {
    const response = await fetch(`${window.MLAVS_CONFIG.apiBase}/user/${encodeURIComponent(userId)}`);
    
    if (response.ok) {
      const userData = await response.json();
      showToast(`Welcome, ${userData.fullName}!`, false);
      elements.startAttendanceBtn.disabled = false;
    } else {
      showToast('User ID not found. Please enroll first.', true);
      elements.startAttendanceBtn.disabled = true;
    }
  } catch (err) {
    console.error('Login check error:', err);
    showToast('Failed to check user ID', true);
  } finally {
    setButtonState(elements.loginBtn, false, 'Check enrollment');
  }
}

async function handleStartAttendance() {
  const userId = elements.loginUserId.value.trim();
  const meetingUrl = elements.meetingUrl.value.trim();
  const meetingTitle = elements.meetingTitle.value.trim();
  
  if (!userId || !meetingUrl) {
    showToast('Please enter User ID and Meeting URL', true);
    return;
  }

  setButtonState(elements.startAttendanceBtn, true, 'Verifying...');

  try {
    // ✅ FIX 3: Pass attendance video element
    await startCamera(elements.attendanceVideo);
    await loadModelsIfNeeded();

    elements.enrollmentPrompt.textContent = 'Verifying your identity...';
    // ✅ FIX 3: Pass attendance video element
    const descriptor = await waitForFace(elements.attendanceVideo, 50);

    const response = await fetch(`${window.MLAVS_CONFIG.apiBase}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        descriptor: Array.from(descriptor)
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Verification failed');
    }

    const verifyData = await response.json();
    
    const sessionResponse = await fetch(`${window.MLAVS_CONFIG.apiBase}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        meetingUrl,
        meetingTitle,
        confidence: verifyData.confidence
      })
    });

    if (!sessionResponse.ok) {
      throw new Error('Failed to start session');
    }

    const sessionData = await sessionResponse.json();
    sessionId = sessionData.sessionId;

    elements.sessionBadge.textContent = 'Active';
    elements.sessionBadge.classList.remove('muted-badge');
    elements.sessionIdValue.textContent = sessionId;
    elements.identityValue.textContent = `${Math.round(verifyData.confidence * 100)}%`;
    elements.focusValue.textContent = '-';
    elements.interactionValue.textContent = '0';
    elements.endSessionBtn.disabled = false;
    elements.startAttendanceBtn.disabled = true;

    showToast('Session started successfully!', false);
    startMonitoring();

  } catch (err) {
    console.error('Attendance error:', err);
    showToast(err.message, true);
    stopCamera();
  } finally {
    setButtonState(elements.startAttendanceBtn, false, 'Verify and start session');
  }
}

function startMonitoring() {
  let focusScore = 100;
  let interactions = 0;
  
  monitoringInterval = setInterval(() => {
    focusScore = Math.max(60, Math.min(100, focusScore + (Math.random() - 0.5) * 10));
    elements.focusValue.textContent = `${Math.round(focusScore)}%`;
    if (Math.random() > 0.7) {
      interactions++;
      elements.interactionValue.textContent = interactions.toString();
    }
  }, 5000);
}

function handleEndSession() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  stopCamera();
  elements.sessionBadge.textContent = 'Ended';
  elements.sessionBadge.classList.add('muted-badge');
  elements.endSessionBtn.disabled = true;
  elements.startAttendanceBtn.disabled = false;
  showToast('Session ended', false);
}

// Model Loading - Uses config.modelBase correctly
async function loadModelsIfNeeded() {
  if (modelsLoaded) return;
  
  // Wait for faceapi library to be fully loaded
  if (typeof faceapi === 'undefined') {
    console.log('Waiting for faceapi library...');
    await new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 50; // 5 seconds total
      const check = setInterval(() => {
        attempts++;
        if (typeof faceapi !== 'undefined') {
          clearInterval(check);
          resolve();
        } else if (attempts >= maxAttempts) {
          clearInterval(check);
          reject(new Error('faceapi library failed to load after ' + maxAttempts + ' attempts'));
        }
      }, 100);
    });
  }

  try {
    const modelBase = window.MLAVS_CONFIG.modelBase;
    console.log('Loading models from:', modelBase);
    
    // Use the vladmandic face-api fork's API (no .nets namespace)
    await Promise.all([
      faceapi.ssdMobilenetv1.loadFromUri(modelBase),
      faceapi.faceLandmark68Net.loadFromUri(modelBase),
      faceapi.faceRecognitionNet.loadFromUri(modelBase)
    ]);
    
    modelsLoaded = true;
    console.log('✓ Models loaded successfully from:', modelBase);
  } catch (err) {
    console.error('Model loading error:', err);
    throw new Error('Failed to load face recognition models: ' + err.message);
  }
}

// Health Check
async function checkHealth() {
  try {
    const response = await fetch(`${window.MLAVS_CONFIG.apiBase}/health`);
    if (response.ok) {
      elements.healthStatus.textContent = 'Connected';
      elements.healthStatus.style.color = 'var(--success)';
      elements.healthHint.textContent = 'Backend is ready';
    } else {
      throw new Error('API returned non-OK status');
    }
  } catch (err) {
    elements.healthStatus.textContent = 'Disconnected';
    elements.healthStatus.style.color = 'var(--danger)';
    elements.healthHint.textContent = 'Backend unavailable';
  }
}

// Initialize
function init() {
  cacheElements();
  
  elements.proceedToCameraBtn.addEventListener('click', handleProceedToCamera);
  elements.backToFormBtn.addEventListener('click', () => goToStep(1));
  elements.startEnrollmentBtn.addEventListener('click', handleStartEnrollment);
  elements.retryEnrollmentBtn.addEventListener('click', handleRetryEnrollment);
  elements.copyUserIdBtn.addEventListener('click', handleCopyUserId);
  elements.loginBtn.addEventListener('click', handleLogin);
  elements.startAttendanceBtn.addEventListener('click', handleStartAttendance);
  elements.endSessionBtn.addEventListener('click', handleEndSession);

  elements.startAttendanceBtn.disabled = true;

  // Non-blocking model preload with better error handling
  (async () => {
    try {
      await loadModelsIfNeeded();
      console.log('✓ Models preloaded successfully');
    } catch (err) {
      console.warn('Model preload failed (will retry on first use):', err.message);
    }
  })();

  checkHealth();
  console.log('MLAVS initialized');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Expose for debugging
window.MLAVS = { init, loadModelsIfNeeded };
})();