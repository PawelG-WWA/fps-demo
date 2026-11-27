(() => {
  'use strict';

  // ============================================================================
  // CONFIGURATION & CONSTANTS
  // ============================================================================
  const MODES = ['30', '40', 'interp', '60'];

  const TRACK_COLORS = {
    '30': '#ef5350',
    '40': '#f59e0b',
    'interp': '#a78bfa',
    '60': '#10b981'
  };

  const LIGHT_COLORS = {
    '30': '#d94848',
    '40': '#d97706',
    'interp': '#6d28d9',
    '60': '#059669'
  };

  const MODE_META = {
    '30': { name: '30 FPS', gameFps: 30, periodMs: 1000 / 30 },
    '40': { name: '40 FPS', gameFps: 40, periodMs: 1000 / 40 },
    'interp': { name: '30 FPS + simulated frame interpolation', gameFps: 30, periodMs: 1000 / 30 },
    '60': { name: '60 FPS', gameFps: 60, periodMs: 1000 / 60 }
  };

  const FT_HISTORY_LEN = 36;

  // ============================================================================
  // SHARED REAL-WORLD SCENE LOAD MODEL (Load level 1.0 = 14.0 ms → 5.0 = 44.0 ms)
  // All modes render the EXACT SAME scene workload on the same hardware.
  // Higher FPS targets have smaller frame budgets and struggle first.
  // ============================================================================
  const SPIKE_PEAK_MS = 17.5;
  const SPIKE_DURATION_MS = 720;

  function getSpikeEnvelopeMs(elapsedMs) {
    if (elapsedMs < 0 || elapsedMs >= SPIKE_DURATION_MS) return 0;
    if (elapsedMs < 40) return SPIKE_PEAK_MS * (elapsedMs / 40);
    if (elapsedMs < 340) return SPIKE_PEAK_MS;
    const decay = 1 - (elapsedMs - 340) / (SPIKE_DURATION_MS - 340);
    return SPIKE_PEAK_MS * decay * decay;
  }

  function getMeanSceneRenderMs(load, spikeMs = 0) {
    return 14.0 + (load - 1.0) * 7.5 + spikeMs;
  }

  function getRenderTimeMs(_mode, load, frameSeq, spikeMs = 0) {
    const mean = getMeanSceneRenderMs(load, spikeMs);
    if (load <= 1.001 && spikeMs <= 0.01) return mean;
    // Realistic ±8% scene complexity variance (keeps 40 FPS locked at 2.0 and 30 FPS locked at 3.0)
    const baseMean = 14.0 + (load - 1.0) * 7.5;
    const varAmp = Math.min(0.08, Math.max(0, (load - 1) * 0.04));
    const wave = 0.65 * Math.sin(frameSeq * 1.73) + 0.35 * Math.cos(frameSeq * 0.61);
    return baseMean * (1 + varAmp * wave) + spikeMs;
  }

  function getMeanFrameDurMs(mode, load, spikeMs = 0) {
    const meta = MODE_META[mode];
    return Math.max(meta.periodMs, getMeanSceneRenderMs(load, spikeMs));
  }

  function getInterpBufferLagMs(load, spikeMs = 0) {
    // Optical-flow motion smoothing requires ~2 source frames buffered
    return getMeanFrameDurMs('interp', load, spikeMs) * 2;
  }

  function getEfficiencyDropPct(actualFps, targetFps) {
    return Math.max(0, Math.min(100, (1 - actualFps / targetFps) * 100));
  }

  // Unified input-to-pixel latency estimator shared by 01 Motion (mid-screen: 0.5 scanout)
  // and 05 Pipeline (bottom-of-screen: 1.0 scanout), +2.5 ms assumed gray-to-gray pixel response.
  function computeModelLatencyMs(mode, hz, load, spikeMs = 0, scanFraction = 0.5) {
    const dispPeriod = 1000 / hz;
    const sceneMs = getMeanSceneRenderMs(load, spikeMs);
    const budgetMs = MODE_META[mode].periodMs;
    const missed = sceneMs > budgetMs + 0.5;
    const pacedMs = Math.max(budgetMs, sceneMs);

    let waitMs;
    if (mode === '40' && hz === 60 && !missed) {
      waitMs = 25.0 - sceneMs + 4.2;
    } else {
      const vSyncAlignedMs = Math.ceil((pacedMs - 0.01) / dispPeriod) * dispPeriod;
      waitMs = Math.max(0.4, vSyncAlignedMs - sceneMs);
    }
    const interpBufMs = mode === 'interp' ? Math.max(33.33, sceneMs) * 2 : 0;
    const scanMs = dispPeriod * scanFraction;
    const gtgMs = 2.5;
    return sceneMs + waitMs + interpBufMs + scanMs + gtgMs;
  }

  // ============================================================================
  // GLOBAL STATE
  // ============================================================================
  const state = {
    detectedHz: null,
    measuredRawHz: null,
    displayHz: 60,
    speed: 1,
    motionLoad: 1.0,
    consoleLoad: 1.0,
    consoleLoadActive: false,
    simLevel: 1.0,
    spikeStartSim: -1,
    spikeStartReal: -1,
    simSpikeMs: 0,
    realSpikeMs: 0,
    paused: false,
    showTruePos: true,
    showArtifacts: true,
    panSpeed: 420,
    tSim: 0,
    tRealSynced: 0,
    arenaMode: 'interp',
    showGhostCursor: true,
    hideOSCursor: false
  };

  const laneState = {};
  function initLaneState() {
    MODES.forEach((m) => {
      laneState[m] = {
        lastDisplayTick: -1,
        frameSeq: 0,
        nextFrameReadyTime: 0,
        holdTicks: 0,
        presentedTime: 0,
        ftHistory: [],
        lastPresentedHoldMs: MODE_META[m].periodMs,
        // Interpolation source tracking
        srcFrameSeq: 0,
        srcNextReadyTime: 0,
        srcHoldTicks: 0,
        avgSrcMs: 1000 / 30,
        currentLagMs: (1000 / 30) * 2
      };
    });
  }
  initLaneState();

  // ============================================================================
  // DOM REFERENCES
  // ============================================================================
  const dom = {
    detectedHz: document.getElementById('detectedHz'),
    detectedMeta: document.getElementById('detectedMeta'),
    detectorNote: document.getElementById('detectorNote'),
    remeasureBtn: document.getElementById('remeasureBtn'),
    btn60Hz: document.getElementById('btn60Hz'),
    btn120Hz: document.getElementById('btn120Hz'),
    btnSpeed1x: document.getElementById('btnSpeed1x'),
    btnSpeedSlow: document.getElementById('btnSpeedSlow'),
    loadPod: document.getElementById('loadPod'),
    loadScopeTag: document.getElementById('loadScopeTag'),
    loadSlider: document.getElementById('loadSlider'),
    loadVal: document.getElementById('loadVal'),
    loadMs: document.getElementById('loadMs'),
    loadResetBtn: document.getElementById('loadResetBtn'),
    deskConsoleToggle: document.getElementById('desktopConsoleToggle'),
    deskConsoleLoadTxt: document.getElementById('deskConsoleLoadTxt'),
    mobConsoleBtn: document.getElementById('mobConsoleBtn'),
    loadStatusToast: document.getElementById('loadStatusToast'),
    loadStatusToastTxt: document.getElementById('loadStatusToastTxt'),
    secLoadBtns: Array.from(document.querySelectorAll('[data-open-load-console]')),
    explodeBtn: document.getElementById('explodeBtn'),
    toggleTruePos: document.getElementById('toggleTruePos'),
    toggleArtifacts: document.getElementById('toggleArtifacts'),
    pauseBtn: document.getElementById('pauseBtn'),
    pauseLbl: document.getElementById('pauseLbl'),
    simBanner: document.getElementById('simBanner'),
    panSpeedSlider: document.getElementById('panSpeedSlider'),
    panSpeedLabel: document.getElementById('panSpeedLabel'),
    arenaCanvas: document.getElementById('arenaCanvas'),
    arenaHint: document.getElementById('arenaHint'),
    toggleGhostCursor: document.getElementById('toggleGhostCursor'),
    toggleHideOSCursor: document.getElementById('toggleHideOSCursor'),
    arenaStatMode: document.getElementById('arenaStatMode'),
    arenaStatLag: document.getElementById('arenaStatLag'),
    arenaStatVisual: document.getElementById('arenaStatVisual'),
    arenaStatPacing: document.getElementById('arenaStatPacing'),
    arenaStatScore: document.getElementById('arenaStatScore'),
    timelineBoard: document.getElementById('timelineBoard'),
    timelineHzText: document.getElementById('timelineHzText'),
    expCurveWrap: document.getElementById('expCurveWrap'),
    expCurveCanvas: document.getElementById('expCurveCanvas'),
    simLevelVal: document.getElementById('simLevelVal'),
    simEntityVal: document.getElementById('simEntityVal'),
    simCostVal: document.getElementById('simCostVal'),
    simFooterCard: document.getElementById('simFooterCard'),
    simScenarioLvlTxt: document.getElementById('simScenarioLvlTxt'),
    simScenarioTitle: document.getElementById('simScenarioTitle'),
    simScenarioDesc: document.getElementById('simScenarioDesc'),
    simImpactTag: document.getElementById('simImpactTag'),
    simMeterBars: Array.from(document.querySelectorAll('#simMeter span'))
  };

  const simCanvases = {};
  const simStatEls = {};
  const simAreaEls = {};
  MODES.forEach((m) => {
    simCanvases[m] = document.getElementById(`sim-canvas-${m}`);
    simStatEls[m] = document.getElementById(`sim-stat-${m}`);
    simAreaEls[m] = document.querySelector(`.sim-area[data-sim-mode="${m}"]`);
  });
  const simSectionEl = document.getElementById('simSection');
  const simLevelBtns = Array.from(document.querySelectorAll('.sim-lvl-btn'));
  const simScenarioBtns = Array.from(document.querySelectorAll('.sim-scenario-btn'));
  const simViewBtns = Array.from(document.querySelectorAll('[data-sim-view-btn]'));
  const simCostPills = Array.from(document.querySelectorAll('[data-sim-cost-pill]'));

  const laneCanvases = {};
  const ftCanvases = {};
  const laneMetricsEl = {};
  const ftValEl = {};
  const ftCapEl = {};
  const laneTagEl = {};

  MODES.forEach((m) => {
    laneCanvases[m] = document.getElementById(`canvas-${m}`);
    ftCanvases[m] = document.getElementById(`ft-${m}`);
    laneMetricsEl[m] = document.getElementById(`metrics-${m}`);
    ftValEl[m] = document.getElementById(`ft-val-${m}`);
    ftCapEl[m] = document.getElementById(`ft-cap-${m}`);
    laneTagEl[m] = document.getElementById(`lane-tag-${m}`);
  });

  // ============================================================================
  // HI-DPI CANVAS HELPER (CACHED + RESIZE-OBSERVER DRIVEN, ZERO PER-FRAME LAYOUT)
  // ============================================================================
  let rafId = null;
  let needsPausedRedraw = true;
  const canvasCache = new WeakMap();
  const trackedCanvases = new Set();
  const canvasResizeObserver = ('ResizeObserver' in window)
    ? new ResizeObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
          const cached = canvasCache.get(entries[i].target);
          if (cached) cached.dirty = true;
        }
        requestCanvasRedraw();
      })
    : null;

  function invalidateAllCanvases() {
    trackedCanvases.forEach((canvas) => {
      const cached = canvasCache.get(canvas);
      if (cached) cached.dirty = true;
    });
  }

  function getCanvasHiResScale() {
    const vw = window.innerWidth || 1440;
    const vh = window.innerHeight || 900;
    if (vw < 2200 || vh < 1120) return 1;
    return Math.min(2.6, Math.max(1, Math.min(vw / 1920, vh / 1040)));
  }

  function setupCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const uiScale = getCanvasHiResScale();
    let cached = canvasCache.get(canvas);
    if (!cached) {
      cached = { ctx: canvas.getContext('2d'), w: 1, h: 1, dpr: 0, uiScale: 0, dirty: true };
      canvasCache.set(canvas, cached);
      trackedCanvases.add(canvas);
      if (canvasResizeObserver) canvasResizeObserver.observe(canvas);
    }
    if (cached.dirty || cached.dpr !== dpr || cached.uiScale !== uiScale || !canvasResizeObserver) {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width);
      const cssH = Math.max(1, rect.height);
      const pw = Math.max(1, Math.round(cssW * dpr));
      const ph = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      cached.w = Math.max(1, Math.round(cssW / uiScale));
      cached.h = Math.max(1, Math.round(cssH / uiScale));
      cached.dpr = dpr;
      cached.uiScale = uiScale;
      cached.dirty = false;
    }
    const sx = canvas.width / cached.w;
    const sy = canvas.height / cached.h;
    cached.ctx.setTransform(sx, 0, 0, sy, 0, 0);
    return cached;
  }

  // ============================================================================
  // REFRESH RATE DETECTOR
  // ============================================================================
  function snapRefreshRate(hz) {
    const common = [30, 50, 60, 75, 90, 100, 120, 144, 165, 180, 240, 360];
    for (const c of common) {
      if (Math.abs(hz - c) / c < 0.055) return c;
    }
    return Math.round(hz);
  }

  let measuringHz = false;
  function detectRefreshRate(autoSelectDisplay = false) {
    if (measuringHz) return;
    measuringHz = true;
    dom.detectedHz.textContent = 'Check…';
    dom.detectedMeta.textContent = '';

    const deltas = [];
    let lastTs = null;
    let frames = 0;
    const WARMUP = 5;
    const TARGET_SAMPLES = 36;

    function sample(ts) {
      if (lastTs !== null) {
        const dt = ts - lastTs;
        if (frames >= WARMUP && dt > 2 && dt < 60) {
          deltas.push(dt);
        }
      }
      lastTs = ts;
      frames++;

      if (deltas.length < TARGET_SAMPLES && frames < 90) {
        requestAnimationFrame(sample);
        return;
      }

      measuringHz = false;
      if (deltas.length < 10) {
        state.detectedHz = 60;
        state.measuredRawHz = 60;
      } else {
        deltas.sort((a, b) => a - b);
        const medianDt = deltas[Math.floor(deltas.length / 2)];
        state.measuredRawHz = 1000 / medianDt;
        state.detectedHz = snapRefreshRate(state.measuredRawHz);
      }

      const medianMs = (1000 / state.measuredRawHz).toFixed(2);
      dom.detectedHz.textContent = `${state.detectedHz} Hz`;
      dom.detectedMeta.textContent = `${state.measuredRawHz.toFixed(1)} Hz · ${medianMs} ms`;

      if (state.detectedHz >= 110) {
        dom.detectorNote.textContent =
          `Browser animation cadence: approximately ${state.detectedHz} Hz. Simulated 60 Hz and 120 Hz patterns can both play at normal speed.`;
        if (autoSelectDisplay) setDisplayHz(120);
      } else if (state.detectedHz <= 45) {
        dom.detectorNote.textContent =
          `Browser animation cadence is throttled to ~${state.detectedHz} Hz (likely Chrome Energy Saver or OS Low Power Mode). Live 40/60 FPS motion will not look precise until power saving is disabled.`;
        if (autoSelectDisplay) setDisplayHz(60);
      } else {
        dom.detectorNote.textContent =
          `Browser animation cadence: approximately ${state.detectedHz} Hz. Use 0.25× slow motion to inspect the simulated 120 Hz timing pattern.`;
        if (autoSelectDisplay) setDisplayHz(60);
      }

      if (typeof updatePowerSaveNotice === 'function') {
        updatePowerSaveNotice(state.detectedHz);
      }
      updateSimBanner();
    }

    requestAnimationFrame(sample);
  }

  // ============================================================================
  // UI CONTROLS & NOTICE BANNER
  // ============================================================================
  function resetLaneSimulators() {
    state.tSim = 0;
    initLaneState();
    initSimArenaState();
  }

  function setDisplayHz(hz) {
    state.displayHz = hz;
    dom.btn60Hz.classList.toggle('active', hz === 60);
    dom.btn120Hz.classList.toggle('active', hz === 120);
    resetLaneSimulators();
    updateSimBanner();
    if (isSectionVisible('motionSection')) updateLaneReadouts();
    if (isSectionVisible('simSection')) {
      updateSimReadouts();
      drawExpCurve();
    }
    if (isSectionVisible('inputSection')) updateArenaStaticStats();
    if (isSectionVisible('timelineSection')) drawTimeline();
    if (isSectionVisible('pipelineSection')) updatePipelineView();
    if (isSectionVisible('physicsSection') && typeof onPhysicsSettingChanged === 'function') {
      onPhysicsSettingChanged(true);
    }
    requestCanvasRedraw();
    scheduleUrlSync();
  }

  function setSpeed(spd) {
    state.speed = spd;
    dom.btnSpeed1x.classList.toggle('active', spd === 1);
    dom.btnSpeedSlow.classList.toggle('active', spd !== 1);
    updateSimBanner();
    requestCanvasRedraw();
    scheduleUrlSync();
  }

  let activeSectionId = 'motionSection';
  let loadToastTimer = null;
  let loadToastHideTimer = null;
  let consoleTabPulseTimer = null;
  let mobConsolePulseTimer = null;
  let lastCommittedConsoleLoad = 1.0;

  function getCurrentSectionId() {
    if (window.fpsLabNav && typeof window.fpsLabNav.getActiveSectionId === 'function') {
      return window.fpsLabNav.getActiveSectionId();
    }
    return activeSectionId;
  }

  function getLoadForSection(secId) {
    if (secId === 'motionSection') return state.motionLoad;
    return state.consoleLoad;
  }

  function isMotionOnlyLoad(secId) {
    return secId === 'motionSection'
      && Math.abs(state.motionLoad - state.consoleLoad) >= 0.05
      && state.motionLoad > 1.01;
  }

  function getLoadTier(loadVal, spikeMs = 0) {
    return (loadVal >= 3.0 || spikeMs > 8) ? 'high' : (loadVal >= 1.5 || spikeMs > 1) ? 'mid' : 'low';
  }

  function showLoadStatusToast(message, tone = 'info', durationMs = 2300) {
    if (!dom.loadStatusToast || !dom.loadStatusToastTxt || !message) return;
    if (document.documentElement.classList.contains('is-intro-replay')) return;
    clearTimeout(loadToastTimer);
    clearTimeout(loadToastHideTimer);
    dom.loadStatusToast.dataset.tone = tone === 'high' ? 'high' : (tone === 'mid' ? 'mid' : 'info');
    dom.loadStatusToastTxt.textContent = message;
    dom.loadStatusToast.hidden = false;
    void dom.loadStatusToast.offsetWidth;
    dom.loadStatusToast.classList.add('is-visible');
    loadToastTimer = setTimeout(() => {
      dom.loadStatusToast.classList.remove('is-visible');
      loadToastHideTimer = setTimeout(() => {
        dom.loadStatusToast.hidden = true;
      }, 220);
    }, durationMs);
  }

  function pulseConsoleLoadIndicators() {
    if (dom.deskConsoleToggle) {
      dom.deskConsoleToggle.classList.remove('is-load-pulse');
      void dom.deskConsoleToggle.offsetWidth;
      dom.deskConsoleToggle.classList.add('is-load-pulse');
      clearTimeout(consoleTabPulseTimer);
      consoleTabPulseTimer = setTimeout(() => {
        if (dom.deskConsoleToggle) dom.deskConsoleToggle.classList.remove('is-load-pulse');
      }, 720);
    }
    if (dom.mobConsoleBtn) {
      dom.mobConsoleBtn.classList.remove('is-load-pulse');
      void dom.mobConsoleBtn.offsetWidth;
      dom.mobConsoleBtn.classList.add('is-load-pulse');
      clearTimeout(mobConsolePulseTimer);
      mobConsolePulseTimer = setTimeout(() => {
        if (dom.mobConsoleBtn) dom.mobConsoleBtn.classList.remove('is-load-pulse');
      }, 720);
    }
  }

  function pulseSectionLoadPills(secId) {
    const key = secId === 'simSection' ? 'sim' : (secId === 'physicsSection' ? 'phys' : (secId === 'inputSection' ? 'input' : null));
    if (!key) return;
    dom.secLoadBtns.forEach((btn) => {
      if (btn.dataset.openLoadConsole !== key) return;
      btn.classList.remove('is-refresh-pulse');
      void btn.offsetWidth;
      btn.classList.add('is-refresh-pulse');
      setTimeout(() => btn.classList.remove('is-refresh-pulse'), 760);
    });
  }

  function updateSectionLoadPills(simUi) {
    if (!dom.secLoadBtns.length) return;
    const cLoad = state.consoleLoad;
    const simSpike = Math.max(state.simSpikeMs, simUi ? simUi.burstMs : 0);
    const baseSceneMs = getMeanSceneRenderMs(cLoad, state.simSpikeMs);
    const simExtraMs = (cLoad - 1.0) * 7.5 + simSpike;
    const baseTier = getLoadTier(cLoad, state.simSpikeMs);
    const simTier = getLoadTier(cLoad, simSpike);

    dom.secLoadBtns.forEach((btn) => {
      const kind = btn.dataset.openLoadConsole;
      const isSim = kind === 'sim';
      const tier = isSim ? simTier : baseTier;
      if (btn.dataset.tier !== tier) btn.dataset.tier = tier;
      const valEl = btn.querySelector('[data-sec-load-val]');
      const msEl = btn.querySelector('[data-sec-load-ms]');
      const valTxt = cLoad.toFixed(1);
      const msTxt = isSim ? `+${simExtraMs.toFixed(1)} ms` : `${baseSceneMs.toFixed(1)} ms`;
      if (valEl && valEl.textContent !== valTxt) valEl.textContent = valTxt;
      if (msEl && msEl.textContent !== msTxt) msEl.textContent = msTxt;
    });
  }

  function updateLoadDisplay(explicitSectionId = null) {
    const secId = explicitSectionId || getCurrentSectionId();
    const onSim = secId === 'simSection';
    const onMotion = secId === 'motionSection';
    const activeLoad = getLoadForSection(secId);
    const motionOnly = isMotionOnlyLoad(secId);
    const globalLocked = state.consoleLoadActive && state.consoleLoad > 1.01;
    const simUi = (onSim && typeof getSimBlastUiState === 'function')
      ? getSimBlastUiState(state.tSim)
      : { active: false, charging: 0, bursting: 0, burstMs: 0 };
    const autoMotionSpikeMs = (onMotion && typeof getMotionScenarioAutoSpikeMs === 'function')
      ? getMotionScenarioAutoSpikeMs(state.tSim)
      : 0;
    const effectiveSpikeMs = onSim
      ? Math.max(state.simSpikeMs, simUi.burstMs)
      : Math.max(state.simSpikeMs, autoMotionSpikeMs);
    const extraSimMs = (activeLoad - 1.0) * 7.5 + effectiveSpikeMs;
    const sceneMs = getMeanSceneRenderMs(activeLoad, effectiveSpikeMs);
    const tier = getLoadTier(activeLoad, effectiveSpikeMs);

    if (dom.loadPod) {
      dom.loadPod.dataset.tier = tier;
      dom.loadPod.title = motionOnly
        ? 'Motion Scenario Load (local to 01 Motion — refreshes to 1.0 on other sections). Drag slider here to apply Load across all sections.'
        : globalLocked
          ? 'Console Load (inherited by all sections): drag from 1.0 (14 ms) to 5.0 (44 ms). Click reset or double-click slider to return all sections to 1.0.'
          : onSim
            ? 'Console Extra Load (applied across all sections): adds +0.0 ms (1.0) to +30.0 ms (5.0) on top of NPC workload. Double-click slider to reset.'
            : 'Console Load (applies across all sections when adjusted): drag from 1.0 (14 ms) to 5.0 (44 ms). Double-click slider to reset.';
    }

    if (dom.loadScopeTag) {
      if (motionOnly) {
        dom.loadScopeTag.hidden = false;
        dom.loadScopeTag.dataset.scope = 'motion';
        dom.loadScopeTag.textContent = 'Motion';
      } else if (globalLocked) {
        dom.loadScopeTag.hidden = false;
        dom.loadScopeTag.dataset.scope = 'global';
        dom.loadScopeTag.textContent = window.innerWidth <= 820 ? 'Global' : 'All sections';
      } else {
        dom.loadScopeTag.hidden = true;
      }
    }

    if (dom.loadResetBtn) {
      dom.loadResetBtn.hidden = activeLoad <= 1.01 && state.consoleLoad <= 1.01;
    }
    dom.loadVal.textContent = `${activeLoad.toFixed(1)}`;
    dom.loadVal.className = 'load-val mono' + (activeLoad >= 3.0 ? ' high' : activeLoad >= 1.5 ? ' mid' : '');
    dom.loadMs.textContent = onSim
      ? `+${extraSimMs.toFixed(1)} ms`
      : `${sceneMs.toFixed(1)} ms`;
    dom.loadMs.className = 'load-ms mono' + (effectiveSpikeMs > 0.5 ? ' spike' : '');

    if (dom.deskConsoleToggle && dom.deskConsoleLoadTxt) {
      dom.deskConsoleToggle.dataset.tier = tier;
      const tabTxt = motionOnly
        ? `Load ${activeLoad.toFixed(1)} · Motion`
        : globalLocked
          ? `Load ${activeLoad.toFixed(1)} · All`
          : `Load ${activeLoad.toFixed(1)}`;
      if (dom.deskConsoleLoadTxt.textContent !== tabTxt) {
        dom.deskConsoleLoadTxt.textContent = tabTxt;
      }
    }

    if (dom.mobConsoleBtn) {
      const mobTier = (activeLoad > 1.05 || effectiveSpikeMs > 2) ? tier : 'low';
      if (dom.mobConsoleBtn.dataset.loadTier !== mobTier) {
        dom.mobConsoleBtn.dataset.loadTier = mobTier;
      }
    }

    updateSectionLoadPills(simUi);

    const motionPct = Math.max(0, Math.min(100, (state.simSpikeMs / SPIKE_PEAK_MS) * 100));
    const simPct = simUi.bursting > 0.01 ? simUi.bursting * 100 : simUi.charging * 100;
    const spikePct = Math.max(motionPct, simPct);
    dom.explodeBtn.style.setProperty('--spike-pct', `${spikePct.toFixed(1)}%`);
    dom.explodeBtn.classList.toggle('active', state.simSpikeMs > 2.0 || simUi.bursting > 0.08);
  }

  function syncLoadSliderToActiveSection(explicitSectionId = null) {
    const secId = explicitSectionId || getCurrentSectionId();
    const activeLoad = getLoadForSection(secId);
    if (dom.loadSlider) {
      const targetStr = String(activeLoad);
      if (dom.loadSlider.value !== targetStr) {
        dom.loadSlider.value = targetStr;
      }
      syncRangeFill(dom.loadSlider);
    }
    updateLoadDisplay(secId);
  }

  // Motion-only scenario Load setter: updates 01 Motion without altering Console Load for 02-06
  function setMotionScenarioLoad(val) {
    state.motionLoad = Math.max(1, Math.min(5, val));
    if (getCurrentSectionId() === 'motionSection') {
      if (dom.loadSlider) {
        dom.loadSlider.value = String(state.motionLoad);
        syncRangeFill(dom.loadSlider);
      }
      updateLoadDisplay('motionSection');
      if (!isApplyingUrlParams) {
        pulseConsoleLoadIndicators();
      }
    }
    if (isSectionVisible('motionSection')) updateLaneReadouts();
    requestCanvasRedraw();
    scheduleUrlSync();
  }

  // Global Console Load setter: when explicitly adjusted in Console, ALL sections inherit this Load
  function setConsoleLoad(val) {
    const clamped = Math.max(1, Math.min(5, val));
    state.consoleLoad = clamped;
    state.consoleLoadActive = clamped > 1.01;
    state.motionLoad = clamped;
    if (typeof syncMotionScenarioFromLoad === 'function') {
      syncMotionScenarioFromLoad(clamped);
    }
    if (dom.loadSlider) {
      dom.loadSlider.value = String(clamped);
      syncRangeFill(dom.loadSlider);
    }
    updateLoadDisplay();
    if (isSectionVisible('motionSection')) updateLaneReadouts();
    if (typeof updateSimReadouts === 'function') updateSimReadouts();
    if (isSectionVisible('simSection') && typeof drawExpCurve === 'function') drawExpCurve();
    if (typeof onPhysicsSettingChanged === 'function') onPhysicsSettingChanged(false);
    if (typeof updateArenaStaticStats === 'function') updateArenaStaticStats();
    if (isSectionVisible('timelineSection')) drawTimeline();
    if (isSectionVisible('pipelineSection')) updatePipelineView();
    requestCanvasRedraw();
    scheduleUrlSync();
  }

  function triggerExplode() {
    if (typeof markSpikeInteracted === 'function') markSpikeInteracted();
    if (getCurrentSectionId() === 'simSection' && typeof triggerSimNpcExplosion === 'function') {
      // On 02 Simulation, sync the workload spike strictly to the NPC detonation burst (0–950ms charge -> 950–2050ms blast)
      triggerSimNpcExplosion();
      updateLoadDisplay();
      updateSimReadouts();
      drawExpCurve();
      requestCanvasRedraw();
      return;
    }
    // 01 Motion & other sections: preserve original immediate transient load spike
    state.spikeStartSim = state.tSim;
    state.spikeStartReal = performance.now();
    state.simSpikeMs = SPIKE_PEAK_MS;
    state.realSpikeMs = SPIKE_PEAK_MS;
    updateLoadDisplay();
    if (isSectionVisible('motionSection')) updateLaneReadouts();
    if (isSectionVisible('inputSection')) updateArenaStaticStats();
    if (isSectionVisible('timelineSection')) drawTimeline();
    if (isSectionVisible('pipelineSection')) updatePipelineView();
    requestCanvasRedraw();
  }

  function updateSimBanner() {
    if (!state.detectedHz) {
      dom.simBanner.hidden = true;
      return;
    }
    if (state.displayHz === 120 && state.detectedHz < 110 && state.speed === 1) {
      dom.simBanner.hidden = false;
      dom.simBanner.className = 'notice';
      dom.simBanner.innerHTML = `
        <span>
          <strong>Browser cadence ~${state.detectedHz} Hz:</strong> Your browser may not show every simulated 120 Hz refresh at normal speed. Use slow motion to inspect the timing pattern.
        </span>
        <button type="button" id="bannerSlowMoBtn">Switch to 0.25×</button>
      `;
      const btn = document.getElementById('bannerSlowMoBtn');
      if (btn) btn.addEventListener('click', () => setSpeed(0.25));
    } else if (state.speed < 1) {
      dom.simBanner.hidden = false;
      dom.simBanner.className = 'notice info';
      dom.simBanner.innerHTML = `
        <span>
          <strong>0.25× Slow-Mo active:</strong> Quarter-speed playback stretches the simulated ${state.displayHz} Hz pattern (${(state.displayHz * state.speed).toFixed(0)} ticks/s) for frame-by-frame inspection; reported stats remain in simulated time.
        </span>
        <button type="button" id="bannerRealTimeBtn">Return to 1.0×</button>
      `;
      const btn = document.getElementById('bannerRealTimeBtn');
      if (btn) btn.addEventListener('click', () => setSpeed(1));
    } else {
      dom.simBanner.hidden = true;
    }
  }

  function getEffectiveFpsFromHistory(mode) {
    const ls = laneState[mode];
    const hist = ls.ftHistory;
    if (hist.length < 3) {
      const meanDur = getMeanFrameDurMs(mode, state.motionLoad);
      const dispPeriod = 1000 / state.displayHz;
      const effPeriod = Math.ceil((meanDur - 0.01) / dispPeriod) * dispPeriod;
      return Math.min(MODE_META[mode].gameFps, 1000 / effPeriod);
    }
    const recent = hist.slice(-8);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    return Math.min(MODE_META[mode].gameFps, 1000 / avg);
  }

  const laneBadgeNodes = {};

  function setLaneBadges(mode, t0, c0, dropPct, t2, c2, t3, c3) {
    let nodes = laneBadgeNodes[mode];
    if (!nodes) {
      const container = laneMetricsEl[mode];
      container.textContent = '';
      nodes = [0, 1, 2, 3].map(() => {
        const span = document.createElement('span');
        span.className = 'meta-item';
        container.appendChild(span);
        return span;
      });
      laneBadgeNodes[mode] = nodes;
    }
    const roundedDrop = Math.round(dropPct);
    const dropText = roundedDrop < 1 ? 'Target met' : `${roundedDrop}% below target`;
    const dropCls = roundedDrop < 1 ? 'meta-item good' : 'meta-item warn';
    const cls0 = c0 ? `meta-item ${c0}` : 'meta-item';
    const cls2 = c2 ? `meta-item ${c2}` : 'meta-item';
    const cls3 = c3 ? `meta-item ${c3}` : 'meta-item';

    if (nodes[0].textContent !== t0) nodes[0].textContent = t0;
    if (nodes[0].className !== cls0) nodes[0].className = cls0;
    if (nodes[1].textContent !== dropText) nodes[1].textContent = dropText;
    if (nodes[1].className !== dropCls) nodes[1].className = dropCls;
    if (nodes[2].textContent !== t2) nodes[2].textContent = t2;
    if (nodes[2].className !== cls2) nodes[2].className = cls2;
    if (nodes[3].textContent !== t3) nodes[3].textContent = t3;
    if (nodes[3].className !== cls3) nodes[3].className = cls3;
  }

  function setLaneCaption(mode, valText, capText, capCls) {
    const valEl = ftValEl[mode];
    const capEl = ftCapEl[mode];
    if (valEl.textContent !== valText) valEl.textContent = valText;
    if (capEl.textContent !== capText) capEl.textContent = capText;
    if (capEl.className !== capCls) capEl.className = capCls;
  }

  function setLaneTag(mode, text, tone) {
    const tagEl = laneTagEl[mode];
    if (!tagEl) return;
    if (tagEl.textContent !== text) tagEl.textContent = text;
    const cls = tone ? `lane-sim-tag mono ${tone}` : 'lane-sim-tag mono';
    if (tagEl.className !== cls) tagEl.className = cls;
  }

  function updateLaneReadouts() {
    const hz = state.displayHz;
    const is120 = hz === 120;
    const load = state.motionLoad;
    const autoSpikeMs = typeof getMotionScenarioAutoSpikeMs === 'function'
      ? getMotionScenarioAutoSpikeMs(state.tSim)
      : 0;
    const spikeMs = Math.max(state.simSpikeMs, autoSpikeMs);
    const isSpikeScenario = typeof activeMotionScenario === 'number' && activeMotionScenario === 2;
    const underLoad = load > 1.05 || spikeMs > 0.5 || isSpikeScenario;

    // 30 FPS (33.3 ms budget)
    const fps30 = underLoad ? getEffectiveFpsFromHistory('30') : 30.0;
    const avg30 = 1000 / Math.max(1, fps30);
    const dropPct30 = getEfficiencyDropPct(fps30, 30);
    const drop30 = dropPct30 >= 3;
    const midLat30 = Math.round(computeModelLatencyMs('30', hz, load, spikeMs, 0.5));
    setLaneBadges(
      '30',
      `${fps30.toFixed(1)} FPS`, drop30 ? 'warn' : '',
      dropPct30,
      `${avg30.toFixed(1)} ms`, drop30 ? 'warn' : '',
      `Mid-screen: ~${midLat30} ms`, ''
    );
    setLaneCaption(
      '30',
      `${avg30.toFixed(1)} ms`,
      drop30
        ? `${Math.round(dropPct30)}% below target · >33.3 ms`
        : (is120 ? 'Even 4-4-4 cadence' : 'Even 2-2-2 cadence'),
      drop30 ? 'ft-note judder' : 'ft-note'
    );
    setLaneTag(
      '30',
      drop30 ? 'Over budget' : (spikeMs > 2 ? 'Absorbs spike' : 'Within budget'),
      drop30 ? 'warn' : 'good'
    );

    // 40 FPS (25.0 ms budget)
    const fps40 = underLoad ? getEffectiveFpsFromHistory('40') : 40.0;
    const avg40 = 1000 / Math.max(1, fps40);
    const dropPct40 = getEfficiencyDropPct(fps40, 40);
    const drop40 = dropPct40 >= 3;
    const midLat40 = Math.round(computeModelLatencyMs('40', hz, load, spikeMs, 0.5));
    if (!drop40 && is120) {
      setLaneBadges('40', '40.0 FPS', 'good', 0, '25.0 ms', 'good', `Mid-screen: ~${midLat40} ms`, '');
      setLaneCaption('40', '25.0 ms', 'Even 3-refresh cadence', 'ft-note');
      setLaneTag('40', 'Within budget', 'good');
    } else if (!drop40 && !is120) {
      setLaneBadges('40', '40.0 FPS (uneven)', 'warn', 0, '16.7 / 33.3 ms', 'warn', `Mid-screen: ~${midLat40} ms`, '');
      setLaneCaption('40', '16.7 / 33.3 ms', 'Uneven 2–1 cadence (60 Hz)', 'ft-note judder');
      setLaneTag('40', 'Uneven 2–1', 'judder');
    } else {
      setLaneBadges(
        '40',
        `${fps40.toFixed(1)} FPS`, 'warn',
        dropPct40,
        `${avg40.toFixed(1)} ms`, 'warn',
        `Mid-screen: ~${midLat40} ms`, ''
      );
      setLaneCaption('40', `${avg40.toFixed(1)} ms`, `${Math.round(dropPct40)}% below target · >25 ms`, 'ft-note judder');
      setLaneTag('40', spikeMs > 2 ? 'Spike hitch' : 'Over budget', 'warn');
    }

    // 30 FPS + simulated frame interpolation (33.3 ms source budget)
    const interpOutMs = (1000 / hz).toFixed(1);
    const bufLag = Math.round(laneState['interp'].currentLagMs || getInterpBufferLagMs(load));
    const srcFps = Math.min(30, 1000 / Math.max(33.33, laneState['interp'].avgSrcMs || getMeanFrameDurMs('interp', load)));
    const dropPctInterp = getEfficiencyDropPct(srcFps, 30);
    const midLatInterp = Math.round(computeModelLatencyMs('interp', hz, load, spikeMs, 0.5));
    setLaneBadges(
      'interp',
      `${srcFps.toFixed(0)} → ${hz} FPS`, '',
      dropPctInterp,
      `Added buffer: +${bufLag} ms`, 'warn',
      `Mid-screen: ~${midLatInterp} ms`, 'warn'
    );
    setLaneCaption(
      'interp',
      `${interpOutMs} ms (+${bufLag} ms)`,
      dropPctInterp >= 3
        ? `Src ${Math.round(dropPctInterp)}% below target`
        : `${hz} displayed FPS · buffered`,
      dropPctInterp >= 3 ? 'ft-note judder' : 'ft-note'
    );
    setLaneTag(
      'interp',
      dropPctInterp >= 3 ? `Added buffer: +${bufLag} ms · Drops` : `Added buffer: +${bufLag} ms`,
      dropPctInterp >= 3 ? 'warn' : 'interp'
    );

    // 60 FPS (16.7 ms budget)
    const fps60 = underLoad ? getEffectiveFpsFromHistory('60') : 60.0;
    const avg60 = 1000 / Math.max(1, fps60);
    const dropPct60 = getEfficiencyDropPct(fps60, 60);
    const drop60 = dropPct60 >= 3;
    const cls60 = drop60 ? 'warn' : 'good';
    const midLat60 = Math.round(computeModelLatencyMs('60', hz, load, spikeMs, 0.5));
    setLaneBadges(
      '60',
      `${fps60.toFixed(1)} FPS`, cls60,
      dropPct60,
      `${avg60.toFixed(1)} ms`, cls60,
      `Mid-screen: ~${midLat60} ms`, cls60
    );
    setLaneCaption(
      '60',
      `${avg60.toFixed(1)} ms`,
      drop60
        ? `${Math.round(dropPct60)}% below target · >16.7 ms`
        : (is120 ? 'Even 2-2-2 cadence' : 'Even 1-1-1 cadence'),
      drop60 ? 'ft-note judder' : 'ft-note'
    );
    setLaneTag(
      '60',
      drop60 ? (spikeMs > 2 || isSpikeScenario ? 'Spike hitch' : 'Over budget') : 'Within budget',
      drop60 ? 'warn' : 'good'
    );
  }

  // ============================================================================
  // SECTION 1: MOTION SIMULATION WITH LOAD PHYSICS
  // ============================================================================
  function resyncLaneSimulators() {
    const dispPeriod = 1000 / state.displayHz;
    const targetTick = Math.floor((state.tSim + 0.001) / dispPeriod);
    const tNowSim = targetTick * dispPeriod;
    MODES.forEach((mode) => {
      const ls = laneState[mode];
      if (ls.lastDisplayTick >= 0 && targetTick - ls.lastDisplayTick > 12) {
        ls.lastDisplayTick = targetTick - 1;
        ls.holdTicks = 1;
        ls.srcHoldTicks = 1;
        if (mode === 'interp') {
          ls.srcNextReadyTime = tNowSim;
          ls.presentedTime = Math.max(0, tNowSim - ls.currentLagMs);
        } else {
          ls.nextFrameReadyTime = tNowSim;
          ls.presentedTime = tNowSim;
        }
      }
    });
  }

  function stepLaneSimulators() {
    const dispPeriod = 1000 / state.displayHz;
    const targetTick = Math.floor((state.tSim + 0.001) / dispPeriod);

    MODES.forEach((mode) => {
      const ls = laneState[mode];
      if (ls.lastDisplayTick < 0) {
        ls.lastDisplayTick = targetTick - 1;
      }

      const ticksToStep = Math.min(targetTick - ls.lastDisplayTick, 12);
      if (ticksToStep <= 0) return;

      const gamePeriod = MODE_META[mode].periodMs;

      for (let i = 1; i <= ticksToStep; i++) {
        const tick = ls.lastDisplayTick + i;
        const tTick = tick * dispPeriod;
        const manualSpikeMs = state.spikeStartSim >= 0
          ? getSpikeEnvelopeMs(tTick - state.spikeStartSim)
          : 0;
        const autoSpikeMs = typeof getMotionScenarioAutoSpikeMs === 'function'
          ? getMotionScenarioAutoSpikeMs(tTick)
          : 0;
        const tickSpikeMs = Math.max(manualSpikeMs, autoSpikeMs);

        if (mode === 'interp') {
          // Advance underlying 30 FPS source producer under current load
          if (ls.srcFrameSeq === 0) {
            ls.srcFrameSeq = 1;
            ls.srcHoldTicks = 1;
            ls.srcNextReadyTime = Math.max(gamePeriod, getRenderTimeMs('interp', state.motionLoad, 1, tickSpikeMs));
          } else if (tTick + 0.001 >= ls.srcNextReadyTime) {
            const heldMs = ls.srcHoldTicks * dispPeriod;
            ls.avgSrcMs = ls.avgSrcMs * 0.75 + heldMs * 0.25;
            ls.srcFrameSeq++;
            const dur = Math.max(gamePeriod, getRenderTimeMs('interp', state.motionLoad, ls.srcFrameSeq, tickSpikeMs));
            ls.srcNextReadyTime = Math.max(ls.srcNextReadyTime + dur, tTick + dispPeriod * 0.05);
            ls.srcHoldTicks = 1;
          } else {
            ls.srcHoldTicks++;
          }

          // Smoothly track 2-frame optical flow buffer lag
          const targetLag = Math.max(66.7, ls.avgSrcMs * 2);
          ls.currentLagMs += (targetLag - ls.currentLagMs) * 0.12;

          // Under severe source frame drops (> 50 ms source), TV interpolation briefly hiccups
          const hiccup = ls.avgSrcMs > 50 && (tick % 5 === 0);
          if (!hiccup) {
            ls.presentedTime = Math.max(0, tTick - ls.currentLagMs);
            ls.lastPresentedHoldMs = dispPeriod;
            ls.ftHistory.push(dispPeriod);
          } else {
            ls.lastPresentedHoldMs = dispPeriod * 2;
            ls.ftHistory.push(dispPeriod * 2);
          }
          if (ls.ftHistory.length > FT_HISTORY_LEN) ls.ftHistory.shift();
        } else {
          if (ls.frameSeq === 0) {
            ls.frameSeq = 1;
            ls.holdTicks = 1;
            ls.presentedTime = tTick;
            const dur = Math.max(gamePeriod, getRenderTimeMs(mode, state.motionLoad, 1, tickSpikeMs));
            ls.nextFrameReadyTime = tTick + dur;
          } else if (tTick + 0.001 >= ls.nextFrameReadyTime) {
            const heldMs = ls.holdTicks * dispPeriod;
            ls.lastPresentedHoldMs = heldMs;
            ls.ftHistory.push(heldMs);
            if (ls.ftHistory.length > FT_HISTORY_LEN) ls.ftHistory.shift();

            ls.presentedTime = ls.nextFrameReadyTime;
            ls.frameSeq++;
            const dur = Math.max(gamePeriod, getRenderTimeMs(mode, state.motionLoad, ls.frameSeq, tickSpikeMs));
            ls.nextFrameReadyTime = ls.nextFrameReadyTime + dur;
            if (ls.nextFrameReadyTime < tTick) {
              ls.nextFrameReadyTime = tTick + dur;
            }
            ls.holdTicks = 1;
          } else {
            ls.holdTicks++;
          }
        }
      }

      ls.lastDisplayTick = targetTick;
    });
  }

  function drawTestBlock(ctx, x, y, color, ghostStrength) {
    const bw = 64;
    const bh = 36;
    const left = x - bw / 2;
    const top = y - bh / 2;

    if (ghostStrength > 0) {
      const spread = 8 + ghostStrength * 14;
      ctx.fillStyle = `rgba(167, 139, 250, ${Math.min(0.42, 0.18 + ghostStrength * 0.18)})`;
      ctx.fillRect(left - spread, top - 3, bw + spread * 2, bh + 6);
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.28, 0.12 + ghostStrength * 0.12)})`;
      ctx.fillRect(left + 12, top - 6, 18 + ghostStrength * 10, 6);
      ctx.fillRect(left - 6, top + bh, 22 + ghostStrength * 12, 5);
    }

    ctx.fillStyle = '#1e2330';
    ctx.fillRect(left, top, bw, bh);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(left + 0.5, top + 0.5, bw - 1, bh - 1);

    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(left + 10, top + 7, 4, bh - 14);
    ctx.fillRect(left + 20, top + 7, 4, bh - 14);
    ctx.fillRect(left + 30, top + 7, 4, bh - 14);

    ctx.fillStyle = color;
    ctx.fillRect(left + bw - 8, top + 4, 4, bh - 8);
  }

  function drawLane(mode) {
    const canvas = laneCanvases[mode];
    const { ctx, w, h } = setupCanvas(canvas);
    const ls = laneState[mode];
    const color = TRACK_COLORS[mode];

    const tSec = ls.presentedTime / 1000;
    const trueSec = state.tSim / 1000;
    const pxPerSec = state.panSpeed;

    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, w, h);

    // Subtle top indicator during transient Explode spike
    if (state.simSpikeMs > 0.5) {
      const ratio = Math.min(1, state.simSpikeMs / SPIKE_PEAK_MS);
      ctx.fillStyle = `rgba(217, 72, 72, ${0.22 + ratio * 0.55})`;
      ctx.fillRect(0, 0, w * ratio, 2);
      ctx.fillStyle = `rgba(248, 113, 113, ${0.45 + ratio * 0.5})`;
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`SPIKE +${Math.round(state.simSpikeMs)} ms`, w - 10, 9);
    }

    const cy = Math.round(h * 0.54);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();

    const tickSpacing = 120;
    const tickOffset = (tSec * pxPerSec * 0.5) % tickSpacing;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    for (let px = w - tickOffset; px > -10; px -= tickSpacing) {
      ctx.fillRect(Math.round(px), 10, 1, h - 20);
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    for (let rx = 60; rx < w; rx += 60) {
      const maj = rx % 120 === 0 ? 5 : 3;
      ctx.fillRect(rx, 0, 1, maj);
      ctx.fillRect(rx, h - maj, 1, maj);
    }

    const span = w + 100;
    const blockX = ((tSec * pxPerSec) % span) - 50;

    const hudW = 118;
    const hudH = 20;
    const isNarrowInterp = mode === 'interp' && w < 540;
    const isDesktopInterp = mode === 'interp' && w >= 540 && w < 720;
    const hudX = isDesktopInterp
      ? Math.round(w * 0.59 - hudW / 2)
      : Math.round(w * 0.5 - hudW / 2);
    const hudY = isNarrowInterp ? Math.max(9, h - hudH - 6) : 9;
    const nearHud = Math.abs(blockX - (hudX + hudW / 2)) < 95;
    const showArt = mode === 'interp' && state.showArtifacts;

    // Artifacts intensify as base 30 FPS drops under heavy load
    const loadSeverity = Math.max(0, (state.motionLoad - 1.5) / 3.5);
    const ghostStrength = showArt && (nearHud || loadSeverity > 0.25)
      ? (nearHud ? 0.6 + loadSeverity : loadSeverity * 0.7)
      : 0;

    drawTestBlock(ctx, blockX, cy, color, ghostStrength);

    ctx.save();
    if (showArt) {
      const jitter = Math.sin(tSec * 40) * (2 + loadSeverity * 4);
      ctx.fillStyle = `rgba(167, 139, 250, ${0.22 + loadSeverity * 0.18})`;
      ctx.fillRect(hudX + jitter - 2, hudY - 2, hudW + 4, hudH + 4);
    }
    ctx.fillStyle = '#181c26';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.fillRect(hudX, hudY, hudW, hudH);
    ctx.strokeRect(hudX + 0.5, hudY + 0.5, hudW - 1, hudH - 1);

    ctx.fillStyle = '#9ca3af';
    ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(showArt ? 'OVERLAY · HALO' : 'STATIC OVERLAY', hudX + hudW / 2, hudY + hudH / 2 + 0.5);
    ctx.restore();

    if (state.showTruePos) {
      const trueX = ((trueSec * pxPerSec) % span) - 50;
      const leadX = trueX + 32;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(leadX, 6);
      ctx.lineTo(leadX, h - 6);
      ctx.stroke();
      ctx.setLineDash([]);

      if (mode === 'interp') {
        const lagPx = trueX - blockX;
        if (lagPx > 4 && lagPx < 360) {
          ctx.fillStyle = 'rgba(167, 139, 250, 0.18)';
          ctx.fillRect(blockX + 32, cy - 18, lagPx, 36);
          ctx.fillStyle = '#d8b4fe';
          ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`-${Math.round(ls.currentLagMs)} ms`, blockX + 36, cy - 24);
        }
      }
      ctx.restore();
    }
  }

  function drawFrametimeGraph(mode) {
    const canvas = ftCanvases[mode];
    const { ctx, w, h } = setupCanvas(canvas);
    const ls = laneState[mode];
    const color = LIGHT_COLORS[mode];

    ctx.clearRect(0, 0, w, h);

    const hist = ls.ftHistory;
    let peak = 35;
    for (let i = 0; i < hist.length; i++) {
      if (hist[i] > peak) peak = hist[i];
    }
    const maxMs = Math.max(42, Math.ceil(peak / 10) * 10 + 6);
    const padBottom = 4;
    const usableH = h - padBottom - 4;

    // Reference lines: 16.7 ms, 33.3 ms (and 50 ms if expanded)
    const refs = maxMs > 52 ? [16.67, 33.33, 50] : [16.67, 25, 33.33];
    refs.forEach((refMs) => {
      const y = Math.round(h - padBottom - (refMs / maxMs) * usableH) + 0.5;
      ctx.strokeStyle = '#e2e5eb';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    });

    if (hist.length === 0) return;

    const barGap = 2;
    const barW = Math.max(2, (w - barGap * (FT_HISTORY_LEN - 1)) / FT_HISTORY_LEN);
    const startX = w - hist.length * (barW + barGap);
    const targetPeriod = MODE_META[mode].periodMs;
    const is40Judder = mode === '40' && state.displayHz === 60;

    hist.forEach((ms, i) => {
      const clamped = Math.min(ms, maxMs);
      const barH = Math.max(2, (clamped / maxMs) * usableH);
      const x = startX + i * (barW + barGap);
      const y = h - padBottom - barH;

      if (mode !== 'interp' && ms > targetPeriod + 4) {
        ctx.fillStyle = '#d94848'; // missed budget spike
      } else if (is40Judder) {
        ctx.fillStyle = ms > 25 ? '#d94848' : '#d97706';
      } else {
        ctx.fillStyle = color;
      }
      ctx.fillRect(x, y, barW, barH);
    });
  }

  // ============================================================================
  // SECTION 2: INTERACTIVE INPUT LATENCY PAD (LOAD-AWARE)
  // ============================================================================
  const arena = {
    pointerActive: false,
    trueX: 520,
    trueY: 180,
    history: [],
    pendingClicks: [],
    flashes: [],
    lastDispTick: -1,
    frameSeq: 0,
    nextFrameReadyTime: 0,
    renderedX: 520,
    renderedY: 180,
    shots: 0,
    hits: 0,
    targetX: 520,
    targetY: 180,
    targetRadius: 22
  };

  function samplePointerAt(targetTime) {
    const h = arena.history;
    if (h.length === 0) return { x: arena.trueX, y: arena.trueY };
    if (targetTime <= h[0].t) return { x: h[0].x, y: h[0].y };
    if (targetTime >= h[h.length - 1].t) return { x: h[h.length - 1].x, y: h[h.length - 1].y };

    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= targetTime && h[i].t >= targetTime) {
        const span = h[i].t - h[i - 1].t;
        const alpha = span > 0.001 ? (targetTime - h[i - 1].t) / span : 0;
        return {
          x: h[i - 1].x + (h[i].x - h[i - 1].x) * alpha,
          y: h[i - 1].y + (h[i].y - h[i - 1].y) * alpha
        };
      }
    }
    return { x: arena.trueX, y: arena.trueY };
  }

  function getArenaLagConfig(mode) {
    const is120 = state.displayHz === 120;
    const load = state.consoleLoad;
    const spikeMs = state.realSpikeMs;
    const meanDur = getMeanFrameDurMs(mode, load, spikeMs);
    const effFps = Math.min(MODE_META[mode].gameFps, 1000 / meanDur);
    const dropping = effFps < MODE_META[mode].gameFps - 1;

    const dropPct = Math.round(getEfficiencyDropPct(effFps, MODE_META[mode].gameFps));

    if (mode === 'interp') {
      const srcDur = getMeanFrameDurMs('interp', load, spikeMs);
      const bufLag = srcDur * 2;
      const totalDelay = srcDur + bufLag + 18;
      const srcFps = Math.min(30, 1000 / srcDur);
      const srcDropPct = Math.round(getEfficiencyDropPct(srcFps, 30));
      return {
        label: '30 FPS + simulated frame interpolation',
        pipelineDelayMs: totalDelay,
        estLagText: `~${Math.round(totalDelay)}–${Math.round(totalDelay + 18)} ms`,
        visualText: srcDropPct > 0
          ? `${srcFps.toFixed(0)} source FPS → ${state.displayHz} displayed FPS (-${srcDropPct}%)`
          : `30 source FPS → ${state.displayHz} displayed FPS`,
        pacingText: srcDropPct > 0 ? 'Elevated buffer delay' : 'Smooth visual, buffered',
        status: 'warn'
      };
    }

    const totalLow = Math.round(meanDur * 1.5);
    const totalHigh = Math.round(meanDur * 2.0);

    if (mode === '60') {
      return {
        label: '60 FPS',
        pipelineDelayMs: meanDur,
        estLagText: `~${totalLow}–${totalHigh} ms`,
        visualText: dropping ? `${effFps.toFixed(0)} FPS (${dropPct}% below target)` : '60 FPS (Target met)',
        pacingText: dropping ? 'Over 16.7 ms budget' : (is120 ? 'Even (2-2-2)' : 'Even (1-1-1)'),
        status: dropping ? 'warn' : 'good'
      };
    }
    if (mode === '40') {
      return {
        label: '40 FPS',
        pipelineDelayMs: meanDur,
        estLagText: `~${totalLow}–${totalHigh} ms`,
        visualText: dropping ? `${effFps.toFixed(0)} FPS (${dropPct}% below target)` : (is120 ? '40 FPS (Target met)' : '40 FPS (Target met, 2–1)'),
        pacingText: dropping ? 'Over 25.0 ms budget' : (is120 ? 'Even (3-3-3)' : 'Uneven 2–1 cadence'),
        status: (dropping || !is120) ? 'warn' : 'good'
      };
    }
    return {
      label: '30 FPS',
      pipelineDelayMs: meanDur,
      estLagText: `~${totalLow}–${totalHigh} ms`,
      visualText: dropping ? `${effFps.toFixed(0)} FPS (${dropPct}% below target)` : '30 FPS (Target met)',
      pacingText: dropping ? 'Over 33.3 ms budget' : (is120 ? 'Even (4-4-4)' : 'Even (2-2-2)'),
      status: dropping ? 'warn' : 'good'
    };
  }

  function updateArenaStaticStats() {
    const cfg = getArenaLagConfig(state.arenaMode);
    dom.arenaStatMode.textContent = cfg.label;
    dom.arenaStatLag.textContent = cfg.estLagText;
    dom.arenaStatLag.className = `metric-val ${cfg.status}`;
    dom.arenaStatVisual.textContent = cfg.visualText;
    dom.arenaStatPacing.textContent = cfg.pacingText;
    dom.arenaStatScore.textContent = `${arena.hits} / ${arena.shots}`;
  }

  function getTargetPos(tNow, w, h) {
    const s = tNow / 1000;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const rx = Math.min(w * 0.36, 330);
    const ry = Math.min(h * 0.3, 104);
    return {
      x: cx + Math.sin(s * 1.45) * rx,
      y: cy + Math.sin(s * 2.9) * ry * 0.72
    };
  }

  function updateAndDrawArena(tNow) {
    const { ctx, w, h } = setupCanvas(dom.arenaCanvas);
    const mode = state.arenaMode;
    const dispPeriod = 1000 / state.displayHz;
    const tick = Math.floor((state.tRealSynced + 0.001) / dispPeriod);

    while (arena.history.length > 2 && tNow - arena.history[0].t > 800) {
      arena.history.shift();
    }

    const cfg = getArenaLagConfig(mode);

    if (tick !== arena.lastDispTick) {
      arena.lastDispTick = tick;
      const tTick = tick * dispPeriod;

      if (mode === 'interp') {
        const srcPeriod = getMeanFrameDurMs('interp', state.consoleLoad);
        const delayedT = tNow - cfg.pipelineDelayMs;
        const kIdx = Math.floor(delayedT / srcPeriod);
        const tK0 = kIdx * srcPeriod;
        const tK1 = (kIdx + 1) * srcPeriod;
        const alpha = Math.max(0, Math.min(1, (delayedT - tK0) / srcPeriod));

        const p0 = samplePointerAt(tK0);
        const p1 = samplePointerAt(tK1);
        arena.renderedX = p0.x + (p1.x - p0.x) * alpha;
        arena.renderedY = p0.y + (p1.y - p0.y) * alpha;

        const tp = getTargetPos(tNow - cfg.pipelineDelayMs, w, h);
        arena.targetX = tp.x;
        arena.targetY = tp.y;
      } else {
        const gamePeriod = MODE_META[mode].periodMs;
        if (arena.nextFrameReadyTime === 0 || Math.abs(tTick - arena.nextFrameReadyTime) > 500) {
          arena.nextFrameReadyTime = tTick;
        }
        if (tTick + 0.001 >= arena.nextFrameReadyTime) {
          arena.frameSeq++;
          const sampled = samplePointerAt(tNow - cfg.pipelineDelayMs);
          arena.renderedX = sampled.x;
          arena.renderedY = sampled.y;

          const tp = getTargetPos(tNow, w, h);
          arena.targetX = tp.x;
          arena.targetY = tp.y;

          const dur = Math.max(gamePeriod, getRenderTimeMs(mode, state.consoleLoad, arena.frameSeq, state.realSpikeMs));
          arena.nextFrameReadyTime += dur;
          if (arena.nextFrameReadyTime < tTick) {
            arena.nextFrameReadyTime = tTick + dur;
          }
        }
      }
    }

    for (let i = arena.pendingClicks.length - 1; i >= 0; i--) {
      const c = arena.pendingClicks[i];
      if (tNow >= c.releaseT) {
        arena.pendingClicks.splice(i, 1);
        arena.shots++;
        const dx = arena.renderedX - arena.targetX;
        const dy = arena.renderedY - arena.targetY;
        const hit = Math.hypot(dx, dy) <= arena.targetRadius + 6;
        if (hit) arena.hits++;
        arena.flashes.push({ x: arena.renderedX, y: arena.renderedY, t: tNow, hit });
        dom.arenaStatScore.textContent = `${arena.hits} / ${arena.shots}`;
      }
    }

    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, w, h);

    // Subtle top indicator during transient Explode spike
    if (state.simSpikeMs > 0.5) {
      const ratio = Math.min(1, state.simSpikeMs / SPIKE_PEAK_MS);
      ctx.fillStyle = `rgba(217, 72, 72, ${0.22 + ratio * 0.55})`;
      ctx.fillRect(0, 0, w * ratio, 2);
      ctx.fillStyle = `rgba(248, 113, 113, ${0.45 + ratio * 0.5})`;
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`SPIKE +${Math.round(state.simSpikeMs)} ms`, w - 10, 9);
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    const gridStep = 40;
    ctx.beginPath();
    for (let gx = gridStep; gx < w; gx += gridStep) {
      ctx.moveTo(gx + 0.5, 0);
      ctx.lineTo(gx + 0.5, h);
    }
    for (let gy = gridStep; gy < h; gy += gridStep) {
      ctx.moveTo(0, gy + 0.5);
      ctx.lineTo(w, gy + 0.5);
    }
    ctx.stroke();

    const tx = arena.targetX;
    const ty = arena.targetY;
    const r = arena.targetRadius;

    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(tx, ty, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx - r - 6, ty); ctx.lineTo(tx - r + 4, ty);
    ctx.moveTo(tx + r - 4, ty); ctx.lineTo(tx + r + 6, ty);
    ctx.moveTo(tx, ty - r - 6); ctx.lineTo(tx, ty - r + 4);
    ctx.moveTo(tx, ty + r - 4); ctx.lineTo(tx, ty + r + 6);
    ctx.stroke();

    ctx.fillStyle = '#e5e7eb';
    ctx.beginPath();
    ctx.arc(tx, ty, 2.5, 0, Math.PI * 2);
    ctx.fill();

    for (let i = arena.flashes.length - 1; i >= 0; i--) {
      const f = arena.flashes[i];
      const age = tNow - f.t;
      if (age > 300) {
        arena.flashes.splice(i, 1);
        continue;
      }
      const alpha = 1 - age / 300;
      const rad = 8 + (age / 300) * 24;
      ctx.strokeStyle = f.hit
        ? `rgba(16, 185, 129, ${alpha})`
        : `rgba(239, 83, 80, ${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(f.x, f.y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }

    const modeColor = TRACK_COLORS[mode];

    if (state.showGhostCursor && arena.pointerActive) {
      const dist = Math.hypot(arena.trueX - arena.renderedX, arena.trueY - arena.renderedY);
      if (dist > 3) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(arena.trueX, arena.trueY);
        ctx.lineTo(arena.renderedX, arena.renderedY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.beginPath();
      ctx.arc(arena.trueX, arena.trueY, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.textAlign = 'left';
      ctx.fillText('OS POINTER', arena.trueX + 8, arena.trueY - 12);

      if (dist > 18) {
        const mx = (arena.trueX + arena.renderedX) * 0.5;
        const my = (arena.trueY + arena.renderedY) * 0.5;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(mx - 26, my - 9, 52, 16);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '700 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.round(dist)} px lag`, mx, my + 2.5);
      }
    }

    const cx = arena.renderedX;
    const cy = arena.renderedY;

    ctx.save();
    ctx.strokeStyle = modeColor;
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - 20, cy); ctx.lineTo(cx - 7, cy);
    ctx.moveTo(cx + 7, cy);  ctx.lineTo(cx + 20, cy);
    ctx.moveTo(cx, cy - 20); ctx.lineTo(cx, cy - 7);
    ctx.moveTo(cx, cy + 7);  ctx.lineTo(cx, cy + 20);
    ctx.stroke();

    ctx.fillStyle = modeColor;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(cfg.label.toUpperCase(), cx + 17, cy + 18);
    ctx.restore();
  }

  // ============================================================================
  // SECTION 3: REFRESH CYCLE TIMELINE (HTML/CSS RENDERER, LOAD-AWARE)
  // ============================================================================
  let lastTimelineKey = '';

  function drawTimeline() {
    if (!dom.timelineBoard) return;
    const hz = state.displayHz;
    const load = state.consoleLoad;
    const spikeMs = state.simSpikeMs;
    const sceneMs = getMeanSceneRenderMs(load, spikeMs);
    if (dom.timelineHzText) {
      dom.timelineHzText.textContent = hz === 120
        ? `120 Hz = 8.33 ms · Scene ${sceneMs.toFixed(1)} ms (Load level ${load.toFixed(1)})`
        : `60 Hz = 16.67 ms · Scene ${sceneMs.toFixed(1)} ms (Load level ${load.toFixed(1)})`;
    }
    const key = `${hz}|${load.toFixed(1)}|${Math.round(spikeMs)}`;
    if (key === lastTimelineKey) return;
    lastTimelineKey = key;

    const dispPeriod = 1000 / hz;
    const totalMs = 100;
    const numTicks = Math.round(totalMs / dispPeriod);

    // Axis tick labels & gridlines
    let tickLabelsHtml = '';
    let gridlinesHtml = '';
    for (let i = 0; i <= numTicks; i++) {
      const ms = i * dispPeriod;
      if (ms > totalMs + 0.5) break;
      const pct = Math.min(100, (ms / totalMs) * 100);
      gridlinesHtml += `<span class="tl-gridline" style="--p:${pct.toFixed(3)}%;left:${pct.toFixed(3)}%"></span>`;
      if (hz === 60 || i % 2 === 0) {
        const edgeCls = i === 0 ? ' is-start' : (pct >= 99.5 ? ' is-end' : '');
        tickLabelsHtml += `<span class="tl-tick-lbl${edgeCls}" style="--p:${pct.toFixed(3)}%;left:${pct.toFixed(3)}%">${ms.toFixed(0)} ms</span>`;
      }
    }

    const bufLagMs = getInterpBufferLagMs(load, spikeMs);
    const estDrop = (m) => {
      const meanDur = getMeanFrameDurMs(m, load, spikeMs);
      const effFps = Math.min(MODE_META[m].gameFps, 1000 / meanDur);
      return Math.round(getEfficiencyDropPct(effFps, MODE_META[m].gameFps));
    };

    const d30 = estDrop('30');
    const d40 = estDrop('40');
    const d60 = estDrop('60');

    const rows = [
      { mode: '30', label: '30 FPS', sub: d30 > 0 ? `${d30}% below target (33.3 ms)` : 'Target met · 33.3 ms' },
      {
        mode: '40',
        label: '40 FPS',
        sub: d40 > 0
          ? `${d40}% below target (25.0 ms)`
          : (hz === 120 ? 'Target met · even 25.0 ms' : 'Uneven · 33.3 / 16.7 ms')
      },
      { mode: 'interp', label: '30 + Interp', sub: `Added buffer +${Math.round(bufLagMs)} ms${d30 > 0 ? ` (${d30}% below)` : ''}` },
      { mode: '60', label: '60 FPS', sub: d60 > 0 ? `${d60}% below target (16.7 ms)` : 'Target met · 16.7 ms' }
    ];

    let html = `
      <div class="tl-axis-row">
        <div class="tl-axis-label">Display (${hz} Hz)</div>
        <div class="tl-axis-ticks">${tickLabelsHtml}</div>
      </div>
    `;

    rows.forEach((row) => {
      const overBudget = row.mode !== 'interp' && getMeanFrameDurMs(row.mode, load, spikeMs) > MODE_META[row.mode].periodMs + 0.5;
      const subWarn = overBudget || (row.mode === '40' && hz === 60) || (row.mode === 'interp' && d30 > 0);
      let blocksHtml = '';

      if (row.mode === 'interp') {
        const clampedBuf = Math.min(bufLagMs, totalMs);
        const bufPct = (clampedBuf / totalMs) * 100;
        const bufFull = bufLagMs >= totalMs
          ? `BUFFER DELAY (~${Math.round(bufLagMs)} ms) — exceeds 100 ms window`
          : `BUFFER DELAY (~${Math.round(bufLagMs)} ms) — waiting for Frame B`;
        const bufShort = `BUFFER (~${Math.round(bufLagMs)} ms)`;
        blocksHtml += `<div class="tl-block interp-buf" style="--p:0%;--s:${bufPct.toFixed(3)}%;left:0%;width:calc(${bufPct.toFixed(3)}% - 3px)" title="${bufFull}"><span class="tl-txt"><span class="tl-full">${bufFull}</span><span class="tl-short">${bufShort}</span></span></div>`;

        let t = bufLagMs;
        let k = 0;
        while (t < totalMs - 0.5) {
          const nextT = Math.min(totalMs, t + dispPeriod);
          const startPct = (t / totalMs) * 100;
          const widthPct = ((nextT - t) / totalMs) * 100;
          const isReal = k % (hz === 120 ? 4 : 2) === 0;
          const cls = isReal ? 'interp-real' : 'interp-fake';
          const lbl = widthPct >= 7 ? (isReal ? 'REAL' : 'INT') : '';
          const tip = isReal ? 'Real rendered source frame' : 'Synthesized interpolated frame';
          blocksHtml += `<div class="tl-block ${cls}" style="--p:${startPct.toFixed(3)}%;--s:${widthPct.toFixed(3)}%;left:calc(${startPct.toFixed(3)}% + 1.5px);width:calc(${widthPct.toFixed(3)}% - 3px)" title="${tip}">${lbl}</div>`;
          t += dispPeriod;
          k++;
        }
      } else {
        const gamePeriod = MODE_META[row.mode].periodMs;
        const segments = [];
        let frameNum = 1;
        let nextReady = Math.max(gamePeriod, getRenderTimeMs(row.mode, load, 1, spikeMs));
        let segStartTick = 0;

        for (let tick = 1; tick < numTicks; tick++) {
          const tTick = tick * dispPeriod;
          if (tTick + 0.001 >= nextReady) {
            segments.push({
              frameNum,
              startMs: segStartTick * dispPeriod,
              endMs: tick * dispPeriod,
              ticks: tick - segStartTick
            });
            frameNum++;
            segStartTick = tick;
            nextReady += Math.max(gamePeriod, getRenderTimeMs(row.mode, load, frameNum, spikeMs));
          }
        }
        segments.push({
          frameNum,
          startMs: segStartTick * dispPeriod,
          endMs: Math.min(totalMs, numTicks * dispPeriod),
          ticks: numTicks - segStartTick
        });

        segments.forEach((seg) => {
          const endClamped = Math.min(seg.endMs, totalMs);
          const startPct = (seg.startMs / totalMs) * 100;
          const widthPct = ((endClamped - seg.startMs) / totalMs) * 100;
          const durMs = seg.endMs - seg.startMs;

          const missedBudget = durMs > gamePeriod + 4;
          const isJudderLong = row.mode === '40' && hz === 60 && seg.ticks === 2;
          const isJudderShort = row.mode === '40' && hz === 60 && seg.ticks === 1;

          let cls = `mode-${row.mode}`;
          if (missedBudget) cls = 'is-missed';
          else if (isJudderLong) cls = 'is-judder-long';
          else if (isJudderShort) cls = 'is-judder-short';

          const isNarrow = widthPct < 24;
          const innerHtml = widthPct >= 24
            ? `<span class="tl-txt">F${seg.frameNum}<span class="tl-dur"> (${durMs.toFixed(1)} ms)</span></span>`
            : (widthPct >= 7 ? `<span class="tl-txt">F${seg.frameNum}</span>` : '');
          const tip = `Frame F${seg.frameNum} · ${durMs.toFixed(1)} ms (${seg.ticks} refresh${seg.ticks === 1 ? '' : 'es'})`;
          blocksHtml += `<div class="tl-block ${cls}${isNarrow ? ' is-narrow' : ''}" tabindex="0" role="note" aria-label="${tip}" data-tip="${tip}" style="--p:${startPct.toFixed(3)}%;--s:${widthPct.toFixed(3)}%;left:calc(${startPct.toFixed(3)}% + 2px);width:calc(${widthPct.toFixed(3)}% - 4px)" title="${tip}">${innerHtml}</div>`;
        });
      }

      html += `
        <div class="tl-row" data-row-mode="${row.mode}">
          <div class="tl-row-head">
            <div class="tl-row-title"><span class="swatch swatch-${row.mode}"></span><span>${row.label}</span></div>
            <div class="tl-row-sub${subWarn ? ' warn' : ''}">${row.sub}</div>
          </div>
          <div class="tl-track">
            ${gridlinesHtml}
            ${blocksHtml}
          </div>
        </div>
      `;
    });

    dom.timelineBoard.innerHTML = html;
  }

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================
  dom.remeasureBtn.addEventListener('click', () => detectRefreshRate(false));
  dom.btn60Hz.addEventListener('click', () => setDisplayHz(60));
  dom.btn120Hz.addEventListener('click', () => setDisplayHz(120));
  dom.btnSpeed1x.addEventListener('click', () => setSpeed(1));
  dom.btnSpeedSlow.addEventListener('click', () => setSpeed(0.25));

  function syncRangeFill(input) {
    if (!input) return;
    const min = parseFloat(input.min) || 0;
    const max = parseFloat(input.max) || 100;
    const val = parseFloat(input.value) || min;
    const pct = ((val - min) / Math.max(0.001, max - min)) * 100;
    input.style.setProperty('--range-pct', `${pct.toFixed(1)}%`);
  }

  dom.loadSlider.addEventListener('pointerdown', () => {
    if (typeof markLoadInteracted === 'function') markLoadInteracted();
  });

  dom.loadSlider.addEventListener('input', (e) => {
    if (typeof markLoadInteracted === 'function') markLoadInteracted();
    syncRangeFill(dom.loadSlider);
    setConsoleLoad(parseFloat(e.target.value));
  });

  dom.loadSlider.addEventListener('change', () => {
    const cur = state.consoleLoad;
    if (cur > 1.01) {
      showLoadStatusToast(`Console Load ${cur.toFixed(1)} inherited by all sections`, getLoadTier(cur, 0));
    } else if (lastCommittedConsoleLoad > 1.01) {
      showLoadStatusToast('↺ Load reset to 1.0 across all sections', 'info');
    }
    lastCommittedConsoleLoad = cur;
  });

  dom.loadSlider.addEventListener('dblclick', () => {
    if (typeof markLoadInteracted === 'function') markLoadInteracted();
    const hadElevated = state.consoleLoad > 1.01 || state.motionLoad > 1.01;
    dom.loadSlider.value = '1';
    syncRangeFill(dom.loadSlider);
    setConsoleLoad(1.0);
    lastCommittedConsoleLoad = 1.0;
    if (hadElevated) {
      showLoadStatusToast('↺ Load reset to 1.0 across all sections', 'info');
    }
  });

  if (dom.loadResetBtn) {
    dom.loadResetBtn.addEventListener('click', () => {
      if (typeof markLoadInteracted === 'function') markLoadInteracted();
      const hadElevated = state.consoleLoad > 1.01 || state.motionLoad > 1.01;
      dom.loadSlider.value = '1';
      syncRangeFill(dom.loadSlider);
      setConsoleLoad(1.0);
      lastCommittedConsoleLoad = 1.0;
      if (hadElevated) {
        showLoadStatusToast('↺ Load reset to 1.0 across all sections', 'info');
      }
    });
  }

  dom.secLoadBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (window.fpsLabConsole && typeof window.fpsLabConsole.open === 'function') {
        window.fpsLabConsole.open();
      }
      syncLoadSliderToActiveSection();
      setTimeout(() => {
        if (dom.loadSlider) {
          try {
            dom.loadSlider.focus({ preventScroll: true });
          } catch (_) {
            dom.loadSlider.focus();
          }
        }
        if (dom.loadPod) {
          dom.loadPod.classList.remove('is-heartbeat');
          void dom.loadPod.offsetWidth;
          dom.loadPod.classList.add('is-heartbeat');
          setTimeout(() => {
            if (dom.loadPod) dom.loadPod.classList.remove('is-heartbeat');
          }, 1050);
        }
      }, 60);
    });
  });

  let initialNavSettled = false;
  setTimeout(() => { initialNavSettled = true; }, 450);

  window.addEventListener('fpslab:section-changed', (e) => {
    const nextId = e && e.detail && e.detail.id ? e.detail.id : getCurrentSectionId();
    const prevId = activeSectionId;
    const prevLoad = getLoadForSection(prevId);
    if (nextId) activeSectionId = nextId;
    const nextLoad = getLoadForSection(activeSectionId);
    syncLoadSliderToActiveSection(activeSectionId);

    if (initialNavSettled && !isApplyingUrlParams && prevId !== activeSectionId && Math.abs(nextLoad - prevLoad) >= 0.05) {
      if (activeSectionId !== 'motionSection' && nextLoad <= 1.01) {
        showLoadStatusToast('↺ Load refreshed to 1.0 · Open Load to stress-test this section', 'info');
        pulseConsoleLoadIndicators();
        pulseSectionLoadPills(activeSectionId);
      } else if (activeSectionId !== 'motionSection' && state.consoleLoadActive && nextLoad > 1.01) {
        showLoadStatusToast(`Console Load ${nextLoad.toFixed(1)} active across all sections`, getLoadTier(nextLoad, 0));
        pulseConsoleLoadIndicators();
        pulseSectionLoadPills(activeSectionId);
      } else if (activeSectionId === 'motionSection' && nextLoad > 1.01) {
        const scMs = getMeanSceneRenderMs(nextLoad).toFixed(1);
        showLoadStatusToast(`Scenario ${activeMotionScenario} Load active (${nextLoad.toFixed(1)} · ${scMs} ms)`, getLoadTier(nextLoad, 0));
        pulseConsoleLoadIndicators();
      }
    }
  });

  const mobConsoleToggleEl = document.getElementById('mobileConsoleToggle');
  if (mobConsoleToggleEl) {
    mobConsoleToggleEl.addEventListener('change', () => {
      if (mobConsoleToggleEl.checked) syncLoadSliderToActiveSection();
    });
  }
  const deskConsoleToggleEl = document.getElementById('desktopConsoleToggle');
  if (deskConsoleToggleEl) {
    deskConsoleToggleEl.addEventListener('click', () => {
      syncLoadSliderToActiveSection();
    });
  }

  function togglePause() {
    state.paused = !state.paused;
    if (dom.pauseLbl) {
      dom.pauseLbl.textContent = state.paused ? 'Resume' : 'Pause';
    } else {
      dom.pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
    }
    dom.pauseBtn.classList.toggle('is-paused', state.paused);
    requestCanvasRedraw();
    scheduleUrlSync();
  }

  dom.explodeBtn.addEventListener('click', () => {
    triggerExplode();
  });

  // Keyboard shortcuts: 'S' for Load Spike, 'P' for Pause / Resume
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      triggerExplode();
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      togglePause();
    }
  });

  dom.toggleTruePos.addEventListener('change', (e) => {
    state.showTruePos = e.target.checked;
    requestCanvasRedraw();
    scheduleUrlSync();
  });

  dom.toggleArtifacts.addEventListener('change', (e) => {
    state.showArtifacts = e.target.checked;
    requestCanvasRedraw();
    scheduleUrlSync();
  });

  dom.pauseBtn.addEventListener('click', () => {
    togglePause();
  });

  dom.panSpeedSlider.addEventListener('input', (e) => {
    syncRangeFill(dom.panSpeedSlider);
    const v = Number(e.target.value);
    state.panSpeed = v;
    dom.panSpeedLabel.textContent = `${v} px/s`;
    requestCanvasRedraw();
    scheduleUrlSync();
  });

  syncRangeFill(dom.loadSlider);
  syncRangeFill(dom.panSpeedSlider);

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.arenaMode = btn.dataset.arenaMode;
      arena.nextFrameReadyTime = 0;
      arena.shots = 0;
      arena.hits = 0;
      updateArenaStaticStats();
      scheduleUrlSync();
    });
  });

  dom.toggleGhostCursor.addEventListener('change', (e) => {
    state.showGhostCursor = e.target.checked;
    scheduleUrlSync();
  });

  dom.toggleHideOSCursor.addEventListener('change', (e) => {
    state.hideOSCursor = e.target.checked;
    dom.arenaCanvas.classList.toggle('hide-cursor', state.hideOSCursor);
    scheduleUrlSync();
  });

  function recordPointer(clientX, clientY) {
    const rect = dom.arenaCanvas.getBoundingClientRect();
    const uiScale = getCanvasHiResScale();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left)) / uiScale;
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top)) / uiScale;
    arena.trueX = x;
    arena.trueY = y;
    arena.pointerActive = true;
    arena.history.push({ t: performance.now(), x, y });
    dom.arenaHint.classList.add('hidden');
  }

  dom.arenaCanvas.addEventListener('pointermove', (e) => {
    recordPointer(e.clientX, e.clientY);
  });

  dom.arenaCanvas.addEventListener('pointerdown', (e) => {
    recordPointer(e.clientX, e.clientY);
    const now = performance.now();
    const cfg = getArenaLagConfig(state.arenaMode);
    arena.pendingClicks.push({
      clickT: now,
      releaseT: now + cfg.pipelineDelayMs
    });
  });

  // ============================================================================
  // SECTION 2 (VIEW 02): EXPONENTIAL SIMULATION LOAD (PLAYER + WHITE NPCs)
  // ============================================================================
  const SIM_MAX_NPCS = 200;
  const SIM_SHAPES = ['dot', 'rect', 'tri'];
  const SIM_BLAST_CHARGE_MS = 950;
  const SIM_BLAST_BURST_MS = 1100;
  const SIM_BLAST_RESPAWN_MS = 320;
  const SIM_BLAST_TOTAL_MS = SIM_BLAST_CHARGE_MS + SIM_BLAST_BURST_MS + SIM_BLAST_RESPAWN_MS;
  const SIM_SHARD_COLORS = ['#ef4444', '#f97316', '#fbbf24', '#fef08a', '#dc2626'];
  const simNpcBlasts = new Map();
  let simBlastNonce = 1;

  function triggerSimNpcExplosion() {
    const npcCount = getSimEntityCount(state.simLevel);
    const targetCount = Math.max(1, Math.round(npcCount * 0.2));
    const candidates = [];
    for (let i = 0; i < npcCount; i++) {
      const existing = simNpcBlasts.get(i);
      if (!existing || state.tSim - existing.startSimMs >= SIM_BLAST_TOTAL_MS) {
        candidates.push(i);
      }
    }
    if (!candidates.length) return;

    // Fisher-Yates shuffle to pick 20% of active NPCs randomly
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = candidates[i];
      candidates[i] = candidates[j];
      candidates[j] = tmp;
    }

    const chosen = candidates.slice(0, Math.min(targetCount, candidates.length));
    const startSimMs = state.tSim;
    const detSec = (startSimMs + SIM_BLAST_CHARGE_MS) / 1000;

    chosen.forEach((idx) => {
      const seed = (simBlastNonce++ * 2654435761) >>> 0;
      const rng = createSeededRng(seed);
      const shardCount = 9 + Math.floor(rng() * 4);
      const shards = [];
      for (let s = 0; s < shardCount; s++) {
        const baseAngle = (s / shardCount) * Math.PI * 2;
        const angle = baseAngle + (rng() - 0.5) * 0.55;
        shards.push({
          angle,
          dist: 16 + rng() * 26,
          size: 1.5 + rng() * 2.4,
          color: SIM_SHARD_COLORS[Math.floor(rng() * SIM_SHARD_COLORS.length)],
          isSpark: rng() > 0.55
        });
      }
      simNpcBlasts.set(idx, {
        startSimMs,
        detSec,
        seed: rng() * Math.PI * 2,
        shards
      });
    });
  }

  function pruneSimNpcBlasts() {
    if (!simNpcBlasts.size) return;
    // Keep entries slightly past total duration so lagged interp arena completes respawn cleanly
    const expireAfter = SIM_BLAST_TOTAL_MS + 350;
    simNpcBlasts.forEach((blast, idx) => {
      if (state.tSim - blast.startSimMs > expireAfter) {
        simNpcBlasts.delete(idx);
      }
    });
  }

  function getSimDestroyedCount(npcCount) {
    if (!simNpcBlasts.size) return 0;
    let destroyed = 0;
    simNpcBlasts.forEach((blast, idx) => {
      if (idx >= npcCount) return;
      const elapsed = state.tSim - blast.startSimMs;
      if (elapsed >= SIM_BLAST_CHARGE_MS && elapsed < SIM_BLAST_CHARGE_MS + SIM_BLAST_BURST_MS) {
        destroyed++;
      }
    });
    return destroyed;
  }

  function getSimBlastEnvelope(burstElapsed) {
    if (burstElapsed < 0 || burstElapsed >= SIM_BLAST_BURST_MS) return 0;
    const u = burstElapsed / SIM_BLAST_BURST_MS;
    if (u < 0.06) return u / 0.06;
    if (u < 0.72) return 1.0 - 0.14 * ((u - 0.06) / 0.66);
    const tail = 1 - (u - 0.72) / 0.28;
    return 0.86 * Math.pow(Math.max(0, tail), 1.6);
  }

  // Calibrated per-level explosion headroom deltas:
  // At Load=1.0, L1 (12.0ms + 19.4 = 31.4ms) and L2 (18.2ms + 13.4 = 31.6ms) stay strictly under 33.3ms (30 FPS locked)
  // while oscillating across 16.7ms (60 FPS) & 25.0ms (40 FPS). At L3+ (27.7ms + 14.5 = 42.2ms), 30 FPS finally breaks too.
  function getSimBlastDeltaBounds(level) {
    if (level <= 2.0) {
      const t = Math.max(0, Math.min(1, level - 1.0));
      return {
        floorDelta: 3.6 - 0.4 * t,
        peakDelta: 19.4 - 6.0 * t
      };
    }
    const t = Math.max(0, Math.min(1, level - 2.0));
    return {
      floorDelta: 3.2 + 2.3 * t,
      peakDelta: 13.4 + 1.1 * t
    };
  }

  function getSimBlastMaxEnv(tMs) {
    if (!simNpcBlasts.size) return 0;
    let maxEnv = 0;
    simNpcBlasts.forEach((blast) => {
      const env = getSimBlastEnvelope(tMs - (blast.startSimMs + SIM_BLAST_CHARGE_MS));
      if (env > maxEnv) maxEnv = env;
    });
    return maxEnv;
  }

  function getSimBlastWorkloadMs(tMs, frameSeq, level) {
    const env = getSimBlastMaxEnv(tMs);
    if (env <= 0.001) return 0;
    const { floorDelta, peakDelta } = getSimBlastDeltaBounds(level);
    // Deterministic bursty frame-to-frame oscillation so 60/40 FPS visibly hitch across V-Sync boundaries
    // while 30 FPS clamps every frame <= 33.3ms to an even, locked cadence
    const wave01 = 0.5 + 0.5 * Math.sin(frameSeq * 2.15 + 0.4);
    const burst = floorDelta + (peakDelta - floorDelta) * wave01;
    return burst * env;
  }

  function getSimBlastMeanSpikeMs(tMs, level) {
    const env = getSimBlastMaxEnv(tMs);
    if (env <= 0.001) return 0;
    const { floorDelta, peakDelta } = getSimBlastDeltaBounds(level);
    return (floorDelta + (peakDelta - floorDelta) * 0.62) * env;
  }

  function getSimBlastCurvePeakMs(tMs, level) {
    const env = getSimBlastMaxEnv(tMs);
    if (env <= 0.001) return 0;
    const { peakDelta } = getSimBlastDeltaBounds(level);
    return peakDelta * env;
  }

  function getSimBlastUiState(tMs) {
    let charging = 0;
    let bursting = 0;
    let active = false;
    let inDetonation = false;
    simNpcBlasts.forEach((blast) => {
      const elapsed = tMs - blast.startSimMs;
      if (elapsed >= 0 && elapsed < SIM_BLAST_TOTAL_MS) {
        active = true;
        if (elapsed < SIM_BLAST_CHARGE_MS) {
          const c = elapsed / SIM_BLAST_CHARGE_MS;
          if (c > charging) charging = c;
        } else if (elapsed < SIM_BLAST_CHARGE_MS + SIM_BLAST_BURST_MS) {
          inDetonation = true;
          const b = 1 - (elapsed - SIM_BLAST_CHARGE_MS) / SIM_BLAST_BURST_MS;
          if (b > bursting) bursting = b;
        }
      }
    });
    const burstMs = inDetonation ? getSimBlastMeanSpikeMs(tMs, state.simLevel) : 0;
    return { active, inDetonation, charging, bursting, burstMs };
  }

  // Deterministic PRNG so all 4 FPS areas share the exact same world & entity count
  function createSeededRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  const simNpcs = [];
  {
    const rng = createSeededRng(42071);
    for (let i = 0; i < SIM_MAX_NPCS; i++) {
      const speed = 0.08 + rng() * 0.16;
      const dir = rng() * Math.PI * 2;
      simNpcs.push({
        x0: 0.06 + rng() * 0.88,
        y0: 0.08 + rng() * 0.84,
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        size: 3.2 + rng() * 2.8,
        angle0: rng() * Math.PI * 2,
        vAngle: (rng() - 0.5) * 2.4,
        shape: SIM_SHAPES[i % 3]
      });
    }
  }

  function pingPong(val, min, max) {
    const span = max - min;
    const mod = (((val - min) % (span * 2)) + span * 2) % (span * 2);
    return mod <= span ? min + mod : max - (mod - span);
  }

  // Exponential entity count: Level 1 -> 8, 2 -> 18, 3 -> 40, 4 -> 89, 5 -> 200
  function getSimEntityCount(level) {
    return Math.min(SIM_MAX_NPCS, Math.max(8, Math.round(8 * Math.pow(2.236, level - 1))));
  }

  // Extra GPU/CPU cost from the Console Load level slider (0 ms at 1.0 → +30 ms at 5.0)
  function getTopBarExtraLoadMs() {
    return (state.consoleLoad - 1.0) * 7.5;
  }

  // Exponential frame cost + Console Load level + Explode spike
  function getSimMeanRenderMs(level, spikeMs = 0) {
    return 12.0 * Math.pow(1.52, level - 1) + getTopBarExtraLoadMs() + spikeMs;
  }

  function getSimRenderTimeMs(level, frameSeq, spikeMs = 0) {
    const base = 12.0 * Math.pow(1.52, level - 1) + getTopBarExtraLoadMs();
    if (level <= 1.01 && state.consoleLoad <= 1.001 && spikeMs <= 0.01) return base;
    const varAmp = Math.min(0.07, Math.max(0, (Math.max(level, state.consoleLoad) - 1) * 0.03));
    const wave = 0.65 * Math.sin(frameSeq * 1.73) + 0.35 * Math.cos(frameSeq * 0.61);
    return base * (1 + varAmp * wave) + spikeMs;
  }

  const simState = {};
  function initSimArenaState() {
    simNpcBlasts.clear();
    MODES.forEach((m) => {
      simState[m] = {
        lastDisplayTick: -1,
        frameSeq: 0,
        nextFrameReadyTime: 0,
        holdTicks: 0,
        presentedTime: 0,
        ftHistory: [],
        ftOverBudget: [],
        pendingOverBudget: false,
        srcFrameSeq: 0,
        srcNextReadyTime: 0,
        srcHoldTicks: 0,
        avgSrcMs: 1000 / 30,
        currentLagMs: (1000 / 30) * 2
      };
    });
  }
  initSimArenaState();

  function resyncSimArenas() {
    const dispPeriod = 1000 / state.displayHz;
    const targetTick = Math.floor((state.tSim + 0.001) / dispPeriod);
    const tNowSim = targetTick * dispPeriod;
    MODES.forEach((mode) => {
      const ss = simState[mode];
      if (ss.lastDisplayTick >= 0 && targetTick - ss.lastDisplayTick > 12) {
        ss.lastDisplayTick = targetTick - 1;
        ss.holdTicks = 1;
        ss.srcHoldTicks = 1;
        if (mode === 'interp') {
          ss.srcNextReadyTime = tNowSim;
          ss.presentedTime = Math.max(0, tNowSim - ss.currentLagMs);
        } else {
          ss.nextFrameReadyTime = tNowSim;
          ss.presentedTime = tNowSim;
        }
      }
    });
  }

  function stepSimArenas() {
    if (!dom.expCurveCanvas) return;
    pruneSimNpcBlasts();
    const dispPeriod = 1000 / state.displayHz;
    const targetTick = Math.floor((state.tSim + 0.001) / dispPeriod);

    MODES.forEach((mode) => {
      const ss = simState[mode];
      if (ss.lastDisplayTick < 0) ss.lastDisplayTick = targetTick - 1;

      const ticksToStep = Math.min(targetTick - ss.lastDisplayTick, 12);
      if (ticksToStep <= 0) return;

      const gamePeriod = MODE_META[mode].periodMs;

      for (let i = 1; i <= ticksToStep; i++) {
        const tick = ss.lastDisplayTick + i;
        const tTick = tick * dispPeriod;
        const baseSpikeMs = state.spikeStartSim >= 0
          ? getSpikeEnvelopeMs(tTick - state.spikeStartSim)
          : 0;

        if (mode === 'interp') {
          if (ss.srcFrameSeq === 0) {
            ss.srcFrameSeq = 1;
            ss.srcHoldTicks = 1;
            const tickSpikeMs = Math.max(baseSpikeMs, getSimBlastWorkloadMs(tTick, 1, state.simLevel));
            ss.srcNextReadyTime = Math.max(gamePeriod, getSimRenderTimeMs(state.simLevel, 1, tickSpikeMs));
          } else if (tTick + 0.001 >= ss.srcNextReadyTime) {
            const heldMs = ss.srcHoldTicks * dispPeriod;
            ss.avgSrcMs = ss.avgSrcMs * 0.75 + heldMs * 0.25;
            ss.srcFrameSeq++;
            const tickSpikeMs = Math.max(baseSpikeMs, getSimBlastWorkloadMs(tTick, ss.srcFrameSeq, state.simLevel));
            const dur = Math.max(gamePeriod, getSimRenderTimeMs(state.simLevel, ss.srcFrameSeq, tickSpikeMs));
            ss.srcNextReadyTime = Math.max(ss.srcNextReadyTime + dur, tTick + dispPeriod * 0.05);
            ss.srcHoldTicks = 1;
          } else {
            ss.srcHoldTicks++;
          }

          const targetLag = Math.max(66.7, ss.avgSrcMs * 2);
          ss.currentLagMs += (targetLag - ss.currentLagMs) * 0.12;
          const hiccup = ss.avgSrcMs > 46 && (tick % 4 === 0);
          if (!hiccup) {
            ss.presentedTime = Math.max(0, tTick - ss.currentLagMs);
            ss.ftHistory.push(dispPeriod);
          } else {
            ss.ftHistory.push(dispPeriod * 2);
          }
          ss.ftOverBudget.push(hiccup || ss.avgSrcMs > 35.0);
          if (ss.ftHistory.length > 24) ss.ftHistory.shift();
          if (ss.ftOverBudget.length > 24) ss.ftOverBudget.shift();
        } else {
          if (ss.frameSeq === 0) {
            ss.frameSeq = 1;
            ss.holdTicks = 1;
            ss.presentedTime = tTick;
            const tickSpikeMs = Math.max(baseSpikeMs, getSimBlastWorkloadMs(tTick, 1, state.simLevel));
            const renderMs = getSimRenderTimeMs(state.simLevel, 1, tickSpikeMs);
            ss.pendingOverBudget = renderMs > gamePeriod + 0.5;
            ss.nextFrameReadyTime = tTick + Math.max(gamePeriod, renderMs);
          } else if (tTick + 0.001 >= ss.nextFrameReadyTime) {
            const heldMs = ss.holdTicks * dispPeriod;
            ss.ftHistory.push(heldMs);
            ss.ftOverBudget.push(!!ss.pendingOverBudget);
            if (ss.ftHistory.length > 24) ss.ftHistory.shift();
            if (ss.ftOverBudget.length > 24) ss.ftOverBudget.shift();

            ss.presentedTime = ss.nextFrameReadyTime;
            ss.frameSeq++;
            const tickSpikeMs = Math.max(baseSpikeMs, getSimBlastWorkloadMs(tTick, ss.frameSeq, state.simLevel));
            const renderMs = getSimRenderTimeMs(state.simLevel, ss.frameSeq, tickSpikeMs);
            ss.pendingOverBudget = renderMs > gamePeriod + 0.5;
            const dur = Math.max(gamePeriod, renderMs);
            ss.nextFrameReadyTime = ss.nextFrameReadyTime + dur;
            if (ss.nextFrameReadyTime < tTick) {
              ss.nextFrameReadyTime = tTick + dur;
            }
            ss.holdTicks = 1;
          } else {
            ss.holdTicks++;
          }
        }
      }

      ss.lastDisplayTick = targetTick;
    });
  }

  function drawSimNpcShape(ctx, shape, r) {
    if (shape === 'dot') {
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2);
      ctx.fill();
    } else if (shape === 'rect') {
      ctx.fillRect(-r * 0.8, -r * 0.8, r * 1.6, r * 1.6);
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.05);
      ctx.lineTo(r * 0.95, r * 0.85);
      ctx.lineTo(-r * 0.95, r * 0.85);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawSimArena(mode) {
    const canvas = simCanvases[mode];
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(canvas);
    const ss = simState[mode];
    const presentedMs = ss.presentedTime;
    const tSec = presentedMs / 1000;
    const npcCount = getSimEntityCount(state.simLevel);

    ctx.fillStyle = '#11141c';
    ctx.fillRect(0, 0, w, h);

    // Subtle grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
    ctx.lineWidth = 1;
    const step = 36;
    ctx.beginPath();
    for (let x = step; x < w; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = step; y < h; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    // Player position (Lissajous patrol) + proximity interaction radius
    const px = (0.5 + 0.34 * Math.sin(tSec * 1.25)) * w;
    const py = (0.5 + 0.30 * Math.sin(tSec * 1.85 + 0.6)) * h;
    const proxRadius = 38;

    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, proxRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();

    // Draw identical count of white NPCs (dots, rects, triangles), handling Load Spike blasts
    for (let i = 0; i < npcCount; i++) {
      const n = simNpcs[i];
      const nx = pingPong(n.x0 + n.vx * tSec, 0.04, 0.96) * w;
      const ny = pingPong(n.y0 + n.vy * tSec, 0.06, 0.94) * h;
      const r = n.size;
      const blast = simNpcBlasts.get(i);
      const elapsed = blast ? presentedMs - blast.startSimMs : -1;

      if (blast && elapsed >= 0 && elapsed < SIM_BLAST_TOTAL_MS) {
        if (elapsed < SIM_BLAST_CHARGE_MS) {
          // Phase 1: Turn red, grow slowly, and shake with escalating intensity
          const p = elapsed / SIM_BLAST_CHARGE_MS;
          const scale = 1 + 1.25 * Math.pow(p, 1.3);
          const shakeAmp = Math.pow(p, 1.75) * 5.2;
          const freq = 24 + p * 38;
          const sx = Math.sin(elapsed * 0.001 * freq * Math.PI * 2 + blast.seed) * shakeAmp;
          const sy = Math.cos(elapsed * 0.001 * (freq * 1.27) * Math.PI * 2 + blast.seed * 1.7) * shakeAmp;
          const bx = nx + sx;
          const by = ny + sy;
          const cT = Math.min(1, p * 2.8);
          const cr = Math.round(241 + (239 - 241) * cT);
          const cg = Math.round(245 + (52 - 245) * cT);
          const cb = Math.round(249 + (52 - 249) * cT);

          // Growing danger aura
          ctx.beginPath();
          ctx.arc(bx, by, r * scale * 1.7, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(239, 68, 68, ${(0.14 + p * 0.36).toFixed(3)})`;
          ctx.fill();

          ctx.save();
          ctx.translate(bx, by);
          if (n.shape !== 'dot') ctx.rotate(n.angle0 + n.vAngle * tSec);
          ctx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
          drawSimNpcShape(ctx, n.shape, r * scale);

          // Overheat core flicker right before detonation
          if (p > 0.72) {
            const flicker = 0.45 + 0.55 * Math.sin(elapsed * 0.065 + blast.seed);
            ctx.beginPath();
            ctx.arc(0, 0, r * scale * 0.42, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(254, 240, 138, ${((p - 0.72) / 0.28 * flicker).toFixed(3)})`;
            ctx.fill();
          }
          ctx.restore();
          continue;
        }

        if (elapsed < SIM_BLAST_CHARGE_MS + SIM_BLAST_BURST_MS) {
          // Phase 2: Destroyed NPC explodes into vanishing debris particles
          const bp = (elapsed - SIM_BLAST_CHARGE_MS) / SIM_BLAST_BURST_MS;
          const detX = pingPong(n.x0 + n.vx * blast.detSec, 0.04, 0.96) * w;
          const detY = pingPong(n.y0 + n.vy * blast.detSec, 0.06, 0.94) * h;

          // Brief detonation core flash
          if (bp < 0.22) {
            const fa = 1 - bp / 0.22;
            ctx.beginPath();
            ctx.arc(detX, detY, r * (1.8 + bp * 6), 0, Math.PI * 2);
            ctx.fillStyle = `rgba(254, 226, 226, ${(fa * 0.85).toFixed(3)})`;
            ctx.fill();
          }

          // Expanding shockwave ring
          if (bp < 0.56) {
            const rp = bp / 0.56;
            ctx.beginPath();
            ctx.arc(detX, detY, r * (1.5 + rp * 6.5), 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(239, 68, 68, ${((1 - rp) * 0.75).toFixed(3)})`;
            ctx.lineWidth = Math.max(0.8, 2.2 * (1 - rp));
            ctx.stroke();
          }

          // Radial vanishing particles
          const easeOut = 1 - Math.pow(1 - bp, 2.3);
          const pAlpha = Math.max(0, 1 - Math.pow(bp, 1.35));
          ctx.save();
          // Optical-flow motion-smoothing ghost trails behind fast-moving shards on Interp arena
          if (mode === 'interp' && state.showArtifacts) {
            const ghostEase = Math.max(0, easeOut * 0.72);
            ctx.globalAlpha = pAlpha * 0.42;
            ctx.fillStyle = '#a78bfa';
            for (let s = 0; s < blast.shards.length; s++) {
              const sh = blast.shards[s];
              const gxS = detX + Math.cos(sh.angle) * (sh.dist * ghostEase);
              const gyS = detY + Math.sin(sh.angle) * (sh.dist * ghostEase);
              const gSz = Math.max(1.2, sh.size * 1.15);
              ctx.beginPath();
              ctx.arc(gxS, gyS, gSz, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          ctx.globalAlpha = pAlpha;
          for (let s = 0; s < blast.shards.length; s++) {
            const sh = blast.shards[s];
            const dist = sh.dist * easeOut;
            const pxS = detX + Math.cos(sh.angle) * dist;
            const pyS = detY + Math.sin(sh.angle) * dist;
            const sz = Math.max(0.6, sh.size * (1 - bp * 0.58));
            ctx.fillStyle = sh.color;
            if (sh.isSpark) {
              ctx.save();
              ctx.translate(pxS, pyS);
              ctx.rotate(sh.angle);
              ctx.fillRect(-sz * 1.15, -sz * 0.45, sz * 2.3, sz * 0.9);
              ctx.restore();
            } else {
              ctx.beginPath();
              ctx.arc(pxS, pyS, sz, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          ctx.restore();
          continue;
        }

        // Phase 3: Recreate destroyed NPC in its default form
        const rp = (elapsed - SIM_BLAST_CHARGE_MS - SIM_BLAST_BURST_MS) / SIM_BLAST_RESPAWN_MS;
        const popScale = 0.2 + 0.8 * (1 - Math.pow(1 - rp, 2.5));
        const nearPlayer = Math.hypot(nx - px, ny - py) <= proxRadius;

        ctx.beginPath();
        ctx.arc(nx, ny, r * (1.2 + rp * 2.2), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(241, 245, 249, ${((1 - rp) * 0.45).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.save();
        ctx.globalAlpha = Math.min(1, rp * 1.45);
        ctx.translate(nx, ny);
        if (n.shape !== 'dot') ctx.rotate(n.angle0 + n.vAngle * tSec);
        ctx.fillStyle = nearPlayer ? '#fde047' : 'rgba(241, 245, 249, 0.88)';
        drawSimNpcShape(ctx, n.shape, r * popScale);
        ctx.restore();
        continue;
      }

      const nearPlayer = Math.hypot(nx - px, ny - py) <= proxRadius;
      ctx.fillStyle = nearPlayer ? '#fde047' : 'rgba(241, 245, 249, 0.88)';

      if (n.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(nx, ny, r * 0.78, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(nx, ny);
        ctx.rotate(n.angle0 + n.vAngle * tSec);
        drawSimNpcShape(ctx, n.shape, r);
        ctx.restore();
      }
    }

    // Subtle interpolation artifact ghost when load is heavy
    if (mode === 'interp' && state.showArtifacts && state.simLevel >= 2.4) {
      const prevT = Math.max(0, tSec - 0.045);
      const gx = (0.5 + 0.34 * Math.sin(prevT * 1.25)) * w;
      const gy = (0.5 + 0.30 * Math.sin(prevT * 1.85 + 0.6)) * h;
      ctx.beginPath();
      ctx.arc(gx, gy, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(167, 139, 250, 0.35)';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(px, py, 9.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.38)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#facc15';
    ctx.fill();

    // Transient top-left detonation verdict pill inside each arena during explosion burst
    const blastEnv = getSimBlastMaxEnv(presentedMs);
    if (blastEnv > 0.04) {
      const overHist = ss.ftOverBudget;
      const recentLen = Math.min(6, overHist ? overHist.length : 0);
      let recentOver = 0;
      for (let k = (overHist ? overHist.length : 0) - recentLen; k < (overHist ? overHist.length : 0); k++) {
        if (k >= 0 && overHist[k]) recentOver++;
      }
      const isNarrow = w < 220;
      let pillText = '';
      let pillBg = '';
      if (mode === 'interp') {
        const srcDropped = ss.avgSrcMs > 35.0;
        pillBg = srcDropped ? 'rgba(217, 119, 6, 0.92)' : 'rgba(124, 58, 237, 0.9)';
        pillText = isNarrow
          ? (srcDropped ? 'LAG SPIKE' : 'HALO')
          : (srcDropped ? `LAG SPIKE · +${Math.round(ss.currentLagMs)} ms` : `HALO · +${Math.round(ss.currentLagMs)} ms`);
      } else if (recentOver > 0) {
        pillBg = 'rgba(220, 38, 38, 0.92)';
        pillText = isNarrow ? 'STUTTER' : 'BUDGET MISSED · STUTTER';
      } else {
        pillBg = 'rgba(5, 150, 105, 0.92)';
        pillText = isNarrow ? 'LOCKED' : 'LOCKED · 0% DROP';
      }

      ctx.save();
      ctx.globalAlpha = Math.min(1, blastEnv * 2.2);
      ctx.font = isNarrow
        ? '700 8.5px ui-monospace, SFMono-Regular, Menlo, monospace'
        : '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const tw = ctx.measureText(pillText).width;
      const pxPad = isNarrow ? 5 : 7;
      const ph = isNarrow ? 15 : 18;
      const pw = tw + pxPad * 2;
      const rx = 6;
      const ry = 6;
      const rad = 4;

      ctx.fillStyle = pillBg;
      ctx.beginPath();
      ctx.moveTo(rx + rad, ry);
      ctx.lineTo(rx + pw - rad, ry);
      ctx.quadraticCurveTo(rx + pw, ry, rx + pw, ry + rad);
      ctx.lineTo(rx + pw, ry + ph - rad);
      ctx.quadraticCurveTo(rx + pw, ry + ph, rx + pw - rad, ry + ph);
      ctx.lineTo(rx + rad, ry + ph);
      ctx.quadraticCurveTo(rx, ry + ph, rx, ry + ph - rad);
      ctx.lineTo(rx, ry + rad);
      ctx.quadraticCurveTo(rx, ry, rx + rad, ry);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(pillText, rx + pxPad, ry + ph / 2 + 0.5);
      ctx.restore();
    }
  }

  const SIM_SCENARIOS = [
    {
      title: 'Light Workload',
      impact: 'All targets within budget',
      tier: 'low',
      desc: 'A light scene illustrates low frame cost—leaving headroom inside the 16.7 ms (60 FPS), 25.0 ms (40 FPS), and 33.3 ms (30 FPS) budgets.'
    },
    {
      title: 'Moderate Workload',
      impact: '60 FPS over budget',
      tier: 'mid',
      desc: 'Increased modeled cost pushes past 16.7 ms so 60 FPS falls below target, while 40 FPS (25.0 ms) and 30 FPS (33.3 ms) remain within budget.'
    },
    {
      title: 'Heavy Workload',
      impact: 'Only 30 FPS within budget',
      tier: 'warn',
      desc: 'Heavier modeled cost crosses both 16.7 ms and 25.0 ms—leaving only the 30 FPS (33.3 ms) target within its frame budget.'
    },
    {
      title: 'Overloaded Workload',
      impact: 'All targets below target',
      tier: 'high',
      desc: 'Modeled frame cost exceeds 33.3 ms—so every native target falls below its rate while simulated interpolation latency climbs.'
    },
    {
      title: 'Dense Scene Overload',
      impact: 'Severe overload',
      tier: 'high',
      desc: 'A dense scene illustrates the effect of increased simulation workload; the displayed frame cost comes from the lab’s exponential workload model.'
    }
  ];

  let lastAnnouncedSimLvl = -1;
  let simUpdateTimer = null;

  function triggerSimFooterPulse() {
    if (!dom.simFooterCard) return;
    dom.simFooterCard.classList.remove('is-updating');
    // Force reflow so rapid level clicks replay the sheen & pop cleanly
    void dom.simFooterCard.offsetWidth;
    dom.simFooterCard.classList.add('is-updating');
    clearTimeout(simUpdateTimer);
    simUpdateTimer = setTimeout(() => {
      dom.simFooterCard.classList.remove('is-updating');
    }, 540);
  }

  function updateSimReadouts() {
    if (!dom.simLevelVal) return;
    const lvl = state.simLevel;
    const blastMeanSpikeMs = getSimBlastMeanSpikeMs(state.tSim, lvl);
    const cost = getSimMeanRenderMs(lvl, Math.max(state.simSpikeMs, blastMeanSpikeMs));
    const count = getSimEntityCount(lvl);
    const liveCount = Math.max(0, count - getSimDestroyedCount(count));
    const inDetonation = getSimBlastMaxEnv(state.tSim) > 0.04;

    dom.simLevelVal.textContent = lvl.toFixed(1);
    dom.simLevelVal.className = 'sim-kpi-val mono' + (cost > 33.3 ? ' high' : cost > 16.7 ? ' mid' : '');
    dom.simEntityVal.textContent = String(liveCount);
    dom.simCostVal.textContent = `${cost.toFixed(1)} ms`;
    dom.simCostVal.className = 'sim-kpi-val mono' + (cost > 33.3 ? ' high' : cost > 16.7 ? ' mid' : '');

    if (dom.expCurveWrap) {
      dom.expCurveWrap.setAttribute('aria-valuenow', lvl.toFixed(1));
    }

    const nearestLvl = Math.round(lvl);
    simLevelBtns.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.simLevel) === nearestLvl);
    });
    simScenarioBtns.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.simLevel) === nearestLvl);
    });
    simCostPills.forEach((pill) => {
      const pLvl = Number(pill.dataset.simCostPill);
      if (pLvl >= 1 && pLvl <= 5) {
        pill.textContent = `${getSimEntityCount(pLvl)} NPCs · ${getSimMeanRenderMs(pLvl).toFixed(1)} ms`;
      }
    });

    if (dom.simFooterCard && dom.simScenarioLvlTxt && dom.simScenarioTitle && dom.simScenarioDesc) {
      const sc = SIM_SCENARIOS[Math.max(0, Math.min(4, nearestLvl - 1))];
      const extraTop = getTopBarExtraLoadMs();
      const tier = cost > 33.3 ? 'high' : cost > 25.0 ? 'warn' : cost > 16.7 ? 'mid' : sc.tier;
      dom.simFooterCard.dataset.tier = tier;
      dom.simScenarioLvlTxt.textContent = `LEVEL ${nearestLvl}`;
      dom.simScenarioTitle.textContent = sc.title;
      dom.simScenarioDesc.textContent = extraTop > 0.5
        ? `${sc.desc} (+${extraTop.toFixed(1)} ms added from Console Load ${state.consoleLoad.toFixed(1)}.)`
        : sc.desc;
      if (dom.simImpactTag) {
        dom.simImpactTag.textContent = cost > 33.3
          ? (nearestLvl >= 5 ? 'Severe overload' : 'All targets below target')
          : cost > 25.0 ? 'Only 30 FPS within budget'
          : cost > 16.7 ? '60 FPS over budget'
          : sc.impact;
      }
      if (dom.simMeterBars) {
        dom.simMeterBars.forEach((bar, i) => bar.classList.toggle('is-lit', i < nearestLvl));
      }
      if (lastAnnouncedSimLvl !== -1 && lastAnnouncedSimLvl !== nearestLvl) {
        triggerSimFooterPulse();
      }
      lastAnnouncedSimLvl = nearestLvl;
    }

    MODES.forEach((m) => {
      const el = simStatEls[m];
      const areaEl = simAreaEls[m];
      if (!el) return;
      const ss = simState[m];
      const overHist = ss.ftOverBudget || [];
      const recentOverCount = overHist.slice(-6).filter(Boolean).length;

      if (m === 'interp') {
        const srcFps = Math.min(30, 1000 / Math.max(33.33, ss.avgSrcMs));
        const dropPct = Math.round(getEfficiencyDropPct(srcFps, 30));
        const lag = Math.round(ss.currentLagMs);
        el.textContent = dropPct > 2
          ? `${srcFps.toFixed(0)} → ${state.displayHz} FPS · +${lag} ms`
          : `30 → ${state.displayHz} FPS · +${lag} ms`;
        el.title = `${srcFps.toFixed(0)} source FPS → ${state.displayHz} displayed FPS · Added model buffer: about ${lag} ms`;
        el.className = 'sim-area-stat mono' + (dropPct > 2 ? ' warn' : '');
        if (areaEl) {
          areaEl.classList.toggle('is-blast-interp', inDetonation);
          areaEl.classList.remove('is-blast-locked', 'is-blast-stutter');
        }
      } else {
        const hist = ss.ftHistory;
        let fps = MODE_META[m].gameFps;
        if (hist.length >= 3) {
          const recent = hist.slice(-8);
          const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
          fps = Math.min(MODE_META[m].gameFps, 1000 / avg);
        } else {
          const eff = Math.max(MODE_META[m].periodMs, cost);
          fps = Math.min(MODE_META[m].gameFps, 1000 / eff);
        }
        const dropPct = Math.round(getEfficiencyDropPct(fps, MODE_META[m].gameFps));
        el.textContent = `${fps.toFixed(1)} FPS · ${dropPct >= 2 ? `${dropPct}% below target` : 'Target met'}`;
        el.className = 'sim-area-stat mono' + (dropPct >= 2 ? ' warn' : ' good');
        if (areaEl) {
          const isStutter = inDetonation && (recentOverCount > 0 || dropPct >= 2);
          areaEl.classList.toggle('is-blast-stutter', isStutter);
          areaEl.classList.toggle('is-blast-locked', inDetonation && !isStutter);
          areaEl.classList.remove('is-blast-interp');
        }
      }
    });
  }

  function drawExpCurve() {
    if (!dom.expCurveCanvas) return;
    const { ctx, w, h } = setupCanvas(dom.expCurveCanvas);
    ctx.clearRect(0, 0, w, h);

    const padL = 16;
    const padR = 16;
    const padT = 16;
    const padB = 26;
    const cw = Math.max(10, w - padL - padR);
    const ch = Math.max(10, h - padT - padB);
    const maxMs = Math.max(68, Math.ceil((getSimMeanRenderMs(5) + 4) / 10) * 10);

    const lvlToX = (l) => padL + ((l - 1) / 4) * cw;
    const msToY = (ms) => padT + ch - (Math.min(ms, maxMs) / maxMs) * ch;

    // Vertical level guides (1..5)
    for (let l = 1; l <= 5; l++) {
      const x = Math.round(lvlToX(l)) + 0.5;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + ch);
      ctx.stroke();

      ctx.fillStyle = Math.round(state.simLevel) === l ? '#0f172a' : '#64748b';
      ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`L${l}`, x, h - 8);
    }

    // Horizontal FPS budget lines (60, 40, 30 FPS)
    const budgets = [
      { ms: 16.67, label: '60 FPS', color: '#059669' },
      { ms: 25.0,  label: '40 FPS', color: '#d97706' },
      { ms: 33.33, label: '30 FPS', color: '#dc2626' }
    ];
    budgets.forEach((b) => {
      const y = Math.round(msToY(b.ms)) + 0.5;
      ctx.strokeStyle = b.color + '55';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + cw, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = b.color;
      ctx.font = '700 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(b.label, padL + 3, y - 3);
    });

    // Filled area under curve up to current simLevel
    const curCost = getSimMeanRenderMs(state.simLevel);
    const activeColor = curCost > 33.33 ? '#dc2626' : curCost > 25.0 ? '#ea580c' : curCost > 16.67 ? '#d97706' : '#059669';

    ctx.beginPath();
    ctx.moveTo(lvlToX(1), padT + ch);
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const l = 1 + (state.simLevel - 1) * (i / steps);
      ctx.lineTo(lvlToX(l), msToY(getSimMeanRenderMs(l)));
    }
    ctx.lineTo(lvlToX(state.simLevel), padT + ch);
    ctx.closePath();
    ctx.fillStyle = activeColor + '24';
    ctx.fill();

    // Full exponential curve stroke (muted)
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const l = 1 + 4 * (i / 60);
      const x = lvlToX(l);
      const y = msToY(getSimMeanRenderMs(l));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Active exponential curve segment
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const l = 1 + (state.simLevel - 1) * (i / steps);
      const x = lvlToX(l);
      const y = msToY(getSimMeanRenderMs(l));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = activeColor;
    ctx.lineWidth = 3;
    ctx.stroke();

    // 5 Level anchor dots along the curve
    for (let l = 1; l <= 5; l++) {
      const x = lvlToX(l);
      const y = msToY(getSimMeanRenderMs(l));
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = l <= state.simLevel + 0.01 ? activeColor : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = l <= state.simLevel + 0.01 ? activeColor : '#94a3b8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Active draggable handle
    const hx = lvlToX(state.simLevel);
    const hy = msToY(curCost);

    // Live vertical detonation spike excursion vector jumping across FPS budget lines
    const spikeJumpMs = Math.max(state.simSpikeMs, getSimBlastCurvePeakMs(state.tSim, state.simLevel));
    if (spikeJumpMs > 0.5) {
      const spikedCost = curCost + spikeJumpMs;
      const sy = msToY(spikedCost);
      const crosses30 = spikedCost > 33.33;
      const spikeColor = crosses30 ? '#dc2626' : '#ea580c';

      // Soft translucent glow beam
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx, sy);
      ctx.strokeStyle = crosses30 ? 'rgba(220, 38, 38, 0.24)' : 'rgba(234, 88, 12, 0.24)';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Dashed vertical excursion vector
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx, sy);
      ctx.strokeStyle = spikeColor;
      ctx.lineWidth = 2.2;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Peak detonation dot
      ctx.beginPath();
      ctx.arc(hx, sy, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = crosses30 ? 'rgba(220, 38, 38, 0.22)' : 'rgba(234, 88, 12, 0.22)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(hx, sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = spikeColor;
      ctx.lineWidth = 2.2;
      ctx.stroke();

      // Compact peak ms callout tag
      const tag = `${spikedCost.toFixed(0)} ms`;
      ctx.font = '700 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      const tw = ctx.measureText(tag).width;
      const tagW = tw + 10;
      const tagH = 16;
      const placeLeft = hx + 10 + tagW > w - 4;
      const tx = placeLeft ? Math.max(4, hx - 10 - tagW) : hx + 10;
      const ty = Math.max(4, Math.min(padT + ch - tagH - 2, sy - tagH / 2));

      ctx.fillStyle = spikeColor;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(tx, ty, tagW, tagH, 4) : ctx.rect(tx, ty, tagW, tagH);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tag, tx + tagW / 2, ty + tagH / 2 + 0.5);
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(hx, hy, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = activeColor;
    ctx.fill();
  }

  function setSimLevel(val) {
    state.simLevel = Math.max(1, Math.min(5, val));
    updateSimReadouts();
    drawExpCurve();
    requestCanvasRedraw();
    scheduleUrlSync();
  }

  // Interactive swipe/drag along the exponential curve
  if (dom.expCurveWrap) {
    let draggingCurve = false;

    const updateFromPointer = (clientX) => {
      const rect = dom.expCurveWrap.getBoundingClientRect();
      const pad = 16 * getCanvasHiResScale();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left - pad) / Math.max(1, rect.width - pad * 2)));
      setSimLevel(1 + ratio * 4);
    };

    dom.expCurveWrap.addEventListener('pointerdown', (e) => {
      draggingCurve = true;
      dom.expCurveWrap.setPointerCapture(e.pointerId);
      updateFromPointer(e.clientX);
    });

    dom.expCurveWrap.addEventListener('pointermove', (e) => {
      if (!draggingCurve) return;
      updateFromPointer(e.clientX);
    });

    const endDrag = (e) => {
      if (!draggingCurve) return;
      draggingCurve = false;
      try { dom.expCurveWrap.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    dom.expCurveWrap.addEventListener('pointerup', endDrag);
    dom.expCurveWrap.addEventListener('pointercancel', endDrag);

    dom.expCurveWrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSimLevel(Math.round((state.simLevel + 0.5) * 2) / 2);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSimLevel(Math.round((state.simLevel - 0.5) * 2) / 2);
      }
    });
  }

  function setSimViewMode(mode) {
    const next = mode === 'detailed' ? 'detailed' : 'simplified';
    if (simSectionEl) simSectionEl.dataset.simView = next;
    simViewBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.simViewBtn === next);
    });
    invalidateAllCanvases();
    updateSimReadouts();
    drawExpCurve();
    requestCanvasRedraw();
    scheduleUrlSync();
  }

  simLevelBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      setSimLevel(Number(btn.dataset.simLevel));
    });
  });

  simScenarioBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      setSimLevel(Number(btn.dataset.simLevel));
    });
  });

  simViewBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      setSimViewMode(btn.dataset.simViewBtn);
    });
  });

  // ============================================================================
  // SECTION 4 (VIEW 04): ANIMATED FRAME PIPELINE PRESENTATION (PER-TARGET MODEL)
  // ============================================================================
  const pipeEls = {
    card: document.getElementById('pipeCard'),
    targetStatus: document.getElementById('pipeTargetStatus'),
    totalMs: document.getElementById('pipeTotalMs'),
    stepCounter: document.getElementById('pipeStepCounter'),
    prevBtn: document.getElementById('pipePrevBtn'),
    nextBtn: document.getElementById('pipeNextBtn'),
    msCpu: document.getElementById('pipeMsCpu'),
    msGpu: document.getElementById('pipeMsGpu'),
    vsyncLbl: document.getElementById('pipeVsyncLbl'),
    msVsync: document.getElementById('pipeMsVsync'),
    msHdmi: document.getElementById('pipeMsHdmi'),
    msDisp: document.getElementById('pipeMsDisp'),
    segCpu: document.getElementById('pipeSegCpu'),
    segGpu: document.getElementById('pipeSegGpu'),
    segVsync: document.getElementById('pipeSegVsync'),
    segHdmi: document.getElementById('pipeSegHdmi'),
    segDisp: document.getElementById('pipeSegDisp'),
    title: document.getElementById('pipeStageTitle'),
    desc: document.getElementById('pipeStageDesc'),
    scrollHint: document.getElementById('pipeScrollHint'),
    nodes: Array.from(document.querySelectorAll('.pipe-node')),
    links: Array.from(document.querySelectorAll('.pipe-link')),
    pills: Array.from(document.querySelectorAll('.pipe-step-pill')),
    modeTabs: Array.from(document.querySelectorAll('.pipe-mode-tab'))
  };

  const introEls = {
    card: document.getElementById('pipeIntroCard'),
    stepCounter: document.getElementById('introStepCounter'),
    prevBtn: document.getElementById('introPrevBtn'),
    nextBtn: document.getElementById('introNextBtn'),
    mobPrevBtn: document.getElementById('introMobPrevBtn'),
    mobNextBtn: document.getElementById('introMobNextBtn'),
    exitBtn: document.getElementById('introExitBtn'),
    replayBtn: document.getElementById('pipeReplayBtn'),
    copyPane: document.getElementById('introCopyPane'),
    kicker: document.getElementById('introStageKicker'),
    stageMs: document.getElementById('introStageMs'),
    title: document.getElementById('introStageTitle'),
    desc: document.getElementById('introStageDesc'),
    scrollHint: document.getElementById('introScrollHint'),
    msCpu: document.getElementById('introMsCpu'),
    msGpu: document.getElementById('introMsGpu'),
    msVsync: document.getElementById('introMsVsync'),
    msHdmi: document.getElementById('introMsHdmi'),
    msDisp: document.getElementById('introMsDisp'),
    tiles: Array.from(document.querySelectorAll('.intro-tile')),
    dots: Array.from(document.querySelectorAll('.intro-dot'))
  };

  let pipeStage = 0;
  let pipeMode = '60';
  let introCompleting = false;
  let lastIntroRenderedStage = -1;
  let introLastDir = 'up';

  function isIntroModeActive() {
    return document.documentElement.classList.contains('is-intro-replay');
  }

  function startPipelineIntroReplay() {
    if (introCompleting || isIntroModeActive()) return;
    const root = document.documentElement;
    pipeStage = 0;
    lastIntroRenderedStage = -1;
    root.classList.add('is-intro-replay');
    updatePipelineView();
    window.dispatchEvent(new CustomEvent('fpslab:intro-replay-started'));
    syncVisibleSectionsNow();
  }

  function completeIntroPresentation() {
    const root = document.documentElement;
    if (introCompleting || !isIntroModeActive()) return;
    introCompleting = true;

    // Gently vanish the Pipeline intro replay before returning to Pipeline
    root.classList.add('is-intro-vanishing');

    setTimeout(() => {
      root.classList.remove('is-intro-replay', 'is-intro-vanishing');
      root.classList.add('is-intro-revealed');

      pipeStage = 0;
      lastIntroRenderedStage = -1;
      updatePipelineView();

      window.dispatchEvent(new CustomEvent('fpslab:intro-unlocked', {
        detail: { target: 'pipeline' }
      }));
      syncVisibleSectionsNow();
      introCompleting = false;

      setTimeout(() => {
        root.classList.remove('is-intro-revealed');
      }, 650);
    }, 430);
  }

  function getPipelineStageCopy(stageIdx, ctx) {
    const { mode, hz, dispPeriod, sceneMs, cpuMs, gpuMs, budgetMs, missed, waitMs, interpBufMs, effFps, dropPct } = ctx;
    const modeName = MODE_META[mode].name;

    if (stageIdx === 0) {
      return {
        title: `1. CPU Simulation & Frame Prep (${cpuMs.toFixed(1)} ms modeled)`,
        desc: `In this example, simulation updates follow the selected ${modeName} target (${budgetMs.toFixed(1)} ms budget). Real engines may update physics, gameplay, and rendering at different rates and overlap CPU/GPU work.`
      };
    }
    if (stageIdx === 1) {
      return {
        title: `2. Command Queue & GPU Render (${gpuMs.toFixed(1)} ms · Combined ${sceneMs.toFixed(1)} ms)`,
        desc: missed
          ? `OVER BUDGET: Modeled combined cost (${sceneMs.toFixed(1)} ms) exceeds ${modeName}’s ${budgetMs.toFixed(1)} ms budget, reducing modeled rate to ${effFps.toFixed(1)} FPS (${dropPct}% below target).`
          : `WITHIN BUDGET: Modeled combined cost finishes in ${sceneMs.toFixed(1)} ms—leaving ${(budgetMs - sceneMs).toFixed(1)} ms of spare headroom inside ${modeName}’s ${budgetMs.toFixed(1)} ms budget.`
      };
    }
    if (stageIdx === 2) {
      if (mode === 'interp') {
        return {
          title: `3. Frame Pacer + Simulated Lookahead Buffer (+${Math.round(waitMs + interpBufMs)} ms)`,
          desc: `This interpolation example runs a 30 FPS source (${Math.max(33.3, sceneMs).toFixed(1)} ms) and holds a chosen 2-frame buffer (+${Math.round(interpBufMs)} ms) to synthesize intermediate frames. Actual delay depends on implementation and settings.`
        };
      }
      if (mode === '40' && hz === 60 && !missed) {
        return {
          title: `3. Frame Pacer & Fixed 60 Hz V-Sync (+${waitMs.toFixed(1)} ms avg · Uneven 2–1)`,
          desc: `At a fixed 60 Hz (16.7 ms ticks), a 25.0 ms frame alternates 2-refresh (33.3 ms) and 1-refresh (16.7 ms) holds, producing uneven 2–1 cadence.`
        };
      }
      if (mode === '40' && hz === 120 && !missed) {
        return {
          title: `3. Frame Pacer & Fixed 120 Hz V-Sync (+${waitMs.toFixed(1)} ms)`,
          desc: `At a fixed 120 Hz (8.33 ms ticks), each 25.0 ms frame can occupy three refreshes (3 × 8.33 ms = 25.0 ms) with even pacing.`
        };
      }
      return {
        title: `3. Frame Pacer & V-Sync Gate (+${waitMs.toFixed(1)} ms)`,
        desc: missed
          ? `Because modeled rendering (${sceneMs.toFixed(1)} ms) missed the ${budgetMs.toFixed(1)} ms deadline, presentation waits an extra ${waitMs.toFixed(1)} ms for the next simulated ${hz} Hz refresh tick.`
          : `In this fixed-refresh V-Sync model, the completed frame waits ${waitMs.toFixed(1)} ms to align with ${modeName}’s ${budgetMs.toFixed(1)} ms cadence at ${hz} Hz.`
      };
    }
    if (stageIdx === 3) {
      return {
        title: `4. Line-by-Line Signal Stream (${dispPeriod.toFixed(1)} ms @ ${hz} Hz)`,
        desc: `Pixel rows stream top-to-bottom over a full ${dispPeriod.toFixed(1)} ms refresh period at ${hz} Hz. Stage times illustrate the selected model; real systems can overlap work and use different queue policies.`
      };
    }
    return {
      title: `5. Scanout & gray-to-gray pixel response (2.5 ms assumed)`,
      desc: `In this display model, the image scans out top-to-bottom and gray-to-gray pixel response (2.5 ms assumed) completes as the scan reaches each region—reaching bottom-of-screen model latency in ~${ctx.totalMs.toFixed(1)} ms.`
    };
  }

  function updatePipelineView() {
    if (!pipeEls.card) return;
    const hz = state.displayHz;
    const dispPeriod = 1000 / hz;
    const sceneMs = getMeanSceneRenderMs(state.consoleLoad, state.simSpikeMs);
    const cpuMs = sceneMs * 0.30;
    const gpuMs = sceneMs * 0.70;

    const budgetMs = MODE_META[pipeMode].periodMs;
    const missed = sceneMs > budgetMs + 0.5;
    const pacedMs = Math.max(budgetMs, sceneMs);

    // Align to display v-sync boundary (accounting for 40 FPS @ 60 Hz 1.5-tick average vs integer ticks)
    let vSyncAlignedMs;
    if (pipeMode === '40' && hz === 60 && !missed) {
      vSyncAlignedMs = 25.0; // averages 16.7 / 33.3 ms across 3:2 pulldown, +4.2 ms avg v-sync phase wait
    } else {
      vSyncAlignedMs = Math.ceil((pacedMs - 0.01) / dispPeriod) * dispPeriod;
    }

    const waitMs = (pipeMode === '40' && hz === 60 && !missed)
      ? (25.0 - sceneMs + 4.2)
      : Math.max(0.4, vSyncAlignedMs - sceneMs);

    const interpBufMs = pipeMode === 'interp' ? Math.max(33.33, sceneMs) * 2 : 0;
    const gateTotalMs = waitMs + interpBufMs;

    // HDMI streams line-by-line simultaneously with display scanout over 1 refresh period, +2.5 ms GtG
    const hdmiMs = dispPeriod;
    const dispMs = 2.5;
    const totalMs = cpuMs + gpuMs + gateTotalMs + hdmiMs + dispMs;

    const effFps = Math.min(MODE_META[pipeMode].gameFps, 1000 / pacedMs);
    const dropPct = Math.round(getEfficiencyDropPct(effFps, MODE_META[pipeMode].gameFps));

    pipeEls.card.dataset.stage = String(pipeStage);

    // Header status & total latency badges
    if (pipeEls.targetStatus) {
      if (pipeMode === 'interp') {
        pipeEls.targetStatus.textContent = dropPct > 1
          ? `${effFps.toFixed(0)} src → ${hz} vis (${dropPct}% below)`
          : `30 src → ${hz} vis · +${Math.round(interpBufMs)} ms buf`;
        pipeEls.targetStatus.className = 'pipe-status mono warn';
      } else if (pipeMode === '40' && hz === 60 && !missed) {
        pipeEls.targetStatus.textContent = '40.0 FPS · uneven 2–1';
        pipeEls.targetStatus.className = 'pipe-status mono warn';
      } else {
        pipeEls.targetStatus.textContent = dropPct > 1
          ? `${effFps.toFixed(1)} FPS · ${dropPct}% below target`
          : `${effFps.toFixed(1)} FPS · Target met`;
        pipeEls.targetStatus.className = 'pipe-status mono ' + (dropPct > 1 ? 'warn' : 'good');
      }
    }

    pipeEls.totalMs.textContent = `Bottom-scan: ~${totalMs.toFixed(1)} ms`;
    pipeEls.totalMs.title = `Input to bottom-of-screen pixel completion (full scanout + 2.5 ms assumed gray-to-gray pixel response). Motion shows mid-screen (~${(totalMs - dispPeriod * 0.5).toFixed(1)} ms).`;
    pipeEls.stepCounter.textContent = `${pipeStage + 1} / 5`;
    pipeEls.prevBtn.disabled = pipeStage <= 0;
    pipeEls.nextBtn.disabled = pipeStage >= 4;
    pipeEls.nextBtn.textContent = 'Next →';
    pipeEls.nextBtn.classList.remove('is-finish');

    pipeEls.msCpu.textContent = `${cpuMs.toFixed(1)} ms`;
    pipeEls.msGpu.textContent = `${gpuMs.toFixed(1)} ms`;
    if (pipeEls.vsyncLbl) {
      pipeEls.vsyncLbl.textContent = pipeMode === 'interp' ? 'Buffer + V-Sync' : 'Pacer / V-Sync';
    }
    pipeEls.msVsync.textContent = `+${gateTotalMs.toFixed(1)} ms`;
    pipeEls.msHdmi.textContent = `${hdmiMs.toFixed(1)} ms`;
    pipeEls.msDisp.textContent = `${dispMs.toFixed(1)} ms pixel`;
    pipeEls.msDisp.title = 'Assumed gray-to-gray pixel response: 2.5 ms';

    // Update proportional millisecond breakdown segments
    const vsyncSegLbl = pipeMode === 'interp' ? 'Interp Buf' : 'Pacer/V-Sync';
    const segs = [
      { el: pipeEls.segCpu,   ms: cpuMs,       lbl: 'CPU',        idx: 0 },
      { el: pipeEls.segGpu,   ms: gpuMs,       lbl: 'GPU',        idx: 1 },
      { el: pipeEls.segVsync, ms: gateTotalMs, lbl: vsyncSegLbl,  idx: 2 },
      { el: pipeEls.segHdmi,  ms: hdmiMs,      lbl: 'HDMI+Scan',  idx: 3 },
      { el: pipeEls.segDisp,  ms: dispMs,      lbl: 'Pixel',      idx: 4 }
    ];
    segs.forEach((s) => {
      s.el.style.flexGrow = String(Math.max(2.2, s.ms));
      s.el.textContent = s.ms >= 4.5 ? `${s.lbl} ${s.ms.toFixed(1)} ms` : s.lbl;
      s.el.classList.toggle('is-active', s.idx === pipeStage);
      s.el.classList.toggle('is-done', s.idx < pipeStage);
    });
    pipeEls.segGpu.classList.toggle('is-missed', missed);
    pipeEls.segVsync.classList.toggle('is-interp', pipeMode === 'interp');
    pipeEls.segVsync.classList.toggle('is-missed', missed && pipeMode !== 'interp');

    // Update hardware node states
    pipeEls.nodes.forEach((node) => {
      const idx = Number(node.dataset.node);
      node.classList.toggle('is-active', idx === pipeStage);
      node.classList.toggle('is-done', idx < pipeStage);
      if (idx === 1) node.classList.toggle('is-missed', missed);
    });

    // Update signal link states
    pipeEls.links.forEach((link) => {
      const idx = Number(link.dataset.link);
      link.classList.toggle('is-active', idx === pipeStage);
      link.classList.toggle('is-done', idx < pipeStage);
    });

    // Update step pills, mode tabs & narrative copy
    pipeEls.pills.forEach((p) => {
      p.classList.toggle('active', Number(p.dataset.pipeStep) === pipeStage);
    });
    pipeEls.modeTabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.pipeMode === pipeMode);
    });

    const info = getPipelineStageCopy(pipeStage, {
      mode: pipeMode,
      hz,
      dispPeriod,
      sceneMs,
      cpuMs,
      gpuMs,
      budgetMs,
      missed,
      waitMs,
      interpBufMs,
      effFps,
      dropPct,
      totalMs
    });
    pipeEls.title.textContent = info.title;
    pipeEls.desc.textContent = info.desc;

    if (pipeEls.scrollHint) {
      pipeEls.scrollHint.textContent = pipeStage >= 4
        ? 'Use ← Prev or scroll ↓ for Refresh Map'
        : 'Use ← → or Next to advance';
    }

    // Update progressive 5-slide Pipeline Intro view (first-visit & replay mode)
    if (introEls.card) {
      const isReplay = document.documentElement.classList.contains('is-intro-replay');
      const isFinishStep = pipeStage >= 4;
      const stageMsLabels = [
        `${cpuMs.toFixed(1)} ms`,
        `${gpuMs.toFixed(1)} ms`,
        `+${gateTotalMs.toFixed(1)} ms`,
        `${hdmiMs.toFixed(1)} ms`,
        `${dispMs.toFixed(1)} ms GtG`
      ];

      introEls.card.dataset.stage = String(pipeStage);
      introEls.card.dataset.dir = introLastDir;
      if (introEls.stepCounter) introEls.stepCounter.textContent = `${pipeStage + 1} / 5`;
      if (introEls.prevBtn) introEls.prevBtn.disabled = pipeStage <= 0;
      const nextLabel = isFinishStep
        ? (isReplay ? 'Back to Pipeline →' : 'Enter Lab →')
        : 'Next →';
      if (introEls.nextBtn) {
        introEls.nextBtn.disabled = false;
        introEls.nextBtn.textContent = nextLabel;
        introEls.nextBtn.classList.toggle('is-finish', isFinishStep);
      }
      if (introEls.mobPrevBtn) introEls.mobPrevBtn.disabled = pipeStage <= 0;
      if (introEls.mobNextBtn) {
        introEls.mobNextBtn.disabled = false;
        introEls.mobNextBtn.textContent = nextLabel;
        introEls.mobNextBtn.classList.toggle('is-finish', isFinishStep);
      }

      if (introEls.msCpu) introEls.msCpu.textContent = `${cpuMs.toFixed(1)} ms`;
      if (introEls.msGpu) introEls.msGpu.textContent = `${gpuMs.toFixed(1)} ms`;
      if (introEls.msVsync) introEls.msVsync.textContent = `+${gateTotalMs.toFixed(1)} ms`;
      if (introEls.msHdmi) introEls.msHdmi.textContent = `${hdmiMs.toFixed(1)} ms`;
      if (introEls.msDisp) introEls.msDisp.textContent = `${dispMs.toFixed(1)} ms`;

      introEls.tiles.forEach((tile) => {
        const idx = Number(tile.dataset.introStep);
        tile.classList.toggle('is-active', idx === pipeStage);
        tile.classList.toggle('is-done', idx < pipeStage);
        tile.classList.toggle('is-upcoming', idx > pipeStage);
      });

      introEls.dots.forEach((dot) => {
        const idx = Number(dot.dataset.introDot);
        dot.classList.toggle('is-active', idx === pipeStage);
        dot.classList.toggle('is-done', idx < pipeStage);
      });

      if (introEls.kicker) introEls.kicker.textContent = `STAGE ${pipeStage + 1} OF 5`;
      if (introEls.stageMs) introEls.stageMs.textContent = stageMsLabels[pipeStage];
      if (introEls.title) introEls.title.textContent = info.title;
      if (introEls.desc) introEls.desc.textContent = info.desc;
      if (introEls.scrollHint) {
        const isMobile = window.innerWidth <= 820;
        if (isFinishStep) {
          introEls.scrollHint.textContent = isMobile
            ? 'Tap Back to return'
            : 'Press → or click Back to Pipeline';
        } else {
          introEls.scrollHint.textContent = isMobile
            ? 'Tap Next to navigate'
            : 'Use ← → or Next to continue';
        }
      }

      if (introEls.copyPane && pipeStage !== lastIntroRenderedStage) {
        lastIntroRenderedStage = pipeStage;
        introEls.copyPane.classList.remove('is-swapping');
        void introEls.copyPane.offsetWidth;
        introEls.copyPane.classList.add('is-swapping');
      }
    }
  }

  function setPipelineStep(idx) {
    if (introCompleting) return;
    const clamped = Math.max(0, Math.min(4, idx));
    introLastDir = clamped < pipeStage ? 'down' : 'up';
    pipeStage = clamped;
    updatePipelineView();
    scheduleUrlSync();
  }

  function stepPipeline(dir) {
    if (introCompleting) return true;
    const next = pipeStage + dir;
    if (next < 0) return false;
    if (next >= 5) {
      if (isIntroModeActive()) {
        completeIntroPresentation();
        return true;
      }
      return false;
    }
    introLastDir = dir < 0 ? 'down' : 'up';
    pipeStage = next;
    updatePipelineView();
    return true;
  }

  if (introEls.prevBtn) introEls.prevBtn.addEventListener('click', () => stepPipeline(-1));
  if (introEls.nextBtn) introEls.nextBtn.addEventListener('click', () => stepPipeline(1));
  if (introEls.mobPrevBtn) introEls.mobPrevBtn.addEventListener('click', () => stepPipeline(-1));
  if (introEls.mobNextBtn) introEls.mobNextBtn.addEventListener('click', () => stepPipeline(1));
  if (introEls.exitBtn) introEls.exitBtn.addEventListener('click', () => completeIntroPresentation());
  if (introEls.replayBtn) introEls.replayBtn.addEventListener('click', () => startPipelineIntroReplay());
  introEls.tiles.forEach((tile) => {
    tile.addEventListener('click', () => {
      const idx = Number(tile.dataset.introStep);
      if (idx < pipeStage) setPipelineStep(idx);
    });
  });

  if (pipeEls.prevBtn) pipeEls.prevBtn.addEventListener('click', () => stepPipeline(-1));
  if (pipeEls.nextBtn) pipeEls.nextBtn.addEventListener('click', () => stepPipeline(1));
  pipeEls.pills.forEach((p) => {
    p.addEventListener('click', () => setPipelineStep(Number(p.dataset.pipeStep)));
  });
  pipeEls.nodes.forEach((node) => {
    node.addEventListener('click', () => setPipelineStep(Number(node.dataset.node)));
  });
  pipeEls.links.forEach((link) => {
    link.style.cursor = 'pointer';
    link.addEventListener('click', () => setPipelineStep(Number(link.dataset.link)));
  });
  [pipeEls.segCpu, pipeEls.segGpu, pipeEls.segVsync, pipeEls.segHdmi, pipeEls.segDisp].forEach((seg, idx) => {
    if (seg) seg.addEventListener('click', () => setPipelineStep(idx));
  });
  pipeEls.modeTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      pipeMode = tab.dataset.pipeMode;
      updatePipelineView();
    });
  });

  // Cross-highlight Refresh Map rows when hovering View 05 explanation cards
  document.querySelectorAll('.note-item[data-focus-mode]').forEach((card) => {
    const focusMode = card.dataset.focusMode;
    card.addEventListener('mouseenter', () => {
      if (!dom.timelineBoard) return;
      dom.timelineBoard.querySelectorAll('.tl-row').forEach((r) => {
        r.classList.toggle('is-highlighted', r.dataset.rowMode === focusMode);
      });
    });
    card.addEventListener('mouseleave', () => {
      if (!dom.timelineBoard) return;
      dom.timelineBoard.querySelectorAll('.tl-row.is-highlighted').forEach((r) => {
        r.classList.remove('is-highlighted');
      });
    });
  });

  // Expose presentation controller for ui.js scroll integration
  window.pipelinePresentation = {
    step: stepPipeline,
    setStep: setPipelineStep,
    getStep: () => pipeStage,
    count: 5
  };

  // ============================================================================
  // VIEWPORT VISIBILITY GATING (ONLY VISIBLE SCREEN DOES WORK)
  // ============================================================================
  const SECTION_IDS = ['motionSection', 'simSection', 'physicsSection', 'inputSection', 'pipelineSection', 'timelineSection'];
  const visibleSections = new Set();

  function isSectionVisible(id) {
    return visibleSections.has(id);
  }

  function setSectionVisibility(id, visible) {
    const el = document.getElementById(id);
    if (el) el.dataset.visible = visible ? 'true' : 'false';
    const wasVisible = visibleSections.has(id);
    if (visible) {
      visibleSections.add(id);
      if (!wasVisible) onSectionWake(id);
    } else {
      visibleSections.delete(id);
    }
  }

  function onSectionWake(id) {
    invalidateAllCanvases();
    if (id === 'motionSection') {
      resyncLaneSimulators();
      updateLaneReadouts();
      requestCanvasRedraw();
    } else if (id === 'simSection') {
      resyncSimArenas();
      updateSimReadouts();
      drawExpCurve();
      requestCanvasRedraw();
    } else if (id === 'physicsSection') {
      if (typeof resetPhysicsChambers === 'function') resetPhysicsChambers();
      if (typeof updatePhysicsReadouts === 'function') updatePhysicsReadouts();
      requestCanvasRedraw();
    } else if (id === 'inputSection') {
      arena.lastDispTick = -1;
      arena.nextFrameReadyTime = 0;
      updateArenaStaticStats();
      requestCanvasRedraw();
    } else if (id === 'pipelineSection') {
      updatePipelineView();
    } else if (id === 'timelineSection') {
      drawTimeline();
    }
  }

  function syncVisibleSectionsNow() {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    SECTION_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const r = el.getBoundingClientRect();
      setSectionVisibility(id, r.bottom > 1 && r.top < vh - 1);
    });
  }

  if ('IntersectionObserver' in window) {
    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const id = entry.target.id;
        if (!id) return;
        setSectionVisibility(id, entry.isIntersecting && entry.intersectionRatio > 0.01);
      });
    }, { root: null, threshold: [0, 0.01, 0.05] });

    SECTION_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) sectionObserver.observe(el);
    });
  }

  window.addEventListener('resize', () => {
    invalidateAllCanvases();
    syncVisibleSectionsNow();
    if (isSectionVisible('timelineSection')) drawTimeline();
    if (isSectionVisible('simSection')) drawExpCurve();
    requestCanvasRedraw();
  });

  // ============================================================================
  // MAIN ANIMATION LOOP (ON-DEMAND rAF + PAUSED-STATE GATING)
  // ============================================================================
  let lastRafTime = null;
  let lastReadoutTime = 0;
  let wasSpiking = false;

  function ensureLoopRunning() {
    if (rafId === null && !document.hidden) {
      lastRafTime = null;
      rafId = requestAnimationFrame(loop);
    }
  }

  function requestCanvasRedraw() {
    needsPausedRedraw = true;
    ensureLoopRunning();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastRafTime = null;
    } else {
      requestCanvasRedraw();
    }
  });

  // Lock simulation clock to the host display's V-Sync cadence when running near a
  // 60/120 Hz harmonic (e.g. 59.94 Hz TVs or ±0.5 ms rAF jitter) so locked 60 FPS
  // never suffers beat-frequency duplicate/skipped ticks.
  function getQuantizedVsyncDt(dtReal) {
    if (dtReal <= 0) return 0;
    const hostHz = state.detectedHz || 60;
    if (hostHz === 60 || hostHz === 120) {
      const hostPeriod = 1000 / hostHz;
      const ratio = dtReal / hostPeriod;
      const nearest = Math.round(ratio);
      if (nearest >= 1 && nearest <= 3 && Math.abs(ratio - nearest) < 0.35) {
        return nearest * hostPeriod;
      }
    }
    return dtReal;
  }

  let wasSimBlasting = false;

  function loop(now) {
    rafId = null;
    if (document.hidden) {
      lastRafTime = null;
      return;
    }

    if (lastRafTime === null) lastRafTime = now;
    const dtReal = Math.min(now - lastRafTime, 50);
    lastRafTime = now;

    if (typeof observeLivePowerSaveFrame === 'function') {
      observeLivePowerSaveFrame(dtReal);
    }

    const vsyncDt = getQuantizedVsyncDt(dtReal);
    state.tRealSynced += vsyncDt;

    if (!state.paused) {
      state.tSim += vsyncDt * state.speed;
    }

    state.simSpikeMs = state.spikeStartSim >= 0
      ? getSpikeEnvelopeMs(state.tSim - state.spikeStartSim)
      : 0;
    state.realSpikeMs = state.spikeStartReal >= 0
      ? getSpikeEnvelopeMs(now - state.spikeStartReal)
      : 0;

    const motionVisible = isSectionVisible('motionSection');
    const simVisible = isSectionVisible('simSection');
    const physicsVisible = isSectionVisible('physicsSection');
    const inputVisible = isSectionVisible('inputSection');
    const pipelineVisible = isSectionVisible('pipelineSection');
    const timelineVisible = isSectionVisible('timelineSection');

    if (!state.paused) {
      if (motionVisible) stepLaneSimulators();
      if (simVisible) stepSimArenas();
      if (physicsVisible && typeof stepPhysicsChambers === 'function') {
        stepPhysicsChambers(vsyncDt * state.speed);
      }
    }

    const isSpiking = state.simSpikeMs > 0.1 || state.realSpikeMs > 0.1;
    if (isSpiking || wasSpiking) {
      updateLoadDisplay();
      if (simVisible) {
        updateSimReadouts();
        drawExpCurve();
      }
      if (inputVisible) updateArenaStaticStats();
      if (timelineVisible) drawTimeline();
      if (pipelineVisible) updatePipelineView();
      wasSpiking = isSpiking;
      needsPausedRedraw = true;
    }

    const shouldDrawSimCanvases = !state.paused || needsPausedRedraw;

    if (motionVisible && shouldDrawSimCanvases) {
      MODES.forEach((m) => {
        drawLane(m);
        drawFrametimeGraph(m);
      });
    }

    if (simVisible && shouldDrawSimCanvases) {
      MODES.forEach((m) => {
        drawSimArena(m);
      });
    }

    if (physicsVisible && shouldDrawSimCanvases && typeof drawPhysicsChambers === 'function') {
      drawPhysicsChambers();
    }

    needsPausedRedraw = false;

    const simBlasting = simVisible && simNpcBlasts.size > 0;
    if (simBlasting || wasSimBlasting) {
      updateLoadDisplay();
      if (simVisible) {
        drawExpCurve();
        if (!simBlasting) updateSimReadouts();
      }
      wasSimBlasting = simBlasting;
    }

    const motionAutoSpiking = motionVisible && activeMotionScenario === 2;
    if ((!state.paused || isSpiking) && now - lastReadoutTime > (isSpiking || simBlasting || motionAutoSpiking ? 90 : 260)) {
      lastReadoutTime = now;
      if (motionVisible) {
        updateLaneReadouts();
        if (motionAutoSpiking) updateLoadDisplay();
      }
      if (simVisible) updateSimReadouts();
      if (physicsVisible && typeof updatePhysicsReadouts === 'function') updatePhysicsReadouts();
    }

    if (inputVisible) {
      updateAndDrawArena(now);
    }

    // Keep rAF running only when an animated canvas section or active spike needs frames
    const keepRunning =
      inputVisible ||
      isSpiking ||
      wasSpiking ||
      (!state.paused && (motionVisible || simVisible || physicsVisible));

    if (keepRunning) {
      rafId = requestAnimationFrame(loop);
    } else {
      lastRafTime = null;
    }
  }

  // ============================================================================
  // SECTION 1 (MOTION): SIMPLIFIED ↔ DETAILED VIEW & 5 LOAD HEADROOM SCENARIOS
  // ============================================================================
  const MOTION_SCENARIOS = [
    {
      id: 1,
      title: 'All Stable',
      load: 1.0,
      tier: 'low',
      impact: 'All targets within budget',
      desc: 'At 14.0 ms per frame, all native targets meet their budgets. 60 FPS updates most often with the lowest modeled latency; switch 60 ↔ 120 Hz to see 40 FPS shift from uneven 33/17 ms holds to even 25 ms holds.'
    },
    {
      id: 2,
      title: '60 Hitches on Spikes',
      load: 1.2,
      tier: 'mid',
      impact: '30 absorbs spikes',
      autoSpikes: true,
      desc: 'Base cost (15.5 ms) leaves 60 FPS only 1.2 ms of margin before 16.7 ms. Repeating +15 ms bursts (~30.5 ms total) push 60 and 40 FPS over budget, while 30 FPS absorbs every spike inside its 33.3 ms budget.'
    },
    {
      id: 3,
      title: '60 FPS Unstable',
      load: 2.0,
      tier: 'mid',
      impact: '60 FPS over budget',
      desc: 'At a modeled cost of 21.5 ms per frame, the workload exceeds the 16.7 ms budget for 60 FPS, while fitting within the budgets for 40 and 30 FPS. The selected refresh timing determines how completed frames are shown.'
    },
    {
      id: 4,
      title: 'Only 30 Absorbs Load',
      load: 3.0,
      tier: 'warn',
      impact: 'Only 30 within budget',
      desc: 'A modeled 29.0 ms frame cost exceeds both 60 FPS (16.7 ms) and 40 FPS (25.0 ms) budgets. Only 30 FPS stays within its 33.3 ms budget—while simulated interpolation smooths motion by adding a ~67 ms buffer.'
    },
    {
      id: 5,
      title: 'All Overloaded',
      load: 4.3,
      tier: 'high',
      impact: 'All below target',
      desc: 'At a modeled 38.8 ms per frame, workload exceeds 30 FPS’s 33.3 ms budget. Every native target falls below its rate, while simulated interpolation latency climbs past ~140 ms.'
    }
  ];

  const motionSectionEl = document.getElementById('motionSection');
  const motionFooterCard = document.getElementById('motionFooterCard');
  const motionScenarioNum = document.getElementById('motionScenarioNum');
  const motionScenarioTitle = document.getElementById('motionScenarioTitle');
  const motionScenarioDesc = document.getElementById('motionScenarioDesc');
  const motionImpactTag = document.getElementById('motionImpactTag');
  const motionMeterBars = Array.from(document.querySelectorAll('#motionMeter span'));
  const motionScenarioBtns = Array.from(document.querySelectorAll('[data-motion-scenario]'));
  const motionViewBtns = Array.from(document.querySelectorAll('[data-motion-view-btn]'));

  let activeMotionScenario = 1;
  let motionAutoSpikeAnchorMs = 0;
  let motionFooterPulseTimer = null;

  function getMotionScenarioAutoSpikeMs(tMs) {
    if (activeMotionScenario !== 2 || !isSectionVisible('motionSection')) return 0;
    const cycleMs = 2400;
    const burstMs = 680;
    const phase = (((tMs - motionAutoSpikeAnchorMs) % cycleMs) + cycleMs) % cycleMs;
    if (phase >= burstMs) return 0;
    // Fast attack, brief plateau, smooth decay; peak +15.0 ms on 15.5 ms base = 30.5 ms (< 33.3 ms for 30 FPS!)
    if (phase < 45) return 15.0 * (phase / 45);
    if (phase < 320) return 15.0;
    const k = 1 - (phase - 320) / (burstMs - 320);
    return 15.0 * k * k;
  }

  function triggerMotionFooterPulse() {
    if (!motionFooterCard) return;
    motionFooterCard.classList.remove('is-updating');
    void motionFooterCard.offsetWidth;
    motionFooterCard.classList.add('is-updating');
    clearTimeout(motionFooterPulseTimer);
    motionFooterPulseTimer = setTimeout(() => {
      motionFooterCard.classList.remove('is-updating');
    }, 540);
  }

  function applyMotionScenarioUI(id, pulse = true) {
    const sc = MOTION_SCENARIOS[Math.max(0, Math.min(MOTION_SCENARIOS.length - 1, id - 1))];
    if (!sc) return;
    const changed = activeMotionScenario !== sc.id;
    activeMotionScenario = sc.id;

    motionScenarioBtns.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.motionScenario) === sc.id);
    });
    if (motionFooterCard) motionFooterCard.dataset.tier = sc.tier;
    if (motionScenarioNum) motionScenarioNum.textContent = `SCENARIO ${sc.id}`;
    if (motionScenarioTitle) motionScenarioTitle.textContent = sc.title;
    if (motionScenarioDesc) motionScenarioDesc.textContent = sc.desc;
    if (motionImpactTag) motionImpactTag.textContent = sc.impact;
    if (motionMeterBars.length) {
      motionMeterBars.forEach((bar, i) => bar.classList.toggle('is-lit', i < sc.id));
    }
    if (pulse && changed) triggerMotionFooterPulse();
  }

  function setMotionScenario(id) {
    const sc = MOTION_SCENARIOS[Math.max(0, Math.min(MOTION_SCENARIOS.length - 1, id - 1))];
    if (!sc) return;
    applyMotionScenarioUI(sc.id, true);
    if (sc.autoSpikes) {
      // Fire first periodic spike almost immediately so user sees 60/40 hitch vs 30 absorb right away
      motionAutoSpikeAnchorMs = state.tSim - 60;
    }
    setMotionScenarioLoad(sc.load);
  }

  function syncMotionScenarioFromLoad(loadVal) {
    let matched = 1;
    if (loadVal >= 3.58) matched = 5;
    else if (loadVal >= 2.47) matched = 4;
    else if (loadVal >= 1.36) matched = 3;
    else matched = 1;
    applyMotionScenarioUI(matched, matched !== activeMotionScenario);
  }

  function setMotionViewMode(mode) {
    const next = mode === 'detailed' ? 'detailed' : 'simplified';
    if (motionSectionEl) motionSectionEl.dataset.motionView = next;
    motionViewBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.motionViewBtn === next);
    });
    invalidateAllCanvases();
    updateLaneReadouts();
    requestCanvasRedraw();
    scheduleUrlSync();
  }

  motionScenarioBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.motionScenario);
      if (id >= 1 && id <= 5) setMotionScenario(id);
    });
  });

  motionViewBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      setMotionViewMode(btn.dataset.motionViewBtn);
    });
  });

  applyMotionScenarioUI(1, false);

  // ============================================================================
  // HOW THIS MODEL WORKS MODAL
  // ============================================================================
  const modelModal = document.getElementById('modelModal');
  const modelModalBackdrop = document.getElementById('modelModalBackdrop');
  const modelModalCloseBtn = document.getElementById('modelModalCloseBtn');
  const modelGuideBtn = document.getElementById('modelGuideBtn');

  function openModelModal() {
    if (!modelModal) return;
    modelModal.hidden = false;
  }

  function closeModelModal() {
    if (!modelModal) return;
    modelModal.hidden = true;
  }

  if (modelGuideBtn) modelGuideBtn.addEventListener('click', openModelModal);
  if (modelModalBackdrop) modelModalBackdrop.addEventListener('click', closeModelModal);
  if (modelModalCloseBtn) modelModalCloseBtn.addEventListener('click', closeModelModal);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modelModal && !modelModal.hidden) {
      closeModelModal();
    }
  });

  // ============================================================================
  // DISCOVERY HEARTBEAT NUDGES (LOAD SPIKE BUTTON + LOAD SLIDER + UNIFIED HINTS COOKIE)
  // ============================================================================
  const HINTS_COOKIE = 'fps_lab_hints';
  const LEGACY_SPIKE_COOKIE = 'fps_lab_used_spike';
  const LEGACY_LOAD_COOKIE = 'fps_lab_used_load';
  const HEARTBEAT_FIRST_MS = 7200;
  const HEARTBEAT_MIN_MS = 7000;
  const HEARTBEAT_MAX_MS = 10000;

  function readHintsSet() {
    const flags = new Set();
    const match = document.cookie.match(/(?:^|;\s*)fps_lab_hints=([^;]*)/);
    if (match && match[1]) {
      match[1].split(',').forEach((f) => {
        const clean = f.trim();
        if (clean) flags.add(clean);
      });
    }
    // Backward compatibility with previous separate hint cookies
    if (new RegExp(`(?:^|;\\s*)${LEGACY_SPIKE_COOKIE}=1(?:;|$)`).test(document.cookie)) {
      flags.add('spike');
    }
    if (new RegExp(`(?:^|;\\s*)${LEGACY_LOAD_COOKIE}=1(?:;|$)`).test(document.cookie)) {
      flags.add('load');
    }
    return flags;
  }

  function hasHintFlag(flag) {
    return readHintsSet().has(flag);
  }

  function setHintFlag(flag) {
    const flags = readHintsSet();
    flags.add(flag);
    document.cookie = `${HINTS_COOKIE}=${Array.from(flags).join(',')}; path=/; max-age=31536000; SameSite=Lax`;
  }

  window.fpsLabHints = {
    has: hasHintFlag,
    mark: setHintFlag
  };

  if (/[?&]reset_hints=1(?:&|$)/.test(window.location.search)) {
    document.cookie = `${HINTS_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    document.cookie = `${LEGACY_SPIKE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    document.cookie = `${LEGACY_LOAD_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  }

  let spikeHintDone = hasHintFlag('spike');
  let loadHintDone = spikeHintDone || hasHintFlag('load');
  let heartbeatTimerId = null;
  let heartbeatClearSpikeId = null;
  let heartbeatClearLoadId = null;
  let heartbeatFirstFired = false;
  const mobSpikeBtnEl = document.getElementById('mobSpikeBtn');

  function clearHeartbeatVisuals(includeSpike = true, includeLoad = true) {
    if (includeSpike) {
      if (heartbeatClearSpikeId) {
        clearTimeout(heartbeatClearSpikeId);
        heartbeatClearSpikeId = null;
      }
      if (dom.explodeBtn) dom.explodeBtn.classList.remove('is-heartbeat');
      if (mobSpikeBtnEl) mobSpikeBtnEl.classList.remove('is-heartbeat');
    }
    if (includeLoad) {
      if (heartbeatClearLoadId) {
        clearTimeout(heartbeatClearLoadId);
        heartbeatClearLoadId = null;
      }
      if (dom.loadPod) dom.loadPod.classList.remove('is-heartbeat');
    }
  }

  function stopHeartbeatTimer() {
    if (heartbeatTimerId) {
      clearTimeout(heartbeatTimerId);
      heartbeatTimerId = null;
    }
  }

  function canRunHeartbeats() {
    if (spikeHintDone) return false;
    const root = document.documentElement;
    if (root.classList.contains('is-intro-replay')) {
      return false;
    }
    if (document.visibilityState === 'hidden') return false;
    return true;
  }

  function triggerHeartbeatPulse() {
    heartbeatTimerId = null;
    if (!canRunHeartbeats()) return;

    // Pulse Load Spike button (desktop + mobile mini bar)
    const spikeTargets = [dom.explodeBtn, mobSpikeBtnEl].filter(Boolean);
    spikeTargets.forEach((el) => {
      el.classList.remove('is-heartbeat');
      void el.offsetWidth;
      el.classList.add('is-heartbeat');
    });
    if (heartbeatClearSpikeId) clearTimeout(heartbeatClearSpikeId);
    heartbeatClearSpikeId = setTimeout(() => {
      spikeTargets.forEach((el) => el.classList.remove('is-heartbeat'));
      heartbeatClearSpikeId = null;
    }, 1150);

    // Pulse Load slider pod with left-to-right glossy sheen (unless slider already interacted with)
    if (!loadHintDone && dom.loadPod) {
      dom.loadPod.classList.remove('is-heartbeat');
      void dom.loadPod.offsetWidth;
      dom.loadPod.classList.add('is-heartbeat');
      if (heartbeatClearLoadId) clearTimeout(heartbeatClearLoadId);
      heartbeatClearLoadId = setTimeout(() => {
        if (dom.loadPod) dom.loadPod.classList.remove('is-heartbeat');
        heartbeatClearLoadId = null;
      }, 1050);
    }

    heartbeatFirstFired = true;
    scheduleNextHeartbeat();
  }

  function scheduleNextHeartbeat() {
    stopHeartbeatTimer();
    if (!canRunHeartbeats()) return;
    const delayMs = heartbeatFirstFired
      ? Math.round(HEARTBEAT_MIN_MS + Math.random() * (HEARTBEAT_MAX_MS - HEARTBEAT_MIN_MS))
      : HEARTBEAT_FIRST_MS;
    heartbeatTimerId = setTimeout(triggerHeartbeatPulse, delayMs);
  }

  function markSpikeInteracted() {
    spikeHintDone = true;
    loadHintDone = true;
    setHintFlag('spike');
    stopHeartbeatTimer();
    clearHeartbeatVisuals(true, true);
  }

  function markLoadInteracted() {
    if (loadHintDone) return;
    loadHintDone = true;
    setHintFlag('load');
    clearHeartbeatVisuals(false, true);
  }

  window.addEventListener('fpslab:intro-replay-started', () => {
    stopHeartbeatTimer();
    clearHeartbeatVisuals(true, true);
  });

  window.addEventListener('fpslab:intro-unlocked', () => {
    scheduleNextHeartbeat();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopHeartbeatTimer();
      clearHeartbeatVisuals(true, true);
    } else {
      scheduleNextHeartbeat();
    }
  });

  // ============================================================================
  // SECTION 3 (SIMULATION): CONSTANT 30 HZ PHYSICS STEP ACROSS ENVIRONMENTS
  // ============================================================================
  const PHYS_FIXED_DT = 1 / 30; // 33.333 ms constant simulation step
  const PHYS_WORLD_W = 1000;
  const PHYS_WORLD_H = 260;
  const PHYS_START_X = 190;
  const PHYS_LEDGE_Y = 186;
  const PHYS_LEDGE_X1 = 532;
  const PHYS_LEDGE_X2 = 884;
  const PHYS_SLAB_H = 12;
  const PHYS_CYCLE_PAUSE_SEC = 0.58;

  const PHYS_ENVIRONMENTS = [
    {
      id: 1,
      tier: 'low',
      swatch: 'swatch-60',
      pillClass: 'good',
      title: 'Fixed 30 Hz + Physics Interp',
      shortTitle: 'Decoupled 30 Hz',
      impact: 'Same landing every time',
      desc: 'In this demo, both balls land in the same place when the rendering rate changes because physics uses a fixed 30 Hz step. Physics interpolation draws between the two most recent steps for smooth motion.',
      more: {
        look: 'Both green landing dots stack on the exact same spot every cycle, and the ball glides smoothly between the green 30 Hz step ticks along the bottom strip.',
        why: 'The renderer draws the ball between its two most recent physics positions (physics interpolation). That makes movement look smooth at 60 Hz or 120 Hz and introduces a visual delay of one physics step (~33 ms here).',
        takeaway: 'In this demo, the ball lands in the same place even when rendering rate or Load changes because physics uses a fixed 30 Hz step—separate from simulated frame interpolation used in Motion.'
      }
    },
    {
      id: 2,
      tier: 'mid',
      swatch: 'swatch-40',
      pillClass: 'mid',
      title: '30 Hz on 60/120 Hz · No Physics Interp',
      shortTitle: '60/120 Hz · No Interp',
      impact: 'Exact landing · Repeated frames',
      desc: 'The bottom ball still lands in the exact same place because physics uses a fixed 30 Hz step—but without physics interpolation, it repeats each position across display refreshes.',
      more: {
        look: 'Compare the motion trail in the bottom box against the top box (try 0.25× Speed to see it clearly). The ball holds still for multiple screen refreshes before stepping forward.',
        why: 'Physics ticks steadily at 30 Hz, so the jump never drifts. Without physics interpolation between the two most recent steps, 60 Hz shows every position twice (120 Hz four times), and rates like 144 Hz produce uneven holds.',
        takeaway: 'Gameplay timing stays consistent across render rates, but movement looks stepped on high-refresh monitors unless the engine adds physics interpolation.'
      }
    },
    {
      id: 3,
      tier: 'warn',
      swatch: 'swatch-40',
      pillClass: 'warn',
      title: 'Variable Frame Step',
      shortTitle: 'Variable Frame Step',
      impact: 'Jumps overshoot or miss',
      desc: 'In this example, physics updates once per rendered frame. Changing the step size changes the calculated path, so some jumps overshoot and others fall short into the gap.',
      more: {
        look: 'The top box lands on the yellow target every jump. In the bottom box, shorter frame steps overshoot while frame hitches fall short into the gap (red × marks).',
        why: 'Each rendered frame runs one simple Euler integration step—updating speed and position once using that frame’s duration. Because gravity and air drag change mid-flight, varying step size bends the calculated arc.',
        takeaway: 'When physics depends on rendered frame duration, a jump that lands cleanly at one frame rate can miss during frame drops or on another refresh rate.'
      }
    },
    {
      id: 4,
      tier: 'high',
      swatch: 'swatch-30',
      pillClass: 'bad',
      title: 'Tied to Monitor Refresh (2× Speed on 60 Hz)',
      shortTitle: 'Tied to Monitor Refresh',
      impact: '2× speed at 60 Hz',
      desc: 'The test advances physics by 1/30 of a second on every rendered frame. At baseline load it runs 2× as fast at 60 Hz, 4× at 120 Hz, and slows down when frames drop.',
      more: {
        look: 'Count how many times the bottom ball completes the jump while the top ball finishes once. Then raise the Console Load slider: as frame rate drops, the bottom simulation slows down.',
        why: 'Instead of tracking real elapsed time, the loop advances physics by a fixed 1/30 s on each rendered frame. At 60 Hz it steps twice as often as 30 Hz (four times at 120 Hz).',
        takeaway: 'Tying fixed physics steps directly to rendered frames makes game speed depend on monitor refresh rate and frame drops—a classic issue in older 30 FPS games unlocked on PC.'
      }
    },
    {
      id: 5,
      tier: 'high',
      swatch: 'swatch-30',
      pillClass: 'bad',
      title: 'Constant 30 Hz Limits',
      shortTitle: '30 Hz Limit: Falling Through Floors',
      impact: 'Falls through floor',
      desc: 'The test checks for overlap only at the end of each 30 Hz step. A fast-moving ball can cross the entire thin floor between checks. The reference checks the path traveled during the step.',
      more: {
        look: 'Compare both boxes as the ball drops onto the thin floor. In the bottom box, Step 1 catches the ball above the floor and Step 2 lands below it—crossing right through.',
        why: 'Checking overlap only at discrete 30 Hz positions leaves gaps between checks. When an object moves farther in one step than a floor is thick, it crosses without ever overlapping (tunneling).',
        takeaway: 'Slow fixed timesteps need continuous path checks between steps (as the top box uses) or higher tick rates so fast objects do not clip through thin geometry.'
      }
    }
  ];

  const physEls = {
    section: document.getElementById('physicsSection'),
    refCanvas: document.getElementById('physRefCanvas'),
    testCanvas: document.getElementById('physTestCanvas'),
    refMeta: document.getElementById('physRefMeta'),
    refTitle: document.querySelector('#physTrackRef .phys-chamber-title h3'),
    testMeta: document.getElementById('physTestMeta'),
    testTrack: document.getElementById('physTrackTest'),
    testSwatch: document.getElementById('physTestSwatch'),
    testTitle: document.getElementById('physTestTitle'),
    envBtns: Array.from(document.querySelectorAll('.phys-env-btn')),
    footerCard: document.getElementById('physicsFooterCard'),
    footerNum: document.getElementById('physFooterNum'),
    footerTitle: document.getElementById('physFooterTitle'),
    footerDesc: document.getElementById('physFooterDesc'),
    impactTag: document.getElementById('physImpactTag'),
    meterBars: Array.from(document.querySelectorAll('#physFooterMeter span')),
    moreBtn: document.getElementById('physMoreBtn'),
    morePane: document.getElementById('physMorePane'),
    moreBackdrop: document.getElementById('physMoreBackdrop'),
    moreCloseBtn: document.getElementById('physMoreCloseBtn'),
    moreBadge: document.getElementById('physMoreBadge'),
    moreTitle: document.getElementById('physMoreTitle'),
    moreLook: document.getElementById('physMoreLook'),
    moreWhy: document.getElementById('physMoreWhy'),
    moreTakeaway: document.getElementById('physMoreTakeaway')
  };

  const physState = {
    env: 1,
    refArcNormal: [],
    refLandNormal: 550.6,
    refArcTunnel: [],
    refLandTunnel: 599.6,
    ref: null,
    test: null
  };

  function getPhysParams(isTunnelMode) {
    return isTunnelMode
      ? { vx0: 1140, vy0: -628, vT: 220, dragR: 3.4, gUp: 1180, gDown: 2950 }
      : { vx0: 1080, vy0: -470, vT: 220, dragR: 5.6, gUp: 690, gDown: 1950 };
  }

  function precomputePhysReference(isTunnelMode) {
    const p = getPhysParams(isTunnelMode);
    let x = PHYS_START_X;
    let y = PHYS_LEDGE_Y;
    let vx = p.vx0;
    let vy = p.vy0;
    const pts = [{ x, y }];
    let landX = 550.6;
    for (let k = 0; k < 90; k++) {
      const px = x;
      const py = y;
      const g = vy < 0 ? p.gUp : p.gDown;
      vx += (p.vT - vx) * Math.min(1.4, p.dragR * PHYS_FIXED_DT);
      vy += g * PHYS_FIXED_DT;
      x += vx * PHYS_FIXED_DT;
      y += vy * PHYS_FIXED_DT;
      if (x >= PHYS_LEDGE_X1 && x <= PHYS_LEDGE_X2 && vy > 0 && py <= PHYS_LEDGE_Y && y >= PHYS_LEDGE_Y) {
        const f = (PHYS_LEDGE_Y - py) / Math.max(0.001, y - py);
        landX = px + (x - px) * f;
        pts.push({ x: landX, y: PHYS_LEDGE_Y });
        break;
      }
      pts.push({ x, y });
      if (y > PHYS_WORLD_H - 12) break;
    }
    return { pts, landX };
  }

  {
    const norm = precomputePhysReference(false);
    physState.refArcNormal = norm.pts;
    physState.refLandNormal = norm.landX;
    const tun = precomputePhysReference(true);
    physState.refArcTunnel = tun.pts;
    physState.refLandTunnel = tun.landX;
  }

  function createPhysChamberState(isTunnelMode) {
    const p = getPhysParams(isTunnelMode);
    return {
      x: PHYS_START_X,
      y: PHYS_LEDGE_Y,
      prevX: PHYS_START_X,
      prevY: PHYS_LEDGE_Y,
      vx: p.vx0,
      vy: p.vy0,
      dispX: PHYS_START_X,
      dispY: PHYS_LEDGE_Y,
      landed: false,
      fell: false,
      tunneled: false,
      tunnelFrom: null,
      tunnelTo: null,
      pauseTimer: 0,
      accumSec: 0,
      renderAccumSec: 0,
      wallClockSec: 0,
      simClockSec: 0,
      speedRatio: 1.0,
      lastDriftPx: 0,
      maxDriftPx: 0,
      missedCount: 0,
      totalJumps: 0,
      history: [],
      trail: [],
      ticks: [], // { t, type: 'render' | 'step' | 'stall' }
      frameSeq: 0,
      holdCount: 1,
      lastHoldCount: 1,
      stepsThisFrame: 0
    };
  }

  function resetBodyForNextJump(ch, isTunnelMode) {
    const p = getPhysParams(isTunnelMode);
    ch.x = PHYS_START_X;
    ch.y = PHYS_LEDGE_Y;
    ch.prevX = PHYS_START_X;
    ch.prevY = PHYS_LEDGE_Y;
    ch.vx = p.vx0;
    ch.vy = p.vy0;
    ch.dispX = PHYS_START_X;
    ch.dispY = PHYS_LEDGE_Y;
    ch.landed = false;
    ch.fell = false;
    ch.tunneled = false;
    ch.tunnelFrom = null;
    ch.tunnelTo = null;
    ch.pauseTimer = 0;
    ch.trail = [{ x: PHYS_START_X, y: PHYS_LEDGE_Y }];
  }

  function stepSingleJumpBody(ch, dtSec, isTunnelMode, useDiscreteCollision) {
    const p = getPhysParams(isTunnelMode);
    const refLandX = isTunnelMode ? physState.refLandTunnel : physState.refLandNormal;
    ch.prevX = ch.x;
    ch.prevY = ch.y;

    if (ch.landed || ch.fell) {
      ch.pauseTimer += dtSec;
      if (ch.pauseTimer >= PHYS_CYCLE_PAUSE_SEC) {
        resetBodyForNextJump(ch, isTunnelMode);
      }
      return;
    }

    const g = ch.vy < 0 ? p.gUp : p.gDown;
    ch.vx += (p.vT - ch.vx) * Math.min(1.4, p.dragR * dtSec);
    ch.vy += g * dtSec;
    ch.x += ch.vx * dtSec;
    ch.y += ch.vy * dtSec;

    if (ch.x >= PHYS_LEDGE_X1 && ch.x <= PHYS_LEDGE_X2 && ch.vy > 0) {
      if (useDiscreteCollision) {
        if (ch.y >= PHYS_LEDGE_Y && ch.y <= PHYS_LEDGE_Y + PHYS_SLAB_H) {
          ch.y = PHYS_LEDGE_Y;
          ch.vx = 0;
          ch.vy = 0;
          ch.landed = true;
          ch.pauseTimer = 0;
          const drift = ch.x - refLandX;
          ch.lastDriftPx = drift;
          ch.maxDriftPx = Math.max(ch.maxDriftPx, Math.abs(drift));
          ch.totalJumps += 1;
          ch.history.push({ x: ch.x, y: PHYS_LEDGE_Y, missed: false, tunneled: false });
          if (ch.history.length > 6) ch.history.shift();
          return;
        } else if (ch.prevY < PHYS_LEDGE_Y && ch.y > PHYS_LEDGE_Y + PHYS_SLAB_H && !ch.tunneled) {
          ch.tunneled = true;
          ch.tunnelFrom = { x: ch.prevX, y: ch.prevY };
          ch.tunnelTo = { x: ch.x, y: ch.y };
        }
      } else if (ch.prevY <= PHYS_LEDGE_Y && ch.y >= PHYS_LEDGE_Y) {
        const f = (PHYS_LEDGE_Y - ch.prevY) / Math.max(0.001, ch.y - ch.prevY);
        const lx = ch.prevX + (ch.x - ch.prevX) * f;
        ch.x = lx;
        ch.y = PHYS_LEDGE_Y;
        ch.vx = 0;
        ch.vy = 0;
        ch.landed = true;
        ch.pauseTimer = 0;
        const drift = lx - refLandX;
        ch.lastDriftPx = drift;
        ch.maxDriftPx = Math.max(ch.maxDriftPx, Math.abs(drift));
        ch.totalJumps += 1;
        ch.history.push({ x: lx, y: PHYS_LEDGE_Y, missed: false, tunneled: false });
        if (ch.history.length > 6) ch.history.shift();
        return;
      }
    }

    if (ch.y >= PHYS_WORLD_H - 14) {
      ch.y = PHYS_WORLD_H - 14;
      ch.vx = 0;
      ch.vy = 0;
      ch.fell = true;
      ch.pauseTimer = 0;
      const drift = ch.x - refLandX;
      ch.lastDriftPx = drift;
      ch.maxDriftPx = Math.max(ch.maxDriftPx, Math.abs(drift));
      ch.missedCount += 1;
      ch.totalJumps += 1;
      ch.history.push({ x: ch.x, y: PHYS_WORLD_H - 14, missed: true, tunneled: ch.tunneled });
      if (ch.history.length > 6) ch.history.shift();
    }
  }

  function recordPhysTick(ch, type) {
    ch.ticks.push({ t: ch.wallClockSec, type });
    const cutoff = ch.wallClockSec - 1.15;
    while (ch.ticks.length && ch.ticks[0].t < cutoff) {
      ch.ticks.shift();
    }
  }

  function getPhysRenderFrameSec(ch, displayHz, envMode) {
    const refreshPeriodMs = 1000 / displayHz;
    if (envMode === 4) {
      // Lightweight 30 FPS game running unlocked on 60/120 Hz hardware: renders in ~6.5 ms at Load 1.0 -> 2x at 60 Hz, 4x at 120 Hz, slows down under Console Load
      const renderMs = 6.5 + (state.consoleLoad - 1.0) * 8.5 + state.simSpikeMs;
      const ticksHeld = Math.max(1, Math.ceil(renderMs / refreshPeriodMs));
      return (ticksHeld * refreshPeriodMs) / 1000;
    }
    let renderMs = getRenderTimeMs('60', state.consoleLoad, ch.frameSeq, state.simSpikeMs);
    if (envMode === 3) {
      // Env 3 (Bad Variable Δt): alternate clean high-FPS jumps (overshoot) with hitched jumps (65–90 ms drops that fall into the gap!)
      const isHitchJump = (ch.totalJumps % 2 === 1) || state.consoleLoad > 1.25;
      if (isHitchJump) {
        const phase = ch.frameSeq % 9;
        if (phase === 2 || phase === 6) {
          renderMs += 62 + (ch.frameSeq % 3) * 14;
        }
      } else {
        // Clean high-FPS run so 120 Hz actually steps at 8.33 ms and 60 Hz at 16.67 ms (showing pure Δt integration overshoot)
        renderMs = 6.5 + state.simSpikeMs;
      }
    }
    const ticksHeld = Math.max(1, Math.ceil(renderMs / refreshPeriodMs));
    return (ticksHeld * refreshPeriodMs) / 1000;
  }

  function resetPhysicsChambers() {
    const isTunnel = physState.env === 5;
    physState.ref = createPhysChamberState(isTunnel);
    physState.test = createPhysChamberState(isTunnel);
  }

  function stepPhysicsChambers(dtSimMs) {
    if (!physState.ref || !physState.test) resetPhysicsChambers();
    const dtWallSec = Math.max(0, Math.min(0.08, dtSimMs / 1000));
    if (dtWallSec <= 0) return;

    const env = physState.env;
    const isTunnel = env === 5;
    const refHz = state.displayHz;
    const testHz = state.displayHz;

    // 1. REFERENCE TRACK: Always proper fixed 30 Hz accumulator + prev/curr state interpolation
    {
      const ch = physState.ref;
      ch.wallClockSec += dtWallSec;
      ch.renderAccumSec += dtWallSec;
      const frameSec = getPhysRenderFrameSec(ch, refHz, 1);
      while (ch.renderAccumSec >= frameSec) {
        ch.renderAccumSec -= frameSec;
        ch.frameSeq += 1;
        recordPhysTick(ch, 'render');
        ch.accumSec += frameSec;
        let steps = 0;
        while (ch.accumSec >= PHYS_FIXED_DT && steps < 6) {
          stepSingleJumpBody(ch, PHYS_FIXED_DT, isTunnel, false);
          ch.accumSec -= PHYS_FIXED_DT;
          ch.simClockSec += PHYS_FIXED_DT;
          steps += 1;
          recordPhysTick(ch, 'step');
        }
        ch.stepsThisFrame = steps;
        const alpha = ch.accumSec / PHYS_FIXED_DT;
        ch.dispX = ch.prevX + (ch.x - ch.prevX) * alpha;
        ch.dispY = ch.prevY + (ch.y - ch.prevY) * alpha;
        ch.trail.push({ x: ch.dispX, y: ch.dispY });
        if (ch.trail.length > 16) ch.trail.shift();
      }
      ch.speedRatio = 1.0;
    }

    // 2. TEST TRACK: Selected environment 1..5
    {
      const ch = physState.test;
      ch.wallClockSec += dtWallSec;
      ch.renderAccumSec += dtWallSec;
      const frameSec = getPhysRenderFrameSec(ch, testHz, env);
      while (ch.renderAccumSec >= frameSec) {
        ch.renderAccumSec -= frameSec;
        ch.frameSeq += 1;
        recordPhysTick(ch, 'render');

        if (env === 1) {
          // Good: Decoupled 30 Hz accumulator + state interpolation
          ch.accumSec += frameSec;
          let steps = 0;
          while (ch.accumSec >= PHYS_FIXED_DT && steps < 6) {
            stepSingleJumpBody(ch, PHYS_FIXED_DT, false, false);
            ch.accumSec -= PHYS_FIXED_DT;
            ch.simClockSec += PHYS_FIXED_DT;
            steps += 1;
            recordPhysTick(ch, 'step');
          }
          ch.stepsThisFrame = steps;
          const alpha = ch.accumSec / PHYS_FIXED_DT;
          ch.dispX = ch.prevX + (ch.x - ch.prevX) * alpha;
          ch.dispY = ch.prevY + (ch.y - ch.prevY) * alpha;
          ch.speedRatio = 1.0;
        } else if (env === 2) {
          // Fixed 30 Hz on 60/120/144 Hz WITHOUT interpolation (raw curr state -> repeated display holds)
          ch.accumSec += frameSec;
          let steps = 0;
          while (ch.accumSec >= PHYS_FIXED_DT && steps < 6) {
            stepSingleJumpBody(ch, PHYS_FIXED_DT, false, false);
            ch.accumSec -= PHYS_FIXED_DT;
            ch.simClockSec += PHYS_FIXED_DT;
            steps += 1;
            recordPhysTick(ch, 'step');
          }
          ch.stepsThisFrame = steps;
          if (steps > 0) {
            ch.lastHoldCount = ch.holdCount;
            ch.holdCount = 1;
          } else {
            ch.holdCount += 1;
          }
          ch.dispX = ch.x;
          ch.dispY = ch.y;
          ch.speedRatio = 1.0;
        } else if (env === 3) {
          // Bad: Variable Δt ("multiply by dt") tied to render frame time & drops
          stepSingleJumpBody(ch, frameSec, false, false);
          ch.simClockSec += frameSec;
          ch.stepsThisFrame = 1;
          recordPhysTick(ch, 'step');
          ch.dispX = ch.x;
          ch.dispY = ch.y;
          ch.speedRatio = 1.0;
        } else if (env === 4) {
          // Tick-Locked 30 Hz: step(1/30) called ONCE per rendered V-Sync frame -> 2x at 60 Hz, 4x at 120 Hz, slow-mo on Load!
          stepSingleJumpBody(ch, PHYS_FIXED_DT, false, false);
          ch.simClockSec += PHYS_FIXED_DT;
          ch.stepsThisFrame = 1;
          recordPhysTick(ch, 'step');
          ch.dispX = ch.x;
          ch.dispY = ch.y;
          const effRenderFps = 1 / Math.max(0.004, frameSec);
          ch.speedRatio = effRenderFps / 30;
        } else if (env === 5 && isTunnel) {
          // 5A · Coarse 33.3 ms step discrete tunneling
          ch.accumSec += frameSec;
          let steps = 0;
          while (ch.accumSec >= PHYS_FIXED_DT && steps < 6) {
            stepSingleJumpBody(ch, PHYS_FIXED_DT, true, true);
            ch.accumSec -= PHYS_FIXED_DT;
            ch.simClockSec += PHYS_FIXED_DT;
            steps += 1;
            recordPhysTick(ch, 'step');
          }
          ch.stepsThisFrame = steps;
          const alpha = ch.accumSec / PHYS_FIXED_DT;
          ch.dispX = ch.prevX + (ch.x - ch.prevX) * alpha;
          ch.dispY = ch.prevY + (ch.y - ch.prevY) * alpha;
          ch.speedRatio = 1.0;
        }

        ch.trail.push({ x: ch.dispX, y: ch.dispY });
        if (ch.trail.length > 16) ch.trail.shift();
      }
    }
  }

  function drawSinglePhysChamber(canvas, ch, isReference) {
    if (!canvas || !ch) return;
    const { ctx, w, h } = setupCanvas(canvas);
    if (w < 10 || h < 10) return;

    const env = physState.env;
    const isTunnel = env === 5;
    const refPts = isTunnel ? physState.refArcTunnel : physState.refArcNormal;
    const refLandX = isTunnel ? physState.refLandTunnel : physState.refLandNormal;

    const stripH = 16;
    const drawH = Math.max(40, h - stripH);
    const sx = w / PHYS_WORLD_W;
    const sy = drawH / PHYS_WORLD_H;

    // Background
    ctx.fillStyle = '#11141c';
    ctx.fillRect(0, 0, w, h);

    // Subtle engineering grid
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 80; gx < PHYS_WORLD_W; gx += 80) {
      const px = Math.round(gx * sx) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, drawH);
    }
    for (let gy = 52; gy < PHYS_WORLD_H; gy += 52) {
      const py = Math.round(gy * sy) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
    }
    ctx.stroke();

    // Hazard gap floor
    const gapX1 = 210 * sx;
    const gapX2 = PHYS_LEDGE_X1 * sx;
    ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
    ctx.fillRect(gapX1, drawH - 14 * sy, gapX2 - gapX1, 14 * sy);
    ctx.strokeStyle = 'rgba(248, 113, 113, 0.32)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(gapX1, drawH - 14 * sy);
    ctx.lineTo(gapX2, drawH - 14 * sy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Start platform (solid left ground)
    const ledgeY = PHYS_LEDGE_Y * sy;
    ctx.fillStyle = '#1e2536';
    ctx.fillRect(28 * sx, ledgeY, (210 - 28) * sx, drawH - ledgeY);
    ctx.fillStyle = '#64748b';
    ctx.fillRect(28 * sx, ledgeY, (210 - 28) * sx, Math.max(2, 3 * sy));
    // Launch pad accent
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect((PHYS_START_X - 18) * sx, ledgeY, 36 * sx, Math.max(2.5, 3.5 * sy));

    // Target thin precision platform (12 px floating slab!)
    const lx1 = PHYS_LEDGE_X1 * sx;
    const lx2 = PHYS_LEDGE_X2 * sx;
    const slabPxH = Math.max(5, PHYS_SLAB_H * sy);
    ctx.fillStyle = isTunnel ? 'rgba(248, 113, 113, 0.22)' : '#1e293b';
    ctx.fillRect(lx1, ledgeY, lx2 - lx1, slabPxH);
    ctx.strokeStyle = isTunnel ? 'rgba(248, 113, 113, 0.72)' : 'rgba(52, 211, 153, 0.65)';
    ctx.lineWidth = 1.25;
    ctx.strokeRect(lx1 + 0.5, ledgeY + 0.5, lx2 - lx1 - 1, slabPxH - 1);
    ctx.fillStyle = isTunnel ? '#f87171' : '#34d399';
    ctx.fillRect(lx1, ledgeY, lx2 - lx1, Math.max(2, 2.5 * sy));

    // Target bullseye line at exact 30 Hz landing X
    const targetX = refLandX * sx;
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(targetX, ledgeY - 26 * sy);
    ctx.lineTo(targetX, ledgeY + slabPxH + 6);
    ctx.stroke();
    ctx.setLineDash([]);

    // Labels for geometry
    ctx.font = '700 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    ctx.fillText('LAUNCH', 38 * sx, ledgeY + Math.min(18, (drawH - ledgeY) * 0.52));
    ctx.fillStyle = 'rgba(248, 113, 113, 0.62)';
    ctx.fillText('GAP', (gapX1 + gapX2) * 0.5 - 10, drawH - 18 * sy);
    ctx.fillStyle = isTunnel ? 'rgba(252, 165, 165, 0.85)' : 'rgba(110, 231, 183, 0.8)';
    ctx.fillText(
      isTunnel ? 'THIN FLOOR' : 'TARGET LEDGE',
      lx2 - (isTunnel ? 66 : 82),
      isTunnel ? ledgeY - 6 : ledgeY + slabPxH + 12
    );

    // Dotted golden 30 Hz reference arc
    if (refPts.length > 1) {
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.34)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      refPts.forEach((pt, idx) => {
        const px = pt.x * sx;
        const py = pt.y * sy;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // Faint 30 Hz tick dots along reference arc
      ctx.fillStyle = 'rgba(250, 204, 21, 0.42)';
      for (let i = 0; i < refPts.length; i += 2) {
        ctx.beginPath();
        ctx.arc(refPts[i].x * sx, refPts[i].y * sy, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Tunneling skipped-step visual highlight (Env 5A: Step 1 above -> Step 2 below)
    if (!isReference && ch.tunneled && ch.tunnelFrom && ch.tunnelTo) {
      const x1 = ch.tunnelFrom.x * sx;
      const y1 = ch.tunnelFrom.y * sy;
      const x2 = ch.tunnelTo.x * sx;
      const y2 = ch.tunnelTo.y * sy;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2.4;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Two clear step circles: Step 1 (above floor) & Step 2 (below floor)
      [
        { x: x1, y: y1, lbl: 'Step 1 (above)' },
        { x: x2, y: y2, lbl: 'Step 2 (below)' }
      ].forEach((pt, idx) => {
        ctx.fillStyle = '#11141c';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#f87171';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.font = '700 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = '#fecaca';
        ctx.fillText(pt.lbl, Math.min(w - 92, pt.x + 10), idx === 0 ? pt.y - 3 : pt.y + 8);
      });

      const badgeTxt = 'SKIPPED FLOOR IN 1 STEP!';
      ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const bw = ctx.measureText(badgeTxt).width + 14;
      const bx = Math.max(12, Math.min(w - bw - 8, x1 - bw - 14));
      const by = Math.max(10, ledgeY - 26);
      ctx.fillStyle = 'rgba(127, 29, 29, 0.94)';
      ctx.fillRect(bx, by, bw, 20);
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.72)';
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, 19);
      ctx.fillStyle = '#fecaca';
      ctx.fillText(badgeTxt, bx + 7, by + 13.5);
    }

    // Landing history pips (last 6 jumps)
    ch.history.forEach((item, idx) => {
      const px = item.x * sx;
      const py = item.y * sy;
      const alpha = 0.45 + (idx / Math.max(1, ch.history.length)) * 0.55;
      if (item.missed) {
        ctx.strokeStyle = `rgba(248, 113, 113, ${alpha.toFixed(2)})`;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(px - 4, py - 4);
        ctx.lineTo(px + 4, py + 4);
        ctx.moveTo(px + 4, py - 4);
        ctx.lineTo(px - 4, py + 4);
        ctx.stroke();
      } else {
        ctx.fillStyle = isReference || env <= 2
          ? `rgba(52, 211, 153, ${alpha.toFixed(2)})`
          : `rgba(251, 191, 36, ${alpha.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(px, py - 3, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Puck color based on track status
    const puckColor = isReference || env === 1
      ? '#10b981'
      : env === 2
        ? '#f59e0b'
        : env === 3
          ? '#fb923c'
          : '#ef4444';

    // Motion trail
    if (ch.trail.length > 1) {
      for (let i = 1; i < ch.trail.length; i++) {
        const a = (i / ch.trail.length) * 0.5;
        ctx.strokeStyle = puckColor;
        ctx.globalAlpha = a;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(ch.trail[i - 1].x * sx, (ch.trail[i - 1].y - 8) * sy);
        ctx.lineTo(ch.trail[i].x * sx, (ch.trail[i].y - 8) * sy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Active jumper puck
    const puckX = ch.dispX * sx;
    const puckY = (ch.dispY - 8) * sy;
    const pr = Math.max(5.5, Math.min(8.5, 7.5 * Math.min(sx, sy * 1.4)));
    ctx.fillStyle = puckColor;
    ctx.beginPath();
    ctx.arc(puckX, puckY, pr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Bottom 16px rolling tick cadence strip (Display ticks vs 30 Hz physics step ticks)
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, drawH, w, stripH);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.beginPath();
    ctx.moveTo(0, drawH + 0.5);
    ctx.lineTo(w, drawH + 0.5);
    ctx.stroke();

    const winSec = 1.0;
    const stripLeft = 92;
    const stripW = Math.max(40, w - stripLeft - 8);
    ctx.font = '700 8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
    ctx.fillText('STEPS / VSYNC', 8, drawH + 11);

    ch.ticks.forEach((tk) => {
      const age = ch.wallClockSec - tk.t;
      if (age < 0 || age > winSec) return;
      const px = stripLeft + (1 - age / winSec) * stripW;
      if (tk.type === 'render') {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.34)';
        ctx.fillRect(px, drawH + 9, 1.2, 5);
      } else {
        ctx.fillStyle = tk.type === 'stall' ? '#ef4444' : puckColor;
        ctx.fillRect(px - 0.8, drawH + 2, 2.2, 8);
      }
    });
  }

  function drawPhysicsChambers() {
    if (!physState.ref || !physState.test) resetPhysicsChambers();
    drawSinglePhysChamber(physEls.refCanvas, physState.ref, true);
    drawSinglePhysChamber(physEls.testCanvas, physState.test, false);
  }

  function updatePhysicsReadouts() {
    if (!physState.ref || !physState.test) return;
    const env = physState.env;
    const isTunnel = env === 5;

    if (physEls.refMeta) {
      const refLbl = isTunnel
        ? '30 Hz · Checks full path · Lands safely'
        : `30 Hz · ${state.displayHz} Hz smooth · Exact`;
      physEls.refMeta.textContent = refLbl;
    }

    if (physEls.testMeta) {
      const ch = physState.test;
      let txt = '';
      if (env === 1) {
        txt = `30 Hz · ${state.displayHz} Hz smooth · Exact`;
      } else if (env === 2) {
        const hz = state.displayHz;
        txt = `30 Hz on ${hz} Hz · ${Math.round(hz / 30)}× repeat · Exact`;
      } else if (env === 3) {
        const missTxt = ch.missedCount > 0 ? ` · ${ch.missedCount} missed` : '';
        const driftTxt = Math.abs(ch.lastDriftPx) < 1.5
          ? 'Shifting arc'
          : (ch.lastDriftPx > 0 ? 'Overshot target' : 'Fell short');
        txt = `${state.displayHz} Hz var step · ${driftTxt}${missTxt}`;
      } else if (env === 4) {
        const spd = ch.speedRatio;
        const speedWord = spd > 1.15 ? 'accelerated' : (spd < 0.85 ? 'slowed' : 'normal');
        txt = `${spd.toFixed(1)}× speed (${speedWord})`;
      } else if (isTunnel) {
        txt = ch.tunneled ? '30 Hz · Fell through floor!' : '30 Hz · Only checks step points';
      }
      physEls.testMeta.textContent = txt;
    }
  }

  function applyPhysicsEnvUI() {
    const meta = PHYS_ENVIRONMENTS[physState.env - 1] || PHYS_ENVIRONMENTS[0];
    if (physEls.section) {
      physEls.section.dataset.physEnv = String(meta.id);
    }

    physEls.envBtns.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.physEnv) === meta.id);
    });

    if (physEls.refTitle) {
      physEls.refTitle.textContent = meta.id === 5
        ? 'Reference · 30 Hz (Checks Full Path)'
        : 'Reference · Fixed 30 Hz + Physics Interp';
    }
    if (physEls.testTrack) physEls.testTrack.dataset.tier = meta.tier;
    if (physEls.testSwatch) physEls.testSwatch.className = `swatch ${meta.swatch}`;
    if (physEls.testTitle) {
      let title = `Test · ${meta.title}`;
      if (meta.id === 5) {
        title = 'Test · 30 Hz (Only Checks Position on Each Step)';
      } else if (meta.id === 4) {
        title = state.displayHz === 120
          ? 'Test · Tied to Monitor (4× Speed on 120 Hz)'
          : 'Test · Tied to Monitor (2× Speed on 60 Hz)';
      }
      physEls.testTitle.textContent = title;
    }
    if (physEls.testMeta) physEls.testMeta.className = `phys-pill mono ${meta.pillClass}`;

    if (physEls.footerCard) physEls.footerCard.dataset.tier = meta.tier;
    if (physEls.footerNum) physEls.footerNum.textContent = `ENV ${meta.id}`;
    if (physEls.footerTitle) physEls.footerTitle.textContent = meta.shortTitle;
    if (physEls.footerDesc) physEls.footerDesc.textContent = meta.desc;
    if (physEls.impactTag) {
      physEls.impactTag.textContent = meta.id === 4
        ? (state.displayHz === 120 ? '4× speed at 120 Hz' : '2× speed at 60 Hz')
        : meta.impact;
    }
    physEls.meterBars.forEach((bar, idx) => {
      bar.classList.toggle('is-lit', idx < meta.id);
    });

    // Populate expandable More pane content for the active environment
    const moreContent = meta.more;
    if (physEls.morePane) physEls.morePane.dataset.tier = meta.tier;
    if (physEls.moreBadge) physEls.moreBadge.textContent = `ENV ${meta.id}`;
    if (physEls.moreTitle) physEls.moreTitle.textContent = meta.shortTitle;
    if (moreContent) {
      if (physEls.moreLook) physEls.moreLook.textContent = moreContent.look;
      if (physEls.moreWhy) physEls.moreWhy.textContent = moreContent.why;
      if (physEls.moreTakeaway) physEls.moreTakeaway.textContent = moreContent.takeaway;
    }
  }

  let physMoreOpen = false;
  const physMoreHome = physEls.morePane ? physEls.morePane.parentElement : null;

  function syncPhysMorePortal() {
    if (!physEls.morePane || !physMoreHome) return;
    const isMobile = window.innerWidth <= 820;
    if (isMobile) {
      if (physEls.morePane.parentElement !== document.body) {
        document.body.appendChild(physEls.morePane);
      }
      physEls.morePane.setAttribute('aria-modal', 'true');
    } else {
      if (physEls.morePane.parentElement !== physMoreHome) {
        physMoreHome.insertBefore(physEls.morePane, physMoreHome.firstChild);
      }
      physEls.morePane.setAttribute('aria-modal', 'false');
    }
  }

  syncPhysMorePortal();
  window.addEventListener('resize', syncPhysMorePortal, { passive: true });

  function setPhysMoreOpen(open) {
    const next = !!open;
    if (physMoreOpen === next && physEls.morePane && physEls.morePane.classList.contains('is-open') === next) {
      return;
    }
    syncPhysMorePortal();
    physMoreOpen = next;
    if (physEls.morePane) {
      if (next) void physEls.morePane.offsetWidth;
      physEls.morePane.classList.toggle('is-open', next);
      physEls.morePane.setAttribute('aria-hidden', next ? 'false' : 'true');
    }
    if (physEls.moreBackdrop) {
      physEls.moreBackdrop.classList.toggle('is-open', next);
    }
    if (physEls.moreBtn) {
      physEls.moreBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    }
  }

  if (physEls.moreBtn) {
    physEls.moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setPhysMoreOpen(!physMoreOpen);
    });
  }

  if (physEls.moreCloseBtn) {
    physEls.moreCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setPhysMoreOpen(false);
    });
  }

  if (physEls.moreBackdrop) {
    physEls.moreBackdrop.addEventListener('click', () => {
      setPhysMoreOpen(false);
    });
  }

  document.addEventListener('pointerdown', (e) => {
    if (!physMoreOpen) return;
    if (physEls.morePane && physEls.morePane.contains(e.target)) return;
    if (physEls.moreBtn && physEls.moreBtn.contains(e.target)) return;
    setPhysMoreOpen(false);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && physMoreOpen) {
      setPhysMoreOpen(false);
    }
  });

  window.addEventListener('fpslab:section-changed', () => {
    if (physMoreOpen) setPhysMoreOpen(false);
  });

  function setPhysicsEnv(id) {
    setPhysMoreOpen(false);
    physState.env = Math.max(1, Math.min(5, Number(id) || 1));
    applyPhysicsEnvUI();
    resetPhysicsChambers();
    updatePhysicsReadouts();
    requestCanvasRedraw();
    scheduleUrlSync();
  }

  function onPhysicsSettingChanged(shouldReset) {
    applyPhysicsEnvUI();
    if (shouldReset) resetPhysicsChambers();
    updatePhysicsReadouts();
  }

  physEls.envBtns.forEach((btn) => {
    btn.addEventListener('click', () => setPhysicsEnv(Number(btn.dataset.physEnv)));
  });

  applyPhysicsEnvUI();
  resetPhysicsChambers();

  // ============================================================================
  // SHAREABLE SCENARIOS & URL STATE SYNC
  // ============================================================================
  const SECTION_SLUG_TO_ID = {
    motion: 'motionSection',
    performance: 'simSection',
    perf: 'simSection',
    sim: 'simSection',
    simulation: 'physicsSection',
    physics: 'physicsSection',
    input: 'inputSection',
    pipeline: 'pipelineSection',
    timeline: 'timelineSection',
    reading: 'readingSection'
  };

  const SECTION_ID_TO_SLUG = {
    motionSection: 'motion',
    simSection: 'performance',
    physicsSection: 'simulation',
    inputSection: 'input',
    pipelineSection: 'pipeline',
    timelineSection: 'timeline',
    readingSection: 'reading'
  };

  let urlSyncActive = false;
  let isApplyingUrlParams = false;
  let urlSyncTimer = null;

  function getActiveSectionSlug() {
    if (window.fpsLabNav && typeof window.fpsLabNav.getActiveSectionId === 'function') {
      const id = window.fpsLabNav.getActiveSectionId();
      if (id && SECTION_ID_TO_SLUG[id]) return SECTION_ID_TO_SLUG[id];
    }
    const activePill = document.querySelector('.step-pill.active');
    if (activePill && activePill.dataset.target && SECTION_ID_TO_SLUG[activePill.dataset.target]) {
      return SECTION_ID_TO_SLUG[activePill.dataset.target];
    }
    return 'motion';
  }

  function buildShareUrl(explicitSectionSlug) {
    const url = new URL(window.location.href);
    const params = new URLSearchParams();
    const sectionSlug = explicitSectionSlug || getActiveSectionSlug();

    // Always include section and hz (prevents auto-detect mismatch across 60/120 Hz screens)
    params.set('section', sectionSlug);
    params.set('hz', String(state.displayHz));

    // Omit default values so links stay clean and readable while capturing every modified control
    if (state.speed !== 1) {
      params.set('speed', String(state.speed));
    }
    if (state.consoleLoadActive && Math.abs(state.consoleLoad - 1.0) >= 0.05) {
      params.set('load', state.consoleLoad.toFixed(1));
    }
    if (activeMotionScenario !== 1) {
      params.set('scenario', String(activeMotionScenario));
    }
    const activeScObj = MOTION_SCENARIOS[activeMotionScenario - 1];
    const motionDiffersFromConsole = Math.abs(state.motionLoad - state.consoleLoad) >= 0.05;
    const motionDiffersFromScenario = !activeScObj || Math.abs(state.motionLoad - activeScObj.load) >= 0.05;
    if (motionDiffersFromConsole && motionDiffersFromScenario) {
      params.set('motionload', state.motionLoad.toFixed(1));
    }
    if (Math.abs(state.simLevel - 1.0) >= 0.05) {
      params.set('sim', state.simLevel.toFixed(1));
    }
    if (physState.env !== 1) {
      params.set('phys', String(physState.env));
    }

    const viewMode = motionSectionEl && motionSectionEl.dataset.motionView === 'detailed'
      ? 'detailed'
      : 'simplified';
    if (viewMode === 'detailed') {
      params.set('view', 'detailed');
    }
    const simViewMode = simSectionEl && simSectionEl.dataset.simView === 'detailed'
      ? 'detailed'
      : 'simplified';
    if (simViewMode === 'detailed') {
      params.set('simview', 'detailed');
    }
    if (state.panSpeed !== 420) {
      params.set('vel', String(Math.round(state.panSpeed)));
    }
    if (!state.showTruePos) {
      params.set('truepos', '0');
    }
    if (!state.showArtifacts) {
      params.set('artifacts', '0');
    }
    if (state.arenaMode && state.arenaMode !== 'interp') {
      params.set('arena', state.arenaMode);
    }
    if (!state.showGhostCursor) {
      params.set('ghost', '0');
    }
    if (state.hideOSCursor) {
      params.set('hidecursor', '1');
    }
    if (typeof pipeStage === 'number' && pipeStage > 0) {
      params.set('pipe', String(pipeStage));
    }
    if (state.paused) {
      params.set('paused', '1');
    }

    url.search = params.toString();
    url.hash = '';
    return url.toString();
  }

  function scheduleUrlSync() {
    if (!urlSyncActive || isApplyingUrlParams) return;
    clearTimeout(urlSyncTimer);
    urlSyncTimer = setTimeout(() => {
      if (!urlSyncActive || isApplyingUrlParams) return;
      try {
        window.history.replaceState(null, '', buildShareUrl());
      } catch (_) {
        // Ignore history errors on restricted origins
      }
    }, 200);
  }

  window.addEventListener('fpslab:section-changed', scheduleUrlSync);

  function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
    }
    return Promise.resolve(fallbackCopyText(text));
  }

  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (_) {
      // Ignore copy errors in restricted contexts
    }
    document.body.removeChild(ta);
  }

  const shareToastEl = document.getElementById('shareToast');
  let shareToastTimer = null;
  let shareToastHideTimer = null;

  function showShareToast() {
    if (!shareToastEl) return;
    clearTimeout(shareToastTimer);
    clearTimeout(shareToastHideTimer);
    shareToastEl.hidden = false;
    // Force reflow so transition plays reliably on repeated clicks
    void shareToastEl.offsetWidth;
    shareToastEl.classList.add('is-visible');
    shareToastTimer = setTimeout(() => {
      shareToastEl.classList.remove('is-visible');
      shareToastHideTimer = setTimeout(() => {
        shareToastEl.hidden = true;
      }, 220);
    }, 2200);
  }

  const shareSetupBtn = document.getElementById('shareSetupBtn');
  const mobShareBtn = document.getElementById('mobShareBtn');
  const allShareBtns = [shareSetupBtn, mobShareBtn].filter(Boolean);
  let shareCopiedTimer = null;

  function handleGlobalShare() {
    urlSyncActive = true;
    clearTimeout(urlSyncTimer);
    const shareUrl = buildShareUrl();
    try {
      window.history.replaceState(null, '', shareUrl);
    } catch (_) {
      // Ignore history errors on file:// origins
    }
    allShareBtns.forEach((b) => {
      b.dataset.lastSharedUrl = shareUrl;
      b.classList.add('is-copied');
    });
    copyTextToClipboard(shareUrl);
    showShareToast();

    clearTimeout(shareCopiedTimer);
    shareCopiedTimer = setTimeout(() => {
      allShareBtns.forEach((b) => b.classList.remove('is-copied'));
    }, 2200);
  }

  allShareBtns.forEach((btn) => {
    btn.addEventListener('click', handleGlobalShare);
  });

  function applySharedUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const result = { explicitHz: false };
    const shareKeys = ['section', 'hz', 'speed', 'load', 'motionload', 'simload', 'physload', 'inputload', 'scenario', 'sim', 'phys', 'view', 'vel', 'truepos', 'artifacts', 'arena', 'ghost', 'hidecursor', 'pipe', 'paused'];
    const hasAnyShareParam = shareKeys.some((k) => params.has(k));

    isApplyingUrlParams = true;
    try {
      const hzParam = params.get('hz');
      if (hzParam === '60' || hzParam === '120') {
        result.explicitHz = true;
        setDisplayHz(Number(hzParam));
      }

      const speedParam = params.get('speed');
      if (speedParam !== null) {
        const spd = parseFloat(speedParam);
        if (spd === 0.25 || spd === 1) {
          setSpeed(spd);
        }
      }

      const viewParam = params.get('view');
      if (viewParam === 'detailed' || viewParam === 'simplified') {
        setMotionViewMode(viewParam);
      }

      const simViewParam = params.get('simview');
      if (simViewParam === 'detailed' || simViewParam === 'simplified') {
        setSimViewMode(simViewParam);
      }

      const loadParam = params.get('load');
      const legacyLoadParam = params.get('simload') || params.get('physload') || params.get('inputload');
      const resolvedConsoleParam = loadParam !== null ? loadParam : legacyLoadParam;
      if (resolvedConsoleParam !== null) {
        const loadVal = parseFloat(resolvedConsoleParam);
        if (Number.isFinite(loadVal) && loadVal >= 1.0 && loadVal <= 5.0) {
          setConsoleLoad(loadVal);
          lastCommittedConsoleLoad = loadVal;
        }
      }

      const scenarioParam = params.get('scenario');
      if (scenarioParam !== null) {
        const scId = parseInt(scenarioParam, 10);
        if (scId >= 1 && scId <= 5) {
          // If global load was already set and synced to this scenario, keep global inheritance; otherwise apply Motion scenario locally
          if (!state.consoleLoadActive || scId !== activeMotionScenario) {
            setMotionScenario(scId);
          }
        }
      }

      const motionLoadParam = params.get('motionload');
      if (motionLoadParam !== null) {
        const mVal = parseFloat(motionLoadParam);
        if (Number.isFinite(mVal) && mVal >= 1.0 && mVal <= 5.0) {
          setMotionScenarioLoad(mVal);
          syncMotionScenarioFromLoad(mVal);
        }
      }

      const velParam = params.get('vel');
      if (velParam !== null) {
        const velVal = parseInt(velParam, 10);
        if (Number.isFinite(velVal) && velVal >= 160 && velVal <= 760) {
          state.panSpeed = velVal;
          if (dom.panSpeedSlider) {
            dom.panSpeedSlider.value = String(velVal);
            syncRangeFill(dom.panSpeedSlider);
          }
          if (dom.panSpeedLabel) {
            dom.panSpeedLabel.textContent = `${velVal} px/s`;
          }
        }
      }

      if (params.get('truepos') === '0') {
        state.showTruePos = false;
        if (dom.toggleTruePos) dom.toggleTruePos.checked = false;
      }

      if (params.get('artifacts') === '0') {
        state.showArtifacts = false;
        if (dom.toggleArtifacts) dom.toggleArtifacts.checked = false;
      }

      const simParam = params.get('sim');
      if (simParam !== null) {
        const simVal = parseFloat(simParam);
        if (Number.isFinite(simVal) && simVal >= 1.0 && simVal <= 5.0) {
          setSimLevel(simVal);
        }
      }

      const physParam = params.get('phys');
      if (physParam !== null) {
        const physId = parseInt(physParam, 10);
        if (physId >= 1 && physId <= 5) {
          physState.env = physId;
        }
        applyPhysicsEnvUI();
        resetPhysicsChambers();
        updatePhysicsReadouts();
      }

      const arenaParam = params.get('arena');
      if (arenaParam && MODES.includes(arenaParam)) {
        state.arenaMode = arenaParam;
        document.querySelectorAll('.tab').forEach((b) => {
          b.classList.toggle('active', b.dataset.arenaMode === arenaParam);
        });
        updateArenaStaticStats();
      }

      if (params.get('ghost') === '0') {
        state.showGhostCursor = false;
        if (dom.toggleGhostCursor) dom.toggleGhostCursor.checked = false;
      }

      if (params.get('hidecursor') === '1') {
        state.hideOSCursor = true;
        if (dom.toggleHideOSCursor) dom.toggleHideOSCursor.checked = true;
        if (dom.arenaCanvas) dom.arenaCanvas.classList.add('hide-cursor');
      }

      const pipeParam = params.get('pipe');
      if (pipeParam !== null) {
        const pipeIdx = parseInt(pipeParam, 10);
        if (Number.isFinite(pipeIdx) && pipeIdx >= 0 && pipeIdx <= 4 && typeof setPipelineStep === 'function') {
          setPipelineStep(pipeIdx);
        }
      }

      if (params.get('paused') === '1' && !state.paused) {
        togglePause();
      }

      const sectionParam = params.get('section');
      let targetId = null;
      if (sectionParam && SECTION_SLUG_TO_ID[sectionParam]) {
        targetId = SECTION_SLUG_TO_ID[sectionParam];
      } else if (physParam !== null && scenarioParam === null) {
        targetId = 'physicsSection';
      } else if (simParam !== null && scenarioParam === null) {
        targetId = 'simSection';
      }

      if (targetId && targetId !== 'motionSection') {
        window.__fpsLabPendingSection = targetId;
        window.dispatchEvent(new CustomEvent('fpslab:navigate-section', {
          detail: { target: targetId, instant: true }
        }));
      }
    } finally {
      isApplyingUrlParams = false;
    }

    if (hasAnyShareParam) {
      urlSyncActive = true;
    }
    return result;
  }

  // ============================================================================
  // POWER SAVING / THROTTLED REFRESH DETECTION (CHROME ENERGY SAVER / LOW POWER)
  // ============================================================================
  const powerSaveBanner = document.getElementById('powerSaveBanner');
  const powerSaveText = document.getElementById('powerSaveText');
  const powerSaveRecheckBtn = document.getElementById('powerSaveRecheckBtn');
  const powerSaveDismissBtn = document.getElementById('powerSaveDismissBtn');
  const detectorCardEl = document.getElementById('detectorCard');

  const powerSaveTestForced = /[?&]power_save_test=1(?:&|$)/.test(window.location.search);
  let powerSaveDismissed = false;
  let batteryUnplugged = null; // null = unknown, true = on battery, false = plugged in
  let liveRafWindow = [];
  let lastPowerSaveAutoCheck = 0;

  function updatePowerSaveNotice(hz) {
    const throttled = powerSaveTestForced || (typeof hz === 'number' && hz > 0 && hz <= 45);
    if (detectorCardEl) {
      detectorCardEl.classList.toggle('is-power-save', throttled);
    }
    if (!powerSaveBanner) return;
    if (!throttled) {
      powerSaveBanner.hidden = true;
      return;
    }
    if (powerSaveDismissed) return;
    if (powerSaveText) {
      const displayHz = powerSaveTestForced ? 30 : Math.round(hz);
      const batteryHint = batteryUnplugged === true
        ? 'Your device is on battery and your browser is throttling animations'
        : 'Your browser is throttling animations';
      powerSaveText.innerHTML =
        `<strong>Power Saving Mode detected (~${displayHz} Hz):</strong> ${batteryHint} below 60 Hz (likely Chrome Energy Saver or OS Low Power Mode), so live motion and 40/60 FPS comparisons won't be precise.`;
    }
    powerSaveBanner.hidden = false;
  }

  function observeLivePowerSaveFrame(dtReal) {
    if (powerSaveTestForced || document.hidden || state.paused) return;
    if (dtReal < 3 || dtReal > 49.5) return;
    liveRafWindow.push(dtReal);
    if (liveRafWindow.length < 48) return;
    const sorted = liveRafWindow.slice().sort((a, b) => a - b);
    const medianDt = sorted[Math.floor(sorted.length / 2)];
    liveRafWindow.length = 0;

    const nowMs = performance.now();
    if (nowMs - lastPowerSaveAutoCheck < 4000) return;

    const estHz = 1000 / medianDt;
    const currentlyThrottled = !!(detectorCardEl && detectorCardEl.classList.contains('is-power-save'));
    if (!currentlyThrottled && estHz <= 38) {
      lastPowerSaveAutoCheck = nowMs;
      detectRefreshRate(false);
    } else if (currentlyThrottled && estHz >= 52) {
      lastPowerSaveAutoCheck = nowMs;
      powerSaveDismissed = false;
      detectRefreshRate(false);
    }
  }

  if (powerSaveRecheckBtn) {
    powerSaveRecheckBtn.addEventListener('click', () => {
      powerSaveDismissed = false;
      detectRefreshRate(false);
    });
  }

  if (powerSaveDismissBtn) {
    powerSaveDismissBtn.addEventListener('click', () => {
      powerSaveDismissed = true;
      if (powerSaveBanner) powerSaveBanner.hidden = true;
    });
  }

  // Progressive enhancement in Chromium: detect battery unplugged state & auto-recheck when plugged back in
  if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
    navigator.getBattery().then((bat) => {
      batteryUnplugged = !bat.charging;
      if (powerSaveBanner && !powerSaveBanner.hidden) {
        updatePowerSaveNotice(state.detectedHz || 30);
      }
      bat.addEventListener('chargingchange', () => {
        batteryUnplugged = !bat.charging;
        if (bat.charging) powerSaveDismissed = false;
        setTimeout(() => detectRefreshRate(false), 600);
      });
    }).catch(() => {
      // Ignore unsupported/restricted battery status
    });
  }

  if (powerSaveTestForced) {
    updatePowerSaveNotice(30);
  }

  // ============================================================================
  // INIT
  // ============================================================================
  const cookieBanner = document.getElementById('cookieBanner');
  const cookieOkBtn = document.getElementById('cookieOkBtn');
  if (cookieBanner && cookieOkBtn) {
    cookieOkBtn.addEventListener('click', () => {
      document.cookie = 'fps_lab_cookie_ok=1; path=/; max-age=31536000; SameSite=Lax';
      cookieBanner.classList.add('is-dismissing');
      setTimeout(() => {
        document.documentElement.classList.add('is-cookie-ok');
      }, 220);
    });
  }

  const sharedInit = applySharedUrlParams();
  syncVisibleSectionsNow();
  updateLoadDisplay();
  detectRefreshRate(!sharedInit.explicitHz);
  ensureLoopRunning();
  scheduleNextHeartbeat();
})();
