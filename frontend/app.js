// MLAVS - Multi-Layer Attendance Verification System
(function() {
  'use strict';

  // State
  let videoStream = null;
  let enrollmentStep = 1;
  let currentPoseIndex = 0;
  let retryCount = 0;
  const MAX_RETRIES = 5;
  let sessionId = null;
  let monitoringTimer = null;
  let passiveState = { visibleSeconds: 0, totalSeconds: 0, interactionCount: 0, lastTick: Date.now() };
  
  // DOM Cache
  const el = {};

  function cacheElements() {
    // Enrollment
    el.enrollFullName = document.getElementById('enrollFullName');
    el.enrollEmail = document.getElementById('enrollEmail');
    el.enrollPassword = document.getElementById('enrollPassword');
    el.proceedToCameraBtn = document.getElementById('proceedToCameraBtn');
    el.enrollmentStep1 = document.getElementById('enrollmentStep1');
    el.enrollmentStep2 = document.getElementById('enrollmentStep2');
    el.enrollmentStepNum = document.getElementById('enrollmentStepNum');
    el.enrollmentPrompt = document.getElementById('enrollmentPrompt');
    el.enrollmentProgress = document.getElementById('enrollmentProgress');
    el.enrollmentCount = document.getElementById('enrollmentCount');
    el.startEnrollmentBtn = document.getElementById('startEnrollmentBtn');
    el.retryEnrollmentBtn = document.getElementById('retryEnrollmentBtn');
    el.generatedUserIdCard = document.getElementById('generatedUserIdCard');
    el.generatedUserId = document.getElementById('generatedUserId');
    el.copyUserIdBtn = document.getElementById('copyUserIdBtn');
    el.enrollVideo = document.getElementById('enrollVideo');

    // Attendance
    el.loginUserId = document.getElementById('loginUserId');
    el.loginPassword = document.getElementById('loginPassword');
    el.meetingUrl = document.getElementById('meetingUrl');
    el.meetingTitle = document.getElementById('meetingTitle');
    el.loginBtn = document.getElementById('loginBtn');
    el.startAttendanceBtn = document.getElementById('startAttendanceBtn');
    el.endSessionBtn = document.getElementById('endSessionBtn');
    el.attendanceVideo = document.getElementById('attendanceVideo');
    el.cameraHint = document.getElementById('cameraHint');

    // Health & Stats
    el.healthStatus = document.getElementById('healthStatus');
    el.healthHint = document.getElementById('healthHint');
    el.sessionBadge = document.getElementById('sessionBadge');
    el.sessionIdValue = document.getElementById('sessionIdValue');
    el.identityValue = document.getElementById('identityValue');
    el.focusValue = document.getElementById('focusValue');
    el.interactionValue = document.getElementById('interactionValue');
    el.toast = document.getElementById('toast');
  }

  // ====================== UTILITIES ======================
  function showToast(msg, isError = false) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('error', isError);
    el.toast.classList.remove('hidden');
    setTimeout(() => el.toast.classList.add('hidden'), 4000);
  }

  function setBtn(btn, loading, text) {
    btn.disabled = loading;
    if (text) btn.textContent = text;
  }

  async function apiFetch(path, options = {}) {
    const base = window.MLAVS_CONFIG.apiBase;
    const url = `${base}${path.startsWith('/') ? path : '/' + path}`;
    const res = await fetch(url, options);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.detail?.message || data?.error || data?.detail || 'Request failed');
    return data;
  }

  // ====================== CAMERA ======================
  async function startCamera(videoEl) {
    if (videoStream) stopCamera();
    videoStream = await navigator.mediaDevices.getUserMedia({ 
      video: { width: 640, height: 480, facingMode: 'user' }, 
      audio: false 
    });
    videoEl.srcObject = videoStream;
    return new Promise(resolve => { 
      videoEl.onloadedmetadata = () => { 
        videoEl.play(); 
        setTimeout(resolve, 500); 
      }; 
    });
  }

  function stopCamera() {
    if (videoStream) { 
      videoStream.getTracks().forEach(t => t.stop()); 
      videoStream = null; 
    }
    if (el.enrollVideo) el.enrollVideo.srcObject = null;
    if (el.attendanceVideo) el.attendanceVideo.srcObject = null;
    if (el.cameraHint) el.cameraHint.style.display = 'flex';
  }

  function captureImageFromVideo(videoEl) {
    return new Promise((resolve, reject) => {
      try {
        const c = document.createElement('canvas');
        c.width = videoEl.videoWidth || 640; 
        c.height = videoEl.videoHeight || 480;
        c.getContext('2d').drawImage(videoEl, 0, 0, c.width, c.height);
        c.toBlob(b => b ? resolve(b) : reject(new Error('Capture failed')), 'image/jpeg', 0.85);
      } catch (e) { reject(e); }
    });
  }

  // ====================== ENROLLMENT HELPERS ======================
  function goToStep(step) {
    enrollmentStep = step;
    if (step === 1) { 
      el.enrollmentStep1.classList.remove('hidden'); 
      el.enrollmentStep2.classList.add('hidden'); 
      stopCamera(); 
    }
  }

  async function completeEnrollment(capturedImages) {
    el.enrollmentPrompt.textContent = 'Saving enrollment...';
    const userId = `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const fd = new FormData();
    fd.append('user_id', userId);
    fd.append('full_name', el.enrollFullName.value.trim());
    fd.append('email', el.enrollEmail.value.trim());
    fd.append('password', el.enrollPassword.value.trim());
    capturedImages.forEach((b, i) => fd.append(`image${i + 1}`, b, `cap_${i + 1}.jpg`));

    try {
      await apiFetch('/enroll', { method: 'POST', body: fd });
      stopCamera();
      el.generatedUserId.textContent = userId;
      el.generatedUserIdCard.classList.remove('hidden');
      el.enrollmentPrompt.textContent = '✓ Enrollment Complete!';
      showToast('Enrollment successful! Save your User ID.', false);
    } catch (e) { 
      showToast(e.message, true); 
      el.startEnrollmentBtn.classList.remove('hidden'); 
    }
  }

  function startPassiveMonitoring() {
    passiveState = { visibleSeconds: 0, totalSeconds: 0, interactionCount: 0, lastTick: Date.now() };
    const trackVisibility = () => { 
      if (!document.hidden) passiveState.visibleSeconds += (Date.now() - passiveState.lastTick) / 1000; 
    };
    const trackInteraction = () => { passiveState.interactionCount++; };

    document.addEventListener('visibilitychange', trackVisibility);
    window.addEventListener('mousemove', trackInteraction, { once: false });
    window.addEventListener('keydown', trackInteraction, { once: false });

    monitoringTimer = setInterval(async () => {
      const now = Date.now();
      const dt = (now - passiveState.lastTick) / 1000;
      passiveState.totalSeconds += dt;
      passiveState.visibleSeconds += dt;
      passiveState.lastTick = now;

      el.focusValue.textContent = `${Math.round(Math.min(1, passiveState.visibleSeconds / Math.max(1, passiveState.totalSeconds)) * 100)}%`;
      el.interactionValue.textContent = passiveState.interactionCount;

      try {
        await apiFetch('/passive', {
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            session_id: sessionId, 
            visible_seconds: passiveState.visibleSeconds, 
            total_seconds: passiveState.totalSeconds, 
            interaction_count: passiveState.interactionCount 
          })
        });
      } catch (e) { 
        console.warn('Passive update failed:', e); 
      }
    }, 15000);
  }

  async function checkHealth() {
    try {
      const h = await apiFetch('/health');
      el.healthStatus.textContent = 'Connected'; 
      el.healthStatus.style.color = 'var(--success)'; 
      el.healthStatus.classList.remove('muted-badge');
      el.healthHint.textContent = `Sessions: ${h.sessions} | ${h.persistence_mode}`;
    } catch {
      el.healthStatus.textContent = 'Disconnected'; 
      el.healthStatus.style.color = 'var(--danger)';
      el.healthHint.textContent = 'Backend unavailable';
    }
  }

  // ====================== EVENT LISTENERS (NOW SAFE) ======================
  function attachEventListeners() {
    // === ENROLLMENT ===
    el.proceedToCameraBtn.addEventListener('click', async () => {
      if (!el.enrollFullName.value.trim() || !el.enrollEmail.value.trim() || !el.enrollPassword.value.trim()) {
        return showToast('Please fill in all fields', true);
      }
      if (el.enrollPassword.value.length < 6) return showToast('Password must be at least 6 characters', true);
      if (!el.enrollEmail.value.includes('@')) return showToast('Invalid email', true);

      enrollmentStep = 2;
      el.enrollmentStepNum.textContent = 'Step 2 of 2';
      el.enrollmentStep1.classList.add('hidden');
      el.enrollmentStep2.classList.remove('hidden');
      try { 
        await startCamera(el.enrollVideo); 
      } catch { 
        showToast('Camera access denied', true); 
        goToStep(1); 
      }
    });

    el.startEnrollmentBtn.addEventListener('click', async () => {
      currentPoseIndex = 0; 
      retryCount = 0;
      const images = [];
      const poses = ['Look straight', 'Tilt slightly up', 'Tilt slightly down', 'Turn slightly left', 'Turn slightly right'];
      el.startEnrollmentBtn.classList.add('hidden');
      el.retryEnrollmentBtn.classList.add('hidden');
      el.generatedUserIdCard.classList.add('hidden');
      el.enrollmentProgress.value = 0; 
      el.enrollmentCount.textContent = '0 / 5';

      try {
        while (currentPoseIndex < poses.length) {
          el.enrollmentPrompt.textContent = `Pose ${currentPoseIndex + 1}/5: ${poses[currentPoseIndex]}`;
          await new Promise(r => setTimeout(r, 1500));
          try {
            const blob = await captureImageFromVideo(el.enrollVideo);
            images.push(blob);
            currentPoseIndex++; 
            retryCount = 0;
            el.enrollmentProgress.value = currentPoseIndex;
            el.enrollmentCount.textContent = `${currentPoseIndex} / 5`;
            showToast(`Pose ${currentPoseIndex} captured`, false);
            await new Promise(r => setTimeout(r, 600));
          } catch {
            retryCount++;
            if (retryCount >= MAX_RETRIES) {
              showToast(`Pose ${currentPoseIndex+1} failed after ${MAX_RETRIES} attempts`, true);
              el.retryEnrollmentBtn.classList.remove('hidden');
              return;
            }
            el.enrollmentPrompt.textContent = `Adjust & retry (${retryCount}/${MAX_RETRIES})...`;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
        await completeEnrollment(images);
      } catch (e) { 
        showToast(e.message, true); 
        el.startEnrollmentBtn.classList.remove('hidden'); 
      }
    });

    el.retryEnrollmentBtn.addEventListener('click', async () => {
      el.retryEnrollmentBtn.classList.add('hidden'); 
      retryCount = 0;
      try {
        await new Promise(r => setTimeout(r, 1500));
        const blob = await captureImageFromVideo(el.enrollVideo);
        if (!window._enrollImages) window._enrollImages = [];
        window._enrollImages[currentPoseIndex] = blob;
        currentPoseIndex++;
        el.enrollmentProgress.value = currentPoseIndex;
        el.enrollmentCount.textContent = `${currentPoseIndex} / 5`;
        if (currentPoseIndex >= 5) {
          await completeEnrollment(window._enrollImages.filter(Boolean));
        } else {
          el.startEnrollmentBtn.classList.remove('hidden');
        }
      } catch (e) { 
        showToast(e.message, true); 
        el.retryEnrollmentBtn.classList.remove('hidden'); 
      }
    });

    el.copyUserIdBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(el.generatedUserId.textContent);
      showToast('User ID copied', false);
    });

    // === ATTENDANCE ===
    el.loginBtn.addEventListener('click', async () => {
      const uid = el.loginUserId.value.trim();
      const pwd = el.loginPassword.value.trim();
      if (!uid || !pwd) return showToast('Enter User ID & Password', true);
      setBtn(el.loginBtn, true, 'Checking...');
      try {
        await apiFetch('/login', { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ user_id: uid, password: pwd }) 
        });
        showToast('Login verified', false);
        el.startAttendanceBtn.disabled = false;
      } catch (e) { 
        showToast(e.message, true); 
      } finally { 
        setBtn(el.loginBtn, false, 'Login & Verify'); 
      }
    });

    el.startAttendanceBtn.addEventListener('click', async () => {
      const uid = el.loginUserId.value.trim();
      const url = el.meetingUrl.value.trim();
      const title = el.meetingTitle.value.trim();
      if (!uid || !url) return showToast('Enter User ID & Meeting URL', true);

      setBtn(el.startAttendanceBtn, true, 'Verifying...');
      try {
        await startCamera(el.attendanceVideo);
        // Show video + hide hint
        el.attendanceVideo.style.display = 'block';
        el.cameraHint.style.display = 'none';

        await new Promise(r => setTimeout(r, 1500));
        const blob = await captureImageFromVideo(el.attendanceVideo);

        const fd = new FormData();
        fd.append('user_id', uid); 
        fd.append('meeting_url', url);
        if (title) fd.append('meeting_title', title);
        fd.append('image', blob, 'verify.jpg');

        const res = await apiFetch('/start', { method: 'POST', body: fd });
        sessionId = res.session_id;
        el.sessionBadge.textContent = 'Active'; 
        el.sessionBadge.classList.remove('muted-badge');
        el.sessionIdValue.textContent = res.session_id.slice(0, 8) + '...';
        el.identityValue.textContent = `${Math.round(res.identity_confidence * 100)}%`;
        el.endSessionBtn.disabled = false; 
        el.startAttendanceBtn.disabled = true;
        showToast('Session started', false);
        startPassiveMonitoring();
      } catch (e) { 
        showToast(e.message, true); 
        stopCamera(); 
      } finally { 
        setBtn(el.startAttendanceBtn, false, 'Start Session'); 
      }
    });

    el.endSessionBtn.addEventListener('click', async () => {
      if (!sessionId) return;
      clearInterval(monitoringTimer);
      setBtn(el.endSessionBtn, true, 'Ending...');
      try {
        await apiFetch('/exit', { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ session_id: sessionId, ended_by: 'user' }) 
        });
        showToast('Session ended', false);
        el.sessionBadge.textContent = 'Ended'; 
        el.sessionBadge.classList.add('muted-badge');
        el.startAttendanceBtn.disabled = false; 
        el.endSessionBtn.disabled = true;
      } catch (e) { 
        showToast(e.message, true); 
      } finally { 
        stopCamera(); 
        setBtn(el.endSessionBtn, false, 'End Session'); 
      }
    });
  }

  // ====================== INIT ======================
  cacheElements();           // ← MUST be first
  attachEventListeners();    // ← now safe
  checkHealth();
  setInterval(checkHealth, 30000);

  console.log('✅ MLAVS Frontend Initialized (bug fixed)');
})();