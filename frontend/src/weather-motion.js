/** Weather-chip surface morph. The surface changes size; its text never scales. */
const activeMotions = new WeakMap();
const EASING = 'cubic-bezier(.22, 1, .36, 1)';
const VISUAL_PROPERTIES = [
  'display', 'position', 'box-sizing', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'margin', 'padding', 'border', 'border-radius',
  'background-color', 'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'font-variant-numeric', 'font-feature-settings',
  'text-align', 'white-space', 'text-overflow', 'overflow', 'opacity',
  'align-items', 'justify-content', 'flex-direction', 'flex-wrap', 'flex-grow',
  'flex-shrink', 'gap', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
];

const cssName = (property) => property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const bounds = (element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    right: rect.right, bottom: rect.bottom };
};
const validBounds = (rect) => rect && rect.width > 0 && rect.height > 0;
const surfaceFrame = (rect, style) => ({
  left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  borderRadius: style.borderRadius, backgroundColor: style.backgroundColor, boxShadow: style.boxShadow,
});
const clipFrame = (dialogRect, surfaceRect, radius) => `inset(${surfaceRect.top - dialogRect.top}px ${dialogRect.right - surfaceRect.right}px ${dialogRect.bottom - surfaceRect.bottom}px ${surfaceRect.left - dialogRect.left}px round ${radius})`;

function visualChip(element, view) {
  const clone = element.cloneNode(true);
  const originalNodes = [element, ...element.querySelectorAll('*')];
  const clonedNodes = [clone, ...clone.querySelectorAll('*')];
  for (let index = 0; index < originalNodes.length; index++) {
    const copy = clonedNodes[index];
    if (copy.matches('script, style, iframe, object, embed, video, audio')) {
      copy.remove();
      continue;
    }
    for (const attribute of [...copy.attributes]) {
      if (/^(on|aria-|data-)/i.test(attribute.name) || ['id', 'tabindex', 'autofocus', 'for', 'role', 'href'].includes(attribute.name)) {
        copy.removeAttribute(attribute.name);
      }
    }
    const style = view.getComputedStyle(originalNodes[index]);
    for (const property of VISUAL_PROPERTIES) copy.style.setProperty(property, style.getPropertyValue(property));
  }
  clone.classList.add('weather-morph-chip');
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  Object.assign(clone.style, {
    position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto',
    minWidth: '0', minHeight: '0', maxWidth: 'none', maxHeight: 'none',
    margin: '0', background: 'transparent', borderColor: 'transparent', boxShadow: 'none',
    pointerEvents: 'none', visibility: 'visible', transform: 'none',
  });
  return clone;
}

/**
 * Call after the overlay is connected. The caller owns/removes root in close's
 * callback. finish() settles the current leg; dispose() only cleans up.
 * Sources are resolved again after DOM patches and before the return morph.
 */
