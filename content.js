/**
 * Springboard Companion - Content Script
 * 
 * Capabilities:
 * 1. Course Traversal Mode:
 *    - Sequential module progression (Mark Complete -> Wait -> Next)
 *    - Dynamic video auto-seek to completion (mutes, seeks to duration - 0.2s, triggers ended/timeupdate)
 *    - Springboard internal message bus signaling
 * 2. Assignment / Quiz Solver Mode:
 *    - Variation 1: Infosys Assessment Platform (Angular Material / IAP)
 *    - Variation 2: Techademy / Yaksha (React Material-UI / MUI)
 *    - Scrapes question statements, code snippets, and radio options
 *    - Calls custom OpenAI-compatible API endpoint via background service worker
 *    - Automatically selects the best option and clicks Save / "Save & Next"
 *    - Sequential batch solving across all questions in sidebar (1 to N)
 * 3. Fullscreen Resiliency:
 *    - Dynamically detects entering fullscreen mode and re-parents HUD inside the active
 *      fullscreen container to prevent disappearing.
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
    MINIMIZED: 'sb_hud_minimized',
    ACTIVE_TAB: 'sb_hud_active_tab',
    BASE_URL: 'sb_cfg_base_url',
    API_KEY: 'sb_cfg_api_key',
    MODEL_ID: 'sb_cfg_model_id',
    AUTO_SAVE: 'sb_cfg_auto_save'
  };

  const DEFAULT_DELAY_MS = 2000;
  let loopTimer = null;
  let isExecutingStep = false;
  let isSolvingBatch = false;

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

  // --- LLM Config Accessors ---
  function getLlmConfig() {
    return {
      baseUrl: localStorage.getItem(STORAGE_KEYS.BASE_URL) || 'https://api.openai.com/v1',
      apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || '',
      model: localStorage.getItem(STORAGE_KEYS.MODEL_ID) || 'gpt-4o-mini',
      autoSave: localStorage.getItem(STORAGE_KEYS.AUTO_SAVE) !== 'false'
    };
  }

  function saveLlmConfig(cfg) {
    if (cfg.baseUrl !== undefined) localStorage.setItem(STORAGE_KEYS.BASE_URL, cfg.baseUrl.trim());
    if (cfg.apiKey !== undefined) localStorage.setItem(STORAGE_KEYS.API_KEY, cfg.apiKey.trim());
    if (cfg.model !== undefined) localStorage.setItem(STORAGE_KEYS.MODEL_ID, cfg.model.trim());
    if (cfg.autoSave !== undefined) localStorage.setItem(STORAGE_KEYS.AUTO_SAVE, cfg.autoSave ? 'true' : 'false');
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
  // SECTION 1: COURSE AUTO-PROGRESSION & VIDEO AUTO-SEEK
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

    // Expand collapsed folders if needed
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
  // SECTION 2: AI ASSIGNMENT & QUIZ SOLVER (VARIATION 1 & VARIATION 2)
  // =========================================================================

  function getContestDocument() {
    // 1. Direct document check
    if (document.querySelector('#problemStatement, .quill-image-test, app-question-details-mcq')) {
      return document;
    }
    // 2. Iframe checks (search all accessible iframes on the page)
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const ifr of iframes) {
      try {
        const idoc = ifr.contentDocument || ifr.contentWindow?.document;
        if (idoc && idoc.querySelector('#problemStatement, .quill-image-test, app-question-details-mcq, input.PrivateSwitchBase-input')) {
          return idoc;
        }
      } catch (_) {}
    }
    return null;
  }

  function scrapeCurrentQuestion(doc = null) {
    const targetDoc = doc || getContestDocument() || document;

    // --- VARIATION 1: IAP / Infosys Assessment Platform (Angular Material) ---
    const qStmtVar1 = targetDoc.querySelector('#problemStatement, .question-description');
    const radioVar1 = targetDoc.querySelectorAll('mat-radio-button, mat-checkbox');

    if (qStmtVar1 && radioVar1.length > 0) {
      const qTitleElem = targetDoc.querySelector('#problem, .questionName');
      const questionTitle = qTitleElem ? qTitleElem.innerText.trim() : 'Question';
      const statement = qStmtVar1.innerText.replace(/\u00a0/g, ' ').trim();

      const options = Array.from(radioVar1).map((btn, idx) => {
        const optTextElem = btn.querySelector('.options, .mat-radio-label-content') || btn;
        const text = optTextElem.innerText.replace(/\u00a0/g, ' ').trim();
        return {
          index: idx,
          element: btn,
          text: text,
          variant: 'iap'
        };
      });

      return {
        title: questionTitle,
        statement,
        options,
        variant: 'iap',
        doc: targetDoc
      };
    }

    // --- VARIATION 2: Techademy / Yaksha (React Material-UI / MUI) ---
    const qStmtVar2 = targetDoc.querySelector('.quill-image-test, [class*="quill-image-test"], h6.MuiTypography-h6');
    const radioInputsVar2 = targetDoc.querySelectorAll('input.PrivateSwitchBase-input[type="radio"], input[type="radio"]');

    if (qStmtVar2 && radioInputsVar2.length > 0) {
      const qNumElem = targetDoc.querySelector('.infoHeader + div h6, .MuiTypography-subtitle1');
      const questionTitle = qNumElem ? `Question ${qNumElem.innerText.trim()}` : 'Question';
      const statement = qStmtVar2.innerText.replace(/\u00a0/g, ' ').trim();

      const options = Array.from(radioInputsVar2).map((inp, idx) => {
        let text = inp.getAttribute('value') || '';
        if (!text || text === '[object Object]') {
          const parentRow = inp.closest('.MuiGrid-item, .MuiFormControlLabel-root, .MuiBox-root') || inp.parentElement;
          if (parentRow) {
            const textElem = parentRow.querySelector('p, span:not(.MuiRadio-root)') || parentRow;
            text = textElem.innerText.trim();
          }
        }
        text = text.replace(/\u00a0/g, ' ').trim();

        const clickable = inp.closest('.MuiRadio-root, .MuiButtonBase-root') || inp;
        return {
          index: idx,
          element: clickable,
          input: inp,
          text: text,
          variant: 'techademy'
        };
      });

      return {
        title: questionTitle,
        statement,
        options,
        variant: 'techademy',
        doc: targetDoc
      };
    }

    return null;
  }

  async function queryLlmAnswer(qData) {
    const cfg = getLlmConfig();
    if (!cfg.apiKey && !cfg.baseUrl.includes('localhost') && !cfg.baseUrl.includes('127.0.0.1')) {
      throw new Error('API Key is required for non-local endpoints.');
    }

    const optionsFormatted = qData.options
      .map((opt) => `Option [${opt.index}]: ${opt.text}`)
      .join('\n');

    const messages = [
      {
        role: 'system',
        content: 'You are an accurate exam quiz solver in Computer Science and Data Science. Analyze the problem and options carefully. Pick the single best option index. Respond ONLY with a valid JSON object: {"best_option_index": <0-based integer>, "reason": "<brief justification>"}'
      },
      {
        role: 'user',
        content: `Question:\n${qData.statement}\n\nAvailable Options:\n${optionsFormatted}\n\nWhich option index is correct? Return JSON only.`
      }
    ];

    logMessage(`Querying ${cfg.model} via ${cfg.baseUrl}...`, 'info');

    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: 'CALL_LLM',
          payload: {
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
            messages: messages
          }
        },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!res) {
            reject(new Error('No response from background worker.'));
          } else if (!res.success) {
            reject(new Error(res.error || 'LLM API request failed.'));
          } else {
            resolve(res.data);
          }
        }
      );
    });

    const replyContent = response.choices?.[0]?.message?.content || '';
    
    let parsed = null;
    const jsonMatch = replyContent.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (_) {}
    }

    if (!parsed || typeof parsed.best_option_index !== 'number') {
      const numMatch = replyContent.match(/option\s*\[?(\d+)\]?/i) || replyContent.match(/\b(\d+)\b/);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10);
        if (idx >= 0 && idx < qData.options.length) {
          parsed = { best_option_index: idx, reason: replyContent.slice(0, 100) };
        }
      }
    }

    if (!parsed || typeof parsed.best_option_index !== 'number') {
      throw new Error(`Could not parse LLM answer: "${replyContent.slice(0, 120)}..."`);
    }

    return parsed;
  }

  async function applyAnswer(qData, bestIndex, autoSave = true) {
    if (bestIndex < 0 || bestIndex >= qData.options.length) {
      throw new Error(`Invalid option index: ${bestIndex}`);
    }

    const targetOption = qData.options[bestIndex];
    logMessage(`Selecting Option [${bestIndex}]: "${targetOption.text.slice(0, 35)}..."`, 'info');

    if (qData.variant === 'techademy') {
      const inp = targetOption.input;
      if (inp) {
        inp.checked = true;
        inp.click();
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (targetOption.element) {
        targetOption.element.click();
      }
    } else {
      const targetElement = targetOption.element;
      const clickable = targetElement.querySelector('label, input') || targetElement;
      clickable.click();
      targetElement.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (autoSave) {
      await new Promise((r) => setTimeout(r, 450));
      const targetDoc = qData.doc || document;

      // 1. Check Var 2 "Save & Next" button
      const allButtons = Array.from(targetDoc.querySelectorAll('button'));
      const saveAndNextBtn = allButtons.find((b) => {
        const t = (b.innerText || '').toLowerCase().replace(/\s+/g, ' ');
        return t.includes('save & next') || t.includes('save and next');
      });

      if (saveAndNextBtn) {
        saveAndNextBtn.click();
        logMessage('Clicked "Save & Next".', 'success');
        return true;
      }

      // 2. Check Var 1 "#formSubmit" Save button
      const saveBtn = targetDoc.querySelector('#formSubmit, button[id="formSubmit"]');
      if (saveBtn) {
        saveBtn.click();
        logMessage('Answer saved.', 'success');
        return true;
      }

      logMessage('Save button not detected; option selected.', 'warning');
    }

    return true;
  }

  async function solveCurrentQuestion() {
    const qData = scrapeCurrentQuestion();
    if (!qData) {
      logMessage('No active question or options found on screen.', 'warning');
      alert('Could not find question statement or options. Make sure an assessment question is open.');
      return false;
    }

    logMessage(`Found ${qData.title} (${qData.options.length} options, ${qData.variant})`, 'info');
    updateHudStatusText(`Solving ${qData.title}...`);

    try {
      const result = await queryLlmAnswer(qData);
      logMessage(`AI Choice: Option [${result.best_option_index}] (${result.reason || 'No reason'})`, 'success');
      
      const cfg = getLlmConfig();
      await applyAnswer(qData, result.best_option_index, cfg.autoSave);
      updateHudStatusText(`Answered: Option ${result.best_option_index}`);
      return true;
    } catch (err) {
      logMessage(`Solver failed: ${err.message}`, 'error');
      updateHudStatusText('Error solving question');
      return false;
    }
  }

  async function solveAllQuestions() {
    if (isSolvingBatch) return;
    isSolvingBatch = true;
    updateHudBatchBtnState(true);

    logMessage('Starting sequential batch quiz solver...', 'info');

    try {
      const targetDoc = getContestDocument() || document;
      
      // Look for sidebar question buttons (Var 1 numeric IDs or Var 2 button.legends)
      let sidebarBtns = Array.from(
        targetDoc.querySelectorAll("app-side-bar-mcq button.fabBtn, app-side-bar-mcq button[id]")
      ).filter((b) => /^\d+$/.test(b.id));

      if (sidebarBtns.length === 0) {
        sidebarBtns = Array.from(targetDoc.querySelectorAll("button.legends"));
      }

      if (sidebarBtns.length === 0) {
        logMessage('No question navigation list detected. Solving current question only...', 'warning');
        await solveCurrentQuestion();
        return;
      }

      logMessage(`Detected ${sidebarBtns.length} questions in contest sidebar.`, 'info');

      for (let i = 0; i < sidebarBtns.length; i++) {
        if (!isSolvingBatch) {
          logMessage('Batch quiz solver stopped by user.', 'warning');
          break;
        }

        const btn = sidebarBtns[i];
        logMessage(`Switching to Question #${i + 1}...`, 'info');
        updateHudStatusText(`Question ${i + 1} of ${sidebarBtns.length}...`);
        btn.click();

        // Wait for question to render
        await new Promise((r) => setTimeout(r, 750));

        const qData = scrapeCurrentQuestion(targetDoc);
        if (!qData) {
          logMessage(`Could not read Question #${i + 1}, skipping...`, 'warning');
          continue;
        }

        try {
          const result = await queryLlmAnswer(qData);
          logMessage(`Q${i + 1} AI Pick: Option [${result.best_option_index}]`, 'success');
          const cfg = getLlmConfig();
          await applyAnswer(qData, result.best_option_index, cfg.autoSave);
        } catch (err) {
          logMessage(`Error solving Q${i + 1}: ${err.message}`, 'error');
        }

        await new Promise((r) => setTimeout(r, 1200));
      }

      logMessage('All questions processed!', 'success');
      updateHudStatusText('All questions done');
    } catch (err) {
      logMessage(`Batch solver error: ${err.message}`, 'error');
    } finally {
      isSolvingBatch = false;
      updateHudBatchBtnState(false);
    }
  }

  function stopBatchSolver() {
    isSolvingBatch = false;
    updateHudBatchBtnState(false);
    logMessage('Batch solver paused.', 'info');
    updateHudStatusText('Solver stopped');
  }

  // Cross-frame message bridge
  window.addEventListener('message', async (event) => {
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.action === 'SB_SOLVE_CURRENT') {
      await solveCurrentQuestion();
    } else if (event.data.action === 'SB_SOLVE_ALL') {
      await solveAllQuestions();
    } else if (event.data.action === 'SB_STOP_SOLVER') {
      stopBatchSolver();
    }
  });

  // =========================================================================
  // SECTION 3: FULLSCREEN DYNAMIC RE-PARENTING
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
        logMessage('Entering Fullscreen: re-anchored HUD into fullscreen layer.', 'info');
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
  // SECTION 4: FLOATING HUD UI & CONTROLLER
  // =========================================================================

  function injectHud() {
    if (document.getElementById('sb-hud-container')) return;

    const isTop = window.self === window.top;
    const isContestStandalone = !isTop && document.querySelector('#problemStatement, .quill-image-test, app-question');
    if (!isTop && !isContestStandalone) return;

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
    const cfg = getLlmConfig();
    const activeTab = localStorage.getItem(STORAGE_KEYS.ACTIVE_TAB) || (isContestStandalone ? 'assignment' : 'course');

    hud.innerHTML = `
      <div id="sb-hud-header">
        <div class="sb-hud-title-wrap">
          <span id="sb-hud-badge" class="sb-hud-badge idle"></span>
          <span class="sb-hud-title">Springboard Companion</span>
        </div>
        <button id="sb-hud-min-btn" class="sb-hud-minimize-btn" title="Toggle Minimize">─</button>
      </div>

      <div class="sb-hud-tabs">
        <button id="sb-tab-course" class="sb-hud-tab-btn ${activeTab === 'course' ? 'active' : ''}">Course Mode</button>
        <button id="sb-tab-assignment" class="sb-hud-tab-btn ${activeTab === 'assignment' ? 'active' : ''}">Assignment AI</button>
      </div>

      <div id="sb-hud-body">
        <!-- TAB 1: COURSE AUTO-STEPPER -->
        <div id="sb-tab-content-course" class="sb-hud-tab-content ${activeTab === 'course' ? 'active' : ''}">
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
        </div>

        <!-- TAB 2: ASSIGNMENT AI SOLVER -->
        <div id="sb-tab-content-assignment" class="sb-hud-tab-content ${activeTab === 'assignment' ? 'active' : ''}">
          <div class="sb-hud-field-group">
            <span class="sb-hud-field-label">Base URL</span>
            <input id="sb-cfg-base-url" class="sb-hud-input" type="text" placeholder="https://api.openai.com/v1" value="${cfg.baseUrl}">
          </div>

          <div class="sb-hud-field-group">
            <span class="sb-hud-field-label">API Key</span>
            <div class="sb-hud-input-wrap">
              <input id="sb-cfg-api-key" class="sb-hud-input" type="password" placeholder="sk-..." value="${cfg.apiKey}">
              <button id="sb-cfg-pw-toggle" class="sb-hud-pw-toggle" title="Show/Hide Key">👁</button>
            </div>
          </div>

          <div class="sb-hud-field-group">
            <span class="sb-hud-field-label">Model ID</span>
            <input id="sb-cfg-model-id" class="sb-hud-input" type="text" placeholder="gpt-4o-mini" value="${cfg.model}">
          </div>

          <label class="sb-hud-checkbox-row">
            <input id="sb-cfg-auto-save" class="sb-hud-checkbox" type="checkbox" ${cfg.autoSave ? 'checked' : ''}>
            <span>Auto Click "Save" after selecting</span>
          </label>

          <div class="sb-hud-buttons-2col">
            <button id="sb-hud-solve-curr-btn" class="sb-hud-btn sb-hud-btn-primary">🤖 Solve Current</button>
            <button id="sb-hud-solve-all-btn" class="sb-hud-btn sb-hud-btn-ai">⚡ Solve All</button>
          </div>
        </div>

        <!-- Shared Console Logs -->
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

    const tabCourse = hud.querySelector('#sb-tab-course');
    const tabAssignment = hud.querySelector('#sb-tab-assignment');
    const contentCourse = hud.querySelector('#sb-tab-content-course');
    const contentAssignment = hud.querySelector('#sb-tab-content-assignment');

    const switchTab = (tab) => {
      if (tab === 'course') {
        tabCourse.classList.add('active');
        tabAssignment.classList.remove('active');
        contentCourse.classList.add('active');
        contentAssignment.classList.remove('active');
        localStorage.setItem(STORAGE_KEYS.ACTIVE_TAB, 'course');
      } else {
        tabAssignment.classList.add('active');
        tabCourse.classList.remove('active');
        contentAssignment.classList.add('active');
        contentCourse.classList.remove('active');
        localStorage.setItem(STORAGE_KEYS.ACTIVE_TAB, 'assignment');
      }
    };

    tabCourse.addEventListener('click', () => switchTab('course'));
    tabAssignment.addEventListener('click', () => switchTab('assignment'));

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

    const baseUrlInput = hud.querySelector('#sb-cfg-base-url');
    const apiKeyInput = hud.querySelector('#sb-cfg-api-key');
    const pwToggle = hud.querySelector('#sb-cfg-pw-toggle');
    const modelInput = hud.querySelector('#sb-cfg-model-id');
    const autoSaveInput = hud.querySelector('#sb-cfg-auto-save');

    const saveInputs = () => {
      saveLlmConfig({
        baseUrl: baseUrlInput.value,
        apiKey: apiKeyInput.value,
        model: modelInput.value,
        autoSave: autoSaveInput.checked
      });
    };

    baseUrlInput.addEventListener('change', saveInputs);
    apiKeyInput.addEventListener('change', saveInputs);
    modelInput.addEventListener('change', saveInputs);
    autoSaveInput.addEventListener('change', saveInputs);

    pwToggle.addEventListener('click', () => {
      if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        pwToggle.textContent = '🔒';
      } else {
        apiKeyInput.type = 'password';
        pwToggle.textContent = '👁';
      }
    });

    const solveCurrBtn = hud.querySelector('#sb-hud-solve-curr-btn');
    const solveAllBtn = hud.querySelector('#sb-hud-solve-all-btn');

    solveCurrBtn.addEventListener('click', async () => {
      saveInputs();
      solveCurrBtn.disabled = true;
      try {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        iframes.forEach((ifr) => {
          try { ifr.contentWindow?.postMessage({ action: 'SB_SOLVE_CURRENT' }, '*'); } catch (_) {}
        });
        await solveCurrentQuestion();
      } finally {
        solveCurrBtn.disabled = false;
      }
    });

    solveAllBtn.addEventListener('click', async () => {
      saveInputs();
      if (isSolvingBatch) {
        stopBatchSolver();
        const iframes = Array.from(document.querySelectorAll('iframe'));
        iframes.forEach((ifr) => {
          try { ifr.contentWindow?.postMessage({ action: 'SB_STOP_SOLVER' }, '*'); } catch (_) {}
        });
      } else {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        iframes.forEach((ifr) => {
          try { ifr.contentWindow?.postMessage({ action: 'SB_SOLVE_ALL' }, '*'); } catch (_) {}
        });
        await solveAllQuestions();
      }
    });
  }

  function updateHudBatchBtnState(running) {
    const solveAllBtn = document.querySelector('#sb-hud-solve-all-btn');
    if (solveAllBtn) {
      if (running) {
        solveAllBtn.textContent = '⏹ Stop Solving';
        solveAllBtn.className = 'sb-hud-btn sb-hud-btn-danger';
      } else {
        solveAllBtn.textContent = '⚡ Solve All';
        solveAllBtn.className = 'sb-hud-btn sb-hud-btn-ai';
      }
    }
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

    if (statusText && !isExecutingStep && !isSolvingBatch) {
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
  // SECTION 5: INITIALIZATION
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
      logMessage('Resuming course loop...', 'info');
      scheduleNextStep(1500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
