import { coverIcon } from './icons.js';
import { controlValueLabel } from './control-label.js';

const RANGE = 'input[type="range"][data-inline-range]';
const TOGGLE = '[data-inline-toggle]';
const DETAILS = '[data-inline-details]';
const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const percent = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

/** Direct, absolute room-detail controls. Callbacks own HA calls/error messages.
 * active covers drafts and callback promises. Call sync after current targets
 * change and after rendering; cancel on navigation and dispose on disconnect.
 * end always runs after state is cleared, so it may synchronously render again.
 */
export class InlineControls {
  constructor(root, { getTarget, canStart, commit, toggle, end, isPending = () => false, openDetails = () => {} }) {
    Object.assign(this, { root, getTarget, canStart, commit, toggle, end, isPending, openDetails });
    this.window = root.ownerDocument.defaultView;
    this.blockedKeys = new Set();
    this.ignoredChanges = new WeakMap();
    this.suppressedDetails = new Set();
    this.listeners = {
      pointerdown: event => this.pointerDown(event),
      pointermove: event => this.pointerMove(event),
      pointerup: event => this.pointerUp(event),
      pointercancel: event => this.pointerCancel(event),
      lostpointercapture: event => this.pointerCancel(event),
      keydown: event => this.keyDown(event),
      keyup: event => this.keyUp(event),
      input: event => this.input(event),
      change: event => this.change(event),
      click: event => this.click(event),
      focusout: event => { if (event.target === this.session?.input && this.session.phase === 'draft') this.cancel(); },
      contextmenu: event => {
        if (this.control(event)) { event.preventDefault(); event.stopPropagation(); }
      },
      // Horizontal trackpad gestures over a control must not navigate rooms.
      wheel: event => { if (this.control(event)) event.stopPropagation(); },
    };
    for (const [name, listener] of Object.entries(this.listeners)) {
      root.addEventListener(name, listener, { capture: true, passive: false });
    }
    this.onLeave = () => { this.cancel(); this.blockedKeys.clear(); };
    for (const name of ['blur', 'pagehide', 'hashchange', 'popstate']) this.window.addEventListener(name, this.onLeave);
    // A candidate is not captured until its direction is known. Observe exits
    // too, so releasing outside the shadow root cannot leave it active.
    this.outsidePointer = event => {
      if (!this.press || event.composedPath().includes(this.root)) return;
      if (event.type === 'pointermove') this.pointerMove(event);
      else if (event.type === 'pointerup') this.pointerUp(event);
      else this.pointerCancel(event);
    };
    for (const name of ['pointermove', 'pointerup', 'pointercancel']) this.window.addEventListener(name, this.outsidePointer, { capture: true, passive: false });
  }

  get active() { return !!(this.session || this.press); }
  control(event) { return event.target?.closest?.(`${RANGE}, ${TOGGLE}, ${DETAILS}`); }

  target(element, action) {
    if (this.disposed || !element?.isConnected || !this.root.contains(element)
      || element.disabled || element.getAttribute('aria-disabled') === 'true'
      || element.closest('[inert]') || !this.canStart()) return null;
    const kind = element.dataset.inlineKind;
    if (kind !== 'light' && kind !== 'cover') return null;
    const id = element.dataset.inlineRange || element.dataset.inlineToggle || element.dataset.inlineDetails;
    const target = this.getTarget(id), summary = target?.[kind];
    if (action === 'details') return target && summary && kind === 'light' ? { target, kind } : null;
    if (!summary || !summary.availableCount) return null;
    const capable = action === 'toggle' ? summary.canToggle
      : kind === 'light' ? summary.canDim : summary.canSetPosition;
    return capable ? { target, kind } : null;
  }

  begin(input, mode, event) {
    if (this.active) return null;
    const current = this.target(input, 'adjust');
    if (!current || this.isPending(current.target, current.kind)) return null;
    const control = input.closest('[data-inline-control]');
    if (!control) return null;
    const value = control.querySelector('.inline-value'), fill = control.querySelector('.inline-fill');
    const iconButton = control.querySelector('.inline-icon');
    const originalIcon = iconButton?.querySelector('svg');
    const session = this.session = {
      element: input, input, control, fill, output: value, iconButton, kind: current.kind, mode, phase: 'draft',
      value: percent(input.value), keys: new Set(), changed: false,
      original: { value: input.value, text: value?.textContent, fill: fill?.style.width,
        aria: input.getAttribute('aria-valuetext'), icon: originalIcon,
        lightLevel: originalIcon?.style.getPropertyValue('--light-level') },
      pointerId: event?.pointerId, pointerType: event?.pointerType,
      startX: event?.clientX, startY: event?.clientY, axis: null,
    };
    this.ignoredChanges.delete(input);
    control.classList.add('is-adjusting');
    return session;
  }

