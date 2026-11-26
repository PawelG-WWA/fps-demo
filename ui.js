(() => {
  'use strict';

  const scroller = document.getElementById('stageScroller');
  if (!scroller) return;

  const slides = Array.from(scroller.querySelectorAll('.stage-slide'));
  const navButtons = Array.from(document.querySelectorAll('[data-target]'));
  const stepPills = Array.from(document.querySelectorAll('.step-pill'));
  const railDots = Array.from(document.querySelectorAll('.rail-dot'));
  const pipelineIdx = slides.findIndex((s) => s.id === 'pipelineSection');

  function isFirstVisitLocked() {
    const root = document.documentElement;
    return root.classList.contains('is-blind-test') || root.classList.contains('is-intro-replay');
  }

  let activeIndex = (isFirstVisitLocked() && pipelineIdx >= 0) ? pipelineIdx : 0;
  let rafPending = false;

  // Smooth programmatic view glide state
  let animRafId = null;
  let isAnimating = false;
  const GLIDE_DURATION_MS = 540;

  // Wheel / trackpad gesture state (prevents inertial double-skipping)
  let wheelAccum = 0;
  let lastWheelTime = 0;
  let lastWheelAbsDelta = 0;
  let wheelLocked = false;
  let wheelUnlockTimer = null;

  function isStackedLayout() {
    return window.innerWidth <= 820 || window.innerHeight <= 640;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function setActiveIndicators(idx) {
    const prevIdx = activeIndex;
    activeIndex = idx;
    const activeId = slides[idx] ? slides[idx].id : '';
    stepPills.forEach((el) => el.classList.toggle('active', el.dataset.target === activeId));
    railDots.forEach((el) => el.classList.toggle('active', el.dataset.target === activeId));
    if (prevIdx !== idx && activeId) {
      window.dispatchEvent(new CustomEvent('fpslab:section-changed', { detail: { id: activeId } }));
    }
  }

  function getActiveSectionId() {
    if (!isStackedLayout()) {
      return slides[activeIndex] ? slides[activeIndex].id : 'motionSection';
    }
    const midY = window.innerHeight * 0.42;
    let bestId = slides[0] ? slides[0].id : 'motionSection';
    let bestDist = Infinity;
    slides.forEach((slide) => {
      const rect = slide.getBoundingClientRect();
      if (rect.height <= 0) return;
      const dist = rect.top <= midY && rect.bottom >= midY
        ? 0
        : Math.min(Math.abs(rect.top - midY), Math.abs(rect.bottom - midY));
      if (dist < bestDist) {
        bestDist = dist;
        bestId = slide.id;
      }
    });
    return bestId;
  }

  window.fpsLabNav = {
    getActiveSectionId
  };

  function updateScrollPresentation() {
    rafPending = false;

    if (isFirstVisitLocked()) {
      if (pipelineIdx >= 0) {
        activeIndex = pipelineIdx;
        const inner = slides[pipelineIdx] && slides[pipelineIdx].querySelector('.slide-inner');
        if (inner) {
          inner.style.opacity = '1';
          inner.style.transform = 'translate3d(0, 0px, 0)';
        }
      }
      return;
    }

    if (isStackedLayout()) {
      slides.forEach((slide) => {
        const inner = slide.querySelector('.slide-inner');
        if (inner) {
          inner.style.opacity = '';
          inner.style.transform = '';
        }
      });
      return;
    }

    const vh = scroller.clientHeight || window.innerHeight;
    const scrollTop = scroller.scrollTop;
    let closestIdx = 0;
    let closestDist = Infinity;

    slides.forEach((slide, idx) => {
      const inner = slide.querySelector('.slide-inner');
      const offset = slide.offsetTop - scrollTop;
      const progress = offset / vh; // 0 = active, <0 = leaving up, >0 = entering from below
      const dist = Math.abs(progress);

      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = idx;
      }

      if (!inner) return;

      if (dist < 0.002) {
        inner.style.opacity = '1';
        inner.style.transform = 'translate3d(0, 0px, 0)';
      } else if (progress < 0) {
        // Previous section vanishes gently as user scrolls down
        const opacity = Math.max(0, 1 - dist * 1.45);
        const shiftY = progress * 24;
        inner.style.opacity = opacity.toFixed(3);
        inner.style.transform = `translate3d(0, ${shiftY.toFixed(1)}px, 0)`;
      } else {
        // Next section rolls up smoothly into view
        const opacity = Math.max(0, 1 - dist * 1.25);
        const shiftY = Math.min(48, progress * 44);
        inner.style.opacity = opacity.toFixed(3);
        inner.style.transform = `translate3d(0, ${shiftY.toFixed(1)}px, 0)`;
      }
    });

    if (!isAnimating) {
      setActiveIndicators(closestIdx);
    }
  }

  function scheduleUpdate() {
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(updateScrollPresentation);
    }
  }

  function goToSlide(targetIdx) {
    const clamped = Math.max(0, Math.min(slides.length - 1, targetIdx));
    const targetSlide = slides[clamped];
    if (!targetSlide) return;

    if (isStackedLayout()) {
      targetSlide.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveIndicators(clamped);
      return;
    }

    const startTop = scroller.scrollTop;
    const targetTop = targetSlide.offsetTop;
    const delta = targetTop - startTop;

    setActiveIndicators(clamped);

    if (Math.abs(delta) < 1) {
      scroller.scrollTop = targetTop;
      updateScrollPresentation();
      return;
    }

    if (animRafId !== null) {
      cancelAnimationFrame(animRafId);
      animRafId = null;
    }

    isAnimating = true;
    const startTime = performance.now();

    function step(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / GLIDE_DURATION_MS);
      scroller.scrollTop = startTop + delta * easeOutCubic(t);
      updateScrollPresentation();

      if (t < 1) {
        animRafId = requestAnimationFrame(step);
      } else {
        scroller.scrollTop = targetTop;
        animRafId = null;
        isAnimating = false;
        updateScrollPresentation();
      }
    }

    animRafId = requestAnimationFrame(step);
  }

  function lockWheelUntilQuiet() {
    wheelLocked = true;
    wheelAccum = 0;
    clearTimeout(wheelUnlockTimer);
    // Unlock once wheel/trackpad events stop firing for 140ms (and animation is done)
    wheelUnlockTimer = setTimeout(() => {
      wheelLocked = false;
      wheelAccum = 0;
    }, 140);
  }

  function handleDirectionalNavigation(dir) {
    // During Pipeline intro replay modal, keep section locked until closed/finished
    if (isFirstVisitLocked()) return;

    const nextIdx = activeIndex + dir;
    if (nextIdx < 0 || nextIdx >= slides.length) return;

    goToSlide(nextIdx);
  }

  function onWheel(e) {
    if (isStackedLayout() && !isFirstVisitLocked()) return;
    // Allow pinch-zoom or horizontal scrolling (e.g. narrow timeline overflow)
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (e.deltaY === 0) return;

    e.preventDefault();

    const now = performance.now();
    const absDelta = Math.abs(e.deltaY);
    const gap = now - lastWheelTime;

    // Detect a fresh intentional scroll flick after animation finishes even if trackpad was still slightly ticking
    if (wheelLocked) {
      if (!isAnimating && gap > 80 && absDelta > lastWheelAbsDelta * 1.8 && absDelta >= 20) {
        wheelLocked = false;
        wheelAccum = 0;
      } else {
        lastWheelTime = now;
        lastWheelAbsDelta = absDelta;
        lockWheelUntilQuiet();
        return;
      }
    }

    if (gap > 160) {
      wheelAccum = 0;
    }
    lastWheelTime = now;
    lastWheelAbsDelta = absDelta;

    if (isAnimating) {
      lockWheelUntilQuiet();
      return;
    }

    // Normalize line/page wheel modes to pixels
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32;
    else if (e.deltaMode === 2) dy *= window.innerHeight;

    wheelAccum += dy;

    // Trigger automatic snap / presentation step on a single gentle mouse wheel roll
    const THRESHOLD = 18;
    if (wheelAccum >= THRESHOLD) {
      lockWheelUntilQuiet();
      handleDirectionalNavigation(1);
    } else if (wheelAccum <= -THRESHOLD) {
      lockWheelUntilQuiet();
      handleDirectionalNavigation(-1);
    }
  }

  // Listen on window so scrolling anywhere (even over top chrome or edges) smoothly advances views
  window.addEventListener('wheel', onWheel, { passive: false });

  // Handle manual scrollbar drag: settle cleanly to nearest slide when drag stops
  let scrollEndTimer = null;
  let lastStackedSectionId = null;
  scroller.addEventListener('scroll', () => {
    scheduleUpdate();
    if (isStackedLayout() && !isFirstVisitLocked()) {
      clearTimeout(scrollEndTimer);
      scrollEndTimer = setTimeout(() => {
        const curId = getActiveSectionId();
        if (curId && curId !== lastStackedSectionId) {
          lastStackedSectionId = curId;
          window.dispatchEvent(new CustomEvent('fpslab:section-changed', { detail: { id: curId } }));
        }
      }, 160);
      return;
    }
    if (isAnimating || isFirstVisitLocked()) return;
    clearTimeout(scrollEndTimer);
    scrollEndTimer = setTimeout(() => {
      if (isAnimating || isStackedLayout() || isFirstVisitLocked()) return;
      const vh = scroller.clientHeight || window.innerHeight;
      const nearest = Math.round(scroller.scrollTop / vh);
      if (Math.abs(scroller.scrollTop - slides[nearest].offsetTop) > 2) {
        goToSlide(nearest);
      }
    }, 140);
  }, { passive: true });

  // Touch swipe support (enabled for desktop slides AND mobile Pipeline intro)
  let touchStartY = null;
  let touchStartX = null;
  let touchIgnored = false;
  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (isStackedLayout() && !isFirstVisitLocked()) return;
    const t = e.target;
    touchIgnored = !!(t && (t.id === 'arenaCanvas' || t.tagName === 'INPUT' || (t.closest && t.closest('button'))));
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  scroller.addEventListener('touchend', (e) => {
    if (touchIgnored || touchStartY === null) return;
    if (isStackedLayout() && !isFirstVisitLocked()) return;
    const endY = e.changedTouches[0].clientY;
    const endX = e.changedTouches[0].clientX;
    const diffY = touchStartY - endY;
    const diffX = Math.abs((touchStartX || 0) - endX);
    touchStartY = null;
    touchStartX = null;
    if (Math.abs(diffY) > 36 && Math.abs(diffY) > diffX) {
      if (diffY > 0) {
        handleDirectionalNavigation(1);
      } else {
        handleDirectionalNavigation(-1);
      }
    }
  }, { passive: true });

  // Keep active slide perfectly aligned on window resize
  window.addEventListener('resize', () => {
    if (!isStackedLayout() && !isFirstVisitLocked() && slides[activeIndex]) {
      scroller.scrollTop = slides[activeIndex].offsetTop;
    }
    scheduleUpdate();
  }, { passive: true });

  // When Blind Test starts (from console), lock viewport onto 01 Motion
  window.addEventListener('fpslab:blind-entered', () => {
    const slide = slides[0];
    if (!slide) return;
    activeIndex = 0;
    if (isStackedLayout()) {
      scroller.scrollTop = 0;
    } else {
      scroller.scrollTop = slide.offsetTop;
    }
    setActiveIndicators(0);
    updateScrollPresentation();
  });

  // When Blind Test exits (completed or skipped), unlock full lab at 01 Motion
  window.addEventListener('fpslab:blind-exited', () => {
    const slide = slides[0];
    if (!slide) return;
    activeIndex = 0;
    if (isStackedLayout()) {
      scroller.scrollTop = 0;
    } else {
      scroller.scrollTop = slide.offsetTop;
    }
    setActiveIndicators(0);
    updateScrollPresentation();
  });

  // When manual replay starts from 04 Pipeline, lock viewport onto the intro slide
  window.addEventListener('fpslab:intro-replay-started', () => {
    if (pipelineIdx < 0 || !slides[pipelineIdx]) return;
    activeIndex = pipelineIdx;
    if (!isStackedLayout()) {
      scroller.scrollTop = 0;
    }
    updateScrollPresentation();
  });

  // When Pipeline intro finishes vanishing, redirect to 01 Motion (first visit) or 04 Pipeline (replay)
  window.addEventListener('fpslab:intro-unlocked', (e) => {
    const target = e && e.detail && e.detail.target === 'pipeline' && pipelineIdx >= 0
      ? pipelineIdx
      : 0;
    const slide = slides[target];
    if (!slide) return;
    if (isStackedLayout()) {
      slide.scrollIntoView({ behavior: 'instant', block: 'start' });
    } else {
      scroller.scrollTop = slide.offsetTop;
    }
    setActiveIndicators(target);
    updateScrollPresentation();
  });

  // Programmatic section navigation (e.g. restoring a shared URL)
  function navigateToTarget(targetId, instant) {
    const idx = slides.findIndex((s) => s.id === targetId);
    if (idx < 0) return;
    const slide = slides[idx];
    if (instant) {
      if (isStackedLayout()) {
        slide.scrollIntoView({ behavior: 'instant', block: 'start' });
      } else {
        scroller.scrollTop = slide.offsetTop;
      }
      setActiveIndicators(idx);
      updateScrollPresentation();
    } else {
      goToSlide(idx);
    }
  }

  window.addEventListener('fpslab:navigate-section', (e) => {
    const detail = e && e.detail ? e.detail : {};
    if (detail.target) {
      navigateToTarget(detail.target, !!detail.instant);
    }
  });

  // Top bar stepper, right-edge dots, and scroll cues
  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = slides.findIndex((s) => s.id === btn.dataset.target);
      if (idx >= 0) goToSlide(idx);
    });
  });

  // Keyboard navigation
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const currentSlide = slides[activeIndex];
      const pres = window.pipelinePresentation;
      if (currentSlide && currentSlide.id === 'pipelineSection' && pres) {
        e.preventDefault();
        pres.step(e.key === 'ArrowRight' ? 1 : -1);
      }
      return;
    }

    if (isStackedLayout() && !isFirstVisitLocked()) return;

    if (e.key === 'PageDown' || e.key === 'ArrowDown') {
      e.preventDefault();
      handleDirectionalNavigation(1);
    } else if (e.key === 'PageUp' || e.key === 'ArrowUp') {
      e.preventDefault();
      handleDirectionalNavigation(-1);
    }
  });

  const initialPendingSection = window.__fpsLabPendingSection || null;
  if (initialPendingSection) {
    delete window.__fpsLabPendingSection;
    navigateToTarget(initialPendingSection, true);
  } else {
    updateScrollPresentation();
  }
  window.addEventListener('load', () => {
    if (initialPendingSection && !isFirstVisitLocked()) {
      navigateToTarget(initialPendingSection, true);
    } else {
      updateScrollPresentation();
    }
    window.dispatchEvent(new Event('resize'));
  });
})();
