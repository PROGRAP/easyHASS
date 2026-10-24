/** Shared room-card surface transition. Geometry changes without scaling text. */
const activeTransitions = new WeakMap();
const EASING = 'cubic-bezier(.22, 1, .36, 1)';
const VISUAL_STYLES = [
  'display', 'position', 'left', 'top', 'right', 'bottom', 'width', 'height',
  'min-width', 'min-height', 'max-width', 'max-height', 'box-sizing',
  'margin', 'padding', 'overflow', 'border', 'border-radius',
  'background-color', 'background-image', 'background-size', 'background-position',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'font-variant-numeric', 'font-feature-settings',
  'text-align', 'text-transform', 'text-overflow', 'text-shadow', 'white-space', 'overflow-wrap',
  'opacity', 'align-items', 'justify-content', 'flex-direction', 'flex-wrap',
  'flex-grow', 'flex-shrink', 'gap', 'object-fit', 'object-position',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
];

function rectOf(element) {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}

function visualClone(element) {
  const clone = element.cloneNode(true);
  const originals = [element, ...element.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  for (let index = 0; index < originals.length; index++) {
    const copy = copies[index];
    if (index && copy.matches('button, input, select, textarea, video, audio, iframe, object, embed, script, style, [data-control]')) {
      copy.remove();
      continue;
    }
    for (const attribute of [...copy.attributes]) {
      if (/^(on|aria-)/i.test(attribute.name) || ['id', 'tabindex', 'autofocus', 'for', 'role'].includes(attribute.name)) copy.removeAttribute(attribute.name);
    }
    if (copy.localName === 'a') copy.removeAttribute('href');
    const computed = getComputedStyle(originals[index]);
    for (const property of VISUAL_STYLES) copy.style.setProperty(property, computed.getPropertyValue(property));
    // Measurement labels inherit the animated wrapper font, instead of freezing
    // a computed pixel size into every nested span.
    if (index && copy.namespaceURI === 'http://www.w3.org/1999/xhtml' && copy.localName !== 'img') {
      copy.style.fontSize = 'inherit';
      copy.style.lineHeight = 'inherit';
    }
  }
  return clone;
}

function captureFragment(element) {
  if (!element) return null;
  const rect = rectOf(element);
  if (!rect.width || !rect.height) return null;
  const style = getComputedStyle(element);
  return {
    rect, clone: visualClone(element),
    styles: {
      borderRadius: style.borderRadius, backgroundColor: style.backgroundColor,
      color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight,
      lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, textShadow: style.textShadow,
    },
  };
}

/** Capture before changing layout; clones contain visual fragments only. */
export function captureRoomVisual(element) {
  if (!element) return null;
  const style = getComputedStyle(element);
  return {
    element, rect: rectOf(element), elementRect: rectOf(element), radius: style.borderRadius,
    backgroundColor: style.backgroundColor,
    photo: captureFragment(element.querySelector('.room-transition-photo, .room-picture, .detail-photo')),
    title: captureFragment(element.matches('.room-detail')
      ? element.querySelector('.detail-header h1')
      : element.querySelector('.room-transition-title, h2, .detail-header h1')),
    climate: captureFragment(element.querySelector('.room-transition-climate, .room-climate, .detail-climate')),
  };
}

const surfaceFrame = (capture) => ({
  left: `${capture.rect.left}px`, top: `${capture.rect.top}px`,
  width: `${capture.rect.width}px`, height: `${capture.rect.height}px`,
  borderRadius: capture.radius, backgroundColor: capture.backgroundColor,
});

function fragmentFrame(fragment, surface) {
  return {
    left: `${fragment.rect.left - surface.rect.left}px`, top: `${fragment.rect.top - surface.rect.top}px`,
    width: `${fragment.rect.width}px`, height: `${fragment.rect.height}px`,
    ...fragment.styles,
  };
}

function clipTo(outer, inner) {
  const top = inner.rect.top - outer.rect.top;
  const right = outer.rect.right - inner.rect.right;
  const bottom = outer.rect.bottom - inner.rect.bottom;
  const left = inner.rect.left - outer.rect.left;
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${inner.radius})`;
}

/**
 * finish() settles visuals and calls onFinish once; dispose() cancels silently.
 * Reduced-motion completion can be synchronous. A new transition on the same
 * root disposes the old one before taking ownership of temporary styles.
 */
export function morphRoom({ root, from, to, opening, onFinish = () => {} }) {
  activeTransitions.get(root)?.dispose();
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const animations = [];
  const restores = [];
  let ghost;
  let backdrop;
  let settled = false;
  const cleanup = () => {
    for (const animation of animations) animation.cancel();
    for (const restore of restores.reverse()) restore();
    ghost?.remove();
    media.removeEventListener('change', motionChange);
    if (activeTransitions.get(root) === controller) activeTransitions.delete(root);
  };
  const controller = {
    snapshot() {
      const detail = opening ? to : from;
      const backdropOpacity = backdrop ? Number(getComputedStyle(backdrop).opacity) : 1;
      if (!ghost || settled) {
        const capture = captureRoomVisual(detail?.element);
        return capture ? { ...capture, backdropOpacity } : capture;
      }
      return {
        ...captureRoomVisual(ghost), element: detail.element,
        elementRect: rectOf(detail.element), transitional: true, backdropOpacity,
        ghostOpacity: Number(getComputedStyle(ghost).opacity),
        detailOpacity: Number(getComputedStyle(detail.element).opacity),
      };
    },
    finish() {
      if (settled) return;
      settled = true;
      cleanup();
      onFinish();
    },
    dispose() {
      if (settled) return;
      settled = true;
      cleanup();
    },
  };
  const motionChange = () => { if (media.matches) controller.finish(); };
  activeTransitions.set(root, controller);
  const valid = from?.rect.width > 0 && from?.rect.height > 0 && to?.rect.width > 0 && to?.rect.height > 0;
  if (media.matches || !valid || !to.element?.animate) {
    controller.finish();
    return controller;
  }
  const preserveStyle = (element, property, value) => {
    const previous = element.style.getPropertyValue(property);
    const priority = element.style.getPropertyPriority(property);
    element.style.setProperty(property, value);
    restores.push(() => {
      if (previous) element.style.setProperty(property, previous, priority);
      else element.style.removeProperty(property);
    });
  };
  const duration = opening ? 480 : 360;
  const animate = (element, frames, easing = EASING) => {
    const animation = element.animate(frames, { duration, easing, fill: 'both' });
    animations.push(animation);
    return animation;
  };
  try {
    backdrop = root.querySelector('.room-backdrop');
    if (backdrop) {
      const opacity = from.transitional && Number.isFinite(from.backdropOpacity)
        ? from.backdropOpacity : opening ? 0 : Number(getComputedStyle(backdrop).opacity);
      const initialOpacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
      preserveStyle(backdrop, 'opacity', String(initialOpacity));
      animate(backdrop, [{ opacity: initialOpacity }, { opacity: opening ? 1 : 0 }]);
    }
    const homeCard = opening ? from.element : to.element;
    const sourceAttribute = homeCard.getAttribute('data-room-morph-source');
    homeCard.setAttribute('data-room-morph-source', '');
    restores.push(() => {
      if (sourceAttribute === null) homeCard.removeAttribute('data-room-morph-source');
      else homeCard.setAttribute('data-room-morph-source', sourceAttribute);
    });
    ghost = root.ownerDocument.createElement('div');
    ghost.className = 'room-transition-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, {
      position: 'fixed', zIndex: '60', pointerEvents: 'none', overflow: 'hidden',
      isolation: 'isolate', boxSizing: 'border-box', margin: '0', padding: '0', border: '0',
      ...surfaceFrame(from),
    });
    root.appendChild(ghost);
    const detail = opening ? to : from;
    const detailBounds = { rect: detail.elementRect || rectOf(detail.element) };
    const initialClip = clipTo(detailBounds, from);
    const finalClip = clipTo(detailBounds, to);
    // Apply the initial clip synchronously: the full destination must never
    // paint for one frame before the Web Animation starts.
    preserveStyle(detail.element, 'clip-path', initialClip);
    preserveStyle(detail.element, 'opacity', opening || from.transitional ? '0' : '1');
    animate(detail.element, [{ clipPath: initialClip }, { clipPath: finalClip }]);
    animate(detail.element, opening ? [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: .82 },
      { opacity: 1, offset: 1 },
    ] : [
      { opacity: from.transitional ? from.detailOpacity ?? 0 : 1, offset: 0 },
      { opacity: 0, offset: .18 },
      { opacity: 0, offset: 1 },
    ], opening ? 'linear' : EASING);
    animate(ghost, [surfaceFrame(from), surfaceFrame(to)]);
    animate(ghost, opening ? [
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: .82 },
      { opacity: 0, offset: 1 },
    ] : [
      { opacity: from.transitional ? from.ghostOpacity ?? 1 : 0, offset: 0 },
      { opacity: 1, offset: .18 },
      { opacity: 1, offset: 1 },
    ], opening ? 'linear' : EASING);
    for (const part of ['photo', 'title', 'climate']) {
      const first = from[part];
      const last = to[part];
      if (!first && !last) continue;
      const copy = (first || last).clone.cloneNode(true);
      copy.classList.add(`room-transition-${part}`);
      const start = first ? fragmentFrame(first, from) : fragmentFrame(last, to);
      const end = last ? fragmentFrame(last, to) : start;
      Object.assign(copy.style, {
        position: 'absolute', margin: '0', minWidth: '0', minHeight: '0', maxWidth: 'none', maxHeight: 'none',
        right: 'auto', bottom: 'auto', boxSizing: 'border-box', pointerEvents: 'none', ...start,
      });
      if (part === 'photo') {
        for (const image of copy.querySelectorAll('img')) Object.assign(image.style, { width: '100%', height: '100%' });
        const firstTint = first?.clone.querySelector('.detail-photo-tint');
        const lastTint = last?.clone.querySelector('.detail-photo-tint');
        const tintSource = firstTint || lastTint;
        if (tintSource) {
          const tint = copy.querySelector('.detail-photo-tint') || tintSource.cloneNode(true);
          Object.assign(tint.style, {
            position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto',
            width: '100%', height: '100%', pointerEvents: 'none',
          });
          if (!tint.parentNode) copy.appendChild(tint);
          const opacity = (element) => element ? Number.parseFloat(element.style.opacity) || 0 : 0;
          animate(tint, [{ opacity: opacity(firstTint) }, { opacity: opacity(lastTint) }]);
        }
      } else {
        // Nested measurement spans and outline icons follow the wrapper's
        // dark-to-light color transition instead of jumping at the handoff.
        for (const child of copy.querySelectorAll('*')) {
          const color = child.style.color;
          if (child.namespaceURI === 'http://www.w3.org/2000/svg') {
            for (const paint of ['fill', 'stroke']) {
              if (color && child.style[paint] === color) child.style[paint] = 'currentColor';
            }
          }
          child.style.color = 'inherit';
        }
      }
      ghost.appendChild(copy);
      animate(copy, [{ ...start, opacity: first ? 1 : 0 }, { ...end, opacity: last ? 1 : 0 }]);
    }
    media.addEventListener('change', motionChange);
    Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!settled) controller.finish();
    });
  } catch {
    // An unsupported animation property must not leave the real UI hidden.
    controller.finish();
  }
  return controller;
}
