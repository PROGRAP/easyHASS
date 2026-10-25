const same = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Pointer capture and transforms keep the live DOM stable throughout a drag.
 * Selector/attribute options let independent lists reuse the room-sort behavior.
 */
export class AreaSorter {
  constructor(root, { canStart, commit, announce, end,
    rowSelector = '[data-settings-area-row]', idAttribute = 'data-settings-area-row',
    handleSelector = '[data-settings-drag]', handleIdAttribute = 'data-settings-drag',
    labelSelector = '.settings-row-label', fallbackName = 'Raum',
    listSelector = '.settings-list', scrollSelector = '.sheet',
  }) {
    Object.assign(this, { root, canStart, commit, announce, end,
      rowSelector, idAttribute, handleSelector, handleIdAttribute, labelSelector, fallbackName,
      listSelector, scrollSelector });
    this.listeners = {
      pointerdown: event => this.pointerDown(event),
      pointermove: event => this.pointerMove(event),
      pointerup: event => this.pointerUp(event),
      pointercancel: event => { if (this.drag?.pointerId === event.pointerId) this.cancel(); },
      lostpointercapture: event => { if (this.drag?.pointerId === event.pointerId) this.cancel(); },
      keydown: event => this.keyDown(event),
    };
    for (const [name, listener] of Object.entries(this.listeners)) root.addEventListener(name, listener, { passive: false });
  }
  get active() { return !!this.drag; }
  matches(ids) { return !this.drag || same(this.drag.original, ids); }
  dispose() {
    this.finish(false, false);
    for (const [name, listener] of Object.entries(this.listeners)) this.root.removeEventListener(name, listener);
  }
  begin(handle, mode, event) {
    if (this.drag || handle.disabled || !this.canStart()) return false;
    const list = handle.closest(this.listSelector), sheet = handle.closest(this.scrollSelector);
    if (!list || !sheet || !this.root.contains(handle)) return false;
    const listTop = list.getBoundingClientRect().top;
    const items = [...list.querySelectorAll(this.rowSelector)].map(node => {
      const rect = node.getBoundingClientRect();
      return { node, id: node.getAttribute(this.idAttribute), top: rect.top - listTop, height: rect.height };
    });
    if (items.length < 2 || items.some(item => !item.id) || new Set(items.map(item => item.id)).size !== items.length) return false;
    const item = items.find(item => item.id === handle.getAttribute(this.handleIdAttribute));
    if (!item) return false;
    handle.focus({ preventScroll: true });
    const original = items.map(item => item.id);
    this.drag = { handle, list, sheet, items, item, mode, original, order: [...original], picked: false,
      pointerId: event?.pointerId, startY: event?.clientY, latestY: event?.clientY,
      offset: event ? event.clientY - item.node.getBoundingClientRect().top : 0 };
    if (mode === 'keyboard') this.pickUp();
    else {
      try { handle.setPointerCapture(event.pointerId); }
      catch { this.finish(false); return false; }
    }
    return true;
  }
  pickUp() {
    const drag = this.drag;
    if (!drag || drag.picked) return;
    drag.picked = true;
    drag.list.classList.add('is-reordering');
    drag.item.node.classList.add('is-dragging');
    drag.handle.setAttribute('aria-pressed', 'true');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const item of drag.items) if (item !== drag.item && !reduced) item.node.style.transition = 'transform 180ms cubic-bezier(.22,1,.36,1)';
    this.announce(`${this.name(drag)} aufgenommen. Position ${drag.order.indexOf(drag.item.id) + 1} von ${drag.order.length}.`);
  }
  name(drag) { return drag.item.node.querySelector(this.labelSelector)?.textContent?.trim() || this.fallbackName; }
  pointerDown(event) {
    const handle = event.target.closest(this.handleSelector);
    if (!handle || event.button !== 0 || !event.isPrimary) return;
    if (this.drag?.mode === 'keyboard') this.cancel();
    if (this.begin(handle, 'pointer', event)) event.preventDefault();
  }
  pointerMove(event) {
    const drag = this.drag;
    if (!drag || drag.mode !== 'pointer' || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drag.latestY = event.clientY;
    if (!drag.picked && Math.abs(drag.latestY - drag.startY) < 5) return;
    this.pickUp();
    this.layoutPointer();
    if (!this.frame) this.frame = requestAnimationFrame(() => this.autoScroll());
  }
  pointerUp(event) {
    if (this.drag?.mode !== 'pointer' || event.pointerId !== this.drag.pointerId) return;
    event.preventDefault();
    this.finish(true);
  }
  layoutPointer() {
    const drag = this.drag;
    if (!drag) return;
    const first = drag.items[0], last = drag.items.at(-1);
    const pointerTop = drag.latestY - drag.list.getBoundingClientRect().top - drag.offset;
    const top = clamp(pointerTop, first.top, last.top + last.height - drag.item.height);
    // Use the unclamped pointer position for insertion, including unequal-height
    // rows; clamping the visual row must not make either end unreachable.
    const center = pointerTop + drag.item.height / 2;
    const others = drag.items.filter(item => item !== drag.item);
    const index = others.filter(item => center >= item.top + item.height / 2).length;
    const order = others.map(item => item.id); order.splice(index, 0, drag.item.id);
    this.setOrder(order);
    this.layout(top);
  }
  setOrder(order) {
    const drag = this.drag;
    if (same(order, drag.order)) return;
    drag.order = order;
    this.announce(`${this.name(drag)}: Position ${order.indexOf(drag.item.id) + 1} von ${order.length}.`);
  }
  layout(pointerTop) {
    const drag = this.drag;
    let top = drag.items[0].top;
    for (const id of drag.order) {
      const item = drag.items.find(item => item.id === id);
      const target = item === drag.item && pointerTop !== undefined ? pointerTop : top;
      item.node.style.transform = `translateY(${target - item.top}px)`;
      top += item.height;
    }
  }
  autoScroll() {
    this.frame = null;
    const drag = this.drag;
    if (!drag?.picked || drag.mode !== 'pointer') return;
    const rect = drag.sheet.getBoundingClientRect(), edge = Math.min(48, rect.height / 4);
    const delta = drag.latestY < rect.top + edge ? -12 * clamp((rect.top + edge - drag.latestY) / edge, 0, 1)
      : drag.latestY > rect.bottom - edge ? 12 * clamp((drag.latestY - rect.bottom + edge) / edge, 0, 1) : 0;
    if (delta) { drag.sheet.scrollTop += delta; this.layoutPointer(); }
    this.frame = requestAnimationFrame(() => this.autoScroll());
  }
  keyDown(event) {
    const handle = event.target.closest(this.handleSelector);
    if (!handle) return;
    const activate = event.key === ' ' || event.key === 'Enter';
    if (!this.drag) {
      if (activate) { event.preventDefault(); this.begin(handle, 'keyboard'); }
      return;
    }
    if (this.drag.mode !== 'keyboard') return;
    if (handle !== this.drag.handle) {
      this.cancel();
      if (activate) { event.preventDefault(); this.begin(handle, 'keyboard'); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); return; }
    if (event.key === 'Tab') { this.cancel(); return; }
    if (activate) { event.preventDefault(); this.finish(true); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const drag = this.drag, index = drag.order.indexOf(drag.item.id);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? drag.order.length - 1
      : clamp(index + (event.key === 'ArrowUp' ? -1 : 1), 0, drag.order.length - 1);
    const order = [...drag.order]; order.splice(index, 1); order.splice(target, 0, drag.item.id);
    this.setOrder(order); this.layout();
    drag.item.node.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  cancel() { return this.finish(false); }
  finish(save, notify = true) {
    const drag = this.drag;
    if (!drag) return false;
    this.drag = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const { node } of drag.items) { node.style.removeProperty('transform'); node.style.removeProperty('transition'); }
    drag.list.classList.remove('is-reordering'); drag.item.node.classList.remove('is-dragging');
    drag.handle.setAttribute('aria-pressed', 'false');
    if (drag.pointerId !== undefined && drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    if (!notify) return true;
    if (save && drag.picked && !same(drag.original, drag.order)) this.commit([...drag.order]);
    else {
      if (drag.picked) this.announce(save ? 'Reihenfolge unverändert.' : 'Sortieren abgebrochen.');
      this.end();
    }
    return true;
  }
}