export function morphWeather(root, sourceButton) {
  activeMotions.get(root)?.dispose();
  const document = root.ownerDocument;
  const view = document.defaultView;
  const sourceRoot = sourceButton?.getRootNode() || root.getRootNode();
  const sourceValue = sourceButton?.getAttribute('data-weather-open');
  const media = view.matchMedia('(prefers-reduced-motion: reduce)');
  const hiddenSources = new Map();
  const stageStyles = new Map();
  const persistentStyles = new Map();
  const closeCallbacks = new Set();
  const oldMotionAttribute = root.getAttribute('data-weather-motion');
  let dialog = root.querySelector('.weather-dialog');
  let backdrop = root.querySelector('.weather-backdrop');
  let source = sourceButton;
  let ghost, chipClone, resizeObserver, treeObserver, disconnectObserver;
  let animations = [], generation = 0, state = 'opening', disposed = false;
  let targetRect;

  function setOwnedStyle(collection, element, property, value) {
    if (!element) return;
    const key = cssName(property);
    if (!collection.has(element)) collection.set(element, new Map());
    const saved = collection.get(element);
    if (!saved.has(key)) saved.set(key, [element.style.getPropertyValue(key), element.style.getPropertyPriority(key)]);
    element.style.setProperty(key, value);
  }
  function restoreStyles(collection) {
    for (const [element, properties] of collection) {
      for (const [key, [value, priority]] of properties) {
        if (value) element.style.setProperty(key, value, priority);
        else element.style.removeProperty(key);
      }
    }
    collection.clear();
  }
  function resolveSource() {
    const candidates = [...(sourceRoot.querySelectorAll?.('[data-weather-open]') || [])]
      .filter((element) => !root.contains(element) && element.isConnected);
    const matching = sourceValue == null ? candidates : candidates.filter((element) => element.getAttribute('data-weather-open') === sourceValue);
    return matching.find((element) => validBounds(bounds(element)))
      || candidates.find((element) => validBounds(bounds(element)))
      || (source?.isConnected && !root.contains(source) && validBounds(bounds(source)) ? source : null);
  }
  function concealSource() {
    source = resolveSource();
    if (!source) return;
    if (!hiddenSources.has(source)) {
      hiddenSources.set(source, {
        visibility: source.style.getPropertyValue('visibility'),
        priority: source.style.getPropertyPriority('visibility'),
        attribute: source.getAttribute('data-weather-morph-source'),
      });
    }
    // updateMarkup also patches attributes of surviving nodes; reapply only if
    // it removed our temporary visibility, without creating an observer loop.
    if (source.style.getPropertyValue('visibility') !== 'hidden' || source.style.getPropertyPriority('visibility') !== 'important') {
      source.style.setProperty('visibility', 'hidden', 'important');
    }
    if (!source.hasAttribute('data-weather-morph-source')) source.setAttribute('data-weather-morph-source', '');
  }
  function cancelAnimations() {
    generation++;
    for (const animation of animations) animation.cancel();
    animations = [];
  }
  function clearStage() {
    cancelAnimations();
    restoreStyles(stageStyles);
    ghost?.remove();
    ghost = chipClone = null;
  }
  function setState(value) {
    state = value;
    root.setAttribute('data-weather-motion', value);
  }
  function cleanup() {
    if (disposed) return;
    disposed = true;
    treeObserver?.disconnect();
    disconnectObserver?.disconnect();
    resizeObserver?.disconnect();
    view.removeEventListener('resize', onResize);
    view.visualViewport?.removeEventListener('resize', onResize);
    view.visualViewport?.removeEventListener('scroll', onResize);
    media.removeEventListener('change', onMotionChange);
    clearStage();
    restoreStyles(persistentStyles);
    for (const [element, saved] of hiddenSources) {
      if (saved.visibility) element.style.setProperty('visibility', saved.visibility, saved.priority);
      else element.style.removeProperty('visibility');
      if (saved.attribute === null) element.removeAttribute('data-weather-morph-source');
      else element.setAttribute('data-weather-morph-source', saved.attribute);
    }
    hiddenSources.clear();
    if (oldMotionAttribute === null) root.removeAttribute('data-weather-motion');
    else root.setAttribute('data-weather-motion', oldMotionAttribute);
    if (activeMotions.get(root) === controller) activeMotions.delete(root);
  }
  function finish() {
    if (disposed) return;
    if (state === 'closing') {
      const callbacks = [...closeCallbacks];
      closeCallbacks.clear();
      cleanup();
      for (const callback of callbacks) callback();
    } else {
      clearStage();
      setState('open');
      targetRect = dialog?.isConnected ? bounds(dialog) : null;
      concealSource();
    }
  }
  function onResize() {
    if (disposed) return;
    if (!root.isConnected) return controller.dispose();
    // Never keep an old viewport-space destination after an orientation change.
    if (state !== 'open') finish();
    else targetRect = dialog?.isConnected ? bounds(dialog) : null;
  }
  function onMotionChange() { if (media.matches) finish(); }
  function onTreeChange() {
    if (disposed) return;
    if (!root.isConnected) return controller.dispose();
    const currentDialog = root.querySelector('.weather-dialog');
    const currentBackdrop = root.querySelector('.weather-backdrop');
    if (!currentDialog) return controller.dispose();
    if (currentDialog !== dialog || currentBackdrop !== backdrop) {
      finish();
      if (disposed) return;
      resizeObserver?.unobserve(dialog);
      dialog = currentDialog;
      backdrop = currentBackdrop;
      targetRect = bounds(dialog);
      resizeObserver?.observe(dialog);
      ensureBlur();
    }
    concealSource();
  }
  function ensureBlur() {
    if (!backdrop) return;
    const computed = view.getComputedStyle(backdrop);
    if (!computed.backdropFilter || computed.backdropFilter === 'none') {
      setOwnedStyle(persistentStyles, backdrop, 'backdrop-filter', 'blur(32px)');
      setOwnedStyle(persistentStyles, backdrop, '-webkit-backdrop-filter', 'blur(32px)');
    }
  }
  function makeGhost(frame, opacity) {
    ghost = document.createElement('div');
    ghost.className = 'weather-morph-surface';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    const backdropZ = Number.parseInt(backdrop ? view.getComputedStyle(backdrop).zIndex : '', 10) || 0;
    const dialogZ = Number.parseInt(view.getComputedStyle(dialog).zIndex, 10) || 0;
    const zIndex = dialogZ > backdropZ + 1 ? backdropZ + 1 : Math.max(backdropZ, dialogZ) + 1;
    Object.assign(ghost.style, {
      position: 'fixed', zIndex: String(zIndex), pointerEvents: 'none', overflow: 'hidden',
      isolation: 'isolate', boxSizing: 'border-box', margin: '0', padding: '0', border: '0',
      ...frame, opacity: String(opacity),
    });
    root.appendChild(ghost);
  }
  function replaceChipClone(element, opacity) {
    chipClone?.remove();
    chipClone = visualChip(element, view);
    const rect = bounds(element);
    Object.assign(chipClone.style, { width: `${rect.width}px`, height: `${rect.height}px`, opacity: String(opacity) });
    ghost.appendChild(chipClone);
  }
  function animate(element, frames, duration, easing = EASING) {
    const animation = element.animate(frames, { duration, easing, fill: 'both' });
    animations.push(animation);
  }
  function waitForStage() {
    const currentGeneration = generation;
    Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!disposed && currentGeneration === generation) finish();
    });
  }
  function animateBackdrop(from, to, duration) {
    if (!backdrop) return;
    for (const [key, value] of Object.entries(from)) setOwnedStyle(stageStyles, backdrop, key, value);
    animate(backdrop, [from, to], duration);
  }
  function startOpening() {
    concealSource();
    if (media.matches || !root.isConnected || !dialog?.animate || !source) return finish();
    const sourceRect = bounds(source);
    targetRect = bounds(dialog);
    if (!validBounds(sourceRect) || !validBounds(targetRect)) return finish();
    const sourceStyle = view.getComputedStyle(source);
    const dialogStyle = view.getComputedStyle(dialog);
    const initial = surfaceFrame(sourceRect, sourceStyle);
    const target = surfaceFrame(targetRect, dialogStyle);
    const initialClip = clipFrame(targetRect, sourceRect, sourceStyle.borderRadius || '22px');
    const targetClip = clipFrame(targetRect, targetRect, dialogStyle.borderRadius || '32px');
    const dialogOpacity = dialogStyle.opacity;
    const duration = 420;
    try {
      makeGhost(initial, 1);
      replaceChipClone(source, 1);
      setOwnedStyle(stageStyles, dialog, 'opacity', '0');
      setOwnedStyle(stageStyles, dialog, 'clip-path', initialClip);
      animate(ghost, [initial, target], duration);
      animate(ghost, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: .78 }, { opacity: 0, offset: 1 }], duration, 'linear');
      animate(chipClone, [{ opacity: 1, offset: 0 }, { opacity: 0, offset: .3 }, { opacity: 0, offset: 1 }], duration, 'linear');
      animate(dialog, [{ clipPath: initialClip }, { clipPath: targetClip }], duration);
      animate(dialog, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: .5 }, { opacity: dialogOpacity, offset: 1 }], duration, 'linear');
      if (backdrop) {
        const style = view.getComputedStyle(backdrop);
        animateBackdrop({ opacity: '0', backdropFilter: 'blur(0px)' },
          { opacity: style.opacity, backdropFilter: style.backdropFilter || 'blur(32px)' }, duration);
      }
      waitForStage();
    } catch {
      finish();
    }
  }
  function close(onFinish = () => {}) {
    if (disposed) return onFinish();
    closeCallbacks.add(onFinish);
    if (state === 'closing') return;
    concealSource();
    setState('closing');
    if (media.matches || !root.isConnected || !source || !dialog?.isConnected || !dialog.animate) return finish();
    const endRect = bounds(source);
    const dialogRect = bounds(dialog);
    if (!validBounds(endRect) || !validBounds(dialogRect)) return finish();
    // Read every in-flight value before canceling an interrupted entrance.
    const surfaceRect = ghost ? bounds(ghost) : dialogRect;
    const surfaceStyle = view.getComputedStyle(ghost || dialog);
    const current = surfaceFrame(surfaceRect, surfaceStyle);
    const ghostOpacity = ghost ? surfaceStyle.opacity : '0';
    const chipOpacity = chipClone ? view.getComputedStyle(chipClone).opacity : '0';
    const dialogStyle = view.getComputedStyle(dialog);
    const dialogOpacity = dialogStyle.opacity;
    const currentClip = dialogStyle.clipPath === 'none'
      ? clipFrame(dialogRect, dialogRect, dialogStyle.borderRadius || '32px') : dialogStyle.clipPath;
    const backdropStyle = backdrop ? view.getComputedStyle(backdrop) : null;
    const backdropFrom = backdropStyle ? { opacity: backdropStyle.opacity, backdropFilter: backdropStyle.backdropFilter || 'blur(32px)' } : null;
    const sourceStyle = view.getComputedStyle(source);
    const target = surfaceFrame(endRect, sourceStyle);
    const targetClip = clipFrame(dialogRect, endRect, sourceStyle.borderRadius || '22px');
    cancelAnimations();
    const duration = 300;
    try {
      if (!ghost) makeGhost(current, ghostOpacity);
      else Object.assign(ghost.style, current, { opacity: ghostOpacity });
      replaceChipClone(source, chipOpacity);
      setOwnedStyle(stageStyles, dialog, 'opacity', dialogOpacity);
      setOwnedStyle(stageStyles, dialog, 'clip-path', currentClip);
      animate(ghost, [current, target], duration);
      animate(ghost, [{ opacity: ghostOpacity, offset: 0 }, { opacity: 1, offset: .22 }, { opacity: 1, offset: 1 }], duration, 'linear');
      animate(chipClone, [{ opacity: chipOpacity, offset: 0 }, { opacity: chipOpacity, offset: .6 }, { opacity: 1, offset: 1 }], duration, 'linear');
      animate(dialog, [{ clipPath: currentClip }, { clipPath: targetClip }], duration);
      animate(dialog, [{ opacity: dialogOpacity, offset: 0 }, { opacity: 0, offset: .22 }, { opacity: 0, offset: 1 }], duration, 'linear');
      if (backdropFrom) animateBackdrop(backdropFrom, { opacity: '0', backdropFilter: 'blur(0px)' }, duration);
      waitForStage();
    } catch {
      finish();
    }
  }
  const controller = {
    close,
    finish,
    dispose() { closeCallbacks.clear(); cleanup(); },
  };
  activeMotions.set(root, controller);
  setState('opening');
  ensureBlur();
  media.addEventListener('change', onMotionChange);
  view.addEventListener('resize', onResize);
  view.visualViewport?.addEventListener('resize', onResize);
  view.visualViewport?.addEventListener('scroll', onResize);
  if (view.MutationObserver) {
    treeObserver = new view.MutationObserver(onTreeChange);
    treeObserver.observe(sourceRoot, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'data-weather-open', 'data-weather-morph-source'] });
    // A shadow root does not observe removal of its own host from the document.
    if (sourceRoot !== document) {
      disconnectObserver = new view.MutationObserver(() => { if (!root.isConnected) controller.dispose(); });
      disconnectObserver.observe(document, { childList: true, subtree: true });
    }
  }
  if (view.ResizeObserver && dialog) {
    resizeObserver = new view.ResizeObserver(() => {
      if (disposed || !targetRect || !dialog.isConnected) return;
      const rect = bounds(dialog);
      if (Math.abs(rect.width - targetRect.width) > .5 || Math.abs(rect.height - targetRect.height) > .5) onResize();
    });
    resizeObserver.observe(dialog);
  }
  startOpening();
  return controller;
}