  paint(session, value) {
    session.value = percent(value);
    session.input.value = String(session.value);
    const label = controlValueLabel(session.kind, session.value);
    session.input.setAttribute('aria-valuetext', label);
    if (session.fill) session.fill.style.width = `${session.value}%`;
    if (session.output) session.output.textContent = label;
    const glyph = session.iconButton?.querySelector('svg');
    if (glyph && session.original.icon) {
      if (session.kind === 'cover') glyph.outerHTML = coverIcon(session.value);
      else glyph.style.setProperty('--light-level', String(session.value / 100));
    }
  }

  position(session, clientX) {
    const rect = session.input.getBoundingClientRect();
    if (rect.width <= 0) return false;
    this.paint(session, (clientX - rect.left) / rect.width * 100);
    session.changed = true;
    return true;
  }

  startPress(element, event) {
    if (this.active || !this.target(element, 'details')) return;
    this.suppressedDetails.delete(element.dataset.inlineDetails);
    const scroll = element.closest('.room-detail');
    this.press = { element, pointerId: event.pointerId, pointerType: event.pointerType,
      startX: event.clientX, startY: event.clientY, axis: null, scroll,
      scrollTop: scroll?.scrollTop || 0, input: element.closest('[data-inline-control]')?.querySelector(RANGE) };
  }

  movePress(event) {
    const press = this.press;
    const dx = event.clientX - press.startX, dy = event.clientY - press.startY;
    if (!press.axis) {
      if (Math.abs(dy) >= 8 && Math.abs(dy) > Math.abs(dx) * 1.1) {
        press.axis = 'vertical';
        if (press.pointerType === 'mouse') {
          try { press.element.setPointerCapture(press.pointerId); } catch { this.cancel(); return; }
        }
      } else if (Math.abs(dx) >= 8 && Math.abs(dx) > Math.abs(dy) * 1.1) {
        this.suppressedDetails.add(press.element.dataset.inlineDetails);
        if (!press.input) { this.cancel(); return; }
        this.press = null;
        const session = this.begin(press.input, 'pointer', event);
        if (!session) { this.end?.(); return; }
        session.element = press.element;
        session.axis = 'horizontal';
        try { press.element.setPointerCapture(press.pointerId); } catch { this.cancel(); return; }
        event.preventDefault();
        this.position(session, event.clientX);
        return;
      }
    }
    if (press.axis === 'vertical' && press.pointerType === 'mouse') {
      event.preventDefault();
      if (press.scroll) press.scroll.scrollTop = press.scrollTop - dy;
    }
  }

  clearPress(notify = true) {
    const press = this.press;
    if (!press) return false;
    this.press = null;
    this.window.clearTimeout(press.clickTimer);
    this.suppressedDetails.add(press.element.dataset.inlineDetails);
    this.release(press);
    if (notify && !this.disposed) this.end?.();
    return true;
  }

  pointerDown(event) {
    const element = this.control(event);
    if (!element) return;
    event.stopPropagation();
    if (element.matches(DETAILS)) {
      if (event.button !== 0 || event.isPrimary === false) return;
      if (this.session?.mode === 'keyboard' || this.session?.mode === 'change') this.cancel();
      this.startPress(element, event);
      return;
    }
    if (!element.matches(RANGE)) return; // Preserve native button click/focus.
    event.preventDefault(); // Own the range's pointer path; native keyboard stays native.
    if (event.button !== 0 || event.isPrimary === false) return;
    if (this.session?.mode === 'keyboard' || this.session?.mode === 'change') this.cancel();
    const session = this.begin(element, 'pointer', event);
    if (!session) return;
    element.focus({ preventScroll: true });
    try { element.setPointerCapture(event.pointerId); }
    catch { this.cancel(); return; }
    if (!this.position(session, event.clientX)) this.cancel();
  }

