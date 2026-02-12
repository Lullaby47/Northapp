// public/app.js (WALLET MODE + RECOVERY PHRASE + QR)

// SINGLE-INIT GUARD - Prevent duplicate initialization
if (window.__GBV_APP_INITED__) {
  console.warn("App already initialized - skipping duplicate init");
} else {
  window.__GBV_APP_INITED__ = true;

window.App = (() => {
  // Cache for /auth/me response
  let __meCache = null;

  function setMsg(id, text, isError = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
    el.dataset.kind = isError ? "error" : "ok";
  }

  function setBusy(btn, busy, labelBusy = "Please wait...") {
    if (!btn) return;
    btn.disabled = !!busy;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = busy ? labelBusy : btn.dataset.label;
  }

  async function api(path, opts = {}) {
    const headers = opts.headers || {};
    headers["Content-Type"] = "application/json";

    const res = await fetch(path, { ...opts, headers, credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `Request failed (${res.status})`);
      // Preserve error details for special handling
      if (data.insufficientBalance !== undefined) error.insufficientBalance = data.insufficientBalance;
      if (data.currentBalance !== undefined) error.currentBalance = data.currentBalance;
      if (data.requiredAmount !== undefined) error.requiredAmount = data.requiredAmount;
      throw error;
    }
    return data;
  }

  // Promise cache for /auth/me - prevents concurrent calls
  let __mePromise = null;

  // Load user data ONCE with promise caching - only redirects on 401
  async function loadMe() {
    // If promise exists, return it (prevents concurrent calls)
    if (__mePromise) {
      return await __mePromise;
    }
    
    // If already redirecting, don't proceed
    if (window.__redirectingToLogin) {
      return null;
    }
    
    // Create and cache the promise
    __mePromise = (async () => {
      try {
        const res = await fetch('/auth/me', { credentials: 'include' });

        // Not logged in => redirect only once (but only if not already on login/register page)
        if (res.status === 401) {
          const currentPath = window.location.pathname.toLowerCase();
          const isAuthPage = currentPath.includes('/login.html') || 
                            currentPath.includes('/register.html') ||
                            currentPath.includes('/recovery') ||
                            currentPath.includes('/recover-reset');
          
          if (!window.__redirectingToLogin && !isAuthPage) {
            window.__redirectingToLogin = true;
            window.location.replace('/login.html');
            return null;
          }
          return null;
        }

        // Other errors => do NOT redirect loop
        if (!res.ok) {
          console.error('auth/me failed:', res.status, await res.text().catch(() => ''));
          return null;
        }

        return await res.json();
      } catch (e) {
        // Network errors - don't redirect, just log
        console.error('loadMe error:', e);
        return null;
      }
    })();
    
    return await __mePromise;
  }

  async function isLoggedIn() {
    try {
      const res = await fetch('/auth/me', { credentials: 'include' });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  // -------- QR helper (needs qrcode lib loaded on page) --------
  function renderQrWithCenterText(canvasId, textToEncode, centerText = "GameBoy") {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.QRCode) return;

    const size = canvas.width || 320;
    const opts = { errorCorrectionLevel: "H", margin: 2, width: size };

    window.QRCode.toCanvas(canvas, textToEncode, opts, (err) => {
      if (err) return console.error(err);
      const ctx = canvas.getContext("2d");

      const boxW = Math.floor(size * 0.36);
      const boxH = Math.floor(size * 0.20);
      const x = Math.floor((size - boxW) / 2);
      const y = Math.floor((size - boxH) / 2);

      ctx.save();
      ctx.fillStyle = "rgba(10,10,14,0.92)";
      roundRect(ctx, x, y, boxW, boxH, 12);
      ctx.fill();

      ctx.strokeStyle = "rgba(0,255,204,0.55)";
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, boxW, boxH, 12);
      ctx.stroke();

      ctx.fillStyle = "rgba(255,208,0,0.95)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `900 ${Math.floor(size * 0.065)}px Arial`;
      ctx.fillText(centerText, size / 2, size / 2);
      ctx.restore();
    });

    function roundRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }
  }

  // ---------------- Pages ----------------
  async function initLoginPage() {
    // Prevent multiple initializations
    if (window.__loginPageInitialized) return;
    window.__loginPageInitialized = true;
    
    // Safe login page check - only redirect if already logged in
    async function loginPageCheck() {
      // Only check if not already redirecting
      if (window.__redirectingToDashboard) return;
      
      try {
        const res = await fetch('/auth/me', { credentials: 'include' });
        if (res.status === 200) {
          // already logged in -> go dashboard ONCE
          if (!window.__redirectingToDashboard) {
            window.__redirectingToDashboard = true;
            window.location.replace('/dashboard.html');
            return; // Stop execution
          }
        } else {
          // 401 => stay on login (this is expected)
          // other errors => log only
          if (res.status !== 401) {
            const errorText = await res.text().catch(() => '');
            console.error('auth/me on login page failed:', res.status, errorText);
          }
        }
      } catch (e) {
        // Network errors - stay on login page
        console.error('auth/me check failed:', e);
      }
    }
    
    await loginPageCheck();

    const btnLogin = document.getElementById("btnLogin");
    const btnGoRegister = document.getElementById("btnGoRegister");

    btnLogin?.addEventListener("click", async () => {
      setMsg("msg", "");
      const identifier = document.getElementById("identifier")?.value.trim();
      const password = document.getElementById("password")?.value;

      setBusy(btnLogin, true, "Logging in...");
      try {
        await api("/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
        // Use replace to prevent back button issues
        if (!window.__redirectingToDashboard) {
          window.__redirectingToDashboard = true;
          window.location.replace("/dashboard.html");
        }
      } catch (e) {
        setMsg("msg", e.message, true);
      } finally {
        setBusy(btnLogin, false);
      }
    });

    btnGoRegister?.addEventListener("click", () => window.location.href = "/register.html");
  }

  async function initRegisterPage() {
    // Prevent multiple initializations
    if (window.__registerPageInitialized) return;
    window.__registerPageInitialized = true;
    
    // Safe register page check - only redirect if already logged in
    async function registerPageCheck() {
      // Only check if not already redirecting
      if (window.__redirectingToDashboard) return;
      
      try {
        const res = await fetch('/auth/me', { credentials: 'include' });
        if (res.status === 200) {
          // already logged in -> go dashboard ONCE
          if (!window.__redirectingToDashboard) {
            window.__redirectingToDashboard = true;
            window.location.replace('/dashboard.html');
            return; // Stop execution
          }
        } else {
          // 401 => stay on register (this is expected)
          // other errors => log only
          if (res.status !== 401) {
            const errorText = await res.text().catch(() => '');
            console.error('auth/me on register page failed:', res.status, errorText);
          }
        }
      } catch (e) {
        // Network errors - stay on register page
        console.error('auth/me check failed:', e);
      }
    }
    
    await registerPageCheck();

    const btnRegister = document.getElementById("btnRegister");

    btnRegister?.addEventListener("click", async () => {
      setMsg("msg", "");
      const username = document.getElementById("username")?.value.trim();
      const password = document.getElementById("password")?.value;

      setBusy(btnRegister, true, "Creating...");
      try {
        const out = await api("/auth/register", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });

        // Save phrase ONLY in sessionStorage temporarily (cleared after user confirms)
        sessionStorage.setItem("recovery_phrase", out.recovery_phrase);
        sessionStorage.setItem("recovery_username", out.user.username);

        window.location.href = "/recovery.html";
      } catch (e) {
        setMsg("msg", e.message, true);
      } finally {
        setBusy(btnRegister, false);
      }
    });
  }

  async function initRecoveryPage() {
    const phrase = sessionStorage.getItem("recovery_phrase") || "";
    const username = sessionStorage.getItem("recovery_username") || "";

    const phraseEl = document.getElementById("phrase");
    if (phraseEl) phraseEl.textContent = phrase || "(missing)";

    const unameEl = document.getElementById("uname");
    if (unameEl) unameEl.textContent = username || "(missing)";

    // Build QR payload (contains phrase + username)
    const payload = JSON.stringify({
      v: 1,
      type: "recovery_phrase",
      username,
      phrase,
    });

    // ✅ Use backend PNG QR (works without CDN)
    const qrUrl = "/qr.png?data=" + encodeURIComponent(payload);

    const img = document.getElementById("qrImg");
    if (img) img.src = qrUrl;

    // QR verification status
    let qrVerified = false;
    const qrVerifyStatusEl = document.getElementById("qrVerifyStatus");
    
    // Verify QR code on page load
    async function verifyQR() {
      if (!qrVerifyStatusEl) return;
      
      qrVerifyStatusEl.textContent = "Verifying QR code...";
      qrVerifyStatusEl.style.background = "rgba(255, 255, 255, 0.1)";
      qrVerifyStatusEl.style.border = "1px solid rgba(255, 255, 255, 0.2)";
      qrVerifyStatusEl.style.color = "rgba(255, 255, 255, 0.8)";
      
      try {
        const response = await api("/qr-verify", {
          method: "POST",
          body: JSON.stringify({ data: payload }),
        });
        
        if (response.ok && response.verified) {
          qrVerified = true;
          qrVerifyStatusEl.textContent = "QR Verified ✅";
          qrVerifyStatusEl.style.background = "rgba(0, 255, 204, 0.15)";
          qrVerifyStatusEl.style.border = "1px solid rgba(0, 255, 204, 0.4)";
          qrVerifyStatusEl.style.color = "rgba(0, 255, 204, 0.95)";
        } else {
          qrVerified = false;
          const reason = response.reason || "Unknown error";
          qrVerifyStatusEl.textContent = `WARNING: QR unreadable. Do not continue. Re-generate backup. (${reason})`;
          qrVerifyStatusEl.style.background = "rgba(255, 53, 94, 0.2)";
          qrVerifyStatusEl.style.border = "1px solid rgba(255, 53, 94, 0.5)";
          qrVerifyStatusEl.style.color = "rgba(255, 53, 94, 0.95)";
        }
      } catch (e) {
        qrVerified = false;
        qrVerifyStatusEl.textContent = `WARNING: QR verification failed. Do not continue. (${e.message})`;
        qrVerifyStatusEl.style.background = "rgba(255, 53, 94, 0.2)";
        qrVerifyStatusEl.style.border = "1px solid rgba(255, 53, 94, 0.5)";
        qrVerifyStatusEl.style.color = "rgba(255, 53, 94, 0.95)";
      }
      
      // Update button states
      updateButtonStates();
    }
    
    // Update button enabled/disabled states
    function updateButtonStates() {
      const ack = document.getElementById("ack");
      const btnContinue = document.getElementById("btnContinue");
      const btnDownload = document.getElementById("btnDownload");
      
      // Continue button: requires checkbox AND QR verified
      if (btnContinue) {
        btnContinue.disabled = !(ack?.checked && qrVerified);
      }
      
      // Download button: disabled if QR not verified
      if (btnDownload) {
        btnDownload.disabled = !qrVerified;
      }
    }

    const btnDownload = document.getElementById("btnDownload");
    btnDownload?.addEventListener("click", () => {
      if (!qrVerified) {
        setMsg("msg", "QR code is not verified. Cannot download.", true);
        return;
      }
      const a = document.createElement("a");
      a.download = "recovery-qr.png";
      a.href = qrUrl;
      a.click();
    });

    // Copy buttons
    const btnCopyUser = document.getElementById("btnCopyUser");
    btnCopyUser?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(username);
        setMsg("msg", "Username copied.");
      } catch {
        setMsg("msg", "Clipboard blocked. Copy manually: " + username, true);
      }
    });

    const btnCopyPhrase = document.getElementById("btnCopyPhrase");
    btnCopyPhrase?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(phrase);
        setMsg("msg", "Recovery phrase copied.");
      } catch {
        setMsg("msg", "Clipboard blocked. Copy manually.", true);
      }
    });

    // Confirm checkbox before continuing
    const ack = document.getElementById("ack");
    const btnContinue = document.getElementById("btnContinue");
    ack?.addEventListener("change", () => {
      updateButtonStates();
    });

    btnContinue?.addEventListener("click", () => {
      if (!qrVerified) {
        setMsg("msg", "QR code is not verified. Cannot continue.", true);
        return;
      }
      sessionStorage.removeItem("recovery_phrase");
      sessionStorage.removeItem("recovery_username");
      window.location.href = "/dashboard.html";
    });

    // Start verification
    verifyQR();
  }

  async function initRecoverResetPage() {
    const btnScan = document.getElementById("btnScan");
    const btnUploadQR = document.getElementById("btnUploadQR");
    const qrFileInput = document.getElementById("qrFileInput");
    const btnReset = document.getElementById("btnReset");

    // Helper function to process decoded QR text
    function processQRData(decodedText) {
      try {
        const obj = JSON.parse(decodedText);
        if (obj?.type === "recovery_phrase") {
          document.getElementById("username").value = obj.username || "";
          document.getElementById("phrase").value = obj.phrase || "";
          setMsg("msg", "QR loaded successfully.", false);
          return true;
        } else {
          setMsg("msg", "This QR is not a recovery QR.", true);
          return false;
        }
      } catch {
        setMsg("msg", "Invalid QR data.", true);
        return false;
      }
    }

    // Camera scan (uses html5-qrcode on the page)
    btnScan?.addEventListener("click", async () => {
      setMsg("msg", "");
      const region = document.getElementById("qrRegion");
      if (!region || !window.Html5Qrcode) {
        setMsg("msg", "QR scanner not available.", true);
        return;
      }

      const qr = new window.Html5Qrcode("qrRegion");
      try {
        const cameras = await window.Html5Qrcode.getCameras();
        if (!cameras || cameras.length === 0) throw new Error("No camera found");

        await qr.start(
          cameras[0].id,
          { fps: 10, qrbox: 250 },
          (decodedText) => {
            if (processQRData(decodedText)) {
              qr.stop().catch(() => {});
              qr.clear().catch(() => {});
            }
          },
          () => {}
        );
      } catch (e) {
        setMsg("msg", e.message, true);
        try { await qr.stop(); } catch {}
        try { await qr.clear(); } catch {}
      }
    });

    // File upload QR scan
    btnUploadQR?.addEventListener("click", () => {
      qrFileInput?.click();
    });

    qrFileInput?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) {
        e.target.value = "";
        return;
      }

      // Validate file type
      if (!file.type.startsWith('image/')) {
        setMsg("msg", "Please select an image file.", true);
        e.target.value = "";
        return;
      }

      setMsg("msg", "Scanning QR code from image...", false);
      
      if (!window.Html5Qrcode) {
        setMsg("msg", "QR scanner library not available.", true);
        e.target.value = "";
        return;
      }

      try {
        let decodedText = null;
        let html5QrCode = null;
        
        // Create instance for file scanning
        html5QrCode = new window.Html5Qrcode("qrRegion");
        
        // Try scanning with different configurations
        try {
          // Method 1: Direct file scan with verbose logging
          decodedText = await html5QrCode.scanFile(file, true);
        } catch (err1) {
          console.log("Method 1 failed, trying data URL method...", err1);
          // Method 2: Convert to data URL first
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = (e) => resolve(e.target.result);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            decodedText = await html5QrCode.scanFile(dataUrl, true);
          } catch (err2) {
            console.log("Method 2 failed, trying image element method...", err2);
            // Method 3: Create image element and scan
            try {
              const img = new Image();
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
              });
              img.src = dataUrl;
              await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
              });
              decodedText = await html5QrCode.scanFile(img, true);
            } catch (err3) {
              throw new Error("All scanning methods failed. Make sure the image contains a clear, unobstructed QR code.");
            }
          }
        } finally {
          // Always clear the scanner
          try {
            await html5QrCode.clear();
          } catch {}
        }
        
        // Process the decoded data
        if (decodedText && decodedText.trim()) {
          console.log("Decoded QR:", decodedText);
          const success = processQRData(decodedText);
          if (!success) {
            setMsg("msg", "QR code scanned but data format is invalid.", true);
          }
        } else {
          setMsg("msg", "No QR code found in image. Please ensure the QR code is clear and not cropped.", true);
        }
      } catch (e) {
        console.error("QR scan error:", e);
        let errorMsg = "Could not read QR code from image.";
        if (e.message && e.message.includes("MultiFormat Readers")) {
          errorMsg = "QR code not detected. Please ensure:\n- The image is clear and in focus\n- The QR code is fully visible\n- The image is not rotated or distorted\n- Try downloading the QR code again from the recovery page";
        } else if (e.message) {
          errorMsg += " " + e.message;
        } else {
          errorMsg += " Make sure the image contains a valid recovery QR code.";
        }
        setMsg("msg", errorMsg, true);
      } finally {
        // Reset file input
        e.target.value = "";
      }
    });

    btnReset?.addEventListener("click", async () => {
      setMsg("msg", "");
      const username = document.getElementById("username")?.value.trim();
      const recovery_phrase = document.getElementById("phrase")?.value.trim();
      const new_password = document.getElementById("newPassword")?.value;

      setBusy(btnReset, true, "Recovering...");
      try {
        const out = await api("/auth/recover-reset", {
          method: "POST",
          body: JSON.stringify({ username, recovery_phrase, new_password }),
        });

        // New phrase returned (rotated) — show it in recovery page
        sessionStorage.setItem("recovery_phrase", out.recovery_phrase);
        sessionStorage.setItem("recovery_username", username);

        window.location.href = "/recovery.html";
      } catch (e) {
        setMsg("msg", e.message, true);
      } finally {
        setBusy(btnReset, false);
      }
    });
  }

  // Set loading state helper for topbar
  function setTopLoading(text = '') {
    // Don't overwrite navbar username - only show loading if navbar still shows "Loading..."
    const navbarUser = document.getElementById("navbarUser");
    if (navbarUser) {
      if (text === '') {
        // Clear loading - restore username if available
        const currentUser = window.__currentUserForNavbar;
        if (currentUser && currentUser.username) {
          const roleBadgeClass = currentUser.role === "admin" ? "admin" : 
                                currentUser.role === "coadmin" ? "coadmin" : "user";
          const roleBadgeText = currentUser.role === "admin" ? "ADMIN" : 
                                currentUser.role === "coadmin" ? "COADMIN" : "USER";
          navbarUser.innerHTML = `
            <span>${currentUser.username}</span>
            <span class="role-badge ${roleBadgeClass}">${roleBadgeText}</span>
          `;
        }
      } else if (navbarUser.textContent === "Loading..." || navbarUser.innerHTML.includes("Loading")) {
        // Only overwrite if still showing loading state
        navbarUser.textContent = text;
      }
    }
  }

  // Set loading state helper (legacy - for overlays)
  function setLoading(isLoading, msg = '') {
    setTopLoading(isLoading ? (msg || 'Loading...') : '');
    
    // Remove any blocking overlays
    const overlays = document.querySelectorAll('.loading-overlay, #loadingOverlay, [class*="loading"]');
    overlays.forEach(overlay => {
      if (overlay.style) {
        overlay.style.display = isLoading ? 'flex' : 'none';
        overlay.style.pointerEvents = isLoading ? 'auto' : 'none';
      }
    });
  }

  async function initDashboardPage() {
    // Prevent multiple initializations
    if (window.__dashboardPageInitialized) {
      console.warn("Dashboard already initialized - skipping");
      return;
    }
    
    // Early exit if already redirecting
    if (window.__redirectingToLogin) return;
    
    // Set loading state
    setTopLoading('Loading...');
    
    try {
      // Load user data ONCE
      const me = await loadMe();
      
      // Check if redirect was initiated
      if (window.__redirectingToLogin) {
        setTopLoading('');
        return; // Stop execution immediately
      }
      
      if (!me || !me.user) {
        // Error occurred - clear loading and stop
        setTopLoading('');
        console.error('Failed to load user data');
        return;
      }
      
      // Mark as initialized AFTER successful auth
      window.__dashboardPageInitialized = true;
    
      const btnNavLogout = document.getElementById("btnNavLogout");
      const btnNavDashboard = document.getElementById("btnNavDashboard");
      const btnNavAdmin = document.getElementById("btnNavAdmin");
      const navbarUser = document.getElementById("navbarUser");
      const dashboardContent = document.getElementById("dashboardContent");
      const adminPanelSection = document.getElementById("adminPanelSection");
      const adminUsersList = document.getElementById("adminUsersList");
      const adminUserSearchInput = document.getElementById("adminUserSearchInput");
      
      // Sidebar elements
      const sidebarBtnGame = document.getElementById("sidebarBtnGame");
      const sidebarBtnUsername = document.getElementById("sidebarBtnUsername");
      const sidebarBtnPayments = document.getElementById("sidebarBtnPayments");
      const sidebarBtnTopUp = document.getElementById("sidebarBtnTopUp");
      const sidebarBtnPlay = document.getElementById("sidebarBtnPlay");
      
      // View elements
      const gameView = document.getElementById("gameView");
      const usernameView = document.getElementById("usernameView");
      const paymentsView = document.getElementById("paymentsView");
      const topUpView = document.getElementById("topUpView");
      const playView = document.getElementById("playView");
      
      // Game view elements
      const gameNameInput = document.getElementById("gameNameInput");
      const btnAddGame = document.getElementById("btnAddGame");
      const gamesList = document.getElementById("gamesList");
      
      // Username view elements
      const usernamesList = document.getElementById("usernamesList");
      const usernameToast = document.getElementById("usernameToast");

      let currentUser = me.user;
      let isAdminPanelOpen = false;
      let currentView = null; // 'game', 'username', 'dashboard', 'admin'
      
      // Navbar coins display
      const navCoins = document.getElementById("navCoins");
      const navCoinsValue = document.getElementById("navCoinsValue");
      
      // Make renderCoins accessible globally for pollTopUpStatus
      window.renderCoins = function(balance) {
        if (navCoinsValue) {
          const coins = Number(balance) || 0;
          navCoinsValue.textContent = coins.toLocaleString();
        }
        if (navCoins) {
          navCoins.style.display = "flex";
        }
      };
      
      // Make navCoins clickable to open TopUp panel
      if (navCoins) {
        navCoins.style.cursor = "pointer";
        navCoins.addEventListener("click", () => {
          showView('topup');
        });
      }
      
      // Initialize coins display
      window.renderCoins(currentUser.balanceCoins || 0);
      
      // Update navbar user info
      if (navbarUser) {
        // Store currentUser globally for navbar restoration
        window.__currentUserForNavbar = currentUser;
        
        const roleBadgeClass = currentUser.role === "admin" ? "admin" : 
                              currentUser.role === "coadmin" ? "coadmin" : "user";
        const roleBadgeText = currentUser.role === "admin" ? "ADMIN" : 
                              currentUser.role === "coadmin" ? "COADMIN" : "USER";
        navbarUser.innerHTML = `
          <span>${currentUser.username}</span>
          <span class="role-badge ${roleBadgeClass}">${roleBadgeText}</span>
        `;
      }

      // Update dashboard content
      const who = document.getElementById("who");
      if (who) {
        who.textContent = `UserID: ${currentUser.id}`;
      }
      const created = document.getElementById("created");
      if (created) created.textContent = `Created: ${currentUser.created_at}`;

      // Show Admin button if user is admin or coadmin
      const isAdmin = currentUser.id === 1 || currentUser.role === "admin";
      const isAdminOrCoAdmin = isAdmin || currentUser.role === "coadmin";
      if (isAdminOrCoAdmin && btnNavAdmin) {
        btnNavAdmin.style.display = "block";
      }
      
      // Show sidebar buttons based on role
      if (isAdmin && sidebarBtnGame) {
        sidebarBtnGame.style.display = "block";
      }
      
      // Show Payments button for Admin/Co-Admin
      if (isAdminOrCoAdmin && sidebarBtnPayments) {
        sidebarBtnPayments.style.display = "block";
      }
      
      // TopUp button is visible for all users (already visible by default)
      
      // Bind sidebar events ONLY ONCE
      if (!window.__sidebarBound) {
        window.__sidebarBound = true;
        
        sidebarBtnGame?.addEventListener("click", () => {
          showView('game');
        });

        sidebarBtnUsername?.addEventListener("click", () => {
          showView('username');
        });

        sidebarBtnPayments?.addEventListener("click", () => {
          showView('payments');
        });

        sidebarBtnTopUp?.addEventListener("click", () => {
          showView('topup');
        });

        sidebarBtnPlay?.addEventListener("click", () => {
          showView('play');
        });
      }
      
      // Set default view
      if (isAdmin) {
        showView('game');
      } else {
        showView('username');
      }

    function showView(viewName) {
      // Hide all views
      if (dashboardContent) dashboardContent.style.display = "none";
      if (gameView) gameView.style.display = "none";
      if (usernameView) usernameView.style.display = "none";
      if (paymentsView) paymentsView.style.display = "none";
      if (topUpView) topUpView.style.display = "none";
      if (playView) playView.style.display = "none";
      if (adminPanelSection) adminPanelSection.style.display = "none";
      
      // Show selected view
      if (viewName === 'dashboard' && dashboardContent) {
        dashboardContent.style.display = "block";
      } else if (viewName === 'game' && gameView) {
        gameView.style.display = "block";
        loadGames();
      } else if (viewName === 'username' && usernameView) {
        usernameView.style.display = "block";
        loadGameUsernames();
      } else if (viewName === 'payments' && paymentsView) {
        paymentsView.style.display = "block";
        loadPaymentQrs();
      } else if (viewName === 'topup' && topUpView) {
        topUpView.style.display = "block";
        // Use currentUser (already loaded) to render balance
        const totalCoinsBalance = document.getElementById("totalCoinsBalance");
        
        if (totalCoinsBalance && currentUser.balanceCoins != null) {
          const currentBalance = Number(currentUser.balanceCoins) || 0;
          totalCoinsBalance.textContent = currentBalance.toLocaleString();
        }
        // Don't auto-generate, wait for user click
      } else if (viewName === 'play' && playView) {
        playView.style.display = "block";
        loadPlayGames();
      } else if (viewName === 'admin' && adminPanelSection) {
        adminPanelSection.style.display = "block";
        // Clear search input - this will trigger showing all users via the input event listener
        if (adminUserSearchInput) {
          adminUserSearchInput.value = "";
          // Trigger input event to load all users (since search bar is now empty)
          adminUserSearchInput.dispatchEvent(new Event('input'));
        } else {
          // If search input doesn't exist yet, load directly
          if (currentUser) {
            loadAdminUsers("");
          } else {
            setTimeout(() => {
              if (currentUser) {
                loadAdminUsers("");
              }
            }, 50);
          }
        }
      }
      
      currentView = viewName;
      
      // Update sidebar button states
      if (sidebarBtnGame) sidebarBtnGame.classList.toggle("active", viewName === 'game');
      if (sidebarBtnUsername) sidebarBtnUsername.classList.toggle("active", viewName === 'username');
      if (sidebarBtnPayments) sidebarBtnPayments.classList.toggle("active", viewName === 'payments');
      if (sidebarBtnTopUp) sidebarBtnTopUp.classList.toggle("active", viewName === 'topup');
      if (sidebarBtnPlay) sidebarBtnPlay.classList.toggle("active", viewName === 'play');
      
      // Update top nav buttons
      if (btnNavDashboard) btnNavDashboard.classList.toggle("active", viewName === 'dashboard');
      if (btnNavAdmin) btnNavAdmin.classList.toggle("active", viewName === 'admin');
    }

    // Dashboard nav button
    btnNavDashboard?.addEventListener("click", () => {
      showView('dashboard');
    });

    // Admin nav button toggle
    btnNavAdmin?.addEventListener("click", async () => {
      const isAdmin = currentUser.id === 1 || currentUser.role === "admin";
      const isAdminOrCoAdmin = isAdmin || currentUser.role === "coadmin";
      
      if (!isAdminOrCoAdmin) return;
      
      if (currentView === 'admin') {
        // Toggle back to default view
        showView(isAdmin ? 'game' : 'username');
      } else {
        showView('admin');
      }
    });

    // Toast Message System
    const gameToast = document.getElementById("gameToast");
    let toastTimeout = null;
    
    function showToast(message, isError = false) {
      if (!gameToast) return;
      
      gameToast.textContent = message;
      gameToast.className = `toast ${isError ? 'error' : 'success'}`;
      gameToast.style.display = 'flex';
      
      // Clear existing timeout
      if (toastTimeout) {
        clearTimeout(toastTimeout);
      }
      
      // Auto-hide after 3 seconds
      toastTimeout = setTimeout(() => {
        gameToast.classList.add('fade-out');
        setTimeout(() => {
          gameToast.style.display = 'none';
          gameToast.classList.remove('fade-out');
        }, 300);
      }, 3000);
    }

    // Modal System
    const deleteModal = document.getElementById("deleteModal");
    const deleteModalText = document.getElementById("deleteModalText");
    const btnCancelDelete = document.getElementById("btnCancelDelete");
    const btnConfirmDelete = document.getElementById("btnConfirmDelete");
    let pendingDeleteGameId = null;
    let pendingDeleteGameName = null;

    function showDeleteModal(gameId, gameName) {
      pendingDeleteGameId = gameId;
      pendingDeleteGameName = gameName;
      if (deleteModalText) {
        deleteModalText.textContent = `Delete "${gameName}"? This will also remove all associated usernames.`;
      }
      if (deleteModal) {
        deleteModal.style.display = 'flex';
      }
    }

    function hideDeleteModal() {
      pendingDeleteGameId = null;
      pendingDeleteGameName = null;
      if (deleteModal) {
        deleteModal.style.display = 'none';
      }
    }

    btnCancelDelete?.addEventListener('click', hideDeleteModal);
    deleteModal?.querySelector('.modal-overlay')?.addEventListener('click', hideDeleteModal);

    // Copy to clipboard helper
    async function copyToClipboard(text, label) {
      try {
        await navigator.clipboard.writeText(text);
        showToast(`${label} copied to clipboard!`, false);
      } catch (e) {
        showToast(`Failed to copy ${label.toLowerCase()}.`, true);
      }
    }

    // Escape HTML helper
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Game Management Functions
    async function loadGames() {
      if (!gamesList) return;
      
      try {
        const response = await api("/games");
        const games = response.games || [];
        
        if (games.length === 0) {
          gamesList.innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">🎮</div>
              <h3 class="empty-state-title">No games yet</h3>
              <p class="empty-state-text">Add your first game to get started. Games will automatically get short codes and slugs.</p>
            </div>
          `;
          return;
        }

        let html = '';
        games.forEach(game => {
          html += `
            <div class="game-card">
              <div class="game-card-info">
                <h3 class="game-card-name">${escapeHtml(game.name)}</h3>
                <div class="game-card-meta">
                  <span class="badge badge-short-code">${escapeHtml(game.short_code)}</span>
                  <span class="badge badge-slug">${escapeHtml(game.slug)}</span>
                </div>
              </div>
              <div class="game-card-actions">
                <button class="btn-icon" data-copy-short-code="${escapeHtml(game.short_code)}" title="Copy Short Code">
                  📋
                </button>
                <button class="btn-icon" data-copy-slug="${escapeHtml(game.slug)}" title="Copy Slug">
                  🔗
                </button>
                <button class="btn-danger" data-game-id="${game.id}" data-game-name="${escapeHtml(game.name)}" title="Delete Game">
                  Delete
                </button>
              </div>
            </div>
          `;
        });

        gamesList.innerHTML = html;

        // Attach copy handlers
        gamesList.querySelectorAll('[data-copy-short-code]').forEach(btn => {
          btn.addEventListener('click', () => {
            const shortCode = btn.dataset.copyShortCode;
            copyToClipboard(shortCode, 'Short code');
          });
        });

        gamesList.querySelectorAll('[data-copy-slug]').forEach(btn => {
          btn.addEventListener('click', () => {
            const slug = btn.dataset.copySlug;
            copyToClipboard(slug, 'Slug');
          });
        });

        // Attach delete handlers
        gamesList.querySelectorAll('.btn-danger[data-game-id]').forEach(btn => {
          btn.addEventListener('click', () => {
            const gameId = Number(btn.dataset.gameId);
            const gameName = btn.dataset.gameName;
            if (gameId && gameName) {
              showDeleteModal(gameId, gameName);
            }
          });
        });
      } catch (e) {
        gamesList.innerHTML = `<div class="msg" data-kind="error" style="margin-top:8px;">Error loading games: ${e.message}</div>`;
      }
    }

    // Handle confirm delete
    btnConfirmDelete?.addEventListener('click', async () => {
      if (!pendingDeleteGameId) return;
      
      const gameId = pendingDeleteGameId;
      hideDeleteModal();
      
      setBusy(btnConfirmDelete, true, "Deleting...");
      try {
        await api(`/games/${gameId}`, { method: 'DELETE' });
        showToast("Game deleted successfully.", false);
        await loadGames();
        await loadGameUsernames(); // Refresh usernames
      } catch (e) {
        showToast(e.message || "Failed to delete game.", true);
      } finally {
        setBusy(btnConfirmDelete, false);
      }
    });

    const handleAddGame = async () => {
      const name = gameNameInput?.value.trim();
      if (!name) {
        showToast("Please enter a game name.", true);
        return;
      }
      
      setBusy(btnAddGame, true, "Adding...");
      try {
        await api("/games", {
          method: 'POST',
          body: JSON.stringify({ name })
        });
        showToast("Game added successfully!", false);
        if (gameNameInput) gameNameInput.value = "";
        await loadGames();
        await loadGameUsernames(); // Refresh usernames list
      } catch (e) {
        showToast(e.message || "Failed to add game.", true);
      } finally {
        setBusy(btnAddGame, false);
      }
    };

    btnAddGame?.addEventListener("click", handleAddGame);
    gameNameInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleAddGame();
    });

    // Username Toast System
    let usernameToastTimeout = null;
    
    function showUsernameToast(message, isError = false) {
      if (!usernameToast) return;
      
      usernameToast.textContent = message;
      usernameToast.className = `toast ${isError ? 'error' : 'success'}`;
      usernameToast.style.display = 'flex';
      
      if (usernameToastTimeout) {
        clearTimeout(usernameToastTimeout);
      }
      
      usernameToastTimeout = setTimeout(() => {
        usernameToast.classList.add('fade-out');
        setTimeout(() => {
          usernameToast.style.display = 'none';
          usernameToast.classList.remove('fade-out');
        }, 300);
      }, 3000);
    }

    // Username Management Functions (Read-only display)
    async function loadGameUsernames() {
      if (!usernamesList) return;

      try {
        const response = await api("/game-usernames");

        // expected shape: { games: [ { game_name, short_code, slug, usernames:[{username}...] } ] }
        const games = response.games || [];

        // Build flat rows: Game | Username | Copy
        const rows = [];
        for (const g of games) {
          const gameName = g.game_name || g.name || "Unknown Game";
          const list = Array.isArray(g.usernames) ? g.usernames : [];

          if (list.length === 0) {
            rows.push({
              gameName,
              username: "",
              empty: true,
            });
          } else {
            for (const u of list) {
              rows.push({
                gameName,
                username: u.username || "",
                empty: false,
              });
            }
          }
        }

        if (rows.length === 0) {
          usernamesList.innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">👤</div>
              <h3 class="empty-state-title">No usernames yet</h3>
              <p class="empty-state-text">Your game usernames will appear here.</p>
            </div>
          `;
          return;
        }

        usernamesList.innerHTML = `
          <div class="uname-table">
            <div class="uname-head">
              <div>Game</div>
              <div>Username</div>
              <div class="uname-head-actions">Copy</div>
            </div>

            ${rows
              .map((r) => {
                if (r.empty) {
                  return `
                    <div class="uname-rowline uname-rowline-empty">
                      <div class="uname-game">${escapeHtml(r.gameName)}</div>
                      <div class="uname-user muted">—</div>
                      <div class="uname-actions"></div>
                    </div>
                  `;
                }

                return `
                  <div class="uname-rowline">
                    <div class="uname-game">${escapeHtml(r.gameName)}</div>
                    <div class="uname-user">
                      <span class="uname-code">${escapeHtml(r.username)}</span>
                    </div>
                    <div class="uname-actions">
                      <button class="btn-icon uname-copy" data-copy="${encodeURIComponent(
                        r.username
                      )}" title="Copy username">📋</button>
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>
        `;

        // Attach copy handlers (same as before)
        usernamesList.querySelectorAll(".uname-copy").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const text = decodeURIComponent(btn.getAttribute("data-copy") || "");
            try {
              await navigator.clipboard.writeText(text);
              showUsernameToast("Copied!", false);
              btn.textContent = "✅";
              setTimeout(() => (btn.textContent = "📋"), 900);
    } catch {
              showUsernameToast("Copy failed.", true);
            }
          });
        });
      } catch (e) {
        usernamesList.innerHTML = `<div class="msg" data-kind="error" style="margin-top:8px;">Error loading usernames: ${e.message}</div>`;
      }
    }

    // Handle add username

    // ==================== Play View (All Users) ====================
    const playGamesList = document.getElementById("playGamesList");
    const playToast = document.getElementById("playToast");
    let playToastTimeout = null;

    function showPlayToast(message, isError = false) {
      if (!playToast) return;
      playToast.textContent = message;
      playToast.className = `toast ${isError ? 'error' : 'success'}`;
      playToast.style.display = 'flex';
      if (playToastTimeout) clearTimeout(playToastTimeout);
      playToastTimeout = setTimeout(() => {
        playToast.classList.add('fade-out');
        setTimeout(() => {
          playToast.style.display = 'none';
          playToast.classList.remove('fade-out');
        }, 300);
      }, 3000);
    }

    // Load games for Play view
    async function loadPlayGames() {
      if (!playGamesList) return;

      try {
        // Get games and user's game usernames
        const [gamesResponse, usernamesResponse] = await Promise.all([
          api("/games"),
          api("/game-usernames")
        ]);

        const games = gamesResponse.games || [];
        const gamesWithUsernames = usernamesResponse.games || [];

        // Create a map of game_id -> username
        const gameUsernameMap = {};
        gamesWithUsernames.forEach(game => {
          if (game.usernames && game.usernames.length > 0) {
            // Find the game by name or short_code
            const matchingGame = games.find(g => 
              g.name === game.game_name || g.short_code === game.short_code
            );
            if (matchingGame) {
              gameUsernameMap[matchingGame.id] = game.usernames[0].username;
            }
          }
        });

        if (games.length === 0) {
          playGamesList.innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">🎮</div>
              <h3 class="empty-state-title">No games available</h3>
              <p class="empty-state-text">Games will appear here once they are added.</p>
            </div>
          `;
          return;
        }

        let html = '';
        games.forEach(game => {
          const hasUsername = gameUsernameMap[game.id];
          html += `
            <div class="game-card">
              <div class="game-card-info">
                <h3 class="game-card-name">${escapeHtml(game.name)}</h3>
                <div class="game-card-meta">
                  <span class="badge badge-short-code">${escapeHtml(game.short_code)}</span>
                  ${hasUsername ? `<span class="badge badge-slug" style="background:rgba(0,255,204,0.2); color:rgba(0,255,204,0.9);">${escapeHtml(hasUsername)}</span>` : '<span class="badge badge-slug" style="color:var(--muted);">No username</span>'}
                </div>
              </div>
              <div class="game-card-actions">
                <button class="btn-primary" data-game-id="${game.id}" data-game-name="${escapeHtml(game.name)}" data-game-username="${hasUsername ? escapeHtml(hasUsername) : ''}" ${!hasUsername ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} title="${hasUsername ? 'Recharge this game' : 'No username for this game'}" style="margin-right:8px;">
                  ${hasUsername ? 'Recharge' : 'No Username'}
                </button>
                <button class="btn-secondary" data-redeem-game-id="${game.id}" data-redeem-game-name="${escapeHtml(game.name)}" data-redeem-game-username="${hasUsername ? escapeHtml(hasUsername) : ''}" ${!hasUsername ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} title="${hasUsername ? 'Redeem from this game' : 'No username for this game'}">
                  ${hasUsername ? 'Redeem' : 'No Username'}
                </button>
              </div>
            </div>
          `;
        });

        playGamesList.innerHTML = html;

        // Attach recharge handlers
        playGamesList.querySelectorAll('.btn-primary[data-game-id]').forEach(btn => {
          btn.addEventListener('click', () => {
            const gameId = Number(btn.dataset.gameId);
            const gameName = btn.dataset.gameName;
            const gameUsername = btn.dataset.gameUsername;

            if (!gameUsername) {
              showPlayToast("No username found for this game. Please add a username first.", true);
              return;
            }

            // Show recharge modal
            showGameRechargeModal(gameId, gameName, gameUsername);
          });
        });

        // Attach redeem handlers
        playGamesList.querySelectorAll('.btn-secondary[data-redeem-game-id]').forEach(btn => {
          btn.addEventListener('click', () => {
            const gameId = Number(btn.dataset.redeemGameId);
            const gameName = btn.dataset.redeemGameName;
            const gameUsername = btn.dataset.redeemGameUsername;

            if (!gameUsername) {
              showPlayToast("No username found for this game. Please add a username first.", true);
              return;
            }

            
            // Show redeem modal
            showGameRedeemModal(gameId, gameName, gameUsername);
});
        });
      } catch (e) {
        playGamesList.innerHTML = `<div class="msg" data-kind="error" style="margin-top:8px;">Error loading games: ${e.message}</div>`;
      }
    }

    // Show game recharge modal
    function showGameRechargeModal(gameId, gameName, gameUsername) {
      const modal = document.getElementById("gameRechargeModal");
      const gameNameEl = document.getElementById("gameRechargeGameName");
      const usernameEl = document.getElementById("gameRechargeUsername");
      const amountInput = document.getElementById("gameRechargeAmountInput");
      const balanceInfo = document.getElementById("gameRechargeBalanceInfo");
      const btnConfirm = document.getElementById("btnConfirmGameRecharge");
      const btnCancel = document.getElementById("btnCancelGameRecharge");

      if (!modal || !gameNameEl || !usernameEl || !amountInput || !btnConfirm) return;

      // Set game info
      gameNameEl.textContent = gameName;
      usernameEl.textContent = gameUsername;
      amountInput.value = "";
      
      // Show current balance
      const currentBalance = Number(currentUser.balanceCoins || 0);
      balanceInfo.textContent = `Your current balance: ${currentBalance.toLocaleString()} coins`;

      // Store game info in button
      btnConfirm.dataset.gameId = gameId;
      btnConfirm.dataset.gameName = gameName;
      btnConfirm.dataset.gameUsername = gameUsername;

      // Show modal
      modal.style.display = "flex";
      amountInput.focus();

      // Close modal handler
      const closeModal = () => {
        modal.style.display = "none";
        amountInput.value = "";
      };

      // Cancel button
      if (btnCancel) {
        btnCancel.onclick = closeModal;
      }

      // Confirm button
      btnConfirm.onclick = async () => {
        const amount = Number(amountInput.value);

        if (!amount || amount <= 0) {
          showPlayToast("Please enter a valid amount greater than 0.", true);
          return;
        }

        if (amount > currentBalance) {
          showPlayToast(`Insufficient balance. You have ${currentBalance} coins, cannot recharge ${amount} coins.`, true);
          return;
        }

        setBusy(btnConfirm, true, "Recharging...");
        try {
          const response = await api("/api/game-recharges", {
            method: 'POST',
            body: JSON.stringify({
              game_id: gameId,
              game_username: gameUsername,
              amount: amount
            })
          });

          closeModal();
          showPlayToast(`Successfully recharged ${amount} coins to ${gameName}!`, false);

          // Refresh user balance
          const meResponse = await loadMe();
          if (meResponse && meResponse.user) {
            currentUser = meResponse.user;
            const newBalance = Number(currentUser.balanceCoins || 0);
            if (window.renderCoins) {
              window.renderCoins(newBalance);
            }
          }

          // Reload games list
          await loadPlayGames();
        } catch (e) {
          showPlayToast(e.message || "Failed to recharge game.", true);
        } finally {
          setBusy(btnConfirm, false);
        }
      };

      // Close on overlay click
      modal.querySelector('.modal-overlay').onclick = closeModal;

      // Enter key to confirm
      amountInput.onkeypress = (e) => {
        if (e.key === 'Enter') {
          btnConfirm.click();
        }
      };
    }

    // Load admin users list
    async function loadAdminUsers(searchTerm = "") {
      if (!adminUsersList) {
        console.error("[loadAdminUsers] adminUsersList element not found");
      return;
    }

      // Show loading state
      adminUsersList.innerHTML = '<div class="small" style="margin-top:8px;">Loading users...</div>';
      
      try {
        const response = await api("/admin/users");
        let users = response.users || [];
        
        console.log(`[loadAdminUsers] API returned ${users.length} users, searchTerm="${searchTerm}"`);
        
        // Filter users based on role:
        // - Admin (id=1 or role='admin') can see ALL users including other Admins
        // - CoAdmin can see CoAdmin and regular users, but NOT Admin users
        if (!currentUser) {
          console.error("[loadAdminUsers] currentUser not available - retrying...");
          adminUsersList.innerHTML = '<div class="small" style="margin-top:8px;">Error: User data not available. Please refresh.</div>';
          return;
        }

        const isAdmin = currentUser.id === 1 || currentUser.role === "admin";
        const isCoAdmin = currentUser.role === "coadmin";
        
        console.log(`[loadAdminUsers] Current user: id=${currentUser.id}, role=${currentUser.role}, isAdmin=${isAdmin}, isCoAdmin=${isCoAdmin}`);
        
        // Only filter for CoAdmin - Admin sees everything
        // IMPORTANT: Admin (id=1 or role='admin') should see ALL users including other Admins
        if (isCoAdmin && !isAdmin) {
          // CoAdmin should not see Admin users - filter them out
          const beforeFilter = users.length;
          users = users.filter(user => user.role !== "admin" && user.id !== 1);
          console.log(`[loadAdminUsers] CoAdmin view: Filtered ${beforeFilter} users to ${users.length} (removed Admin users)`);
        } else if (isAdmin) {
          // Admin sees all users - no filtering
          console.log(`[loadAdminUsers] Admin view: Showing all ${users.length} users (no filtering)`);
        }
        
        // Filter by search term if provided
        if (searchTerm && searchTerm.trim() !== "") {
          const searchLower = searchTerm.toLowerCase().trim();
          const beforeSearch = users.length;
          users = users.filter(user => 
            user.username.toLowerCase().includes(searchLower)
          );
          console.log(`[loadAdminUsers] Search "${searchTerm}": Filtered ${beforeSearch} users to ${users.length}`);
        }
        
        console.log(`[loadAdminUsers] Final users count: ${users.length}`);
        
        if (users.length === 0) {
          if (searchTerm && searchTerm.trim() !== "") {
            adminUsersList.innerHTML = '<div class="small" style="margin-top:8px;">No users found matching your search.</div>';
          } else {
            adminUsersList.innerHTML = '<div class="small" style="margin-top:8px;">No users found.</div>';
          }
          return;
        }

        let html = '<div style="overflow-x:auto; margin-top:8px;"><table style="width:100%; border-collapse:collapse; font-size:12px;">';
        html += '<thead><tr style="border-bottom:1px solid rgba(255,255,255,0.1);">';
        html += '<th style="text-align:left; padding:8px; color:var(--muted);">Username</th>';
        html += '<th style="text-align:left; padding:8px; color:var(--muted);">Role</th>';
        html += '<th style="text-align:left; padding:8px; color:var(--muted);">Balance</th>';
        html += '<th style="text-align:left; padding:8px; color:var(--muted);">Status</th>';
        html += '<th style="text-align:left; padding:8px; color:var(--muted);">Actions</th>';
        html += '</tr></thead><tbody>';

        console.log(`[loadAdminUsers] Rendering ${users.length} users in table`);
        users.forEach((user, index) => {
          console.log(`[loadAdminUsers] Rendering user ${index + 1}/${users.length}: ${user.username} (id=${user.id}, role=${user.role})`);
          const isCurrentUser = user.id === currentUser.id;
          const status = user.is_banned ? '<span style="color:var(--danger);">BANNED</span>' : '<span style="color:rgba(0,255,204,0.8);">Active</span>';
          const roleDisplay = user.role === "admin" ? '<span style="color:rgba(255,208,0,0.9);">ADMIN</span>' : 
                             user.role === "coadmin" ? '<span style="color:rgba(0,255,204,0.9);">COADMIN</span>' : 
                             '<span style="color:var(--muted);">USER</span>';
          const balance = Number(user.balance_coins || 0);
          const balanceDisplay = `<span style="color:rgba(255,208,0,0.9); font-weight:600;">${balance}</span> <span style="color:var(--muted); font-size:11px;">coins</span>`;
          
          html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">`;
          html += `<td style="padding:8px;">${user.username}</td>`;
          html += `<td style="padding:8px;">${roleDisplay}</td>`;
          html += `<td style="padding:8px;">${balanceDisplay}</td>`;
          html += `<td style="padding:8px;">${status}</td>`;
          html += `<td style="padding:8px;">`;
          
          // Check if current user is Admin (not CoAdmin)
          const isAdmin = currentUser.id === 1 || currentUser.role === "admin";
          const isAdminOrCoAdmin = isAdmin || currentUser.role === "coadmin";
          
          // Redeem button (Admin only, show for all users including current user)
          if (isAdmin) {
            html += `<button class="admin-action" data-action="redeem" data-user-id="${user.id}" data-user-name="${escapeHtml(user.username)}" data-balance="${balance}" style="padding:4px 8px; margin-right:4px; font-size:11px; background:rgba(255,208,0,0.15); border:1px solid rgba(255,208,0,0.3); color:rgba(255,208,0,0.9); border-radius:6px; cursor:pointer;">Redeem</button>`;
          }
          
          // Recharge button (Admin and CoAdmin, show for all users including current user)
          if (isAdminOrCoAdmin) {
            html += `<button class="admin-action" data-action="recharge" data-user-id="${user.id}" data-user-name="${escapeHtml(user.username)}" data-balance="${balance}" style="padding:4px 8px; margin-right:4px; font-size:11px; background:rgba(0,255,204,0.15); border:1px solid rgba(0,255,204,0.3); color:rgba(0,255,204,0.9); border-radius:6px; cursor:pointer;">Recharge</button>`;
          }
          
          if (!isCurrentUser) {
            // Promote/Demote buttons (Admin only, not for current user)
            if (isAdmin) {
              if (user.role === "coadmin") {
                html += `<button class="admin-action" data-action="demote" data-user-id="${user.id}" style="padding:4px 8px; margin-right:4px; font-size:11px; background:rgba(255,208,0,0.15); border:1px solid rgba(255,208,0,0.3); color:rgba(255,208,0,0.9); border-radius:6px; cursor:pointer;">Demote</button>`;
              } else if (user.role === "user") {
                html += `<button class="admin-action" data-action="promote" data-user-id="${user.id}" style="padding:4px 8px; margin-right:4px; font-size:11px; background:rgba(0,255,204,0.15); border:1px solid rgba(0,255,204,0.3); color:rgba(0,255,204,0.9); border-radius:6px; cursor:pointer;">Promote</button>`;
              }
            }
            
            // Ban/Unban buttons (Admin only, not for current user)
            if (isAdmin) {
              if (user.is_banned) {
                html += `<button class="admin-action" data-action="unban" data-user-id="${user.id}" style="padding:4px 8px; margin-right:4px; font-size:11px; background:rgba(0,255,204,0.15); border:1px solid rgba(0,255,204,0.3); color:rgba(0,255,204,0.9); border-radius:6px; cursor:pointer;">Unban</button>`;
              } else {
                html += `<button class="admin-action" data-action="ban" data-user-id="${user.id}" style="padding:4px 8px; margin-right:4px; font-size:11px; background:rgba(255,53,94,0.15); border:1px solid rgba(255,53,94,0.3); color:rgba(255,53,94,0.9); border-radius:6px; cursor:pointer;">Ban</button>`;
              }
            }
            
            // Delete button (Admin only, not for current user)
            if (isAdmin) {
              html += `<button class="admin-action" data-action="delete" data-user-id="${user.id}" data-user-name="${escapeHtml(user.username)}" style="padding:4px 8px; font-size:11px; background:rgba(255,53,94,0.15); border:1px solid rgba(255,53,94,0.3); color:rgba(255,53,94,0.9); border-radius:6px; cursor:pointer;">Delete</button>`;
            }
          } else {
            // Show (You) label for current user
            html += `<span style="color:var(--muted); font-size:11px; margin-left:4px;">(You)</span>`;
          }
          
          html += `</td></tr>`;
        });

        html += '</tbody></table></div>';
        console.log(`[loadAdminUsers] Setting HTML (length: ${html.length} chars, ${users.length} users)`);
        adminUsersList.innerHTML = html;
        console.log(`[loadAdminUsers] HTML set successfully. Table rows: ${adminUsersList.querySelectorAll('tbody tr').length}`);

        // Attach event listeners to action buttons
        adminUsersList.querySelectorAll('.admin-action').forEach(btn => {
          btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            const userId = Number(btn.dataset.userId);
            
            if (!userId) return;
            
            // Handle redeem action (show modal)
            if (action === 'redeem') {
              const userName = btn.dataset.userName || 'User';
              const currentBalance = Number(btn.dataset.balance || 0);
              
              // Show redeem modal
              const redeemModal = document.getElementById("redeemModal");
              const redeemAmountInput = document.getElementById("redeemAmountInput");
              const redeemBalanceInfo = document.getElementById("redeemBalanceInfo");
              const btnConfirmRedeem = document.getElementById("btnConfirmRedeem");
              const btnCancelRedeem = document.getElementById("btnCancelRedeem");
              
              if (redeemModal && redeemAmountInput && redeemBalanceInfo) {
                redeemModal.style.display = "block";
                redeemAmountInput.value = "";
                redeemBalanceInfo.textContent = `Current balance: ${currentBalance} coins`;
                redeemAmountInput.focus();
                
                // Store userId for confirm button
                btnConfirmRedeem.dataset.userId = userId;
                btnConfirmRedeem.dataset.currentBalance = currentBalance;
                
                // Close modal handlers
                const closeModal = () => {
                  redeemModal.style.display = "none";
                  redeemAmountInput.value = "";
                };
                
                btnCancelRedeem.onclick = closeModal;
                btnConfirmRedeem.onclick = async () => {
                  const amount = Number(redeemAmountInput.value);
                  
                  if (!amount || amount <= 0) {
                    setMsg("msg", "Please enter a valid amount greater than 0.", true);
                    return;
                  }
                  
                  if (amount > currentBalance) {
                    setMsg("msg", `Cannot redeem more than current balance (${currentBalance} coins).`, true);
                    return;
                  }
                  
                  setBusy(btnConfirmRedeem, true, "Redeeming...");
                  try {
                    const response = await api("/admin/redeem", {
                      method: 'POST',
                      body: JSON.stringify({ user_id: userId, amount: amount })
                    });
                    
                    closeModal();
                    setMsg("msg", response.message || `Redeemed ${amount} coins successfully.`, false);
                    // Refresh list - preserve current search if any
                    const currentSearch = adminUserSearchInput ? adminUserSearchInput.value.trim() : "";
                    await loadAdminUsers(currentSearch);
                  } catch (e) {
                    setMsg("msg", e.message || "Redeem failed.", true);
                  } finally {
                    setBusy(btnConfirmRedeem, false);
                  }
                };
                
                // Close on overlay click
                redeemModal.querySelector('.modal-overlay').onclick = closeModal;
                
                // Enter key to confirm
                redeemAmountInput.onkeypress = (e) => {
                  if (e.key === 'Enter') {
                    btnConfirmRedeem.click();
                  }
                };
              }
              return;
            }
            
            // Handle recharge action (show modal)
            if (action === 'recharge') {
              const userName = btn.dataset.userName || 'User';
              const targetBalance = Number(btn.dataset.balance || 0);
              
              // Show recharge modal
              const rechargeModal = document.getElementById("rechargeModal");
              const rechargeAmountInput = document.getElementById("rechargeAmountInput");
              const rechargeBalanceInfo = document.getElementById("rechargeBalanceInfo");
              const rechargeAdminNote = document.getElementById("rechargeAdminNote");
              const btnConfirmRecharge = document.getElementById("btnConfirmRecharge");
              const btnCancelRecharge = document.getElementById("btnCancelRecharge");
              
              if (rechargeModal && rechargeAmountInput && rechargeBalanceInfo && btnConfirmRecharge) {
                rechargeModal.style.display = "block";
                rechargeAmountInput.value = "";
                rechargeBalanceInfo.textContent = `Target user current balance: ${targetBalance} coins`;
                
                // Show admin/coadmin note
                const isAdmin = currentUser.id === 1 || currentUser.role === "admin";
                if (isAdmin) {
                  rechargeAdminNote.textContent = "ℹ️ As Admin, you can recharge without balance deduction.";
                  rechargeAdminNote.style.display = "block";
                } else if (currentUser.role === "coadmin") {
                  const adminBalance = Number(currentUser.balanceCoins || 0);
                  rechargeAdminNote.textContent = `ℹ️ As CoAdmin, coins will be deducted from your account. Your current balance: ${adminBalance} coins.`;
                  rechargeAdminNote.style.display = "block";
                } else {
                  rechargeAdminNote.style.display = "none";
                }
                
                rechargeAmountInput.focus();
                
                // Store userId for confirm button
                btnConfirmRecharge.dataset.userId = userId;
                
                // Close modal handlers
                const closeModal = () => {
                  rechargeModal.style.display = "none";
                  rechargeAmountInput.value = "";
                };
                
                btnCancelRecharge.onclick = closeModal;
                btnConfirmRecharge.onclick = async () => {
                  const amount = Number(rechargeAmountInput.value);
                  
                  if (!amount || amount <= 0) {
                    setMsg("msg", "Please enter a valid amount greater than 0.", true);
                    return;
                  }
                  
                  // Check coadmin balance
                  if (!isAdmin && currentUser.role === "coadmin") {
                    const adminBalance = Number(currentUser.balanceCoins || 0);
                    if (amount > adminBalance) {
                      setMsg("msg", `Insufficient balance. You have ${adminBalance} coins, cannot recharge ${amount} coins. Please recharge your own account first using the TopUp panel.`, true);
                      // Show a helpful button/link to TopUp panel
                      setTimeout(() => {
                        const msgEl = document.getElementById("msg");
                        if (msgEl) {
                          const topupLink = document.createElement("button");
                          topupLink.textContent = "Go to TopUp Panel";
                          topupLink.style.cssText = "margin-left:12px; padding:6px 12px; background:rgba(0,255,204,0.2); border:1px solid rgba(0,255,204,0.4); color:rgba(0,255,204,0.9); border-radius:6px; cursor:pointer; font-size:12px;";
                          topupLink.onclick = () => {
                            showView('topup');
                            closeModal();
                          };
                          msgEl.appendChild(topupLink);
                        }
                      }, 100);
                      return;
                    }
                  }
                  
                  setBusy(btnConfirmRecharge, true, "Recharging...");
                  try {
                    const response = await api("/admin/recharge", {
                      method: 'POST',
                      body: JSON.stringify({ user_id: userId, amount: amount })
                    });
                    
                    closeModal();
                    setMsg("msg", response.message || `Recharged ${amount} coins successfully.`, false);
                    
                    // Refresh admin users list and current user balance
                    await loadAdminUsers();
                    await loadMe(); // Refresh current user balance if coadmin
                  } catch (e) {
                    const errorMsg = e.message || "Recharge failed.";
                    setMsg("msg", errorMsg, true);
                    
                    // If it's an insufficient balance error for CoAdmin, show TopUp link
                    if (e.insufficientBalance && currentUser.role === "coadmin") {
                      setTimeout(() => {
                        const msgEl = document.getElementById("msg");
                        if (msgEl && !msgEl.querySelector('.topup-link-btn')) {
                          const topupLink = document.createElement("button");
                          topupLink.className = "topup-link-btn";
                          topupLink.textContent = "Go to TopUp Panel";
                          topupLink.style.cssText = "margin-left:12px; padding:6px 12px; background:rgba(0,255,204,0.2); border:1px solid rgba(0,255,204,0.4); color:rgba(0,255,204,0.9); border-radius:6px; cursor:pointer; font-size:12px;";
                          topupLink.onclick = () => {
                            showView('topup');
                            closeModal();
                          };
                          msgEl.appendChild(topupLink);
                        }
                      }, 100);
                    }
                  } finally {
                    setBusy(btnConfirmRecharge, false);
                  }
                };
                
                // Close on overlay click
                rechargeModal.querySelector('.modal-overlay').onclick = closeModal;
                
                // Enter key to confirm
                rechargeAmountInput.onkeypress = (e) => {
                  if (e.key === 'Enter') {
                    btnConfirmRecharge.click();
                  }
                };
              }
              return;
            }
            
            // Handle delete action (show modal)
            if (action === 'delete') {
              const userName = btn.dataset.userName || 'User';
              
              // Show delete user modal
              const deleteUserModal = document.getElementById("deleteUserModal");
              const deleteUserModalText = document.getElementById("deleteUserModalText");
              const btnConfirmDeleteUser = document.getElementById("btnConfirmDeleteUser");
              const btnCancelDeleteUser = document.getElementById("btnCancelDeleteUser");
              
              if (deleteUserModal && deleteUserModalText && btnConfirmDeleteUser) {
                deleteUserModal.style.display = "block";
                deleteUserModalText.textContent = `Are you sure you want to delete user "${userName}"? This action cannot be undone.`;
                
                // Store userId for confirm button
                btnConfirmDeleteUser.dataset.userId = userId;
                
                // Close modal handlers
                const closeModal = () => {
                  deleteUserModal.style.display = "none";
                };
                
                btnCancelDeleteUser.onclick = closeModal;
                btnConfirmDeleteUser.onclick = async () => {
                  setBusy(btnConfirmDeleteUser, true, "Deleting...");
                  try {
                    await api("/admin/delete-user", {
                      method: 'POST',
                      body: JSON.stringify({ user_id: userId })
                    });
                    
                    closeModal();
                    setMsg("msg", `User "${userName}" deleted successfully.`, false);
                    // Refresh list - preserve current search if any
                    const currentSearch = adminUserSearchInput ? adminUserSearchInput.value.trim() : "";
                    await loadAdminUsers(currentSearch);
                  } catch (e) {
                    setMsg("msg", e.message || "Delete failed.", true);
                  } finally {
                    setBusy(btnConfirmDeleteUser, false);
                  }
                };
                
                // Close on overlay click
                deleteUserModal.querySelector('.modal-overlay').onclick = closeModal;
              }
              return;
            }
            
            // Handle other actions (promote, demote, ban, unban)
            setBusy(btn, true, "Processing...");
            try {
              let endpoint = '';
              if (action === 'promote') endpoint = '/admin/promote';
              else if (action === 'demote') endpoint = '/admin/demote';
              else if (action === 'ban') endpoint = '/admin/ban';
              else if (action === 'unban') endpoint = '/admin/unban';
              
              await api(endpoint, {
                method: 'POST',
                body: JSON.stringify({ user_id: userId })
              });
              
              setMsg("msg", `Action completed successfully.`, false);
              await loadAdminUsers(); // Refresh list
            } catch (e) {
              setMsg("msg", e.message || "Action failed.", true);
            } finally {
              setBusy(btn, false);
            }
          });
        });
      } catch (e) {
        adminUsersList.innerHTML = `<div class="msg" data-kind="error" style="margin-top:8px;">Error loading users: ${e.message}</div>`;
      }
    }
    
    // Add search functionality for admin users
    if (adminUserSearchInput) {
      let searchTimeout = null;
      
      adminUserSearchInput.addEventListener("input", (e) => {
        const searchTerm = e.target.value.trim();
        
        // Clear any pending timeout
        if (searchTimeout) clearTimeout(searchTimeout);
        
        // Simple rule: if search bar is empty, show all users
        if (searchTerm === "") {
          loadAdminUsers("");
          return;
        }
        
        // User is typing - debounce search (wait 300ms after user stops typing)
        searchTimeout = setTimeout(() => {
          loadAdminUsers(searchTerm);
        }, 300);
      });
      
      // Also search on Enter key
      adminUserSearchInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
          const searchTerm = e.target.value.trim();
          if (searchTimeout) clearTimeout(searchTimeout);
          loadAdminUsers(searchTerm);
        }
      });
    }

    // ==================== Payments Systems (Admin/Co-Admin) ====================
    const paymentQrNameInput = document.getElementById("paymentQrNameInput");
    const paymentQrFileInput = document.getElementById("paymentQrFileInput");
    const paymentQrFileName = document.getElementById("paymentQrFileName");
    const btnUploadPaymentQr = document.getElementById("btnUploadPaymentQr");
    const paymentQrsList = document.getElementById("paymentQrsList");
    const paymentsToast = document.getElementById("paymentsToast");
    let paymentsToastTimeout = null;

    function showPaymentsToast(message, isError = false) {
      if (!paymentsToast) return;
      paymentsToast.textContent = message;
      paymentsToast.className = `toast ${isError ? 'error' : 'success'}`;
      paymentsToast.style.display = 'flex';
      if (paymentsToastTimeout) clearTimeout(paymentsToastTimeout);
      paymentsToastTimeout = setTimeout(() => {
        paymentsToast.classList.add('fade-out');
        setTimeout(() => {
          paymentsToast.style.display = 'none';
          paymentsToast.classList.remove('fade-out');
        }, 300);
      }, 3000);
    }

    paymentQrFileInput?.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) {
        paymentQrFileName.textContent = file.name;
      } else {
        paymentQrFileName.textContent = "";
      }
    });

    btnUploadPaymentQr?.addEventListener("click", async () => {
      const name = paymentQrNameInput?.value.trim();
      const file = paymentQrFileInput?.files[0];

      if (!name) {
        showPaymentsToast("Please enter a QR name.", true);
        return;
      }

      if (!file) {
        showPaymentsToast("Please select an image file.", true);
        return;
      }

      const formData = new FormData();
      formData.append("name", name);
      formData.append("image", file);

      setBusy(btnUploadPaymentQr, true, "Uploading...");
      try {
        const response = await fetch("/api/payment-qrs", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Upload failed");
        }

        const result = await response.json();
        showPaymentsToast("Payment QR uploaded successfully!", false);
        if (paymentQrNameInput) paymentQrNameInput.value = "";
        if (paymentQrFileInput) paymentQrFileInput.value = "";
        if (paymentQrFileName) paymentQrFileName.textContent = "";
        await loadPaymentQrs();
      } catch (e) {
        showPaymentsToast(e.message || "Failed to upload QR.", true);
      } finally {
        setBusy(btnUploadPaymentQr, false);
      }
    });

    async function loadPaymentQrs() {
      if (!paymentQrsList) return;
      
      try {
        const response = await api("/api/payment-qrs");
        const qrs = response.qrs || [];
        
        if (qrs.length === 0) {
          paymentQrsList.innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">💳</div>
              <h3 class="empty-state-title">No payment QRs</h3>
              <p class="empty-state-text">Upload your first payment QR to get started.</p>
            </div>
          `;
          return;
        }

        let html = '';
        qrs.forEach(qr => {
          html += `
            <div class="game-card">
              <div class="game-card-info">
                <h3 class="game-card-name">${escapeHtml(qr.name)}</h3>
                <div class="game-card-meta">
                  <span class="badge badge-slug">${new Date(qr.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
              <div class="game-card-actions">
                <img src="${escapeHtml(qr.imageUrl)}" alt="${escapeHtml(qr.name)}" style="max-width:100px; max-height:100px; border-radius:8px; border:1px solid rgba(255,255,255,0.1); margin-right:12px;" />
                <button class="btn-danger" data-qr-id="${qr.id}" data-qr-name="${escapeHtml(qr.name)}" title="Delete QR">
                  Delete
                </button>
              </div>
            </div>
          `;
        });

        paymentQrsList.innerHTML = html;

        // Attach delete handlers
        paymentQrsList.querySelectorAll('.btn-danger[data-qr-id]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const qrId = Number(btn.dataset.qrId);
            const qrName = btn.dataset.qrName;
            if (qrId && qrName) {
              const confirmed = confirm(`Delete "${qrName}"?`);
              if (!confirmed) return;
              
              setBusy(btn, true, "Deleting...");
              try {
                await api(`/api/payment-qrs/${qrId}`, { method: 'DELETE' });
                showPaymentsToast("Payment QR deleted successfully.", false);
                await loadPaymentQrs();
              } catch (e) {
                showPaymentsToast(e.message || "Failed to delete QR.", true);
              } finally {
                setBusy(btn, false);
              }
            }
          });
        });
      } catch (e) {
        paymentQrsList.innerHTML = `<div class="msg" data-kind="error" style="margin-top:8px;">Error loading payment QRs: ${e.message}</div>`;
      }
    }

    // ==================== Gmail Payment Monitor Settings ====================
    const gmailAddressInput = document.getElementById("gmailAddressInput");
    const gmailAppPasswordInput = document.getElementById("gmailAppPasswordInput");
    const toggleGmailPassword = document.getElementById("toggleGmailPassword");
    const gmailPollEnabledCheckbox = document.getElementById("gmailPollEnabledCheckbox");
    const btnSaveGmailSettings = document.getElementById("btnSaveGmailSettings");
    const btnTestGmailConnection = document.getElementById("btnTestGmailConnection");
    const gmailMonitorStatusText = document.getElementById("gmailMonitorStatusText");
    const gmailLastChecked = document.getElementById("gmailLastChecked");
    const gmailAccountsList = document.getElementById("gmailAccountsList");

    // Password toggle for Gmail app password
    toggleGmailPassword?.addEventListener("click", () => {
      const input = gmailAppPasswordInput;
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      toggleGmailPassword.querySelectorAll("svg").forEach((svg, index) => {
        svg.style.display = (isPassword && index === 1) || (!isPassword && index === 0) ? "block" : "none";
      });
    });

    // Load Gmail settings
    async function loadGmailSettings() {
      try {
        const response = await api("/api/admin/payment-monitor/settings");
        const settings = response.settings || {};
        
        if (gmailAddressInput) gmailAddressInput.value = settings.gmailAddress || "";
        if (gmailPollEnabledCheckbox) gmailPollEnabledCheckbox.checked = settings.gmailPollEnabled || false;
        
        // Don't populate password field (security)
        if (gmailAppPasswordInput && !settings.hasAppPassword) {
          gmailAppPasswordInput.value = "";
        }
        
        // Update status display
        if (gmailMonitorStatusText) {
          gmailMonitorStatusText.textContent = settings.gmailPollEnabled ? "ON" : "OFF";
          gmailMonitorStatusText.style.color = settings.gmailPollEnabled 
            ? "rgba(0,255,204,0.95)" 
            : "rgba(255,255,255,0.6)";
        }
        
        if (gmailLastChecked) {
          if (settings.lastCheckedAt) {
            const date = new Date(settings.lastCheckedAt);
            gmailLastChecked.textContent = date.toLocaleString();
          } else {
            gmailLastChecked.textContent = "—";
          }
        }

        // Load Gmail accounts list
        await loadGmailAccountsList();
      } catch (e) {
        console.error("Error loading Gmail settings:", e);
      }
    }

    // Load Gmail accounts list
    async function loadGmailAccountsList() {
      if (!gmailAccountsList) return;
      
      try {
        const response = await api("/api/admin/payment-monitor/settings");
        const settings = response.settings || {};
        const gmailAddress = settings.gmailAddress || "";
        
        if (!gmailAddress) {
          gmailAccountsList.innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">📧</div>
              <h3 class="empty-state-title">No Gmail accounts configured</h3>
              <p class="empty-state-text">Add a Gmail address above to get started.</p>
            </div>
          `;
          return;
        }

        // Show configured Gmail address
        gmailAccountsList.innerHTML = `
          <div class="game-card">
            <div class="game-card-info">
              <h3 class="game-card-name">${escapeHtml(gmailAddress)}</h3>
              <div class="game-card-meta">
                <span class="badge ${settings.gmailPollEnabled ? 'badge-success' : 'badge-slug'}">
                  ${settings.gmailPollEnabled ? 'Monitoring: ON' : 'Monitoring: OFF'}
                </span>
                ${settings.hasAppPassword ? '<span class="badge badge-slug" style="margin-left:8px;">Password Set</span>' : ''}
              </div>
            </div>
            <div class="game-card-actions">
              <button class="btn-danger" id="btnDeleteGmailAccount" data-gmail="${escapeHtml(gmailAddress)}" title="Delete Gmail Account">
                Delete
              </button>
            </div>
          </div>
        `;

        // Attach delete handler
        const btnDeleteGmail = document.getElementById("btnDeleteGmailAccount");
        if (btnDeleteGmail) {
          btnDeleteGmail.addEventListener("click", async () => {
            const gmail = btnDeleteGmail.dataset.gmail;
            if (!gmail) return;
            
            const confirmed = confirm(`Delete Gmail account "${gmail}"?\n\nThis will remove the Gmail address and app password. Monitoring will be disabled.`);
            if (!confirmed) return;
            
            setBusy(btnDeleteGmail, true, "Deleting...");
            try {
              // Clear Gmail settings
              await api("/api/admin/payment-monitor/settings", {
                method: "POST",
                body: JSON.stringify({
                  gmailAddress: "",
                  gmailPollEnabled: false,
                }),
              });
              
              showPaymentsToast("Gmail account deleted successfully.", false);
              
              // Clear form fields
              if (gmailAddressInput) gmailAddressInput.value = "";
              if (gmailAppPasswordInput) gmailAppPasswordInput.value = "";
              if (gmailPollEnabledCheckbox) gmailPollEnabledCheckbox.checked = false;
              
              await loadGmailSettings();
            } catch (e) {
              showPaymentsToast(e.message || "Failed to delete Gmail account.", true);
            } finally {
              setBusy(btnDeleteGmail, false);
            }
          });
        }
      } catch (e) {
        gmailAccountsList.innerHTML = `<div class="msg" data-kind="error" style="margin-top:8px;">Error loading Gmail accounts: ${e.message}</div>`;
      }
    }

    // Save Gmail settings
    btnSaveGmailSettings?.addEventListener("click", async () => {
      const gmailAddress = gmailAddressInput?.value.trim();
      const gmailAppPassword = gmailAppPasswordInput?.value.trim();
      const gmailPollEnabled = gmailPollEnabledCheckbox?.checked || false;

      if (!gmailAddress) {
        showPaymentsToast("Please enter Gmail address.", true);
        return;
      }

      setBusy(btnSaveGmailSettings, true, "Saving...");
      try {
        await api("/api/admin/payment-monitor/settings", {
          method: "POST",
          body: JSON.stringify({
            gmailAddress,
            gmailAppPassword: gmailAppPassword || undefined, // Only send if provided
            gmailPollEnabled,
          }),
        });
        
        showPaymentsToast("Gmail settings saved successfully!", false);
        
        // Clear password field after save (security)
        if (gmailAppPasswordInput) gmailAppPasswordInput.value = "";
        
        await loadGmailSettings();
      } catch (e) {
        showPaymentsToast(e.message || "Failed to save settings.", true);
      } finally {
        setBusy(btnSaveGmailSettings, false);
      }
    });

    // Test Gmail connection
    btnTestGmailConnection?.addEventListener("click", async () => {
      const gmailAddress = gmailAddressInput?.value.trim();
      const gmailAppPassword = gmailAppPasswordInput?.value.trim();

      if (!gmailAddress) {
        showPaymentsToast("Please enter Gmail address.", true);
        return;
      }

      if (!gmailAppPassword) {
        showPaymentsToast("Please enter Gmail app password to test.", true);
        return;
      }

      setBusy(btnTestGmailConnection, true, "Testing...");
      try {
        await api("/api/admin/payment-monitor/test", {
          method: "POST",
          body: JSON.stringify({
            gmailAddress,
            gmailAppPassword,
          }),
        });
        
        showPaymentsToast("Gmail connection test successful!", false);
      } catch (e) {
        showPaymentsToast(e.message || "Gmail connection test failed.", true);
      } finally {
        setBusy(btnTestGmailConnection, false);
      }
    });

    // Load Gmail settings when payments view is shown
    const originalLoadPaymentQrs = loadPaymentQrs;
    loadPaymentQrs = async function() {
      await originalLoadPaymentQrs();
      await loadGmailSettings();
    };

    // ==================== TopUp (All Users) ====================
    const btnGenerateTopUp = document.getElementById("btnGenerateTopUp");
    const topUpContent = document.getElementById("topUpContent");
    const topUpDisplay = document.getElementById("topUpDisplay");
    const topUpQrImage = document.getElementById("topUpQrImage");
    const topUpLine = document.getElementById("topUpLine");
    const btnCopyTopUpLine = document.getElementById("btnCopyTopUpLine");
    const topUpTimer = document.getElementById("topUpTimer");
    const topUpStatus = document.getElementById("topUpStatus");
    const topUpToast = document.getElementById("topUpToast");
    const totalCoinsBalance = document.getElementById("totalCoinsBalance");
    let topUpToastTimeout = null;
    let topUpPollInterval = null;
    let topUpTimerInterval = null;
    let currentTopUpLine = null;
    let currentBalance = 0;

    function showTopUpToast(message, isError = false) {
      if (!topUpToast) return;
      topUpToast.textContent = message;
      topUpToast.className = `toast ${isError ? 'error' : 'success'}`;
      topUpToast.style.display = 'flex';
      if (topUpToastTimeout) clearTimeout(topUpToastTimeout);
      topUpToastTimeout = setTimeout(() => {
        topUpToast.classList.add('fade-out');
        setTimeout(() => {
          topUpToast.style.display = 'none';
          topUpToast.classList.remove('fade-out');
        }, 300);
      }, 3000);
    }

    function formatTime(seconds) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function updateTimer(expiresAt) {
      const now = new Date();
      const expiry = new Date(expiresAt);
      const diff = Math.max(0, Math.floor((expiry - now) / 1000));
      
      if (topUpTimer) {
        topUpTimer.textContent = formatTime(diff);
        if (diff === 0) {
          topUpTimer.style.color = 'rgba(255,53,94,0.95)';
        }
      }
      
      return diff;
    }

    async function pollTopUpStatus(code) {
      if (!code) return;
      
      try {
        const response = await api(`/api/topups/${code}`);
        const topup = response.topup;
        
        // Update TOPUP line if available
        if (topup.phrase_topup_line && topUpLine) {
          topUpLine.textContent = topup.phrase_topup_line;
          currentTopUpLine = topup.phrase_topup_line;
        } else if (topup.phrase && topUpLine) {
          const phraseTopupLine = `TOPUP: ${topup.phrase}`;
          topUpLine.textContent = phraseTopupLine;
          currentTopUpLine = phraseTopupLine;
        }
        
        if (topup.status === "CONFIRMED") {
          clearInterval(topUpPollInterval);
          clearInterval(topUpTimerInterval);
          
          // Refresh balance immediately (safe check - no redirect during polling)
          (async () => {
            try {
              const res = await fetch('/auth/me', { credentials: 'include' });
              if (res.ok) {
                const meResponse = await res.json();
                if (meResponse.user && meResponse.user.balanceCoins != null) {
                  currentBalance = Number(meResponse.user.balanceCoins) || 0;
                  if (totalCoinsBalance) {
                    totalCoinsBalance.textContent = currentBalance.toLocaleString();
                    // Add animation effect
                    totalCoinsBalance.style.transition = "transform 0.3s ease";
                    totalCoinsBalance.style.transform = "scale(1.1)";
                    setTimeout(() => {
                      totalCoinsBalance.style.transform = "scale(1)";
                    }, 300);
                  }
                  // Update navbar coins display
                  if (window.renderCoins) {
                    window.renderCoins(currentBalance);
                  }
                }
              } else {
                console.error("Failed to refresh balance: status", res.status);
              }
            } catch (e) {
              console.error("Failed to refresh balance:", e);
            }
          })();
          
          // Clear QR code (barcode) and unique code from display
          if (topUpQrImage) {
            topUpQrImage.src = "";
            topUpQrImage.alt = "";
          }
          if (topUpLine) {
            topUpLine.textContent = "";
          }
          currentTopUpLine = null;
          if (topUpTimer) {
            topUpTimer.textContent = "";
          }
          
          // Show confirmation message in toast
          const creditedAmount = topup.amountCoins || 0;
          const confirmationMessage = creditedAmount > 0 
            ? `✅ Payment Confirmed! +${creditedAmount} coins credited`
            : "✅ Payment Confirmed!";
          showTopUpToast(confirmationMessage, false);
          
          // Automatically reset to initial state after showing confirmation
          // Hide display, show content (initial state with "Generate TopUp Code" button)
          if (topUpContent) topUpContent.style.display = "block";
          if (topUpDisplay) topUpDisplay.style.display = "none";
          if (topUpStatus) topUpStatus.innerHTML = "";
        } else if (topup.status === "EXPIRED") {
          clearInterval(topUpPollInterval);
          clearInterval(topUpTimerInterval);
          
          // Clear QR code (barcode) and unique code from display
          if (topUpQrImage) {
            topUpQrImage.src = "";
            topUpQrImage.alt = "";
          }
          if (topUpLine) {
            topUpLine.textContent = "";
          }
          currentTopUpLine = null;
          if (topUpTimer) {
            topUpTimer.textContent = "";
          }
          
          if (topUpStatus) {
            topUpStatus.innerHTML = `
              <div style="padding:16px; background:rgba(255,53,94,0.15); border:1px solid rgba(255,53,94,0.4); border-radius:12px; color:rgba(255,53,94,0.95); margin-bottom:16px;">
                <strong>⏰ Code Expired</strong>
              </div>
              <button class="btn-primary" id="btnGenerateNewTopUp" style="width:auto; margin:0 auto;">
                Generate New Code
              </button>
            `;
            document.getElementById("btnGenerateNewTopUp")?.addEventListener("click", () => {
              if (topUpStatus) topUpStatus.innerHTML = "";
              handleGenerateTopUp();
            });
          }
        }
      } catch (e) {
        console.error("Polling error:", e);
      }
    }

    async function handleGenerateTopUp() {
      setBusy(btnGenerateTopUp, true, "Generating...");
      try {
        const response = await api("/api/topups", { method: 'POST' });
        const topup = response.topup;
        
        // Show display, hide content
        if (topUpContent) topUpContent.style.display = "none";
        if (topUpDisplay) topUpDisplay.style.display = "block";
        
        // Set QR image
        if (topUpQrImage && topup.qr) {
          topUpQrImage.src = topup.qr.imageUrl;
          topUpQrImage.alt = topup.qr.name;
        }
        
        // Display TOPUP line
        const phrase = topup.phrase || topup.code;
        const phraseTopupLine = topup.phrase_topup_line || `TOPUP: ${phrase}`;
        
        // Store TOPUP line for copying FIRST
        currentTopUpLine = phraseTopupLine;
        console.log("Set currentTopUpLine:", currentTopUpLine);
        
        // Then display it
        if (topUpLine) {
          topUpLine.textContent = phraseTopupLine;
          console.log("Set topUpLine element text:", phraseTopupLine);
        } else {
          console.warn("topUpLine element not found!");
        }
        
        // Reset timer color
        if (topUpTimer) topUpTimer.style.color = 'rgba(255,208,0,0.95)';
        
        // Clear status
        if (topUpStatus) topUpStatus.innerHTML = "";
        
        // Start timer
        if (topUpTimerInterval) clearInterval(topUpTimerInterval);
        topUpTimerInterval = setInterval(() => {
          const remaining = updateTimer(topup.expiresAt);
          if (remaining === 0) {
            clearInterval(topUpTimerInterval);
          }
        }, 1000);
        updateTimer(topup.expiresAt);
        
        // Start polling
        if (topUpPollInterval) clearInterval(topUpPollInterval);
        topUpPollInterval = setInterval(() => {
          pollTopUpStatus(topup.code);
        }, 6000); // Poll every 6 seconds
        
        showTopUpToast("TopUp code generated successfully!", false);
      } catch (e) {
        showTopUpToast(e.message || "Failed to generate TopUp code.", true);
      } finally {
        setBusy(btnGenerateTopUp, false);
      }
    }

    btnGenerateTopUp?.addEventListener("click", handleGenerateTopUp);

    // Copy button handler with fallback
    const handleCopyTopUpLine = async (e) => {
      e?.preventDefault();
      e?.stopPropagation();
      
      console.log("Copy button clicked!");
      
      // Get the button element (in case it wasn't found initially)
      const btn = btnCopyTopUpLine || document.getElementById("btnCopyTopUpLine");
      const lineEl = topUpLine || document.getElementById("topUpLine");
      
      console.log("Button found:", !!btn, "Line element found:", !!lineEl);
      console.log("currentTopUpLine:", currentTopUpLine);
      
      // Get the TOPUP line text from multiple sources
      let lineText = currentTopUpLine;
      if (!lineText && lineEl) {
        lineText = lineEl.textContent || lineEl.innerText || "";
        console.log("Got text from element:", lineText);
      }
      
      if (!lineText || lineText.trim() === "") {
        console.error("No text to copy!");
        showTopUpToast("No code to copy.", true);
        return;
      }
      
      lineText = lineText.trim();
      console.log("Copying text:", lineText);
      
      // Try modern clipboard API first
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(lineText);
          console.log("Copied successfully via Clipboard API");
          showTopUpToast("TOPUP line copied!", false);
          if (btn) {
            btn.textContent = "✅";
            setTimeout(() => {
              if (btn) btn.textContent = "📋";
            }, 900);
          }
          return;
        }
      } catch (err) {
        console.warn("Clipboard API failed, trying fallback:", err);
      }
      
      // Fallback: create temporary textarea
      try {
        const textarea = document.createElement("textarea");
        textarea.value = lineText;
        textarea.style.position = "fixed";
        textarea.style.left = "-999999px";
        textarea.style.top = "-999999px";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, 99999); // For mobile devices
        
        const successful = document.execCommand("copy");
        document.body.removeChild(textarea);
        
        if (successful) {
          console.log("Copied successfully via execCommand");
          showTopUpToast("TOPUP line copied!", false);
          if (btn) {
            btn.textContent = "✅";
            setTimeout(() => {
              if (btn) btn.textContent = "📋";
            }, 900);
          }
        } else {
          throw new Error("execCommand returned false");
        }
      } catch (err) {
        console.error("Copy failed:", err);
        showTopUpToast("Copy failed. Please select and copy manually.", true);
      }
    };
    
    // Attach event listener - use event delegation to ensure it works
    document.addEventListener("click", (e) => {
      if (e.target && (e.target.id === "btnCopyTopUpLine" || e.target.closest("#btnCopyTopUpLine"))) {
        handleCopyTopUpLine(e);
      }
    });
    
    // Also attach directly if button exists
    if (btnCopyTopUpLine) {
      btnCopyTopUpLine.addEventListener("click", handleCopyTopUpLine);
      console.log("Copy button event listener attached directly");
    } else {
      console.warn("Copy button not found initially, using event delegation");
    }

    // Wrap showView to cleanup intervals when leaving topup view
    const originalShowView = showView;
    showView = function(viewName) {
      if (currentView === 'topup' && viewName !== 'topup') {
        // Cleanup intervals when leaving topup view
        if (topUpPollInterval) {
          clearInterval(topUpPollInterval);
          topUpPollInterval = null;
        }
        if (topUpTimerInterval) {
          clearInterval(topUpTimerInterval);
          topUpTimerInterval = null;
        }
      }
      originalShowView(viewName);
    };

      btnNavLogout?.addEventListener("click", async () => {
        const confirmed = confirm("Are you sure you want to logout?");
        if (!confirmed) return;
        
        setBusy(btnNavLogout, true, "Logging out...");
      try { await api("/auth/logout", { method: "POST" }); } catch {}
      window.location.href = "/login.html";
    });
      
    } catch (e) {
      console.error("Dashboard init error:", e);
    } finally {
      // ALWAYS clear loading state
      setTopLoading('');
    }
  }

  
    // Redeem Modal
    function showGameRedeemModal(gameId, gameName, gameUsername) {
      // Create modal if not exists
      let modal = document.getElementById("gameRedeemModal");
      if (!modal) {
        modal = document.createElement("div");
        modal.id = "gameRedeemModal";
        modal.className = "modal-overlay";
        modal.innerHTML = `
          <div class="modal">
            <div class="modal-header">
              <h3 id="redeemModalTitle">Redeem</h3>
              <button class="modal-close" id="redeemModalClose">✕</button>
            </div>
            <div class="modal-body">
              <p class="modal-subtitle" id="redeemModalSubtitle"></p>
              <label class="field">
                <span>Amount</span>
                <input type="number" id="redeemAmountInput" min="1" step="1" placeholder="Enter amount" />
              </label>
              <div id="redeemModalMsg" class="form-msg"></div>
            </div>
            <div class="modal-footer">
              <button class="btn-secondary" id="redeemCancelBtn">Cancel</button>
              <button class="btn-primary" id="redeemConfirmBtn">Redeem</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);

        // close handlers
        modal.addEventListener("click", (e) => {
          if (e.target === modal) hideGameRedeemModal();
        });
        modal.querySelector("#redeemModalClose")?.addEventListener("click", hideGameRedeemModal);
        modal.querySelector("#redeemCancelBtn")?.addEventListener("click", hideGameRedeemModal);
      }

      modal.dataset.gameId = String(gameId);
      modal.dataset.gameName = String(gameName || "");
      modal.dataset.gameUsername = String(gameUsername || "");

      const title = modal.querySelector("#redeemModalTitle");
      const subtitle = modal.querySelector("#redeemModalSubtitle");
      const input = modal.querySelector("#redeemAmountInput");
      const msg = modal.querySelector("#redeemModalMsg");
      const confirmBtn = modal.querySelector("#redeemConfirmBtn");

      if (title) title.textContent = `Redeem - ${gameName}`;
      if (subtitle) subtitle.textContent = `Username: ${gameUsername}`;
      if (input) input.value = "";
      if (msg) msg.textContent = "";

      // Attach confirm handler (replace each time)
      confirmBtn.onclick = async () => {
        try {
          const amount = Number(input.value || 0);
          if (!amount || amount <= 0) {
            msg.textContent = "Please enter a valid amount.";
            msg.dataset.kind = "error";
            return;
          }
          confirmBtn.disabled = true;
          confirmBtn.dataset.label = confirmBtn.dataset.label || confirmBtn.textContent;
          confirmBtn.textContent = "Starting...";

          const data = await api("/api/game-redeems", {
            method: "POST",
            body: JSON.stringify({
              game_id: gameId,
              game_username: gameUsername,
              amount
            })
          });

          const jobId = data?.worker?.job_id;
          showPlayToast(jobId ? `Redeem started (Job: ${jobId})` : `Redeem queued`, false);
          hideGameRedeemModal();
        } catch (e) {
          msg.textContent = e.message || "Redeem failed";
          msg.dataset.kind = "error";
        } finally {
          confirmBtn.disabled = false;
          confirmBtn.textContent = confirmBtn.dataset.label || "Redeem";
        }
      };

      modal.style.display = "flex";
      setTimeout(() => modal.classList.add("open"), 10);
    }

    function hideGameRedeemModal() {
      const modal = document.getElementById("gameRedeemModal");
      if (!modal) return;
      modal.classList.remove("open");
      setTimeout(() => (modal.style.display = "none"), 150);
    }

return {
    initLoginPage,
    initRegisterPage,
    initRecoveryPage,
    initRecoverResetPage,
    initDashboardPage,
  };
})();

} // End of single-init guard
