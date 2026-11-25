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
    'interp': { name: '30 FPS + Interpolation', gameFps: 30, periodMs: 1000 / 30 },
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

  // ============================================================================
  // GLOBAL STATE
  // ============================================================================
  const state = {
    detectedHz: null,
    measuredRawHz: null,
    displayHz: 60,
    speed: 1,
    load: 1.0,
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
    loadSlider: document.getElementById('loadSlider'),
    loadVal: document.getElementById('loadVal'),
    loadMs: document.getElementById('loadMs'),
    loadResetBtn: document.getElementById('loadResetBtn'),
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
  const simLevelBtns = Array.from(document.querySelectorAll('.sim-lvl-btn'));

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

  function setupCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cached = canvasCache.get(canvas);
    if (!cached) {
      cached = { ctx: canvas.getContext('2d'), w: 1, h: 1, dpr: 0, dirty: true };
      canvasCache.set(canvas, cached);
      trackedCanvases.add(canvas);
      if (canvasResizeObserver) canvasResizeObserver.observe(canvas);
    }
    if (cached.dirty || cached.dpr !== dpr || !canvasResizeObserver) {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      cached.w = w;
      cached.h = h;
      cached.dpr = dpr;
      cached.dirty = false;
    }
    cached.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    dom.detectedHz.textContent = 'Measuring…';
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
          'High-refresh display detected. Both 60 Hz and 120 Hz modes run natively.';
        if (autoSelectDisplay) setDisplayHz(120);
      } else {
        dom.detectorNote.textContent =
          '60 Hz display detected. Use 0.25× Slow-Mo to inspect 120 Hz cadence accurately.';
        if (autoSelectDisplay) setDisplayHz(60);
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
    requestCanvasRedraw();
  }

  function setSpeed(spd) {
    state.speed = spd;
    dom.btnSpeed1x.classList.toggle('active', spd === 1);
    dom.btnSpeedSlow.classList.toggle('active', spd !== 1);
    updateSimBanner();
    requestCanvasRedraw();
  }

  function updateLoadDisplay() {
    const onSim = isSectionVisible('simSection');
    const onMotion = isSectionVisible('motionSection');
    const simUi = (onSim && typeof getSimBlastUiState === 'function')
      ? getSimBlastUiState(state.tSim)
      : { active: false, charging: 0, bursting: 0, burstMs: 0 };
    const autoMotionSpikeMs = (onMotion && typeof getMotionScenarioAutoSpikeMs === 'function')
      ? getMotionScenarioAutoSpikeMs(state.tSim)
      : 0;
    const effectiveSpikeMs = onSim
      ? Math.max(state.simSpikeMs, simUi.burstMs)
      : Math.max(state.simSpikeMs, autoMotionSpikeMs);
    const sceneMs = getMeanSceneRenderMs(state.load, effectiveSpikeMs);
    const tier = (state.load >= 3.0 || effectiveSpikeMs > 8) ? 'high' : (state.load >= 1.5 || effectiveSpikeMs > 1) ? 'mid' : 'low';
    if (dom.loadPod) dom.loadPod.dataset.tier = tier;
    if (dom.loadResetBtn) dom.loadResetBtn.hidden = state.load <= 1.01;
    dom.loadVal.textContent = `${state.load.toFixed(1)}`;
    dom.loadVal.className = 'load-val mono' + (state.load >= 3.0 ? ' high' : state.load >= 1.5 ? ' mid' : '');
    dom.loadMs.textContent = `${sceneMs.toFixed(1)} ms`;
    dom.loadMs.className = 'load-ms mono' + (effectiveSpikeMs > 0.5 ? ' spike' : '');
    const motionPct = Math.max(0, Math.min(100, (state.simSpikeMs / SPIKE_PEAK_MS) * 100));
    const simPct = simUi.bursting > 0.01 ? simUi.bursting * 100 : simUi.charging * 100;
    const spikePct = Math.max(motionPct, simPct);
    dom.explodeBtn.style.setProperty('--spike-pct', `${spikePct.toFixed(1)}%`);
    dom.explodeBtn.classList.toggle('active', state.simSpikeMs > 2.0 || simUi.bursting > 0.08);
  }

  function setLoad(val, fromScenario = false) {
    state.load = Math.max(1, Math.min(5, val));
    if (!fromScenario && typeof syncMotionScenarioFromLoad === 'function') {
      syncMotionScenarioFromLoad(state.load);
    }
    updateLoadDisplay();
    if (isSectionVisible('motionSection')) updateLaneReadouts();
    if (isSectionVisible('simSection')) {
      updateSimReadouts();
      drawExpCurve();
    }
    if (isSectionVisible('inputSection')) updateArenaStaticStats();
    if (isSectionVisible('timelineSection')) drawTimeline();
    if (isSectionVisible('pipelineSection')) updatePipelineView();
    requestCanvasRedraw();
  }

  function triggerExplode() {
    if (typeof markSpikeInteracted === 'function') markSpikeInteracted();
    if (isSectionVisible('simSection') && typeof triggerSimNpcExplosion === 'function') {
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
          Your screen refreshes at <strong>${state.detectedHz} Hz</strong>, so 120 Hz cannot be shown natively at 1.0× speed.
          Switch to <strong>0.25× Slow-Mo</strong> (30 ticks/s) to view 120 Hz pacing accurately.
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
          <strong>0.25× Slow-Mo active:</strong> ${state.displayHz} Hz ticks are slowed to ${(state.displayHz * state.speed).toFixed(0)} ticks/s for frame-by-frame inspection.
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
      const meanDur = getMeanFrameDurMs(mode, state.load);
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
    const dropText = roundedDrop < 1 ? '0% drop' : `-${roundedDrop}% drop`;
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
    const load = state.load;
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
    setLaneBadges(
      '30',
      `${fps30.toFixed(1)} FPS`, drop30 ? 'warn' : '',
      dropPct30,
      `${avg30.toFixed(1)} ms`, drop30 ? 'warn' : '',
      `~${Math.round(avg30 * 1.8)} ms lag`, ''
    );
    setLaneCaption(
      '30',
      `${avg30.toFixed(1)} ms`,
      drop30
        ? `-${Math.round(dropPct30)}% eff · missed 33.3 ms`
        : (is120 ? 'Locked · even 4-4-4' : 'Locked · even 2-2-2'),
      drop30 ? 'ft-note judder' : 'ft-note'
    );
    setLaneTag(
      '30',
      drop30 ? 'Overloaded' : (spikeMs > 2 ? 'Absorbs Spike' : 'Stable'),
      drop30 ? 'warn' : 'good'
    );

    // 40 FPS (25.0 ms budget)
    const fps40 = underLoad ? getEffectiveFpsFromHistory('40') : 40.0;
    const avg40 = 1000 / Math.max(1, fps40);
    const dropPct40 = getEfficiencyDropPct(fps40, 40);
    const drop40 = dropPct40 >= 3;
    if (!drop40 && is120) {
      setLaneBadges('40', '40.0 FPS', 'good', 0, '25.0 ms', 'good', '~45 ms lag', '');
      setLaneCaption('40', '25.0 ms', 'Locked · exact 3 ticks', 'ft-note');
      setLaneTag('40', 'Stable', 'good');
    } else if (!drop40 && !is120) {
      setLaneBadges('40', '40.0 FPS (judder)', 'warn', 0, '16.7 / 33.3 ms', 'warn', '~50 ms lag', '');
      setLaneCaption('40', '16.7 / 33.3 ms', '3:2 pulldown judder', 'ft-note judder');
      setLaneTag('40', '3:2 Judder', 'judder');
    } else {
      setLaneBadges(
        '40',
        `${fps40.toFixed(1)} FPS`, 'warn',
        dropPct40,
        `${avg40.toFixed(1)} ms`, 'warn',
        `~${Math.round(avg40 * 1.85)} ms lag`, ''
      );
      setLaneCaption('40', `${avg40.toFixed(1)} ms`, `-${Math.round(dropPct40)}% eff · missed 25 ms`, 'ft-note judder');
      setLaneTag('40', spikeMs > 2 ? 'Spike Hitch' : 'Unstable', 'warn');
    }

    // 30 FPS + Interp (33.3 ms source budget)
    const interpOutMs = (1000 / hz).toFixed(1);
    const bufLag = Math.round(laneState['interp'].currentLagMs || getInterpBufferLagMs(load));
    const srcFps = Math.min(30, 1000 / Math.max(33.33, laneState['interp'].avgSrcMs || getMeanFrameDurMs('interp', load)));
    const dropPctInterp = getEfficiencyDropPct(srcFps, 30);
    const totalInterpLag = Math.round(bufLag + (1000 / srcFps) + 18);
    setLaneBadges(
      'interp',
      `${hz} Hz (${srcFps.toFixed(0)} src)`, '',
      dropPctInterp,
      `+${bufLag} ms buf`, 'warn',
      `~${totalInterpLag} ms lag`, 'warn'
    );
    setLaneCaption(
      'interp',
      `${interpOutMs} ms (+${bufLag} ms)`,
      dropPctInterp >= 3
        ? `Src -${Math.round(dropPctInterp)}% · heavy lag`
        : `${hz} Hz visual · trails true time`,
      dropPctInterp >= 3 ? 'ft-note judder' : 'ft-note'
    );
    setLaneTag(
      'interp',
      dropPctInterp >= 3 ? `+${bufLag} ms · Drops` : `+${bufLag} ms Lag`,
      dropPctInterp >= 3 ? 'warn' : 'interp'
    );

    // 60 FPS (16.7 ms budget)
    const fps60 = underLoad ? getEffectiveFpsFromHistory('60') : 60.0;
    const avg60 = 1000 / Math.max(1, fps60);
    const dropPct60 = getEfficiencyDropPct(fps60, 60);
    const drop60 = dropPct60 >= 3;
    const cls60 = drop60 ? 'warn' : 'good';
    setLaneBadges(
      '60',
      `${fps60.toFixed(1)} FPS`, cls60,
      dropPct60,
      `${avg60.toFixed(1)} ms`, cls60,
      `~${Math.round(avg60 * 1.8)} ms lag`, cls60
    );
    setLaneCaption(
      '60',
      `${avg60.toFixed(1)} ms`,
      drop60
        ? `-${Math.round(dropPct60)}% eff · missed 16.7 ms`
        : (is120 ? 'Locked · even 2-2-2' : 'Locked · even 1-1-1'),
      drop60 ? 'ft-note judder' : 'ft-note'
    );
    setLaneTag(
      '60',
      drop60 ? (spikeMs > 2 || isSpikeScenario ? 'Spike Hitch' : 'Unstable') : 'Stable',
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
            ls.srcNextReadyTime = Math.max(gamePeriod, getRenderTimeMs('interp', state.load, 1, tickSpikeMs));
          } else if (tTick + 0.001 >= ls.srcNextReadyTime) {
            const heldMs = ls.srcHoldTicks * dispPeriod;
            ls.avgSrcMs = ls.avgSrcMs * 0.75 + heldMs * 0.25;
            ls.srcFrameSeq++;
            const dur = Math.max(gamePeriod, getRenderTimeMs('interp', state.load, ls.srcFrameSeq, tickSpikeMs));
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
            const dur = Math.max(gamePeriod, getRenderTimeMs(mode, state.load, 1, tickSpikeMs));
            ls.nextFrameReadyTime = tTick + dur;
          } else if (tTick + 0.001 >= ls.nextFrameReadyTime) {
            const heldMs = ls.holdTicks * dispPeriod;
            ls.lastPresentedHoldMs = heldMs;
            ls.ftHistory.push(heldMs);
            if (ls.ftHistory.length > FT_HISTORY_LEN) ls.ftHistory.shift();

            ls.presentedTime = ls.nextFrameReadyTime;
            ls.frameSeq++;
            const dur = Math.max(gamePeriod, getRenderTimeMs(mode, state.load, ls.frameSeq, tickSpikeMs));
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
    const blindMask = isBlindGuessing();
    const color = blindMask ? '#cbd5e1' : TRACK_COLORS[mode];

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
    const hudX = Math.round(w * 0.5 - hudW / 2);
    const hudY = 9;
    const nearHud = Math.abs(blockX - w * 0.5) < 95;
    const showArt = !blindMask && mode === 'interp' && state.showArtifacts;

    // Artifacts intensify as base 30 FPS drops under heavy load
    const loadSeverity = Math.max(0, (state.load - 1.5) / 3.5);
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

    if (!blindMask && state.showTruePos) {
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
    const load = state.load;
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
        label: '30 FPS + Interpolation',
        pipelineDelayMs: totalDelay,
        estLagText: `~${Math.round(totalDelay)}–${Math.round(totalDelay + 18)} ms`,
        visualText: srcDropPct > 0
          ? `${state.displayHz} FPS (${srcFps.toFixed(0)} src, -${srcDropPct}%)`
          : `${state.displayHz} FPS (30 src, 0% drop)`,
        pacingText: srcDropPct > 0 ? 'Heavy buffer lag & hiccups' : 'Smooth visual, buffered',
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
        visualText: dropping ? `${effFps.toFixed(0)} FPS (-${dropPct}% eff)` : '60 FPS (0% drop)',
        pacingText: dropping ? 'Missed 16.7 ms budget' : (is120 ? 'Even (2-2-2)' : 'Even (1-1-1)'),
        status: dropping ? 'warn' : 'good'
      };
    }
    if (mode === '40') {
      return {
        label: '40 FPS',
        pipelineDelayMs: meanDur,
        estLagText: `~${totalLow}–${totalHigh} ms`,
        visualText: dropping ? `${effFps.toFixed(0)} FPS (-${dropPct}% eff)` : (is120 ? '40 FPS (0% drop)' : '40 FPS (0% drop, judder)'),
        pacingText: dropping ? 'Missed 25.0 ms budget' : (is120 ? 'Even (3-3-3)' : '3:2 Judder (1-2-1-2)'),
        status: (dropping || !is120) ? 'warn' : 'good'
      };
    }
    return {
      label: '30 FPS',
      pipelineDelayMs: meanDur,
      estLagText: `~${totalLow}–${totalHigh} ms`,
      visualText: dropping ? `${effFps.toFixed(0)} FPS (-${dropPct}% eff)` : '30 FPS (0% drop)',
      pacingText: dropping ? 'Missed 33.3 ms budget' : (is120 ? 'Even (4-4-4)' : 'Even (2-2-2)'),
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
        const srcPeriod = getMeanFrameDurMs('interp', state.load);
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

          const dur = Math.max(gamePeriod, getRenderTimeMs(mode, state.load, arena.frameSeq, state.realSpikeMs));
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
    const load = state.load;
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
      { mode: '30', label: '30 FPS', sub: d30 > 0 ? `-${d30}% eff (33.3 ms cap)` : '0% drop (33.3 ms cap)' },
      {
        mode: '40',
        label: '40 FPS',
        sub: d40 > 0
          ? `-${d40}% eff (25.0 ms cap)`
          : (hz === 120 ? '0% drop · even 25 ms' : '0% drop · 3:2 judder')
      },
      { mode: 'interp', label: '30 + Interp', sub: `+${Math.round(bufLagMs)} ms buf${d30 > 0 ? ` (-${d30}%)` : ''}` },
      { mode: '60', label: '60 FPS', sub: d60 > 0 ? `-${d60}% eff (16.7 ms cap)` : '0% drop (16.7 ms cap)' }
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

          const isNarrow = widthPct < 22;
          const innerHtml = widthPct >= 14
            ? `<span class="tl-txt">F${seg.frameNum}<span class="tl-dur"> (${durMs.toFixed(1)} ms)</span></span>`
            : (widthPct >= 7 ? `<span class="tl-txt">F${seg.frameNum}</span>` : '');
          const tip = `Frame F${seg.frameNum} · ${durMs.toFixed(1)} ms (${seg.ticks} refresh${seg.ticks === 1 ? '' : 'es'})`;
          blocksHtml += `<div class="tl-block ${cls}${isNarrow ? ' is-narrow' : ''}" style="--p:${startPct.toFixed(3)}%;--s:${widthPct.toFixed(3)}%;left:calc(${startPct.toFixed(3)}% + 2px);width:calc(${widthPct.toFixed(3)}% - 4px)" title="${tip}">${innerHtml}</div>`;
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
    setLoad(parseFloat(e.target.value));
  });

  dom.loadSlider.addEventListener('dblclick', () => {
    if (typeof markLoadInteracted === 'function') markLoadInteracted();
    dom.loadSlider.value = '1';
    syncRangeFill(dom.loadSlider);
    setLoad(1.0);
  });

  if (dom.loadResetBtn) {
    dom.loadResetBtn.addEventListener('click', () => {
      if (typeof markLoadInteracted === 'function') markLoadInteracted();
      dom.loadSlider.value = '1';
      syncRangeFill(dom.loadSlider);
      setLoad(1.0);
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
  }

  dom.explodeBtn.addEventListener('click', () => {
    triggerExplode();
  });

  // Keyboard shortcuts: 'S' for Load Spike, 'P' for Pause / Resume
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isBlindGuessing()) return;
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
  });

  dom.toggleArtifacts.addEventListener('change', (e) => {
    state.showArtifacts = e.target.checked;
    requestCanvasRedraw();
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
    });
  });

  dom.toggleGhostCursor.addEventListener('change', (e) => {
    state.showGhostCursor = e.target.checked;
  });

  dom.toggleHideOSCursor.addEventListener('change', (e) => {
    state.hideOSCursor = e.target.checked;
    dom.arenaCanvas.classList.toggle('hide-cursor', state.hideOSCursor);
  });

  function recordPointer(clientX, clientY) {
    const rect = dom.arenaCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
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

  // Extra GPU/CPU cost from the top-bar Load level slider (0 ms at 1.0 → +30 ms at 5.0)
  function getTopBarExtraLoadMs() {
    return (state.load - 1.0) * 7.5;
  }

  // Exponential frame cost + top-bar Load level + Explode spike
  function getSimMeanRenderMs(level, spikeMs = 0) {
    return 12.0 * Math.pow(1.52, level - 1) + getTopBarExtraLoadMs() + spikeMs;
  }

  function getSimRenderTimeMs(level, frameSeq, spikeMs = 0) {
    const base = 12.0 * Math.pow(1.52, level - 1) + getTopBarExtraLoadMs();
    if (level <= 1.01 && state.load <= 1.001 && spikeMs <= 0.01) return base;
    const varAmp = Math.min(0.07, Math.max(0, (Math.max(level, state.load) - 1) * 0.03));
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
      title: 'Calm Street',
      impact: 'All FPS Locked',
      tier: 'low',
      desc: 'The player stands still or cruises through light traffic—minimal AI checks, simple patrol paths, and plenty of headroom for 60, 40, and 30 FPS.'
    },
    {
      title: 'Busy District',
      impact: '60 FPS Struggling',
      tier: 'mid',
      desc: 'Traffic thickens and NPCs make complex decisions around lane changes, crosswalks, and avoidance—pushing past 16.7 ms so 60 FPS dips while 40 and 30 FPS stay locked.'
    },
    {
      title: 'Active Pursuit',
      impact: 'Only 30 FPS Locked',
      tier: 'warn',
      desc: 'AI calculates real-time flanking paths for enemies while civilian NPCs react and decide where to run away—both 60 and 40 FPS miss their budgets while 30 FPS still holds 0% drop.'
    },
    {
      title: 'Physics & Crowd Storm',
      impact: 'All Targets Dropping',
      tier: 'high',
      desc: 'Chain-reaction collisions, destructible debris, dense crowd pathfinding, and dynamic shadows stack up—even 30 FPS crosses its 33.3 ms budget and begins dipping.'
    },
    {
      title: 'Worst-Case Overload',
      impact: 'Severe Overload',
      tier: 'high',
      desc: 'Extreme entity swarm with heavy O(N²) collision checks, multi-agent AI, and full particle bursts—every FPS target drops sharply and interpolation lag swells past 100 ms.'
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

    if (dom.simFooterCard && dom.simScenarioLvlTxt && dom.simScenarioTitle && dom.simScenarioDesc) {
      const sc = SIM_SCENARIOS[Math.max(0, Math.min(4, nearestLvl - 1))];
      const extraTop = getTopBarExtraLoadMs();
      const tier = cost > 33.3 ? 'high' : cost > 25.0 ? 'warn' : cost > 16.7 ? 'mid' : sc.tier;
      dom.simFooterCard.dataset.tier = tier;
      dom.simScenarioLvlTxt.textContent = `LEVEL ${nearestLvl}`;
      dom.simScenarioTitle.textContent = sc.title;
      dom.simScenarioDesc.textContent = extraTop > 0.5
        ? `${sc.desc} (+${extraTop.toFixed(1)} ms added from top-bar Load ${state.load.toFixed(1)}.)`
        : sc.desc;
      if (dom.simImpactTag) {
        dom.simImpactTag.textContent = cost > 33.3
          ? (nearestLvl >= 5 ? 'Severe Overload' : 'All Targets Dropping')
          : cost > 25.0 ? 'Only 30 FPS Locked'
          : cost > 16.7 ? '60 FPS Struggling'
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
          ? `+${lag} ms · -${dropPct}%`
          : `${state.displayHz} Hz · +${lag} ms`;
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
        el.textContent = `${fps.toFixed(1)} FPS · ${dropPct >= 2 ? `-${dropPct}%` : '0% drop'}`;
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
  }

  // Interactive swipe/drag along the exponential curve
  if (dom.expCurveWrap) {
    let draggingCurve = false;

    const updateFromPointer = (clientX) => {
      const rect = dom.expCurveWrap.getBoundingClientRect();
      const pad = 16;
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

  simLevelBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      setSimLevel(Number(btn.dataset.simLevel));
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
        title: `1. CPU Simulation & Game State (${cpuMs.toFixed(1)} ms)`,
        desc: `Targeting ${modeName} (${budgetMs.toFixed(1)} ms frame budget), the CPU samples input, steps physics/AI with dt=${(1000 / effFps).toFixed(1)} ms, and prepares draw commands (while GPU renders the previous frame in parallel).`
      };
    }
    if (stageIdx === 1) {
      return {
        title: `2. PCIe Command Queue & GPU Render (${gpuMs.toFixed(1)} ms · Total ${sceneMs.toFixed(1)} ms)`,
        desc: missed
          ? `OVER BUDGET: CPU+GPU take ${sceneMs.toFixed(1)} ms, exceeding ${modeName}’s ${budgetMs.toFixed(1)} ms deadline! The frame misses its target refresh and drops effective output to ${effFps.toFixed(1)} FPS (-${dropPct}%).`
          : `WITHIN BUDGET: CPU+GPU finish in ${sceneMs.toFixed(1)} ms—leaving ${(budgetMs - sceneMs).toFixed(1)} ms of spare headroom inside ${modeName}’s ${budgetMs.toFixed(1)} ms frame budget.`
      };
    }
    if (stageIdx === 2) {
      if (mode === 'interp') {
        return {
          title: `3. Frame Pacer + Optical-Flow Lookahead Buffer (+${Math.round(waitMs + interpBufMs)} ms)`,
          desc: `The engine caps source output at 30 FPS (${Math.max(33.3, sceneMs).toFixed(1)} ms), and the display processor must hold Frame A in a 2-frame buffer (+${Math.round(interpBufMs)} ms) until Frame B arrives to synthesize intermediate frames.`
        };
      }
      if (mode === '40' && hz === 60 && !missed) {
        return {
          title: `3. Frame Pacer & 60 Hz V-Sync Mismatch (+${waitMs.toFixed(1)} ms avg · 3:2 Judder)`,
          desc: `Because a 25.0 ms frame does not divide evenly into 16.7 ms (60 Hz) refresh ticks, frames alternate waiting 1 refresh (16.7 ms) and 2 refreshes (33.3 ms), causing uneven 3:2 pulldown judder.`
        };
      }
      if (mode === '40' && hz === 120 && !missed) {
        return {
          title: `3. Frame Pacer & 120 Hz V-Sync Lock (+${waitMs.toFixed(1)} ms)`,
          desc: `On 120 Hz (8.33 ms ticks), the 25.0 ms frame pacer aligns with exact 3-refresh precision (3 × 8.33 ms = 25.0 ms), giving locked 40 FPS with zero judder.`
        };
      }
      return {
        title: `3. Frame Pacer & V-Sync Gate (+${waitMs.toFixed(1)} ms)`,
        desc: missed
          ? `Because rendering (${sceneMs.toFixed(1)} ms) missed the ${budgetMs.toFixed(1)} ms v-sync window, the swap chain stalls an extra ${waitMs.toFixed(1)} ms waiting for the next ${hz} Hz refresh tick.`
          : `The finished frame waits ${waitMs.toFixed(1)} ms at the swap-chain gate to align cleanly with ${modeName}’s ${budgetMs.toFixed(1)} ms cadence on the ${hz} Hz display.`
      };
    }
    if (stageIdx === 3) {
      return {
        title: `4. HDMI Line-by-Line Signal Stream (${dispPeriod.toFixed(1)} ms @ ${hz} Hz)`,
        desc: `Pixel rows stream top-to-bottom over HDMI in real time (${dispPeriod.toFixed(1)} ms for a full ${hz} Hz refresh). The monitor does not wait for the whole frame—it scans each line directly to the panel as it arrives (<1 ms TCON buffer).`
      };
    }
    return {
      title: `5. Simultaneous Panel Scanout & Pixel GtG (~2.5 ms)`,
      desc: `Physical pixels transition (~2.5 ms GtG) as the scanbeam sweeps down the screen, completing the ${modeName} input-to-photon pipeline in ~${ctx.totalMs.toFixed(1)} ms at ${effFps.toFixed(1)} effective FPS.`
    };
  }

  function updatePipelineView() {
    if (!pipeEls.card) return;
    const hz = state.displayHz;
    const dispPeriod = 1000 / hz;
    const sceneMs = getMeanSceneRenderMs(state.load, state.simSpikeMs);
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
          ? `${hz} Hz out (${effFps.toFixed(0)} src · -${dropPct}%)`
          : `${hz} Hz out (30 src · +${Math.round(interpBufMs)} ms buf)`;
        pipeEls.targetStatus.className = 'pipe-status mono warn';
      } else if (pipeMode === '40' && hz === 60 && !missed) {
        pipeEls.targetStatus.textContent = '40.0 FPS · 3:2 judder';
        pipeEls.targetStatus.className = 'pipe-status mono warn';
      } else {
        pipeEls.targetStatus.textContent = dropPct > 1
          ? `${effFps.toFixed(1)} FPS · -${dropPct}% drop`
          : `${effFps.toFixed(1)} FPS · 0% drop`;
        pipeEls.targetStatus.className = 'pipe-status mono ' + (dropPct > 1 ? 'warn' : 'good');
      }
    }

    pipeEls.totalMs.textContent = `Input→Photon: ~${totalMs.toFixed(1)} ms`;
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
    pipeEls.msDisp.textContent = `${dispMs.toFixed(1)} ms GtG`;

    // Update proportional millisecond breakdown segments
    const vsyncSegLbl = pipeMode === 'interp' ? 'Interp Buf' : 'Pacer/V-Sync';
    const segs = [
      { el: pipeEls.segCpu,   ms: cpuMs,       lbl: 'CPU',        idx: 0 },
      { el: pipeEls.segGpu,   ms: gpuMs,       lbl: 'GPU',        idx: 1 },
      { el: pipeEls.segVsync, ms: gateTotalMs, lbl: vsyncSegLbl,  idx: 2 },
      { el: pipeEls.segHdmi,  ms: hdmiMs,      lbl: 'HDMI+Scan',  idx: 3 },
      { el: pipeEls.segDisp,  ms: dispMs,      lbl: 'GtG',        idx: 4 }
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
  const SECTION_IDS = ['motionSection', 'simSection', 'inputSection', 'pipelineSection', 'timelineSection'];
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
    const inputVisible = isSectionVisible('inputSection');
    const pipelineVisible = isSectionVisible('pipelineSection');
    const timelineVisible = isSectionVisible('timelineSection');

    if (!state.paused) {
      if (motionVisible) stepLaneSimulators();
      if (simVisible) stepSimArenas();
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

    const motionAutoSpiking = motionVisible && !blindActive && activeMotionScenario === 2;
    if ((!state.paused || isSpiking) && now - lastReadoutTime > (isSpiking || simBlasting || motionAutoSpiking ? 90 : 260)) {
      lastReadoutTime = now;
      if (motionVisible) {
        updateLaneReadouts();
        if (motionAutoSpiking) updateLoadDisplay();
      }
      if (simVisible) updateSimReadouts();
    }

    if (inputVisible) {
      updateAndDrawArena(now);
    }

    // Keep rAF running only when an animated canvas section or active spike needs frames
    const keepRunning =
      inputVisible ||
      isSpiking ||
      wasSpiking ||
      (!state.paused && (motionVisible || simVisible));

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
      impact: 'All Targets Locked',
      desc: 'At 14.0 ms per frame, workload sits safely inside the 16.7 ms (60 FPS), 25.0 ms (40 FPS), and 33.3 ms (30 FPS) budgets—so every configuration holds 0% frame drops and higher frame rates win purely on clarity and lower lag.'
    },
    {
      id: 2,
      title: '60 Hitches on Spikes',
      load: 1.2,
      tier: 'mid',
      impact: '30 Absorbs Spikes',
      autoSpikes: true,
      desc: 'Base load (15.5 ms) leaves 60 FPS only 1.2 ms of margin before 16.7 ms. Repeating +15 ms workload bursts (~30.5 ms peaks) push 60 and 40 FPS over budget into visible stutter, while 30 FPS absorbs every spike inside its 33.3 ms cushion at 0% drop.'
    },
    {
      id: 3,
      title: '60 FPS Unstable',
      load: 2.0,
      tier: 'mid',
      impact: '60 FPS Dropping',
      desc: 'At 21.5 ms per frame, steady workload exceeds 60 FPS’s 16.7 ms budget on every single frame—causing continuous uneven frame holds. Stepping down to a 25.0 ms (40 FPS) or 33.3 ms (30 FPS) budget restores 0% frame drops.'
    },
    {
      id: 4,
      title: 'Only 30 Absorbs Load',
      load: 3.0,
      tier: 'warn',
      impact: 'Only 30 FPS Locked',
      desc: 'Heavy 29.0 ms workload overwhelms both 60 FPS (16.7 ms) and 40 FPS (25.0 ms), forcing severe frame drops. Only 30 FPS absorbs over 2× baseline load inside its 33.3 ms budget with locked pacing—while 30 + Interp masks the rate at the cost of +67 ms lag.'
    },
    {
      id: 5,
      title: 'All Overloaded',
      load: 4.3,
      tier: 'high',
      impact: 'All Targets Dropping',
      desc: 'At 38.8 ms per frame, workload crosses 30 FPS’s 33.3 ms ceiling. Every native configuration loses lock and stutters, while 30 FPS + Interpolation suffers compounding buffer lag (~140+ ms) and frame-pacing hiccups.'
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
    if (activeMotionScenario !== 2 || blindActive || !isSectionVisible('motionSection')) return 0;
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
    if (dom.loadSlider) {
      dom.loadSlider.value = String(sc.load);
      syncRangeFill(dom.loadSlider);
    }
    setLoad(sc.load, true);
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
  // BLIND TEST CHALLENGE (FIRST-VISIT & ON-DEMAND FROM CONSOLE)
  // ============================================================================
  const BLIND_COOKIE_NAME = 'fps_lab_blind_seen';
  const BLIND_TRACK_LABELS = ['Track A', 'Track B', 'Track C', 'Track D'];
  const lanesContainer = document.getElementById('lanesContainer');
  const laneElsByMode = {};
  MODES.forEach((m) => {
    laneElsByMode[m] = lanesContainer ? lanesContainer.querySelector(`.lane[data-mode="${m}"]`) : null;
  });
  const blindEls = {
    head: document.getElementById('blindHead'),
    title: document.getElementById('blindTitle'),
    sub: document.getElementById('blindSub'),
    retryBtn: document.getElementById('blindRetryBtn'),
    skipBtn: document.getElementById('blindSkipBtn'),
    triggerBtn: document.getElementById('blindTestBtn'),
    mobToggle: document.getElementById('mobileConsoleToggle')
  };

  let blindActive = document.documentElement.classList.contains('is-blind-test');
  let blindRevealed = false;
  let blindSavedState = null;

  function isBlindGuessing() {
    return blindActive && !blindRevealed;
  }

  function setBlindSeenCookie() {
    document.cookie = `${BLIND_COOKIE_NAME}=1; path=/; max-age=31536000; SameSite=Lax`;
  }

  function shuffleLanesForBlindTest() {
    if (!lanesContainer) return;
    const order = MODES.slice();
    // Fisher-Yates shuffle, ensuring it doesn't stay identical to canonical order
    for (let attempt = 0; attempt < 6; attempt++) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
      }
      if (order.some((m, idx) => m !== MODES[idx])) break;
    }
    order.forEach((m, idx) => {
      const el = laneElsByMode[m];
      if (!el) return;
      const lbl = BLIND_TRACK_LABELS[idx];
      el.dataset.blindLabel = lbl;
      const h3 = el.querySelector('.lane-badge h3');
      if (h3) h3.dataset.blindLabel = lbl;
      el.classList.remove('is-blind-picked', 'is-blind-correct');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', `Pick ${lbl} as 60 FPS`);
      lanesContainer.appendChild(el);
    });
  }

  function restoreCanonicalLaneOrder() {
    if (!lanesContainer) return;
    MODES.forEach((m) => {
      const el = laneElsByMode[m];
      if (!el) return;
      delete el.dataset.blindLabel;
      const h3 = el.querySelector('.lane-badge h3');
      if (h3) delete h3.dataset.blindLabel;
      el.classList.remove('is-blind-picked', 'is-blind-correct');
      el.removeAttribute('role');
      el.removeAttribute('tabindex');
      el.removeAttribute('aria-label');
      lanesContainer.appendChild(el);
    });
  }

  function enterBlindTest(fromConsole = false) {
    const root = document.documentElement;
    if (fromConsole && !blindSavedState) {
      blindSavedState = {
        load: state.load,
        speed: state.speed,
        paused: state.paused
      };
    }
    if (blindEls.mobToggle) blindEls.mobToggle.checked = false;

    // Ensure clean, fair baseline conditions for the blind eye test
    state.spikeStartSim = -1;
    state.spikeStartReal = -1;
    state.simSpikeMs = 0;
    state.realSpikeMs = 0;
    if (state.paused) togglePause();
    if (state.speed !== 1) setSpeed(1);
    if (Math.abs(state.load - 1.0) > 0.01) {
      state.load = 1.0;
      if (dom.loadSlider) {
        dom.loadSlider.value = '1';
        syncRangeFill(dom.loadSlider);
      }
      updateLoadDisplay();
    }

    blindActive = true;
    blindRevealed = false;
    root.classList.add('is-blind-test');
    root.classList.remove('is-blind-revealed');

    if (blindEls.head) blindEls.head.dataset.outcome = '';
    if (blindEls.title) blindEls.title.textContent = 'Spot the True 60 FPS Track';
    if (blindEls.sub) {
      blindEls.sub.textContent =
        'The 4 tracks below are shuffled and unlabeled. Watch the motion closely, then pick the track you think is native 60 FPS.';
    }
    if (blindEls.retryBtn) blindEls.retryBtn.hidden = true;
    if (blindEls.skipBtn) {
      blindEls.skipBtn.textContent = 'Skip →';
      blindEls.skipBtn.classList.remove('is-primary');
    }

    shuffleLanesForBlindTest();
    resetLaneSimulators();
    window.dispatchEvent(new CustomEvent('fpslab:blind-entered'));
    invalidateAllCanvases();
    syncVisibleSectionsNow();
    requestCanvasRedraw();
  }

  function handleBlindPick(mode) {
    if (!isBlindGuessing()) return;
    setBlindSeenCookie();
    blindRevealed = true;

    const root = document.documentElement;
    root.classList.add('is-blind-revealed');

    const pickedEl = laneElsByMode[mode];
    const correctEl = laneElsByMode['60'];
    if (pickedEl) pickedEl.classList.add('is-blind-picked');
    if (correctEl) correctEl.classList.add('is-blind-correct');

    let outcome = 'wrong';
    let title = 'Tricky — that was 30 FPS';
    let sub = 'Compare its 33.3 ms steps side-by-side with the highlighted native 60 FPS track below.';

    if (mode === '60') {
      outcome = 'correct';
      title = 'Spot on — you found native 60 FPS!';
      sub = 'Even 16.7 ms frame pacing gives the sharpest motion clarity and lowest input latency.';
    } else if (mode === 'interp') {
      outcome = 'interp';
      title = 'Fooled by TV Motion Smoothing!';
      sub = 'You picked 30 FPS + Interpolation. It fakes smooth motion by buffering frames — adding +67 ms of lag and halo artifacts.';
    } else if (mode === '40') {
      outcome = 'wrong';
      title = 'Close — that was 40 FPS';
      sub = state.displayHz === 120
        ? 'At 120 Hz, 40 FPS hits an even 25.0 ms cadence — halfway between 30 and 60 FPS.'
        : 'At 60 Hz, 40 FPS alternates 16.7 / 33.3 ms holds (3:2 pulldown judder). Compare it against native 60 FPS below.';
    }

    if (blindEls.head) blindEls.head.dataset.outcome = outcome;
    if (blindEls.title) blindEls.title.textContent = title;
    if (blindEls.sub) blindEls.sub.textContent = sub;
    if (blindEls.retryBtn) blindEls.retryBtn.hidden = false;
    if (blindEls.skipBtn) {
      blindEls.skipBtn.textContent = 'Enter Full Lab →';
      blindEls.skipBtn.classList.add('is-primary');
    }

    MODES.forEach((m) => {
      const el = laneElsByMode[m];
      if (!el) return;
      el.removeAttribute('role');
      el.removeAttribute('tabindex');
      el.removeAttribute('aria-label');
    });

    invalidateAllCanvases();
    updateLaneReadouts();
    requestCanvasRedraw();
  }

  function exitBlindTest() {
    setBlindSeenCookie();
    blindActive = false;
    blindRevealed = false;

    const root = document.documentElement;
    root.classList.remove('is-blind-test', 'is-blind-revealed');
    root.classList.add('is-intro-revealed');

    restoreCanonicalLaneOrder();
    motionAutoSpikeAnchorMs = state.tSim;

    if (blindSavedState) {
      const prev = blindSavedState;
      blindSavedState = null;
      if (Math.abs(prev.load - state.load) > 0.01) {
        state.load = prev.load;
        if (dom.loadSlider) {
          dom.loadSlider.value = String(prev.load);
          syncRangeFill(dom.loadSlider);
        }
        updateLoadDisplay();
      }
      if (prev.speed !== state.speed) setSpeed(prev.speed);
      if (prev.paused && !state.paused) togglePause();
    }

    window.dispatchEvent(new CustomEvent('fpslab:blind-exited'));
    invalidateAllCanvases();
    syncVisibleSectionsNow();
    updateLaneReadouts();
    requestCanvasRedraw();

    setTimeout(() => {
      root.classList.remove('is-intro-revealed');
    }, 650);
  }

  MODES.forEach((m) => {
    const el = laneElsByMode[m];
    if (!el) return;
    el.addEventListener('click', () => {
      if (isBlindGuessing()) handleBlindPick(m);
    });
    el.addEventListener('keydown', (e) => {
      if (!isBlindGuessing()) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleBlindPick(m);
      }
    });
  });

  if (blindEls.skipBtn) {
    blindEls.skipBtn.addEventListener('click', () => exitBlindTest());
  }
  if (blindEls.retryBtn) {
    blindEls.retryBtn.addEventListener('click', () => enterBlindTest(false));
  }
  if (blindEls.triggerBtn) {
    blindEls.triggerBtn.addEventListener('click', () => enterBlindTest(true));
  }

  // ============================================================================
  // DISCOVERY HEARTBEAT NUDGES (LOAD SPIKE BUTTON + LOAD SLIDER)
  // ============================================================================
  const SPIKE_USED_COOKIE = 'fps_lab_used_spike';
  const LOAD_USED_COOKIE = 'fps_lab_used_load';
  const HEARTBEAT_FIRST_MS = 7200;
  const HEARTBEAT_MIN_MS = 7000;
  const HEARTBEAT_MAX_MS = 10000;

  function hasCookieFlag(name) {
    return new RegExp(`(?:^|;\\s*)${name}=1(?:;|$)`).test(document.cookie);
  }

  function setCookieFlag(name) {
    document.cookie = `${name}=1; path=/; max-age=31536000; SameSite=Lax`;
  }

  if (/[?&]reset_hints=1(?:&|$)/.test(window.location.search)) {
    document.cookie = `${SPIKE_USED_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    document.cookie = `${LOAD_USED_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  }

  let spikeHintDone = hasCookieFlag(SPIKE_USED_COOKIE);
  let loadHintDone = spikeHintDone || hasCookieFlag(LOAD_USED_COOKIE);
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
    if (blindActive) return false;
    const root = document.documentElement;
    if (root.classList.contains('is-blind-test') || root.classList.contains('is-intro-replay')) {
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
    setCookieFlag(SPIKE_USED_COOKIE);
    stopHeartbeatTimer();
    clearHeartbeatVisuals(true, true);
  }

  function markLoadInteracted() {
    if (loadHintDone) return;
    loadHintDone = true;
    setCookieFlag(LOAD_USED_COOKIE);
    clearHeartbeatVisuals(false, true);
  }

  window.addEventListener('fpslab:blind-entered', () => {
    stopHeartbeatTimer();
    clearHeartbeatVisuals(true, true);
  });

  window.addEventListener('fpslab:blind-exited', () => {
    scheduleNextHeartbeat();
  });

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

  syncVisibleSectionsNow();
  updateLoadDisplay();
  detectRefreshRate(true);
  if (blindActive) {
    enterBlindTest(false);
  } else {
    ensureLoopRunning();
    scheduleNextHeartbeat();
  }
})();
