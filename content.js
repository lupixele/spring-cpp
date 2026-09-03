/**
 * Springboard Companion - Content Script
 * Autonomous sequential loop:
 *  - Identifies active module ID
 *  - Dispatches completion events & API call
 *  - Delays for configurable duration
 *  - Navigates to next module
 *  - Persists state across SPA route changes and page navigations
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__SB_COMPLETER_INITIALIZED__) return;
  window.__SB_COMPLETER_INITIALIZED__ = true;

  // Configuration & State Keys
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

  // --- State Helpers ---
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

  // --- Logging Helper ---
  function logMessage(text, level = 'info') {
    console.log(`[Springboard Companion] [${level.toUpperCase()}] ${text}`);
    const logBox = document.getElementById('sb-hud-logs');
    if (logBox) {
      const item = document.createElement('div');
      item.className = `sb-hud-log-item ${level}`;
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      item.textContent = `[${time}] ${text}`;
      logBox.appendChild(item);

      // Trim older log items
      while (logBox.children.length > 60) {
        logBox.removeChild(logBox.firstChild);
      }
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  // --- Module Identification ---
  function getCurrentModuleId() {
    // 1. Check URL: /viewer/[contentType]/[id]
    const urlMatch = window.location.href.match(/\/viewer\/[^/]+\/([^?#]+)/);
    if (urlMatch && urlMatch[1]) {
      return decodeURIComponent(urlMatch[1]);
    }

    // 2. Check active mat-tree-node
    const activeNode = document.querySelector("mat-tree-node[aria-selected='true']");
    if (activeNode) {
      if (activeNode.id) return activeNode.id;
      const dataId = activeNode.getAttribute('data-id') || activeNode.getAttribute('identifier');
      if (dataId) return dataId;
    }

    // 3. Check fallback query parameters in current URL
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.has('pathId')) {
      return searchParams.get('pathId');
    }

    return null;
  }

  function getCurrentModuleName() {
    const activeNode = document.querySelector("mat-tree-node[aria-selected='true']");
    if (activeNode) {
      const titleElem = activeNode.querySelector('.content-title') || activeNode.querySelector('.expand-button');
      if (titleElem && titleElem.textContent.trim()) {
        return titleElem.textContent.trim();
      }
    }
    const pageHeading = document.querySelector('.content-title, .ws-mat-headline, h1.title');
    if (pageHeading && pageHeading.textContent.trim()) {
      return pageHeading.textContent.trim();
    }
    return 'Unknown Module';
  }

  // --- Video Auto-Seek & Completion Helper ---
  async function handleVideoSeek() {
    const video = document.querySelector('video') || document.querySelector('video.vjs-tech');
    const isVideoView = window.location.href.includes('/viewer/video') ||
                        window.location.href.includes('/viewer/mp4') ||
                        document.querySelector('ws-widget-player-video, viewer-plugin-video, .video-js, #video-player-container') !== null;

    if (!video && !isVideoView) {
      return false;
    }

    logMessage('Video player detected. Seeking video progress to end...', 'info');
    updateHudStatusText('Seeking video to end...');

    const seekElementToEnd = async (v) => {
      try {
        v.muted = true; // prevent sudden audio output
        if (v.duration && !isNaN(v.duration) && v.duration > 0) {
          v.currentTime = Math.max(0, v.duration - 0.2);
          try { await v.play(); } catch (_) {}
          v.dispatchEvent(new Event('timeupdate', { bubbles: true }));
          v.dispatchEvent(new Event('ended', { bubbles: true }));
          logMessage(`Video sought to completion (${v.duration.toFixed(1)}s)`, 'success');
          return true;
        }

        // Wait up to 3.5s for metadata if not ready
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
                logMessage(`Video metadata ready, sought to ${v.duration.toFixed(1)}s`, 'success');
              }
            } catch (_) {}
            resolve(true);
          };

          v.addEventListener('loadedmetadata', onMeta, { once: true });
          v.addEventListener('canplay', onMeta, { once: true });

          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              try {
                if (v.duration && !isNaN(v.duration) && v.duration > 0) {
                  v.currentTime = Math.max(0, v.duration - 0.2);
                  v.play().catch(() => {});
                  v.dispatchEvent(new Event('timeupdate', { bubbles: true }));
                  v.dispatchEvent(new Event('ended', { bubbles: true }));
                }
              } catch (_) {}
              resolve(false);
            }
          }, 3500);
        });
      } catch (err) {
        logMessage(`Video seek warning: ${err.message}`, 'warning');
        return false;
      }
    };

    // 1. Seek all HTML5 video elements in view
    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) {
      await seekElementToEnd(v);
    }

    // 2. Also control Video.js player instances in page context
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

    // Allow brief time for player events to settle
    await new Promise((r) => setTimeout(r, 600));
    return true;
  }

  // --- Completion Signal Dispatcher ---
  async function markModuleComplete(moduleId) {
    logMessage(`Dispatching completion for: ${moduleId}`, 'info');

    // 1. Dynamic Video seeking if video player is present
    await handleVideoSeek();

    const isVideo = window.location.href.includes('/viewer/video') ||
                    window.location.href.includes('/viewer/mp4') ||
                    document.querySelector('video, ws-widget-player-video, viewer-plugin-video') !== null;
    const mimeType = isVideo ? 'video/mp4' : 'application/web-module';

    // 2. Post MARK_AS_COMPLETE message
    window.postMessage(
      {
        requestId: 'MARK_AS_COMPLETE',
        identifier: moduleId,
        contentType: 'Resource',
        mimeType: mimeType
      },
      '*'
    );

    // 3. Post UPDATE_CONTENT_PROGRESS message
    window.postMessage(
      {
        requestId: 'UPDATE_CONTENT_PROGRESS',
        identifier: moduleId,
        progress: 1
      },
      '*'
    );

    // 4. Fallback direct progress API calculate call
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
      }).catch(() => {
        // Silently catch network/cors/endpoint errors
      });
    } catch (_) {
      // Non-blocking fetch attempt
    }

    // 5. Click any in-DOM "Mark as Complete" mini buttons if present
    const completeBtns = document.querySelectorAll(
      ".mark-as-complete-mini, button[aria-label*='Mark as complete' i], button[mattooltip*='Mark as complete' i]"
    );
    completeBtns.forEach((btn) => {
      try {
        btn.click();
      } catch (_) {}
    });

    logMessage(`Completion signals sent for ${moduleId} (${isVideo ? 'Video' : 'Module'})`, 'success');
  }

  // --- Navigation & DOM Traversal ---
  async function navigateToNext() {
    logMessage('Attempting forward navigation...', 'info');

    // 1. Primary: Forward navigation button
    const nextBtn = document.querySelector("button[aria-label='next content'], .navigation-btn-frwd");
    if (nextBtn && !nextBtn.disabled && nextBtn.offsetParent !== null) {
      logMessage("Found forward button ('next content'). Clicking...", 'info');
      nextBtn.click();
      return true;
    }

    // 2. Secondary: Tree-based sequential traversal
    logMessage('Forward button not available. Checking sidebar tree...', 'info');

    // Expand collapsed folders if any
    const collapsedNodes = Array.from(document.querySelectorAll("mat-tree-node[aria-expanded='false']"));
    for (const node of collapsedNodes) {
      const expandBtn = node.querySelector('.expand-button, button[aria-label*="toggle" i]');
      if (expandBtn) {
        expandBtn.click();
      }
    }

    // Short wait for tree to expand
    if (collapsedNodes.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // Find all leaf tree nodes (items that are modules/resources, not category folders)
    const allNodes = Array.from(document.querySelectorAll('mat-tree-node'));
    const leafNodes = allNodes.filter((node) => {
      const text = node.innerText || '';
      const isFolder = node.querySelector("mat-icon[data-mat-icon-type='font']")?.textContent.includes('folder') ||
                       node.classList.contains('folder-node');
      return !isFolder && text.trim().length > 0;
    });

    if (leafNodes.length === 0) {
      logMessage('No course tree leaf nodes found in view.', 'warning');
      return false;
    }

    // Find current active index
    const activeIndex = leafNodes.findIndex((node) => node.getAttribute('aria-selected') === 'true');

    // Look for next item after active node
    let targetNode = null;
    if (activeIndex !== -1 && activeIndex + 1 < leafNodes.length) {
      targetNode = leafNodes[activeIndex + 1];
    } else {
      // Look for first uncompleted node anywhere in the tree
      targetNode = leafNodes.find((node) => {
        const completedIcon = Array.from(node.querySelectorAll('mat-icon')).find(
          (icon) => icon.textContent.includes('done_all') || icon.classList.contains('completed-color')
        );
        return !completedIcon;
      });
    }

    if (targetNode) {
      const nodeName = targetNode.querySelector('.content-title')?.textContent.trim() || 'Next Module';
      logMessage(`Navigating to tree node: ${nodeName}`, 'info');
      const clickable = targetNode.querySelector('.expand-button, .content-title') || targetNode;
      clickable.click();
      return true;
    }

    logMessage('All modules in tree appear completed or end of course reached!', 'success');
    return false;
  }

  // --- Main Autonomous Step Execution ---
  async function executeStep() {
    if (!isRunning() || isExecutingStep) return;
    isExecutingStep = true;

    try {
      updateHudStatusText('Scanning current module...');
      const moduleId = getCurrentModuleId();

      if (!moduleId) {
        logMessage('Waiting for module/viewer to load...', 'warning');
        updateHudStatusText('Waiting for viewer...');
        isExecutingStep = false;
        scheduleNextStep(1500);
        return;
      }

      const modName = getCurrentModuleName();
      updateHudModuleName(modName, moduleId);

      // Check if we already processed this module in this exact view to avoid repeated double-firing
      const lastId = sessionStorage.getItem(STORAGE_KEYS.LAST_ID);
      if (lastId !== moduleId) {
        updateHudStatusText(`Completing: ${moduleId}`);
        await markModuleComplete(moduleId);
        sessionStorage.setItem(STORAGE_KEYS.LAST_ID, moduleId);
        incrementProcessedCount();
      } else {
        logMessage(`Module ${moduleId} was already signaled. Ready to advance.`, 'info');
      }

      const delayMs = getDelay();
      updateHudStatusText(`Waiting ${ (delayMs / 1000).toFixed(1) }s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      if (!isRunning()) {
        isExecutingStep = false;
        return;
      }

      updateHudStatusText('Advancing to next...');
      const advanced = await navigateToNext();

      if (advanced) {
        updateHudStatusText('Loading next module...');
        // Navigation will trigger either route change or page load
        // Schedule next check
        scheduleNextStep(2000);
      } else {
        logMessage('Auto-loop finished or no next module reachable.', 'warning');
        updateHudStatusText('Finished / Paused');
        setRunning(false);
      }
    } catch (err) {
      logMessage(`Error in execution step: ${err.message}`, 'error');
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

  // --- Route & Navigation Watcher ---
  function observeNavigationChanges() {
    let lastUrl = window.location.href;

    const checkUrlChange = () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        logMessage(`Detected URL navigation: ${lastUrl}`, 'info');
        if (isRunning()) {
          scheduleNextStep(1500);
        }
      }
    };

    // Intercept pushState & replaceState
    const originalPushState = history.pushState;
    history.pushState = function () {
      originalPushState.apply(this, arguments);
      checkUrlChange();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function () {
      originalReplaceState.apply(this, arguments);
      checkUrlChange();
    };

    window.addEventListener('popstate', checkUrlChange);
    window.addEventListener('hashchange', checkUrlChange);

    // Mutation observer fallback for client-side tree selection changes
    const observer = new MutationObserver(() => {
      if (isRunning() && !isExecutingStep && !loopTimer) {
        scheduleNextStep(1000);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // --- HUD UI Construction & Dragging ---
  function injectHud() {
    if (document.getElementById('sb-hud-container')) return;

    const hud = document.createElement('div');
    hud.id = 'sb-hud-container';

    // Restore minimized state
    if (sessionStorage.getItem(STORAGE_KEYS.MINIMIZED) === 'true') {
      hud.classList.add('minimized');
    }

    // Restore saved position
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

        <div id="sb-hud-logs" class="sb-hud-log-box"></div>
      </div>
    `;

    document.body.appendChild(hud);

    // --- Wire Event Handlers ---
    const header = hud.querySelector('#sb-hud-header');
    const minBtn = hud.querySelector('#sb-hud-min-btn');
    const startBtn = hud.querySelector('#sb-hud-start-btn');
    const pauseBtn = hud.querySelector('#sb-hud-pause-btn');
    const nextBtn = hud.querySelector('#sb-hud-next-btn');
    const delaySlider = hud.querySelector('#sb-hud-delay-slider');
    const delayVal = hud.querySelector('#sb-hud-delay-val');

    // Minimize toggle
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hud.classList.toggle('minimized');
      const isMin = hud.classList.contains('minimized');
      minBtn.textContent = isMin ? '□' : '─';
      sessionStorage.setItem(STORAGE_KEYS.MINIMIZED, isMin ? 'true' : 'false');
    });

    // Start
    startBtn.addEventListener('click', () => {
      logMessage('Starting sequential auto-completion...', 'info');
      setRunning(true);
      executeStep();
    });

    // Pause
    pauseBtn.addEventListener('click', () => {
      logMessage('Pausing sequential auto-completion.', 'warning');
      if (loopTimer) clearTimeout(loopTimer);
      setRunning(false);
      updateHudStatusText('Paused');
    });

    // Manual Next
    nextBtn.addEventListener('click', async () => {
      logMessage('Manual Next triggered', 'info');
      await navigateToNext();
    });

    // Delay slider
    delaySlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      delayVal.textContent = `${val.toFixed(1)}s`;
      setDelay(Math.round(val * 1000));
    });

    // Draggable HUD logic
    setupDraggable(hud, header);

    // Sync initial state
    updateHudState();
    logMessage('Springboard Companion HUD initialized.', 'info');
  }

  function setupDraggable(element, handle) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.id === 'sb-hud-min-btn') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = element.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      element.style.right = 'auto';
      element.style.bottom = 'auto';
      element.style.left = `${initialLeft}px`;
      element.style.top = `${initialTop}px`;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = Math.max(10, Math.min(window.innerWidth - element.offsetWidth - 10, initialLeft + dx));
      let newTop = Math.max(10, Math.min(window.innerHeight - element.offsetHeight - 10, initialTop + dy));

      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
    }

    function onMouseUp() {
      if (isDragging) {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // Save position to localStorage
        const rect = element.getBoundingClientRect();
        localStorage.setItem(
          STORAGE_KEYS.HUD_POS,
          JSON.stringify({ top: Math.round(rect.top), left: Math.round(rect.left) })
        );
      }
    }
  }

  // --- HUD State Updaters ---
  function updateHudState() {
    const badge = document.getElementById('sb-hud-badge');
    const startBtn = document.getElementById('sb-hud-start-btn');
    const pauseBtn = document.getElementById('sb-hud-pause-btn');
    const countVal = document.getElementById('sb-hud-count');
    const running = isRunning();

    if (badge) {
      badge.className = `sb-hud-badge ${running ? 'running' : 'paused'}`;
    }
    if (startBtn) {
      startBtn.disabled = running;
    }
    if (pauseBtn) {
      pauseBtn.disabled = !running;
    }
    if (countVal) {
      countVal.textContent = getProcessedCount().toString();
    }
  }

  function updateHudStatusText(status) {
    const elem = document.getElementById('sb-hud-status');
    if (elem) elem.textContent = status;
  }

  function updateHudModuleName(name, id) {
    const elem = document.getElementById('sb-hud-current-module');
    if (elem) {
      elem.textContent = name || id;
      elem.title = `${name} (${id})`;
    }
  }

  // --- Initialize Extension ---
  function initialize() {
    injectHud();
    observeNavigationChanges();

    // Auto-resume if already running prior to page load
    if (isRunning()) {
      logMessage('Auto-resuming active loop from previous navigation...', 'info');
      updateHudState();
      scheduleNextStep(1800);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
