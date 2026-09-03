/**
 * Springboard Companion - Content Script
 * 
 * Features:
 * - Autonomous sequential course progression (Mark Complete -> Wait -> Next)
 * - Dynamic video auto-seeking to completion (seeks to duration - 0.2s, mutes audio, triggers ended/timeupdate)
 * - Springboard internal message bus signaling (MARK_AS_COMPLETE, UPDATE_CONTENT_PROGRESS)
 * - Fallback /progress/v1/progress/calculate API dispatch
 * - Fullscreen resilience (re-parents HUD into fullscreen element so it never disappears)
 * - Draggable floating HUD with Start/Pause/Next controls and configurable delay
 */

(function () {
  'use strict';

  if (window.__SB_COMPANION_INITIALIZED__) return;
  window.__SB_COMPANION_INITIALIZED__ = true;

  // --- Storage & Config Keys ---
  const STORAGE_KEYS = {
    RUNNING: 'sb_autoloop_running',
    DELAY: 'sb_autoloop_delay',
    COUNT: 'sb_autoloop_processed_count',
    LAST_ID: 'sb_autoloop_last_id',
    HUD_POS: 'sb_hud_position',
    MINIMIZED: 'sb_hud_minimized'
  };

  const DEFAULT_DELAY_MS = 2000;
  let loopTimer = null;
  let isExecutingStep = false;

  // --- State Accessors ---
  function isRunning() {
    return sessionStorage.getItem(STORAGE_KEYS.RUNNING) === 'true';
  }

  function setRunning(val) {
    sessionStorage.setItem(STORAGE_KEYS.RUNNING, val ? 'true' : 'false');
    updateHudState();
  }

  function getDelay() {
    const val = parseInt(sessionStorage.getItem(STORAGE_KEYS.DELAY), 10);
    return isNaN(val) ? DEFAULT_DELAY_MS : Math.max(500, val);
  }

  function setDelay(ms) {
    sessionStorage.setItem(STORAGE_KEYS.DELAY, ms.toString());
  }

  function getProcessedCount() {
    const val = parseInt(sessionStorage.getItem(STORAGE_KEYS.COUNT), 10);
    return isNaN(val) ? 0 : val;
  }

  function incrementProcessedCount() {
    const next = getProcessedCount() + 1;
    sessionStorage.setItem(STORAGE_KEYS.COUNT, next.toString());
    updateHudState();
    return next;
  }

  // --- Logger ---
  function logMessage(text, level = 'info') {
    console.log(`[Springboard Companion] [${level.toUpperCase()}] ${text}`);
    const logBox = document.getElementById('sb-hud-logs');
    if (logBox) {
      const item = document.createElement('div');
      item.className = `sb-hud-log-item ${level}`;
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      item.textContent = `[${time}] ${text}`;
      logBox.appendChild(item);

      while (logBox.children.length > 80) {
        logBox.removeChild(logBox.firstChild);
      }
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  // =========================================================================
  // SECTION 1: MODULE DETECTION & COMPLETION
  // =========================================================================

  function getCurrentModuleId() {
    const urlMatch = window.location.href.match(/\/viewer\/[^/]+\/([^?#]+)/);
    if (urlMatch && urlMatch[1]) return decodeURIComponent(urlMatch[1]);

    const activeNode = document.querySelector("mat-tree-node[aria-selected='true']");
    if (activeNode) {
      if (activeNode.id) return activeNode.id;
      const dataId = activeNode.getAttribute('data-id') || activeNode.getAttribute('identifier');
      if (dataId) return dataId;
    }

    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.has('pathId')) return searchParams.get('pathId');
    return null;
  }

  function getCurrentModuleName() {
    const activeNode = document.querySelector("mat-tree-node[aria-selected='true']");
    if (activeNode) {
      const titleElem = activeNode.querySelector('.content-title') || activeNode.querySelector('.expand-button');
      if (titleElem && titleElem.textContent.trim()) return titleElem.textContent.trim();
    }
    const pageHeading = document.querySelector('.content-title, .ws-mat-headline, h1.title');
    if (pageHeading && pageHeading.textContent.trim()) return pageHeading.textContent.trim();
    return 'Unknown Module';
  }

  async function handleVideoSeek() {
    const video = document.querySelector('video') || document.querySelector('video.vjs-tech');
    const isVideoView = window.location.href.includes('/viewer/video') ||
                        window.location.href.includes('/viewer/mp4') ||
                        document.querySelector('ws-widget-player-video, viewer-plugin-video, .video-js, #video-player-container') !== null;

    if (!video && !isVideoView) return false;

    logMessage('Video detected. Seeking to completion...', 'info');
    updateHudStatusText('Seeking video...');

    const seekElementToEnd = async (v) => {
      try {
        v.muted = true;
        if (v.duration && !isNaN(v.duration) && v.duration > 0) {
          v.currentTime = Math.max(0, v.duration - 0.2);
          try { await v.play(); } catch (_) {}
          v.dispatchEvent(new Event('timeupdate', { bubbles: true }));
          v.dispatchEvent(new Event('ended', { bubbles: true }));
          logMessage(`Video sought to end (${v.duration.toFixed(1)}s)`, 'success');
          return true;
        }

        return await new Promise((resolve) => {
          let resolved = false;
          const onMeta = () => {
            if (resolved) return;
            resolved = true;
            try {
              if (v.duration && !isNaN(v.duration) && v.duration > 0) {
                v.currentTime = Math.max(0, v.duration - 0.2);
                v.play().catch(() => {});
                v.dispatchEvent(new Event('timeupdate', { bubbles: true }));
                v.dispatchEvent(new Event('ended', { bubbles: true }));
                logMessage(`Video ready, sought to ${v.duration.toFixed(1)}s`, 'success');
              }
            } catch (_) {}
            resolve(true);
          };

          v.addEventListener('loadedmetadata', onMeta, { once: true });
          v.addEventListener('canplay', onMeta, { once: true });

          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              resolve(false);
            }
          }, 3000);
        });
      } catch (err) {
        logMessage(`Video seek notice: ${err.message}`, 'warning');
        return false;
      }
    };

    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) {
      await seekElementToEnd(v);
    }

    try {
      const script = document.createElement('script');
      script.textContent = `
        (function() {
          try {
            if (window.videojs && typeof window.videojs.getPlayers === 'function') {
              var players = window.videojs.getPlayers();
              for (var pid in players) {
                var p = players[pid];
                if (p && typeof p.duration === 'function') {
                  var d = p.duration();
                  if (d > 0) {
                    p.currentTime(Math.max(0, d - 0.2));
                    p.play();
                    p.trigger('timeupdate');
                    p.trigger('ended');
                  }
                }
              }
            }
          } catch(e) {}
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (_) {}

    await new Promise((r) => setTimeout(r, 600));
    return true;
  }

  async function markModuleComplete(moduleId) {
    logMessage(`Signaling completion for: ${moduleId}`, 'info');

    await handleVideoSeek();

    const isVideo = window.location.href.includes('/viewer/video') ||
                    window.location.href.includes('/viewer/mp4') ||
                    document.querySelector('video, ws-widget-player-video, viewer-plugin-video') !== null;
    const mimeType = isVideo ? 'video/mp4' : 'application/web-module';

    window.postMessage({
      requestId: 'MARK_AS_COMPLETE',
      identifier: moduleId,
      contentType: 'Resource',
      mimeType: mimeType
    }, '*');

    window.postMessage({
      requestId: 'UPDATE_CONTENT_PROGRESS',
      identifier: moduleId,
      progress: 1
    }, '*');

    try {
      fetch('/progress/v1/progress/calculate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-wingspan-caller': 'wingspan'
        },
        body: JSON.stringify({
          contentId: moduleId,
          progress: 1,
          markAsComplete: true
        })
      }).catch(() => {});
    } catch (_) {}

    const completeBtns = document.querySelectorAll(
      ".mark-as-complete-mini, button[aria-label*='Mark as complete' i], button[mattooltip*='Mark as complete' i]"
    );
    completeBtns.forEach((btn) => {
      try { btn.click(); } catch (_) {}
    });

    logMessage(`Completion sent for ${moduleId}`, 'success');
  }

  async function navigateToNext() {
    logMessage('Stepping to next module...', 'info');

    const primaryForwardBtn = document.querySelector(
      "button[aria-label='next content'], button.navigation-btn-frwd"
    );

    if (primaryForwardBtn && !primaryForwardBtn.disabled && !primaryForwardBtn.classList.contains('mat-button-disabled')) {
      logMessage('Clicking forward navigation button', 'info');
      primaryForwardBtn.click();
      return true;
    }

    const collapsedNodes = Array.from(document.querySelectorAll("mat-tree-node[aria-expanded='false']"));
    for (const node of collapsedNodes) {
      const isFolder = node.querySelector("mat-icon[data-mat-icon-type='font']")?.textContent.includes('folder') ||
                       node.classList.contains('folder-node') ||
                       node.querySelector('.toc-expand-icon');
      if (isFolder) {
        const toggleBtn = node.querySelector('.expand-button, .toc-expand-icon') || node;
        toggleBtn.click();
      }
    }

    if (collapsedNodes.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    const allNodes = Array.from(document.querySelectorAll('mat-tree-node'));
    const leafNodes = allNodes.filter((node) => {
      const text = node.innerText || '';
      const isFolder = node.querySelector("mat-icon[data-mat-icon-type='font']")?.textContent.includes('folder') ||
                       node.classList.contains('folder-node');
      return !isFolder && text.trim().length > 0;
    });

    if (leafNodes.length === 0) {
      logMessage('No course leaf nodes found.', 'warning');
      return false;
    }

    const activeIndex = leafNodes.findIndex((node) => node.getAttribute('aria-selected') === 'true');
    let targetNode = null;

    if (activeIndex !== -1 && activeIndex + 1 < leafNodes.length) {
      targetNode = leafNodes[activeIndex + 1];
    } else {
      targetNode = leafNodes.find((node) => {
        const completedIcon = Array.from(node.querySelectorAll('mat-icon')).find(
          (icon) => icon.textContent.includes('done_all') || icon.classList.contains('completed-color')
        );
        return !completedIcon;
      });
    }

    if (targetNode) {
      const nodeName = targetNode.querySelector('.content-title')?.textContent.trim() || 'Next Module';
      logMessage(`Navigating: ${nodeName}`, 'info');
      const clickable = targetNode.querySelector('.expand-button, .content-title') || targetNode;
      clickable.click();
      return true;
    }

    logMessage('All modules completed or end of course reached.', 'success');
    return false;
  }

  async function executeStep() {
    if (!isRunning() || isExecutingStep) return;
    isExecutingStep = true;

    try {
      updateHudStatusText('Scanning current module...');
      const moduleId = getCurrentModuleId();

      if (!moduleId) {
        logMessage('Waiting for viewer to load...', 'warning');
        updateHudStatusText('Waiting for viewer...');
        isExecutingStep = false;
        scheduleNextStep(1500);
        return;
      }

      const modName = getCurrentModuleName();
      updateHudModuleName(modName, moduleId);

      const lastId = sessionStorage.getItem(STORAGE_KEYS.LAST_ID);
      if (lastId !== moduleId) {
        updateHudStatusText(`Completing: ${moduleId}`);
        await markModuleComplete(moduleId);
        sessionStorage.setItem(STORAGE_KEYS.LAST_ID, moduleId);
        incrementProcessedCount();
      }

      const delayMs = getDelay();
      updateHudStatusText(`Waiting ${(delayMs / 1000).toFixed(1)}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      if (!isRunning()) {
        isExecutingStep = false;
        return;
      }

      updateHudStatusText('Advancing to next...');
      const advanced = await navigateToNext();

      if (advanced) {
        updateHudStatusText('Loading next module...');
        scheduleNextStep(2000);
      } else {
        updateHudStatusText('Finished');
        setRunning(false);
      }
    } catch (err) {
      logMessage(`Step error: ${err.message}`, 'error');
      scheduleNextStep(2500);
    } finally {
      isExecutingStep = false;
    }
  }

  function scheduleNextStep(delayMs = null) {
    if (loopTimer) clearTimeout(loopTimer);
    if (!isRunning()) return;
    const delay = delayMs !== null ? delayMs : getDelay();
    loopTimer = setTimeout(() => {
      executeStep();
    }, delay);
  }

  // =========================================================================
  // SECTION 2: FULLSCREEN RESILIENCE
  // =========================================================================

  function handleFullscreenChange() {
    const fsElement = document.fullscreenElement || 
                      document.webkitFullscreenElement || 
                      document.mozFullScreenElement || 
                      document.msFullscreenElement;
    const hud = document.getElementById('sb-hud-container');
    if (!hud) return;

    if (fsElement) {
      if (!fsElement.contains(hud)) {
        fsElement.appendChild(hud);
        hud.style.zIndex = '2147483647';
        logMessage('Fullscreen detected: HUD anchored to active screen layer.', 'info');
      }
    } else {
      if (hud.parentElement !== document.body && document.body) {
        document.body.appendChild(hud);
      }
    }
  }

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  document.addEventListener('mozfullscreenchange', handleFullscreenChange);
  document.addEventListener('MSFullscreenChange', handleFullscreenChange);

  // =========================================================================
  // SECTION 3: FLOATING HUD UI & CONTROLS
  // =========================================================================

  function injectHud() {
    if (document.getElementById('sb-hud-container')) return;

    // Only inject on top window
    if (window.self !== window.top) return;

    const hud = document.createElement('div');
    hud.id = 'sb-hud-container';

    if (sessionStorage.getItem(STORAGE_KEYS.MINIMIZED) === 'true') {
      hud.classList.add('minimized');
    }

    const savedPos = localStorage.getItem(STORAGE_KEYS.HUD_POS);
    if (savedPos) {
      try {
        const { top, left } = JSON.parse(savedPos);
        hud.style.top = `${top}px`;
        hud.style.left = `${left}px`;
        hud.style.right = 'auto';
      } catch (_) {}
    }

    const currentDelay = (getDelay() / 1000).toFixed(1);

    hud.innerHTML = `
      <div id="sb-hud-header">
        <div class="sb-hud-title-wrap">
          <span id="sb-hud-badge" class="sb-hud-badge idle"></span>
          <span class="sb-hud-title">Springboard Companion</span>
        </div>
        <button id="sb-hud-min-btn" class="sb-hud-minimize-btn" title="Toggle Minimize">─</button>
      </div>

      <div id="sb-hud-body">
        <div class="sb-hud-status-box">
          <div class="sb-hud-status-row">
            <span class="sb-hud-label">Status:</span>
            <span id="sb-hud-status" class="sb-hud-value">Ready</span>
          </div>
          <div class="sb-hud-status-row">
            <span class="sb-hud-label">Current:</span>
            <span id="sb-hud-current-module" class="sb-hud-value" title="Active Module">None</span>
          </div>
          <div class="sb-hud-status-row">
            <span class="sb-hud-label">Completed:</span>
            <span id="sb-hud-count" class="sb-hud-value">0</span>
          </div>
        </div>

        <div class="sb-hud-buttons">
          <button id="sb-hud-start-btn" class="sb-hud-btn sb-hud-btn-primary">▶ Start</button>
          <button id="sb-hud-pause-btn" class="sb-hud-btn sb-hud-btn-warning" disabled>❚❚ Pause</button>
          <button id="sb-hud-next-btn" class="sb-hud-btn sb-hud-btn-secondary">⏭ Next</button>
        </div>

        <div class="sb-hud-control-group">
          <div class="sb-hud-control-header">
            <span>Step Delay</span>
            <span id="sb-hud-delay-val">${currentDelay}s</span>
          </div>
          <input id="sb-hud-delay-slider" class="sb-hud-slider" type="range" min="0.5" max="8.0" step="0.5" value="${currentDelay}">
        </div>

        <div id="sb-hud-logs" class="sb-hud-logs-container">
          <div class="sb-hud-log-item info">[Ready] Springboard Companion initialized.</div>
        </div>
      </div>
    `;

    document.body.appendChild(hud);

    setupDraggable(hud, hud.querySelector('#sb-hud-header'));
    setupHudEvents(hud);
    updateHudState();
  }

  function setupHudEvents(hud) {
    const minBtn = hud.querySelector('#sb-hud-min-btn');
    minBtn.addEventListener('click', () => {
      hud.classList.toggle('minimized');
      const isMin = hud.classList.contains('minimized');
      sessionStorage.setItem(STORAGE_KEYS.MINIMIZED, isMin ? 'true' : 'false');
      minBtn.textContent = isMin ? '□' : '─';
    });

    const startBtn = hud.querySelector('#sb-hud-start-btn');
    const pauseBtn = hud.querySelector('#sb-hud-pause-btn');
    const nextBtn = hud.querySelector('#sb-hud-next-btn');
    const delaySlider = hud.querySelector('#sb-hud-delay-slider');
    const delayVal = hud.querySelector('#sb-hud-delay-val');

    startBtn.addEventListener('click', () => {
      logMessage('Auto-loop started.', 'info');
      setRunning(true);
      executeStep();
    });

    pauseBtn.addEventListener('click', () => {
      logMessage('Auto-loop paused.', 'warning');
      setRunning(false);
      if (loopTimer) clearTimeout(loopTimer);
    });

    nextBtn.addEventListener('click', () => {
      navigateToNext();
    });

    delaySlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      delayVal.textContent = `${val.toFixed(1)}s`;
      setDelay(Math.round(val * 1000));
    });
  }

  function updateHudState() {
    const running = isRunning();
    const startBtn = document.getElementById('sb-hud-start-btn');
    const pauseBtn = document.getElementById('sb-hud-pause-btn');
    const badge = document.getElementById('sb-hud-badge');
    const statusText = document.getElementById('sb-hud-status');
    const countText = document.getElementById('sb-hud-count');

    if (startBtn) startBtn.disabled = running;
    if (pauseBtn) pauseBtn.disabled = !running;

    if (badge) {
      badge.className = `sb-hud-badge ${running ? 'running' : 'idle'}`;
    }

    if (statusText && !isExecutingStep) {
      statusText.textContent = running ? 'Running...' : 'Idle / Paused';
    }

    if (countText) {
      countText.textContent = getProcessedCount().toString();
    }
  }

  function updateHudStatusText(text) {
    const el = document.getElementById('sb-hud-status');
    if (el) el.textContent = text;
  }

  function updateHudModuleName(name, id) {
    const el = document.getElementById('sb-hud-current-module');
    if (el) {
      el.textContent = name;
      el.title = `${name} (${id})`;
    }
  }

  function setupDraggable(element, handle) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, input')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = element.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newLeft = Math.max(10, Math.min(window.innerWidth - element.offsetWidth - 10, origX + dx));
      const newTop = Math.max(10, Math.min(window.innerHeight - element.offsetHeight - 10, origY + dy));
      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
      element.style.right = 'auto';
    }

    function onMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      const rect = element.getBoundingClientRect();
      localStorage.setItem(STORAGE_KEYS.HUD_POS, JSON.stringify({ top: rect.top, left: rect.left }));
    }
  }

  // =========================================================================
  // SECTION 4: INITIALIZATION
  // =========================================================================

  function observeNavigation() {
    let lastUrl = window.location.href;
    const checkUrl = () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        logMessage(`Navigation: ${lastUrl}`, 'info');
        if (isRunning()) scheduleNextStep(1500);
      }
    };

    const origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      checkUrl();
    };

    const origReplace = history.replaceState;
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      checkUrl();
    };

    window.addEventListener('popstate', checkUrl);
    window.addEventListener('hashchange', checkUrl);
  }

  function init() {
    injectHud();
    observeNavigation();

    if (isRunning()) {
      logMessage('Resuming course progression...', 'info');
      scheduleNextStep(1500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
