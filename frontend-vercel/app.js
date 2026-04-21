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
  elements.video = document.getElementById('video');
  elements.overlay = document.getElementById('overlay');
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
  elements.resultCard = document.getElementById('resultCard');
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
async function startCamera() {
  try {
    if (videoStream) {
      videoStream.getTracks().forEach(track => track.stop());
    }
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });
    elements.video.srcObject = videoStream;
    return new Promise((resolve) => {
      elements.video.onloadedmetadata = () => {
        elements.video.play();
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
async function captureFaceDescriptor() {
  if (!modelsLoaded) {
    throw new Error('Models not loaded yet');
  }
  const detections = await faceapi.detectSingleFace(elements.video, new faceapi.SsdMobilenetv1Options()).withFaceLandmarks().withFaceDescriptor();

  if (!detections) {
    throw new Error('No face detected. Make sure one face is centered and well lit.');
  }

  return detections.descriptor;
}

async function waitForFace(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const descriptor = await captureFaceDescriptor();
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

  // Proceed to Step 2
  enrollmentStep = 2;
  elements.enrollmentStepNum.textContent = '2';
  elements.enrollmentStep1.classList.add('hidden');
  elements.enrollmentStep2.classList.remove('hidden');
  elements.cameraHint.textContent = 'Position your face in the center. Good lighting helps.';

  // Start camera when entering step 2
  try {
    await startCamera();
    await loadModelsIfNeeded();
  } catch (err) {
    showToast('Failed to initialize camera or load models', true);
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
        const descriptor = await waitForFace(50);
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

    // All poses captured successfully
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
    const descriptor = await waitForFace(50);
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

    // Success!
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
    // Start camera for verification
    await startCamera();
    await loadModelsIfNeeded();

    // Capture face for verification
    elements.enrollmentPrompt.textContent = 'Verifying your identity...';
    const descriptor = await waitForFace(50);

    // Verify against stored descriptors
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
    
    // Start session
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

    // Update UI
    elements.sessionBadge.textContent = 'Active';
    elements.sessionBadge.classList.remove('muted-badge');
    elements.sessionIdValue.textContent = sessionId;
    elements.identityValue.textContent = `${Math.round(verifyData.confidence * 100)}%`;
    elements.focusValue.textContent = '-';
    elements.interactionValue.textContent = '0';
    elements.endSessionBtn.disabled = false;
    elements.startAttendanceBtn.disabled = true;

    showToast('Session started successfully!', false);

    // Start monitoring
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
    // Simulate focus tracking (in real implementation, use eye tracking)
    focusScore = Math.max(60, Math.min(100, focusScore + (Math.random() - 0.5) * 10));
    elements.focusValue.textContent = `${Math.round(focusScore)}%`;

    // Track interactions (could be enhanced with actual event listeners)
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

// ✅ UPDATED: Model Loading - Uses CDN models (no local folder needed)
async function loadModelsIfNeeded() {
  if (modelsLoaded) return;
  
  // Wait for faceapi library to be fully loaded with nets
  if (typeof faceapi === 'undefined' || !faceapi.nets) {
    console.log('Waiting for faceapi library to load...');
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (typeof faceapi !== 'undefined' && faceapi.nets) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  // Debug: verify faceapi is ready
  console.log('faceapi available:', typeof faceapi);
  console.log('faceapi.nets available:', !!faceapi?.nets);

  try {
    // Use CDN-hosted models from @vladmandic/face-api
    // These include proper manifest + shard files required by loadFromUri()
    const modelBase = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
    
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(modelBase + '/ssd_mobilenetv1_model'),
      faceapi.nets.faceLandmark68.loadFromUri(modelBase + '/face_landmark_68_model'),
      faceapi.nets.faceRecognitionNet.loadFromUri(modelBase + '/face_recognition_model')
    ]);
    
    modelsLoaded = true;
    console.log('✓ Face recognition models loaded from CDN');
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
  
  // Event Listeners
  elements.proceedToCameraBtn.addEventListener('click', handleProceedToCamera);
  elements.backToFormBtn.addEventListener('click', () => goToStep(1));
  elements.startEnrollmentBtn.addEventListener('click', handleStartEnrollment);
  elements.retryEnrollmentBtn.addEventListener('click', handleRetryEnrollment);
  elements.copyUserIdBtn.addEventListener('click', handleCopyUserId);
  elements.loginBtn.addEventListener('click', handleLogin);
  elements.startAttendanceBtn.addEventListener('click', handleStartAttendance);
  elements.endSessionBtn.addEventListener('click', handleEndSession);

  // Initial state
  elements.startAttendanceBtn.disabled = true;

  // Load models on page load (non-blocking)
  loadModelsIfNeeded().catch(err => {
    console.warn('Model preload failed (will retry on first use):', err.message);
  });

  // Health check
  checkHealth();

  console.log('MLAVS initialized');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
})();