  pointerMove(event) {
    if (this.press?.pointerId === event.pointerId) {
      event.stopPropagation();
      if (!this.press.released) this.movePress(event);
      return;
    }
    const session = this.session;
    if (this.control(event)) event.stopPropagation();
    if (!session || session.phase !== 'draft' || session.mode !== 'pointer' || event.pointerId !== session.pointerId) return;
    event.stopPropagation();
    if (session.pointerType === 'touch' && !session.axis) {
      const dx = Math.abs(event.clientX - session.startX), dy = Math.abs(event.clientY - session.startY);
      if (dy >= 8 && dy > dx * 1.1) { this.cancel(); return; }
      if (dx < 8 || dx <= dy * 1.1) return;
      session.axis = 'horizontal';
    }
    event.preventDefault();
    this.position(session, event.clientX);
  }

  pointerUp(event) {
    if (this.press?.pointerId === event.pointerId) {
      event.stopPropagation();
      const press = this.press, rect = press.element.getBoundingClientRect();
      if (press.axis || Math.hypot(event.clientX - press.startX, event.clientY - press.startY) >= 8
        || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
        || !this.target(press.element, 'details')) { this.cancel(); return; }
      // Keep the node stable until its native click (including touch activation).
      press.released = true;
      press.clickTimer = this.window.setTimeout(() => { if (this.press === press) this.cancel(); }, 400);
      return;
    }
    const session = this.session;
    if (this.control(event)) event.stopPropagation();
    if (!session || session.phase !== 'draft' || session.mode !== 'pointer' || event.pointerId !== session.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    // Touch may end without delivering a final move; reject vertical intent here too.
    const dx = Math.abs(event.clientX - session.startX), dy = Math.abs(event.clientY - session.startY);
    if (session.pointerType === 'touch' && !session.axis && dy >= 8 && dy > dx * 1.1) { this.cancel(); return; }
    this.position(session, event.clientX);
    this.finish(session);
  }

  pointerCancel(event) {
    if (this.control(event)) event.stopPropagation();
    if (this.press?.pointerId === event.pointerId) {
      // Touch releases its implicit capture before dispatching the native click.
      if (event.type !== 'lostpointercapture' || !this.press.released) this.cancel();
      return;
    }
    const session = this.session;
    if (session?.phase === 'draft' && session.mode === 'pointer' && event.pointerId === session.pointerId) this.cancel();
  }

  keyDown(event) {
    if (event.key === 'Escape' && this.active) {
      event.preventDefault(); event.stopPropagation(); this.cancel(); return;
    }
    const element = this.control(event);
    if (!element) return;
    if (event.key === 'Tab') {
      if (this.press || this.session?.phase === 'draft') this.cancel();
      return; // The room dialog owns Tab focus containment, including toggles.
    }
    event.stopPropagation();
    if (element.matches(DETAILS) && !this.active && ['Enter', ' '].includes(event.key)) this.suppressedDetails.delete(element.dataset.inlineDetails);
    if (!element.matches(RANGE)) return;
    if (this.session?.phase === 'pending') { if (KEYS.has(event.key)) event.preventDefault(); return; }
    if (!KEYS.has(event.key)) return;
    if (this.blockedKeys.has(event.key) || this.session?.mode === 'pointer') { event.preventDefault(); return; }
    if (this.session && this.session.input !== element) this.cancel();
    const session = this.session || this.begin(element, 'keyboard');
    if (!session) { event.preventDefault(); return; }
    session.keys.add(event.key);
    // Do not preventDefault: the real range implements arrows/Home/End/Page.
  }

  keyUp(event) {
    if (this.control(event)) event.stopPropagation();
    if (this.blockedKeys.delete(event.key)) return;
    const session = this.session;
    if (!session || session.phase !== 'draft' || session.mode !== 'keyboard' || !session.keys.has(event.key)) return;
    session.keys.delete(event.key);
    if (!session.keys.size) {
      if (session.changed) this.finish(session);
      else this.cancel();
    }
  }

  input(event) {
    const input = event.target?.closest?.(RANGE);
    if (!input) return;
    event.stopPropagation();
    if (this.blockedKeys.size) return;
    const session = this.session || this.begin(input, 'change');
    if (!session || session.input !== input) return;
    if (session.phase === 'pending' || session.mode === 'pointer') { this.paint(session, session.value); return; }
    session.changed = true;
    this.paint(session, input.value);
  }

  change(event) {
    const input = event.target?.closest?.(RANGE);
    if (!input) return;
    event.stopPropagation();
    if (this.blockedKeys.size || this.ignoredChanges.get(input)?.has(input.value)) return;
    const session = this.session || this.begin(input, 'change');
    if (!session || session.input !== input || session.phase === 'pending' || session.mode === 'pointer' || session.keys.size) return;
    this.paint(session, input.value);
    this.finish(session);
  }

  click(event) {
    const element = this.control(event);
    if (!element) return;
    event.preventDefault(); event.stopPropagation();
    if (element.matches(DETAILS)) {
      if (event.detail === 0 && !this.active) this.suppressedDetails.delete(element.dataset.inlineDetails);
      if (this.session || this.suppressedDetails.has(element.dataset.inlineDetails)
        || (this.press && (this.press.element !== element || !this.press.released))) return;
      const current = this.target(element, 'details');
      if (!current) { this.clearPress(); return; }
      this.clearPress(false);
      try { Promise.resolve(this.openDetails(current.target)).catch(() => {}); }
      finally { this.end?.(); }
      return;
    }
    if (!element.matches(TOGGLE) || this.active) return;
    const current = this.target(element, 'toggle');
    if (!current || this.isPending(current.target, current.kind)) return;
    const session = this.session = {
      element, control: element.closest('[data-inline-control]'), phase: 'pending', mode: 'toggle',
    };
    session.control?.classList.add('is-pending');
    this.run(session, () => this.toggle(current.target, current.kind));
  }

  finish(session) {
    if (this.session !== session || session.phase !== 'draft') return;
    const current = this.target(session.input, 'adjust');
    if (!current) { this.cancel(); return; }
    session.phase = 'pending';
    this.ignoredChanges.set(session.input, new Set([session.original.value, String(session.value)]));
    session.control.classList.remove('is-adjusting');
    session.control.classList.add('is-pending');
    this.release(session);
    this.run(session, () => this.commit(current.target, current.kind, session.value));
  }

  async run(session, callback) {
    try { await callback(); }
    catch { /* HA callbacks report errors; still release UI ownership reliably. */ }
    finally { if (this.session === session) this.clear(session, true); }
  }

  release(session) {
    if (session.pointerId === undefined) return;
    try {
      if (session.element.hasPointerCapture(session.pointerId)) session.element.releasePointerCapture(session.pointerId);
    } catch { /* A render/navigation may already have detached the input. */ }
  }

  clear(session, notify) {
    this.session = null;
    this.release(session);
    session.control?.classList.remove('is-adjusting', 'is-pending');
    if (session.input) {
      this.ignoredChanges.set(session.input, new Set([session.original.value, String(session.value)]));
      session.input.value = session.original.value;
      if (session.original.aria === null) session.input.removeAttribute('aria-valuetext');
      else session.input.setAttribute('aria-valuetext', session.original.aria);
      if (session.fill) session.fill.style.width = session.original.fill;
      if (session.output) session.output.textContent = session.original.text;
      const glyph = session.iconButton?.querySelector('svg');
      if (glyph && session.original.icon && glyph !== session.original.icon) glyph.replaceWith(session.original.icon);
      if (session.kind === 'light' && session.original.icon) {
        if (session.original.lightLevel) session.original.icon.style.setProperty('--light-level', session.original.lightLevel);
        else session.original.icon.style.removeProperty('--light-level');
      }
    }
    if (notify && !this.disposed) this.end?.();
  }

  cancel() {
    if (this.press) return this.clearPress();
    const session = this.session;
    if (!session) return false;
    for (const key of session.keys || []) this.blockedKeys.add(key);
    this.clear(session, true);
    return true;
  }

  sync() {
    if (this.press) {
      if (!this.target(this.press.element, 'details')) this.cancel();
      return;
    }
    const session = this.session;
    if (session) {
      if (!this.target(session.element, session.mode === 'toggle' ? 'toggle' : 'adjust')) this.cancel();
      else if (session.input) this.paint(session, session.value);
      return;
    }
    // Attribute-only DOM patching does not reset a range's dirty value property.
    for (const input of this.root.querySelectorAll(RANGE)) {
      const value = Number(input.getAttribute('value'));
      if (Number.isFinite(value)) input.value = String(percent(value));
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPress(false);
    if (this.session) this.clear(this.session, false);
    for (const [name, listener] of Object.entries(this.listeners)) this.root.removeEventListener(name, listener, true);
    for (const name of ['blur', 'pagehide', 'hashchange', 'popstate']) this.window.removeEventListener(name, this.onLeave);
    for (const name of ['pointermove', 'pointerup', 'pointercancel']) this.window.removeEventListener(name, this.outsidePointer, true);
    this.blockedKeys.clear();
  }
}
