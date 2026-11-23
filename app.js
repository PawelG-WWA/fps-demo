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
    loadSlider: document.getElementById('loadSlider'),
    loadVal: document.getElementById('loadVal'),
    loadMs: document.getElementById('loadMs'),
    explodeBtn: document.getElementById('explodeBtn'),
    toggleTruePos: document.getElementById('toggleTruePos'),
    toggleArtifacts: document.getElementById('toggleArtifacts'),
    pauseBtn: document.getElementById('pauseBtn'),
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
    simCostVal: document.getElementById('simCostVal')
  };

  const simCanvases = {};
  const simStatEls = {};
  MODES.forEach((m) => {
    simCanvases[m] = document.getElementById(`sim-canvas-${m}`);
    simStatEls[m] = document.getElementById(`sim-stat-${m}`);
  });
  const simLevelBtns = Array.from(document.querySelectorAll('.sim-lvl-btn'));

  const laneCanvases = {};
  const ftCanvases = {};
  const laneMetricsEl = {};
  const ftValEl = {};
  const ftCapEl = {};

  MODES.forEach((m) => {
    laneCanvases[m] = document.getElementById(`canvas-${m}`);
    ftCanvases[m] = document.getElementById(`ft-${m}`);
    laneMetricsEl[m] = document.getElementById(`metrics-${m}`);
    ftValEl[m] = document.getElementById(`ft-val-${m}`);
    ftCapEl[m] = document.getElementById(`ft-cap-${m}`);
  });

  // ============================================================================
  // HI-DPI CANVAS HELPER
  // ============================================================================
  function setupCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
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
    updateLaneReadouts();
    updateArenaStaticStats();
    updateSimBanner();
    drawTimeline();
    updatePipelineView();
  }

  function setSpeed(spd) {
    state.speed = spd;
    dom.btnSpeed1x.classList.toggle('active', spd === 1);
    dom.btnSpeedSlow.classList.toggle('active', spd !== 1);
    updateSimBanner();
  }

  function updateLoadDisplay() {
    const sceneMs = getMeanSceneRenderMs(state.load, state.simSpikeMs);
    dom.loadVal.textContent = `${state.load.toFixed(1)}`;
    dom.loadVal.className = 'load-val mono' + (state.load >= 3.0 ? ' high' : state.load >= 1.5 ? ' mid' : '');
    dom.loadMs.textContent = `${sceneMs.toFixed(1)} ms`;
    dom.loadMs.className = 'load-ms mono' + (state.simSpikeMs > 0.5 ? ' spike' : '');
    dom.explodeBtn.classList.toggle('active', state.simSpikeMs > 2.0);
  }

  function setLoad(val) {
    state.load = Math.max(1, Math.min(5, val));
    updateLoadDisplay();
    updateLaneReadouts();
    updateSimReadouts();
    drawExpCurve();
    updateArenaStaticStats();
    drawTimeline();
    updatePipelineView();
  }

  function triggerExplode() {
    state.spikeStartSim = state.tSim;
    state.spikeStartReal = performance.now();
    state.simSpikeMs = SPIKE_PEAK_MS;
    state.realSpikeMs = SPIKE_PEAK_MS;
    updateLoadDisplay();
    updateLaneReadouts();
    updateArenaStaticStats();
    drawTimeline();
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

  function formatDropBadge(dropPct) {
    const rounded = Math.round(dropPct);
    if (rounded < 1) return `<span class="meta-item good">0% drop</span>`;
    return `<span class="meta-item warn">-${rounded}% drop</span>`;
  }

  function updateLaneReadouts() {
    const hz = state.displayHz;
    const is120 = hz === 120;
    const load = state.load;
    const spikeMs = state.simSpikeMs;
    const sceneMs = getMeanSceneRenderMs(load, spikeMs);
    const underLoad = load > 1.05 || spikeMs > 0.5;

    // 30 FPS (33.3 ms budget)
    const fps30 = underLoad ? getEffectiveFpsFromHistory('30') : 30.0;
    const avg30 = 1000 / Math.max(1, fps30);
    const dropPct30 = getEfficiencyDropPct(fps30, 30);
    const drop30 = dropPct30 >= 3;
    laneMetricsEl['30'].innerHTML = `
      <span class="meta-item ${drop30 ? 'warn' : ''}">${fps30.toFixed(1)} FPS</span>
      ${formatDropBadge(dropPct30)}
      <span class="meta-item ${drop30 ? 'warn' : ''}">${avg30.toFixed(1)} ms</span>
      <span class="meta-item">~${Math.round(avg30 * 1.8)} ms lag</span>
    `;
    ftValEl['30'].textContent = `${avg30.toFixed(1)} ms`;
    ftCapEl['30'].textContent = drop30
      ? `-${Math.round(dropPct30)}% eff · missed 33.3 ms`
      : (is120 ? 'Locked · even 4-4-4' : 'Locked · even 2-2-2');
    ftCapEl['30'].className = drop30 ? 'ft-note judder' : 'ft-note';

    // 40 FPS (25.0 ms budget)
    const fps40 = underLoad ? getEffectiveFpsFromHistory('40') : 40.0;
    const avg40 = 1000 / Math.max(1, fps40);
    const dropPct40 = getEfficiencyDropPct(fps40, 40);
    const drop40 = dropPct40 >= 3;
    if (!drop40 && is120) {
      laneMetricsEl['40'].innerHTML = `
        <span class="meta-item good">40.0 FPS</span>
        ${formatDropBadge(0)}
        <span class="meta-item good">25.0 ms</span>
        <span class="meta-item">~45 ms lag</span>
      `;
      ftValEl['40'].textContent = '25.0 ms';
      ftCapEl['40'].textContent = 'Locked · exact 3 ticks';
      ftCapEl['40'].className = 'ft-note';
    } else if (!drop40 && !is120) {
      laneMetricsEl['40'].innerHTML = `
        <span class="meta-item warn">40.0 FPS (judder)</span>
        ${formatDropBadge(0)}
        <span class="meta-item warn">16.7 / 33.3 ms</span>
        <span class="meta-item">~50 ms lag</span>
      `;
      ftValEl['40'].textContent = '16.7 / 33.3 ms';
      ftCapEl['40'].textContent = '3:2 pulldown judder';
      ftCapEl['40'].className = 'ft-note judder';
    } else {
      laneMetricsEl['40'].innerHTML = `
        <span class="meta-item warn">${fps40.toFixed(1)} FPS</span>
        ${formatDropBadge(dropPct40)}
        <span class="meta-item warn">${avg40.toFixed(1)} ms</span>
        <span class="meta-item">~${Math.round(avg40 * 1.85)} ms lag</span>
      `;
      ftValEl['40'].textContent = `${avg40.toFixed(1)} ms`;
      ftCapEl['40'].textContent = `-${Math.round(dropPct40)}% eff · missed 25 ms`;
      ftCapEl['40'].className = 'ft-note judder';
    }

    // 30 FPS + Interp (33.3 ms source budget)
    const interpOutMs = (1000 / hz).toFixed(1);
    const bufLag = Math.round(laneState['interp'].currentLagMs || getInterpBufferLagMs(load));
    const srcFps = Math.min(30, 1000 / Math.max(33.33, laneState['interp'].avgSrcMs || getMeanFrameDurMs('interp', load)));
    const dropPctInterp = getEfficiencyDropPct(srcFps, 30);
    const totalInterpLag = Math.round(bufLag + (1000 / srcFps) + 18);
    laneMetricsEl['interp'].innerHTML = `
      <span class="meta-item">${hz} Hz (${srcFps.toFixed(0)} FPS src)</span>
      ${formatDropBadge(dropPctInterp)}
      <span class="meta-item warn">+${bufLag} ms buf</span>
      <span class="meta-item warn">~${totalInterpLag} ms lag</span>
    `;
    ftValEl['interp'].textContent = `${interpOutMs} ms (+${bufLag} ms)`;
    ftCapEl['interp'].textContent = dropPctInterp >= 3
      ? `Src -${Math.round(dropPctInterp)}% · heavy lag`
      : `${hz} Hz visual · trails true time`;
    ftCapEl['interp'].className = dropPctInterp >= 3 ? 'ft-note judder' : 'ft-note';

    // 60 FPS (16.7 ms budget)
    const fps60 = underLoad ? getEffectiveFpsFromHistory('60') : 60.0;
    const avg60 = 1000 / Math.max(1, fps60);
    const dropPct60 = getEfficiencyDropPct(fps60, 60);
    const drop60 = dropPct60 >= 3;
    laneMetricsEl['60'].innerHTML = `
      <span class="meta-item ${drop60 ? 'warn' : 'good'}">${fps60.toFixed(1)} FPS</span>
      ${formatDropBadge(dropPct60)}
      <span class="meta-item ${drop60 ? 'warn' : 'good'}">${avg60.toFixed(1)} ms</span>
      <span class="meta-item ${drop60 ? 'warn' : 'good'}">~${Math.round(avg60 * 1.8)} ms lag</span>
    `;
    ftValEl['60'].textContent = `${avg60.toFixed(1)} ms`;
    ftCapEl['60'].textContent = drop60
      ? `-${Math.round(dropPct60)}% eff · missed 16.7 ms`
      : (is120 ? 'Locked · even 2-2-2' : 'Locked · even 1-1-1');
    ftCapEl['60'].className = drop60 ? 'ft-note judder' : 'ft-note';

    dom.timelineHzText.textContent = is120
      ? `120 Hz = 8.33 ms · Scene ${sceneMs.toFixed(1)} ms (Load level ${load.toFixed(1)})`
      : `60 Hz = 16.67 ms · Scene ${sceneMs.toFixed(1)} ms (Load level ${load.toFixed(1)})`;
  }

  // ============================================================================
  // SECTION 1: MOTION SIMULATION WITH LOAD PHYSICS
  // ============================================================================
  function stepLaneSimulators(dtSimMs) {
    state.tSim += dtSimMs;
    state.simSpikeMs = state.spikeStartSim >= 0
      ? getSpikeEnvelopeMs(state.tSim - state.spikeStartSim)
      : 0;
    const dispPeriod = 1000 / state.displayHz;
    const targetTick = Math.floor(state.tSim / dispPeriod);

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
        const tickSpikeMs = state.spikeStartSim >= 0
          ? getSpikeEnvelopeMs(tTick - state.spikeStartSim)
          : 0;

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

    const span = w + 100;
    const blockX = ((tSec * pxPerSec) % span) - 50;

    const hudW = 118;
    const hudH = 20;
    const hudX = Math.round(w * 0.5 - hudW / 2);
    const hudY = 9;
    const nearHud = Math.abs(blockX - w * 0.5) < 95;
    const showArt = mode === 'interp' && state.showArtifacts;

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
    const tick = Math.floor(tNow / dispPeriod);

    while (arena.history.length > 2 && tNow - arena.history[0].t > 800) {
      arena.history.shift();
    }

    const cfg = getArenaLagConfig(mode);

    if (tick !== arena.lastDispTick) {
      arena.lastDispTick = tick;
      const tTick = tick * dispPeriod;

      if (mode === 'interp') {
        const srcPeriod = getMeanFrameDurMs('interp', state.load);
        const delayedT = tTick - cfg.pipelineDelayMs;
        const kIdx = Math.floor(delayedT / srcPeriod);
        const tK0 = kIdx * srcPeriod;
        const tK1 = (kIdx + 1) * srcPeriod;
        const alpha = Math.max(0, Math.min(1, (delayedT - tK0) / srcPeriod));

        const p0 = samplePointerAt(tK0);
        const p1 = samplePointerAt(tK1);
        arena.renderedX = p0.x + (p1.x - p0.x) * alpha;
        arena.renderedY = p0.y + (p1.y - p0.y) * alpha;

        const tp = getTargetPos(tTick - cfg.pipelineDelayMs, w, h);
        arena.targetX = tp.x;
        arena.targetY = tp.y;
      } else {
        const gamePeriod = MODE_META[mode].periodMs;
        if (arena.nextFrameReadyTime === 0 || tTick - arena.nextFrameReadyTime > 500) {
          arena.nextFrameReadyTime = tTick;
        }
        if (tTick + 0.001 >= arena.nextFrameReadyTime) {
          arena.frameSeq++;
          const sampled = samplePointerAt(arena.nextFrameReadyTime - cfg.pipelineDelayMs);
          arena.renderedX = sampled.x;
          arena.renderedY = sampled.y;

          const tp = getTargetPos(arena.nextFrameReadyTime, w, h);
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
      gridlinesHtml += `<span class="tl-gridline" style="left:${pct.toFixed(3)}%"></span>`;
      if (hz === 60 || i % 2 === 0) {
        const edgeCls = i === 0 ? ' is-start' : (pct >= 99.5 ? ' is-end' : '');
        tickLabelsHtml += `<span class="tl-tick-lbl${edgeCls}" style="left:${pct.toFixed(3)}%">${ms.toFixed(0)} ms</span>`;
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
        blocksHtml += `<div class="tl-block interp-buf" style="left:0%;width:calc(${bufPct.toFixed(3)}% - 3px)" title="${bufFull}"><span class="tl-txt"><span class="tl-full">${bufFull}</span><span class="tl-short">${bufShort}</span></span></div>`;

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
          blocksHtml += `<div class="tl-block ${cls}" style="left:calc(${startPct.toFixed(3)}% + 1.5px);width:calc(${widthPct.toFixed(3)}% - 3px)" title="${tip}">${lbl}</div>`;
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
          blocksHtml += `<div class="tl-block ${cls}${isNarrow ? ' is-narrow' : ''}" style="left:calc(${startPct.toFixed(3)}% + 2px);width:calc(${widthPct.toFixed(3)}% - 4px)" title="${tip}">${innerHtml}</div>`;
        });
      }

      html += `
        <div class="tl-row">
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

  dom.loadSlider.addEventListener('input', (e) => {
    setLoad(parseFloat(e.target.value));
  });

  dom.explodeBtn.addEventListener('click', () => {
    triggerExplode();
  });

  dom.toggleTruePos.addEventListener('change', (e) => {
    state.showTruePos = e.target.checked;
  });

  dom.toggleArtifacts.addEventListener('change', (e) => {
    state.showArtifacts = e.target.checked;
  });

  dom.pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    dom.pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
  });

  dom.panSpeedSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.panSpeed = v;
    dom.panSpeedLabel.textContent = `${v} px/s`;
  });

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
    MODES.forEach((m) => {
      simState[m] = {
        lastDisplayTick: -1,
        frameSeq: 0,
        nextFrameReadyTime: 0,
        holdTicks: 0,
        presentedTime: 0,
        ftHistory: [],
        srcFrameSeq: 0,
        srcNextReadyTime: 0,
        srcHoldTicks: 0,
        avgSrcMs: 1000 / 30,
        currentLagMs: (1000 / 30) * 2
      };
    });
  }
  initSimArenaState();

  function stepSimArenas() {
    if (!dom.expCurveCanvas) return;
    const dispPeriod = 1000 / state.displayHz;
    const targetTick = Math.floor(state.tSim / dispPeriod);

    MODES.forEach((mode) => {
      const ss = simState[mode];
      if (ss.lastDisplayTick < 0) ss.lastDisplayTick = targetTick - 1;

      const ticksToStep = Math.min(targetTick - ss.lastDisplayTick, 12);
      if (ticksToStep <= 0) return;

      const gamePeriod = MODE_META[mode].periodMs;

      for (let i = 1; i <= ticksToStep; i++) {
        const tick = ss.lastDisplayTick + i;
        const tTick = tick * dispPeriod;
        const tickSpikeMs = state.spikeStartSim >= 0
          ? getSpikeEnvelopeMs(tTick - state.spikeStartSim)
          : 0;

        if (mode === 'interp') {
          if (ss.srcFrameSeq === 0) {
            ss.srcFrameSeq = 1;
            ss.srcHoldTicks = 1;
            ss.srcNextReadyTime = Math.max(gamePeriod, getSimRenderTimeMs(state.simLevel, 1, tickSpikeMs));
          } else if (tTick + 0.001 >= ss.srcNextReadyTime) {
            const heldMs = ss.srcHoldTicks * dispPeriod;
            ss.avgSrcMs = ss.avgSrcMs * 0.75 + heldMs * 0.25;
            ss.srcFrameSeq++;
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
          if (ss.ftHistory.length > 24) ss.ftHistory.shift();
        } else {
          if (ss.frameSeq === 0) {
            ss.frameSeq = 1;
            ss.holdTicks = 1;
            ss.presentedTime = tTick;
            ss.nextFrameReadyTime = tTick + Math.max(gamePeriod, getSimRenderTimeMs(state.simLevel, 1, tickSpikeMs));
          } else if (tTick + 0.001 >= ss.nextFrameReadyTime) {
            const heldMs = ss.holdTicks * dispPeriod;
            ss.ftHistory.push(heldMs);
            if (ss.ftHistory.length > 24) ss.ftHistory.shift();

            ss.presentedTime = ss.nextFrameReadyTime;
            ss.frameSeq++;
            const dur = Math.max(gamePeriod, getSimRenderTimeMs(state.simLevel, ss.frameSeq, tickSpikeMs));
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

  function drawSimArena(mode) {
    const canvas = simCanvases[mode];
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(canvas);
    const ss = simState[mode];
    const tSec = ss.presentedTime / 1000;
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

    // Draw identical count of white NPCs (dots, rects, triangles)
    ctx.fillStyle = 'rgba(241, 245, 249, 0.88)';
    for (let i = 0; i < npcCount; i++) {
      const n = simNpcs[i];
      const nx = pingPong(n.x0 + n.vx * tSec, 0.04, 0.96) * w;
      const ny = pingPong(n.y0 + n.vy * tSec, 0.06, 0.94) * h;
      const r = n.size;

      if (n.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(nx, ny, r * 0.78, 0, Math.PI * 2);
        ctx.fill();
      } else if (n.shape === 'rect') {
        ctx.save();
        ctx.translate(nx, ny);
        ctx.rotate(n.angle0 + n.vAngle * tSec);
        ctx.fillRect(-r * 0.8, -r * 0.8, r * 1.6, r * 1.6);
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(nx, ny);
        ctx.rotate(n.angle0 + n.vAngle * tSec);
        ctx.beginPath();
        ctx.moveTo(0, -r * 1.05);
        ctx.lineTo(r * 0.95, r * 0.85);
        ctx.lineTo(-r * 0.95, r * 0.85);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // Draw 1 yellow Player dot (Lissajous patrol)
    const px = (0.5 + 0.34 * Math.sin(tSec * 1.25)) * w;
    const py = (0.5 + 0.30 * Math.sin(tSec * 1.85 + 0.6)) * h;

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
  }

  function updateSimReadouts() {
    if (!dom.simLevelVal) return;
    const lvl = state.simLevel;
    const cost = getSimMeanRenderMs(lvl, state.simSpikeMs);
    const count = getSimEntityCount(lvl);

    dom.simLevelVal.textContent = lvl.toFixed(1);
    dom.simLevelVal.className = 'sim-kpi-val mono' + (cost > 33.3 ? ' high' : cost > 16.7 ? ' mid' : '');
    dom.simEntityVal.textContent = String(count);
    dom.simCostVal.textContent = `${cost.toFixed(1)} ms`;
    dom.simCostVal.className = 'sim-kpi-val mono' + (cost > 33.3 ? ' high' : cost > 16.7 ? ' mid' : '');

    if (dom.expCurveWrap) {
      dom.expCurveWrap.setAttribute('aria-valuenow', lvl.toFixed(1));
    }

    const nearestLvl = Math.round(lvl);
    simLevelBtns.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.simLevel) === nearestLvl);
    });

    MODES.forEach((m) => {
      const el = simStatEls[m];
      if (!el) return;
      const ss = simState[m];
      if (m === 'interp') {
        const srcFps = Math.min(30, 1000 / Math.max(33.33, ss.avgSrcMs));
        const dropPct = Math.round(getEfficiencyDropPct(srcFps, 30));
        const lag = Math.round(ss.currentLagMs);
        el.textContent = dropPct > 2
          ? `+${lag} ms · -${dropPct}%`
          : `${state.displayHz} Hz · +${lag} ms`;
        el.className = 'sim-area-stat mono' + (dropPct > 2 ? ' warn' : '');
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
    nodes: Array.from(document.querySelectorAll('.pipe-node')),
    links: Array.from(document.querySelectorAll('.pipe-link')),
    pills: Array.from(document.querySelectorAll('.pipe-step-pill')),
    modeTabs: Array.from(document.querySelectorAll('.pipe-mode-tab'))
  };

  let pipeStage = 0;
  let pipeMode = '60';

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
  }

  function setPipelineStep(idx) {
    pipeStage = Math.max(0, Math.min(4, idx));
    updatePipelineView();
  }

  function stepPipeline(dir) {
    const next = pipeStage + dir;
    if (next < 0 || next >= 5) return false;
    pipeStage = next;
    updatePipelineView();
    return true;
  }

  if (pipeEls.prevBtn) pipeEls.prevBtn.addEventListener('click', () => stepPipeline(-1));
  if (pipeEls.nextBtn) pipeEls.nextBtn.addEventListener('click', () => stepPipeline(1));
  pipeEls.pills.forEach((p) => {
    p.addEventListener('click', () => setPipelineStep(Number(p.dataset.pipeStep)));
  });
  pipeEls.modeTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      pipeMode = tab.dataset.pipeMode;
      updatePipelineView();
    });
  });

  // Expose presentation controller for ui.js scroll integration
  window.pipelinePresentation = {
    step: stepPipeline,
    setStep: setPipelineStep,
    getStep: () => pipeStage,
    count: 5
  };

  window.addEventListener('resize', () => {
    drawTimeline();
    drawExpCurve();
  });

  // ============================================================================
  // MAIN ANIMATION LOOP
  // ============================================================================
  let lastRafTime = null;
  let lastReadoutTime = 0;
  let wasSpiking = false;

  function loop(now) {
    if (lastRafTime === null) lastRafTime = now;
    const dtReal = Math.min(now - lastRafTime, 50);
    lastRafTime = now;

    state.realSpikeMs = state.spikeStartReal >= 0
      ? getSpikeEnvelopeMs(now - state.spikeStartReal)
      : 0;

    if (!state.paused) {
      stepLaneSimulators(dtReal * state.speed);
      stepSimArenas();
    }

    const isSpiking = state.simSpikeMs > 0.1 || state.realSpikeMs > 0.1;
    if (isSpiking || wasSpiking) {
      updateLoadDisplay();
      updateSimReadouts();
      drawExpCurve();
      updateArenaStaticStats();
      drawTimeline();
      updatePipelineView();
      wasSpiking = isSpiking;
    }

    MODES.forEach((m) => {
      drawLane(m);
      drawFrametimeGraph(m);
      drawSimArena(m);
    });

    if (now - lastReadoutTime > (isSpiking ? 90 : 260)) {
      lastReadoutTime = now;
      updateLaneReadouts();
      updateSimReadouts();
    }

    updateAndDrawArena(now);

    requestAnimationFrame(loop);
  }

  // ============================================================================
  // INIT
  // ============================================================================
  updateLaneReadouts();
  updateSimReadouts();
  drawExpCurve();
  updateArenaStaticStats();
  drawTimeline();
  updatePipelineView();
  detectRefreshRate(true);
  requestAnimationFrame(loop);
})();
