import { NavigationGuard } from './compatibility/navigation.js';
import { loadRegistries, subscribeRegistries, deriveHome, pictureUrl, toggleRoomLights,
  setRoomBrightness, toggleRoomCovers, setRoomCoverPosition, callVacuumAction,
  deriveRoomDevices, entityControlTarget, toggleEntity } from './ha-model.js';
import { icon, coverIcon } from './icons.js';
import { updateMarkup } from './dom.js';
import { morphControl } from './control-morph.js';
import { renderRoomDetail } from './room-detail.js';
import { captureRoomVisual, morphRoom } from './room-motion.js';
import { RoomPhotoPalette } from './room-photo.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (value, digits = 1) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(value);
const clamp = value => Math.max(0, Math.min(100, Math.round(value)));
const isNumber = value => value !== null && value !== undefined && typeof value !== 'boolean' && String(value).trim() !== '' && Number.isFinite(Number(value));
const tabs = [['home', 'Zuhause'], ['robot', 'Roboter'], ['map', 'Karte'], ['energy', 'Energie'], ['more', 'mehr …']];
let fontReady;
function loadLocalFont() {
  // Font faces declared inside a shadow tree are not exposed consistently by browsers.
  if (!fontReady && globalThis.FontFace) {
    const face = new FontFace('EasyHassInter', `url(${new URL('./assets/fonts/InterVariable.woff2', import.meta.url).href})`, { weight: '100 900', style: 'normal' });
    document.fonts.add(face);
    fontReady = face.load().catch(() => {});
  }
  return fontReady;
}

/** Embedded panel: HA owns authentication, registries, states and commands. */
export class EasyHassPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._navigation = new NavigationGuard(this);
    this._tab = 'home';
    this._registryGeneration = 0;
    this._pending = new Set();
    this._media = matchMedia('(prefers-color-scheme: dark)');
    this._onThemeChange = () => this._applyTheme();
    this._onGlobalKey = event => {
      if (event.key === 'Escape' && (this._gesture || this._adjustment || this._sheetOpen || this._roomMorph || event.composedPath().includes(this))) this._dismiss();
    };
    this._onBlur = () => { this._cancelGesture(); this._cancelRoomSwipe(); };
    this._onRoomRoute = () => this._syncRoomRoute();
    this._roomReduced = matchMedia('(prefers-reduced-motion: reduce)');
    this._onRoomMotionChange = () => { if (this._roomReduced.matches) { this._roomMorph?.finish(); this._finishRoomSlide(); } };
    this._onRoomResize = () => { this._roomMorph?.finish(); this._cancelRoomSwipe(); this._finishRoomSlide(); this._positionRoomTrack(); };
  }
  set hass(value) {
    const previous = this._hass;
    this._hass = value;
    if (this.isConnected) {
      if (previous?.connection !== value?.connection || (!previous?.connected && value?.connected)) this._connect();
      this._applyTheme();
      this._update();
      this._navigation.refresh();
    }
  }
  get hass() { return this._hass; }
  set panel(value) { this._panel = value; this._navigation.refresh(); }
  get panel() { return this._panel; }
  set route(value) { this._route = value; this._navigation.refresh(); }
  get route() { return this._route; }
  set narrow(value) { this.toggleAttribute('narrow', Boolean(value)); this._navigation.refresh(); }
  get narrow() { return this.hasAttribute('narrow'); }

  connectedCallback() {
    loadLocalFont();
    if (!this.shadowRoot.hasChildNodes()) this._renderShell();
    this._roomPhotos = new RoomPhotoPalette(this.shadowRoot);
    this._media.addEventListener('change', this._onThemeChange);
    window.addEventListener('keydown', this._onGlobalKey);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('hashchange', this._onRoomRoute);
    window.addEventListener('popstate', this._onRoomRoute);
    window.addEventListener('resize', this._onRoomResize);
    this._roomReduced.addEventListener('change', this._onRoomMotionChange);
    this._applyTheme();
    this._syncRoomRoute();
    this._connect();
    this._navigation.start();
  }
  disconnectedCallback() {
    this._registryGeneration++;
    this._registryCleanup?.();
    this._registryCleanup = null;
    this._cancelGesture();
    this._roomPhotos?.dispose(); this._roomPhotos = null;
    this._finishClosingAdjustment();
    this._navigation.stop();
    this._media.removeEventListener('change', this._onThemeChange);
    window.removeEventListener('keydown', this._onGlobalKey);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('hashchange', this._onRoomRoute);
    window.removeEventListener('popstate', this._onRoomRoute);
    window.removeEventListener('resize', this._onRoomResize);
    this._roomReduced.removeEventListener('change', this._onRoomMotionChange);
    this._roomMorph?.dispose(); this._roomMorph = null;
    this._cancelRoomSwipe(false); this._finishRoomSlide();
    this._presentedRoomId = null; this._closingRoom = false;
    this._lockRoomBackground(false);
    clearTimeout(this._toastTimer);
  }
  async _connect() {
    const generation = ++this._registryGeneration;
    this._registryCleanup?.();
    this._registryCleanup = null;
    if (!this._hass?.callWS || this._hass.connected === false) return;
    const accept = registries => {
      if (!this.isConnected || generation !== this._registryGeneration) return;
      this._registries = registries;
      this._registryError = null;
      this._update();
    };
    const fail = error => {
      if (generation !== this._registryGeneration) return;
      this._registryError = error?.message || 'Räume konnten nicht geladen werden.';
      this._update();
    };
    let refreshes = 0;
    try {
      const cleanup = await subscribeRegistries(this._hass, registries => { refreshes++; accept(registries); }, fail);
      if (!this.isConnected || generation !== this._registryGeneration) { cleanup(); return; }
      this._registryCleanup = cleanup;
      const revision = refreshes;
      const snapshot = await loadRegistries(this._hass).catch(error => {
        if (revision === refreshes) throw error;
        return null;
      });
      if (snapshot && revision === refreshes) accept(snapshot);
    } catch (error) { fail(error); }
  }
  _renderShell() {
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="${new URL('./panel.css', import.meta.url).href}">
      <div class="app" id="app-content">
        <main class="page" id="page"></main>
        <nav class="navigation" aria-label="Hauptmenü">${tabs.map(([id, label]) => `<button type="button" data-tab="${id}" aria-label="${label}">${icon(id)}<span>${label}</span></button>`).join('')}</nav>
        <a class="escape-link" id="expert-link" data-easy-hass-exit href="/lovelace">Expertenansicht</a>
      </div>
      <div id="room-root"></div>
      <div id="overlay-root"></div>
      <div class="toast" id="toast" role="alert" hidden></div>
      <span class="sr-only" id="connection-status" role="status"></span>
      <span class="sr-only" id="gesture-hint">Kurz tippen zum Schalten. Zum Einstellen gedrückt halten und nach links oder rechts ziehen. Mit der Tastatur eine Pfeiltaste drücken.</span>`;
    this.shadowRoot.addEventListener('click', event => this._click(event));
    this.shadowRoot.addEventListener('pointerdown', event => this._pointerDown(event));
    this.shadowRoot.addEventListener('pointermove', event => this._pointerMove(event));
    this.shadowRoot.addEventListener('pointerup', event => this._pointerUp(event));
    this.shadowRoot.addEventListener('pointercancel', () => { this._cancelGesture(); this._cancelRoomSwipe(); });
    this.shadowRoot.addEventListener('lostpointercapture', event => {
      if (this._gesture?.button === event.target && this._gesture.pointerId === event.pointerId) this._cancelGesture();
      if (this._roomDrag?.surface === event.target && this._roomDrag.pointerId === event.pointerId) this._cancelRoomSwipe();
    });
    this.shadowRoot.addEventListener('wheel', event => this._roomWheel(event), { passive: false });
    this.shadowRoot.addEventListener('contextmenu', event => { if (event.target.closest('[data-control]')) event.preventDefault(); });
    this.shadowRoot.addEventListener('keydown', event => this._keyDown(event));
    this.shadowRoot.addEventListener('input', event => { if (event.target.id === 'adjust-range') this._setAdjustment(Number(event.target.value)); });
    this.shadowRoot.addEventListener('change', event => {
      if (event.target.name === 'appearance') {
        try { localStorage.setItem(this._themeKey(), event.target.value); } catch { /* Private mode can deny storage. */ }
        this._applyTheme();
      }
    });
  }
  _themeKey() { return `easy-hass:appearance:${this._hass?.user?.id || 'local'}`; }
  _appearance() { try { return localStorage.getItem(this._themeKey()) || 'auto'; } catch { return 'auto'; } }
  _applyTheme() {
    const choice = this._appearance();
    const dark = choice === 'dark' || (choice === 'auto' && (this._hass?.themes?.darkMode ?? this._media.matches));
    this.dataset.theme = dark ? 'dark' : 'light';
  }
  _expertPath() {
    if (this._hass?.user?.is_admin) return '/config';
    const panels = this._hass?.panels || {};
    if (panels.lovelace && !panels.lovelace.require_admin) return '/lovelace';
    const target = Object.entries(panels).find(([path, panel]) => path !== 'easy-hass' && !panel.require_admin && panel.component_name === 'lovelace' && /^[\w-]+$/.test(path));
    return target ? `/${target[0]}` : '/profile';
  }
  _update() {
    if (!this.shadowRoot.getElementById('page')) return;
    this._home = deriveHome(this._registries || {}, this._hass?.states || {});
    const selectedRoom = this._room(this._presentedRoomId);
    this._detailDevices = selectedRoom ? deriveRoomDevices(selectedRoom, this._home.entities, this._home.entityScopes) : [];
    this.shadowRoot.getElementById('expert-link').href = this._expertPath();
    const connected = this._hass?.connected;
    this.shadowRoot.getElementById('connection-status').textContent = connected ? 'Mit Home Assistant verbunden' : connected === false ? 'Verbindung unterbrochen' : 'Warte auf Home Assistant';
    if (this._gesture || this._adjustment || this._closingAdjustment || this._roomMorph || this._roomDrag || this._roomSlide || this._closingRoom) return;
    const active = this.shadowRoot.activeElement;
    const focus = active?.dataset.control ? { room: active.dataset.room, control: active.dataset.control } : null;
    const robotFocus = active?.dataset.vacuum ? { id: active.dataset.vacuum, action: active.dataset.action } : null;
    const page = this.shadowRoot.getElementById('page');
    const content = this._tab === 'robot' ? this._renderRobots() : this._renderHome();
    if (this._lastPageMarkup !== content) { updateMarkup(page, content); this._lastPageMarkup = content; }
    this._renderRoomStage();
    if (focus) [...this.shadowRoot.querySelectorAll('[data-control]')].find(el => !el.closest('[inert]') && el.dataset.room === focus.room && el.dataset.control === focus.control)?.focus({ preventScroll: true });
    if (robotFocus) {
      const buttons = [...page.querySelectorAll('[data-vacuum]')].filter(el => el.dataset.vacuum === robotFocus.id);
      (buttons.find(el => el.dataset.action === robotFocus.action) || buttons[0])?.focus({ preventScroll: true });
    }
    for (const button of this.shadowRoot.querySelectorAll('[data-tab]')) button.setAttribute('aria-current', button.dataset.tab === this._tab ? 'page' : 'false');
  }
  _status() {
    if (this._hass?.connected === false) return '<p class="status-banner" role="status">Verbindung unterbrochen. Die Verbindung wird wiederhergestellt …</p>';
    if (this._registryError) return `<div class="status-banner" role="status">${escape(this._registryError)} <button data-retry>Erneut versuchen</button></div>`;
    return '';
  }
  _renderHome() {
    const weather = this._home.weather.find(entity => entity.available && isNumber(entity.attributes.temperature));
    const onCount = this._home.rooms.reduce((sum, room) => sum + room.light.onCount, 0);
    const lightCount = this._home.rooms.reduce((sum, room) => sum + room.light.count, 0);
    const name = this._hass?.user?.name || '';
    return `<header class="welcome"><h1>Willkommen Zuhause${name ? `<span>${escape(name)}</span>` : ''}</h1>
      <div class="summary">${weather ? `<span class="summary-chip" aria-label="Temperatur draußen">${icon('weather')}<span>${number(Number(weather.attributes.temperature))}${escape(weather.attributes.temperature_unit || this._hass?.config?.unit_system?.temperature || '°')}</span></span>` : ''}
      ${lightCount ? `<span class="summary-chip light-summary ${onCount ? 'active' : ''}">${icon('light')}<span>${onCount} ${onCount === 1 ? 'Lichtquelle' : 'Lichtquellen'}</span></span>` : ''}</div></header>
      ${this._status()}
      ${!this._registries && !this._registryError ? '<div class="empty-state" role="status">Dein Zuhause wird geladen …</div>' : this._home.rooms.length ? `<section class="room-grid" aria-label="Räume">${this._home.rooms.map(room => this._roomCard(room)).join('')}</section>` : '<section class="empty-state"><h2>Deine Räume</h2><p>Lege in Home Assistant Räume an und ordne deine Geräte zu. Sie erscheinen hier automatisch.</p><a data-easy-hass-exit href="/config/areas/dashboard">Räume einrichten</a></section>'}`;
  }
  _reading(reading, kind) {
    if (!reading) return '';
    const value = reading.value === null ? '—' : number(reading.value);
    return `<span class="reading" aria-label="${kind === 'temperature' ? 'Temperatur' : 'Luftfeuchtigkeit'}: ${escape(value)} ${escape(reading.unit)}" title="${escape(reading.name)}">${icon(kind)}<span>${escape(value)}<span class="unit">${escape(reading.unit)}</span></span></span>`;
  }
  _roomCard(room) {
    const picture = pictureUrl(this._hass, room.picture);
    const roomId = escape(room.id);
    return `<article class="room-card" data-room-card="${roomId}" aria-label="${escape(room.name)}">
      <h2 title="${escape(room.name)}">${escape(room.name)}</h2>
      <div class="room-climate">${this._reading(room.temperature, 'temperature')}${this._reading(room.humidity, 'humidity')}</div>
      <div class="room-picture ${picture ? '' : 'no-picture'}" aria-hidden="true">${picture ? `<img data-room-picture src="${escape(picture)}" alt="" loading="lazy" draggable="false">` : icon('home')}</div>
      <a class="room-open" data-open-room="${roomId}" href="#room=${encodeURIComponent(room.id)}" aria-label="${escape(room.name)} öffnen"></a>
      <div class="room-controls">
      ${room.cover.count ? this._controlButton(room, 'cover') : ''}
      ${room.light.count ? this._controlButton(room, 'light') : ''}
      </div></article>`;
  }
  _controlButton(target, kind, entityId) {
    const id = escape(target.id), name = escape(target.name);
    const entity = entityId ? `data-entity="${escape(entityId)}"` : '';
    const state = target[kind];
    const disabled = this._hass?.connected === false || !state.canToggle;
    if (kind === 'cover') return `<button type="button" class="round-control cover-control" data-control="cover" data-room="${id}" ${entity} aria-label="${name}: Rollladen ${state.moving ? 'stoppen' : state.isOpen ? 'schließen' : 'öffnen'}${state.position === null ? '' : `, ${state.position} Prozent geöffnet`}" ${state.canSetPosition ? 'aria-describedby="gesture-hint"' : ''} ${disabled ? 'disabled' : ''}>${coverIcon(state.position ?? (state.allClosed ? 0 : 100))}${state.moving ? '<span class="motion-dot"></span>' : ''}</button>`;
    return `<button type="button" class="round-control light-control ${state.isOn ? 'is-on' : ''}" data-control="light" data-room="${id}" ${entity} aria-label="${name}: Licht ${state.isOn ? 'ausschalten' : 'einschalten'}" aria-pressed="${state.isOn}" ${state.canDim ? 'aria-describedby="gesture-hint"' : ''} ${disabled ? 'disabled' : ''}>${icon('light')}</button>`;
  }
  _selectedRoomId() {
    if (!location.hash.startsWith('#room=')) return null;
    try { return decodeURIComponent(location.hash.slice(6)) || null; } catch { return null; }
  }
  _roomSurface(id = this._presentedRoomId) {
    return [...this.shadowRoot.querySelectorAll('.room-detail')].find(el => el.dataset.roomDetail === id)
      || this.shadowRoot.querySelector('.room-detail');
  }
  _homeCard(id) { return [...this.shadowRoot.querySelectorAll('[data-room-card]')].find(el => el.dataset.roomCard === id); }
  _renderRoomStage() {
    const root = this.shadowRoot.getElementById('room-root');
    if (!this._presentedRoomId) {
      root.replaceChildren(); this._lastRoomMarkup = null;
      this._roomPhotos?.sync();
      this._lockRoomBackground(false); return;
    }
    const rooms = this._home.rooms, selected = this._room(this._presentedRoomId);
    const callbacks = {
      reading: (value, kind) => this._reading(value, kind),
      control: (target, kind, id) => this._controlButton(target, kind, id),
      status: this._status(),
    };
    const content = selected ? rooms.map(room => `<div class="room-slide" data-room-slide="${escape(room.id)}" ${room.id === selected.id ? '' : 'inert aria-hidden="true"'}>${renderRoomDetail(room,
      deriveRoomDevices(room, this._home.entities, this._home.entityScopes), this._hass,
      { ...callbacks, current: room.id === selected.id })}</div>`).join('')
      : `<div class="room-slide"><div class="room-detail" data-current-room><button class="room-back" data-room-back aria-label="Zurück zu Zuhause">${icon('close')}</button><div class="empty-state"><h1 tabindex="-1">${this._registries ? 'Raum nicht mehr vorhanden' : 'Dein Raum wird geladen …'}</h1></div>${this._status()}</div></div>`;
    const html = `<section class="room-stage" role="dialog" aria-modal="true" aria-label="${escape(selected?.name || 'Raum')}">
      <div class="room-backdrop" data-room-back></div>
      <div class="room-viewport"><div class="room-track">${content}</div></div>
      ${selected && rooms.length > 1 ? `<nav class="room-pagination" aria-label="Räume wechseln">${rooms.map(room => `<button type="button" data-room-page="${escape(room.id)}" aria-label="${escape(room.name)} öffnen" aria-current="${room.id === selected.id ? 'page' : 'false'}"><span></span></button>`).join('')}</nav>` : ''}
      <span class="sr-only" aria-live="polite">${escape(selected?.name || '')}</span>
    </section>`;
    if (html !== this._lastRoomMarkup) { updateMarkup(root, html); this._lastRoomMarkup = html; }
    this._roomPhotos?.sync();
    this._lockRoomBackground(true);
    this._positionRoomTrack();
    if (this._needsRoomFocus && selected) { this._needsRoomFocus = false; this._focusRoom(); }
  }
  _lockRoomBackground(open) {
    const app = this.shadowRoot.getElementById('app-content');
    if (app) app.inert = open || !!this._adjustment?.keyboard || !!this._sheetOpen;
    if (open && !this._roomScrollLock) {
      this._roomScrollLock = [document.documentElement.style.overflow, document.body.style.overflow];
      document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden';
    } else if (!open && this._roomScrollLock) {
      [document.documentElement.style.overflow, document.body.style.overflow] = this._roomScrollLock;
      this._roomScrollLock = null;
    }
  }
  _focusRoom() { this._roomSurface()?.querySelector('h1')?.focus({ preventScroll: true }); }
  _stopRoomMorph() {
    const snapshot = this._roomMorph?.snapshot?.();
    this._roomMorph?.dispose(); this._roomMorph = null;
    this._roomTransitionId = (this._roomTransitionId || 0) + 1;
    return snapshot;
  }
  _startRoomMorph(from, to, opening, done) {
    const token = this._roomTransitionId = (this._roomTransitionId || 0) + 1;
    if (!from || !to) { done(); return; }
    let finished = false;
    const motion = morphRoom({ root: this.shadowRoot, from, to, opening, onFinish: () => {
      finished = true;
      if (token !== this._roomTransitionId) return;
      this._roomMorph = null; done();
    } });
    if (!finished) this._roomMorph = motion;
  }
  _syncRoomRoute() {
    const id = this._selectedRoomId();
    if (id === (this._presentedRoomId || null) && !this._closingRoom) { this._update(); return; }
    if (!id && this._closingRoom) return;
    const interrupted = this._stopRoomMorph();
    this._cancelRoomSwipe(false); this._finishRoomSlide();
    this._cancelGesture(); this._finishClosingAdjustment(); this._tab = 'home';
    if (!id) {
      const previous = this._presentedRoomId;
      const from = interrupted || captureRoomVisual(this._roomSurface());
      this._closingRoom = true;
      window.scrollTo({ top: this._homeScroll || 0, behavior: 'instant' });
      const card = this._homeCard(previous);
      card?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const to = captureRoomVisual(card);
      this._startRoomMorph(from, to, false, () => {
        this._closingRoom = false; this._presentedRoomId = null;
        this._update();
        this._homeCard(previous)?.querySelector('[data-open-room]')?.focus({ preventScroll: true });
      });
      return;
    }
    const wasOpen = !!this._presentedRoomId;
    this._closingRoom = false;
    const from = this._roomOpeningSource || interrupted;
    this._roomOpeningSource = null;
    const oldOffset = this._roomTrackVisualOffset();
    this._presentedRoomId = id;
    if (!wasOpen) this._homeScroll = window.scrollY;
    this._update();
    const surface = this._roomSurface(id);
    if (surface) surface.scrollTop = 0;
    if (from) { this._focusRoom(); this._startRoomMorph(from, captureRoomVisual(surface), true, () => { this._update(); this._focusRoom(); }); }
    else if (wasOpen) this._animateRoomTrack(oldOffset);
    else { this._needsRoomFocus = !this._room(id); this._focusRoom(); }
  }
  _roomStep() { return (this.shadowRoot.querySelector('.room-viewport')?.getBoundingClientRect().width || 0) + 12; }
  _roomTrackOffset() { return -Math.max(0, this._home?.rooms.findIndex(room => room.id === this._presentedRoomId) ?? 0) * this._roomStep(); }
  _roomTrackVisualOffset() {
    const track = this.shadowRoot.querySelector('.room-track');
    return track ? new DOMMatrixReadOnly(getComputedStyle(track).transform).m41 : 0;
  }
  _positionRoomTrack(offset = this._roomTrackOffset()) {
    const track = this.shadowRoot.querySelector('.room-track');
    if (track) track.style.transform = `translate3d(${offset}px, 0, 0)`;
  }
  _finishRoomSlide() { this._roomSlide?.finish(); }
  _animateRoomTrack(from, focus = true) {
    this._finishRoomSlide();
    const track = this.shadowRoot.querySelector('.room-track'), to = this._roomTrackOffset();
    this._positionRoomTrack(to);
    if (!track || from === to || this._roomReduced.matches) { if (focus) this._focusRoom(); return; }
    const animation = track.animate([{ transform: `translate3d(${from}px,0,0)` }, { transform: `translate3d(${to}px,0,0)` }],
      { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' });
    const motion = { finish: () => {
      if (this._roomSlide !== motion) return;
      this._roomSlide = null; animation.cancel(); this._update(); if (focus) this._focusRoom();
    } };
    this._roomSlide = motion;
    animation.finished.then(motion.finish, () => {});
  }
  _changeRoom(id, from = this._roomTrackVisualOffset()) {
    if (!this._room(id) || this._closingRoom) return;
    this._roomMorph?.finish(); this._finishRoomSlide();
    this._cancelGesture(); this._finishClosingAdjustment();
    history.replaceState(history.state, '', `#room=${encodeURIComponent(id)}`);
    this._presentedRoomId = id; this._update();
    const surface = this._roomSurface(id); if (surface) surface.scrollTop = 0;
    this._animateRoomTrack(from);
  }
  _returnHome() {
    history.replaceState(history.state, '', location.pathname + location.search);
    this._onRoomRoute();
  }
  _controlTarget(button) {
    if (!button.dataset.entity) return this._room(button.dataset.room);
    const entity = this._detailDevices?.find(entity => entity.id === button.dataset.entity);
    return entity ? entityControlTarget(entity) : null;
  }
  _renderRobots() {
    const stateNames = { cleaning: 'Reinigt', docked: 'In der Station', returning: 'Fährt zur Station', paused: 'Pausiert', idle: 'Bereit', error: 'Fehler', unavailable: 'Nicht verfügbar', unknown: 'Status unbekannt' };
    const actions = { start: 'Starten', pause: 'Pause', return_to_base: 'Zur Station', stop: 'Stoppen' };
    return `<header class="welcome section-heading"><h1>Roboter</h1></header>${this._status()}<section class="robot-list" aria-label="Saugroboter">${this._home.vacuums.length ? this._home.vacuums.map(entity => `<article class="robot-card"><div class="robot-symbol">${icon('robot')}</div><div><h2>${escape(entity.name)}</h2><p>${escape(stateNames[entity.state] || entity.state)}${isNumber(entity.attributes.battery_level) ? ` · ${number(entity.attributes.battery_level, 0)} % Akku` : ''}</p></div><div class="robot-actions">${entity.actions.filter(action => action in actions && (action !== 'pause' || entity.state === 'cleaning') && (action !== 'start' || entity.state !== 'cleaning')).map(action => `<button data-vacuum="${escape(entity.id)}" data-action="${action}" ${!entity.available || this._hass?.connected === false || this._pending.has(entity.id) ? 'disabled' : ''}>${actions[action]}</button>`).join('')}</div></article>`).join('') : '<div class="empty-state"><p>Deine Saugroboter erscheinen hier, sobald sie in Home Assistant eingerichtet sind.</p></div>'}</section>`;
  }
  _room(id) { return this._home?.rooms.find(room => room.id === id); }
  async _run(key, operation) {
    if (this._pending.has(key)) return;
    this._pending.add(key);
    this._update();
    try { await operation(); }
    catch (error) { this._toast(error?.message || 'Das Gerät konnte nicht eingestellt werden.'); }
    finally { this._pending.delete(key); this._update(); }
  }
  _toggle(room, kind) {
    if (!room) return;
    this._run(`${room.id}:${kind}`, () => kind === 'light' ? toggleRoomLights(this._hass, room) : toggleRoomCovers(this._hass, room));
  }
  _click(event) {
    if (event.target.closest('[data-room-back]')) { this._returnHome(); return; }
    const roomPage = event.target.closest('[data-room-page]');
    if (roomPage) { this._changeRoom(roomPage.dataset.roomPage); return; }
    if (this._roomDrag?.locked || (event.detail !== 0 && performance.now() < (this._ignoreRoomClickUntil || 0))) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (this._roomMorph || this._roomSlide) return;
    const control = event.target.closest('[data-control]');
    if (control) {
      if (event.detail === 0 && !control.disabled && !this._gesture && !this._adjustment) this._toggle(this._controlTarget(control), control.dataset.control);
      return;
    }
    // The whole card opens the room, including content hit directly while CSS loads.
    // Device controls are handled above and never trigger room navigation.
    const roomLink = event.target.closest('[data-open-room]')
      || event.target.closest('[data-room-card]')?.querySelector('[data-open-room]');
    if (roomLink) {
      event.preventDefault();
      event.stopPropagation();
      this._roomOpeningSource = captureRoomVisual(roomLink.closest('[data-room-card]'));
      history.pushState(history.state, '', roomLink.getAttribute('href'));
      this._onRoomRoute();
      return;
    }
    const deviceToggle = event.target.closest('[data-toggle-entity]');
    if (deviceToggle && !deviceToggle.disabled) {
      const entity = this._detailDevices?.find(item => item.id === deviceToggle.dataset.toggleEntity);
      if (entity) this._run(`entity:${entity.id}`, () => toggleEntity(this._hass, entity));
      return;
    }
    const moreInfo = event.target.closest('[data-more-info]');
    if (moreInfo) {
      if (this._detailDevices?.some(entity => entity.id === moreInfo.dataset.moreInfo)) this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles: true, composed: true, detail: { entityId: moreInfo.dataset.moreInfo } }));
      return;
    }
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) {
      this._cancelGesture();
      this._finishClosingAdjustment();
      if (tab === 'more') { this._showMore(); return; }
      if (this._selectedRoomId()) history.replaceState(history.state, '', location.pathname + location.search);
      if (tab === 'map' || tab === 'energy') {
        const path = tab === 'map' ? 'map' : 'energy';
        if (!this._hass?.panels?.[path] || (this._hass.panels[path].require_admin && !this._hass.user?.is_admin)) {
          this._toast(`${tab === 'map' ? 'Die Karte' : 'Energie'} ist in Home Assistant noch nicht verfügbar.`);
          return;
        }
        this._navigation.release();
        window.location.assign(`/${path}`);
        return;
      }
      this._tab = tab;
      this._update();
      window.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    const robotButton = event.target.closest('[data-vacuum]');
    if (robotButton && !robotButton.disabled) {
      const entity = this._home.vacuums.find(entity => entity.id === robotButton.dataset.vacuum);
      if (entity) this._run(entity.id, () => callVacuumAction(this._hass, entity, robotButton.dataset.action));
    }
    if (event.target.closest('[data-retry]')) this._connect();
    if (event.target.closest('[data-dismiss]')) this._dismiss();
    if (event.target.closest('[data-apply]')) this._commitAdjustment();
  }
  _pointerDown(event) {
    this._ignoreRoomClickUntil = 0;
    const button = event.target.closest('[data-control]');
    if (!button) { this._roomPointerDown(event); return; }
    if (this._roomMorph || this._roomSlide || this._closingRoom) return;
    if (!button || button.disabled || event.button !== 0 || !event.isPrimary || this._gesture || this._adjustment) return;
    this._finishClosingAdjustment();
    const room = this._controlTarget(button);
    if (!room) return;
    const kind = button.dataset.control;
    if (this._pending.has(`${room.id}:${kind}`)) return;
    const canAdjust = kind === 'light' ? room.light.canDim : room.cover.canSetPosition;
    const gesture = { button, room, kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, held: false, canceled: false };
    this._gesture = gesture;
    button.setPointerCapture(event.pointerId);
    if (canAdjust) gesture.timer = setTimeout(() => {
      if (this._gesture !== gesture || gesture.canceled) return;
      gesture.held = true;
      this._openAdjustment(room, kind, button, false, gesture.lastX);
    }, 400);
  }
  _pointerMove(event) {
    const gesture = this._gesture;
    if (!gesture) { this._roomPointerMove(event); return; }
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.lastX = event.clientX;
    if (!gesture.held) {
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 12) { clearTimeout(gesture.timer); gesture.canceled = true; }
      return;
    }
    event.preventDefault();
    const adjustment = this._adjustment;
    if (!adjustment) return;
    const delta = event.clientX - adjustment.anchorX;
    const distance = delta < 0 ? Math.max(1, adjustment.anchorX - adjustment.left) : Math.max(1, adjustment.left + adjustment.width - adjustment.anchorX);
    const remaining = delta < 0 ? adjustment.anchorValue : 100 - adjustment.anchorValue;
    this._setAdjustment(adjustment.anchorValue + delta / distance * remaining);
  }
  _pointerUp(event) {
    const gesture = this._gesture;
    if (!gesture) { this._roomPointerUp(event); return; }
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    clearTimeout(gesture.timer);
    this._gesture = null;
    if (gesture.button.hasPointerCapture(event.pointerId)) gesture.button.releasePointerCapture(event.pointerId);
    if (gesture.held) this._commitAdjustment();
    else if (!gesture.canceled) this._toggle(gesture.room, gesture.kind);
    else this._update();
  }
  _cancelGesture() {
    const gesture = this._gesture;
    this._gesture = null;
    if (gesture) { clearTimeout(gesture.timer); if (gesture.button.hasPointerCapture(gesture.pointerId)) gesture.button.releasePointerCapture(gesture.pointerId); }
    if (this._adjustment) this._closeAdjustment();
  }
  _roomPointerDown(event) {
    if (!this._presentedRoomId || this._closingRoom || this._roomMorph || this._gesture || this._adjustment
      || event.button !== 0 || !event.isPrimary || this._home.rooms.length < 2) return;
    const surface = event.target.closest('.room-detail[data-current-room]');
    if (!surface || event.target.closest('[data-control], [data-toggle-entity], [data-room-back], input, select, textarea, a')) return;
    const base = this._roomTrackVisualOffset();
    this._finishRoomSlide();
    this._positionRoomTrack(base);
    this._roomDrag = { surface, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      start: performance.now(), delta: 0, base, locked: false };
  }
  _roomPointerMove(event) {
    const drag = this._roomDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.locked) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx) * .8) { this._roomDrag = null; this._update(); return; }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
      drag.locked = true; drag.surface.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const index = this._home.rooms.findIndex(room => room.id === this._presentedRoomId);
    const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === this._home.rooms.length - 1);
    drag.delta = Math.max(-this._roomStep(), Math.min(this._roomStep(), dx * (atEdge ? .18 : 1)));
    this._positionRoomTrack(drag.base + drag.delta);
  }
  _roomPointerUp(event) {
    const drag = this._roomDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this._roomDrag = null;
    if (drag.surface.hasPointerCapture(event.pointerId)) drag.surface.releasePointerCapture(event.pointerId);
    if (!drag.locked) { this._update(); return; }
    this._ignoreRoomClickUntil = performance.now() + 350;
    const index = this._home.rooms.findIndex(room => room.id === this._presentedRoomId);
    const distance = event.clientX - drag.x;
    const commit = Math.abs(distance) > Math.min(80, this._roomStep() * .22)
      || (Math.abs(distance) > 26 && Math.abs(distance) / Math.max(1, performance.now() - drag.start) > .5);
    const next = index + (distance < 0 ? 1 : -1);
    if (commit && next >= 0 && next < this._home.rooms.length) this._changeRoom(this._home.rooms[next].id, drag.base + drag.delta);
    else this._animateRoomTrack(drag.base + drag.delta, false);
  }
  _cancelRoomSwipe(animate = true) {
    const drag = this._roomDrag; this._roomDrag = null;
    if (!drag) return;
    if (drag.surface.hasPointerCapture(drag.pointerId)) drag.surface.releasePointerCapture(drag.pointerId);
    if (drag.locked && animate) this._animateRoomTrack(drag.base + drag.delta, false);
    else this._positionRoomTrack();
  }
  _roomWheel(event) {
    if (event.ctrlKey || !this._presentedRoomId || this._gesture || this._adjustment || this._roomMorph || this._closingRoom
      || !event.target.closest('.room-stage') || Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.3) return;
    event.preventDefault();
    const now = performance.now();
    if (this._roomSlide || now < (this._roomWheelUntil || 0)) return;
    if (now - (this._roomWheelAt || 0) > 180) this._roomWheelDelta = 0;
    this._roomWheelAt = now; this._roomWheelDelta = (this._roomWheelDelta || 0) + event.deltaX;
    if (Math.abs(this._roomWheelDelta) < 65) return;
    const index = this._home.rooms.findIndex(room => room.id === this._presentedRoomId);
    const next = this._home.rooms[index + (this._roomWheelDelta > 0 ? 1 : -1)];
    this._roomWheelDelta = 0; this._roomWheelUntil = now + 450;
    if (next) this._changeRoom(next.id);
  }
  _keyDown(event) {
    // Keep the captured pointer gesture as the single owner of the open control.
    if (this._gesture) {
      if (['Tab', 'Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
      return;
    }
    if (this._adjustment?.keyboard && event.key === 'Enter' && event.target.id === 'adjust-range') { event.preventDefault(); this._commitAdjustment(); return; }
    if (this._adjustment?.keyboard && event.key === 'Tab') {
      const elements = [...this.shadowRoot.querySelectorAll('.adjust-wrap input, .adjust-wrap button')];
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && this.shadowRoot.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && this.shadowRoot.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.key === 'Tab' && this._sheetOpen) {
      const elements = [...this.shadowRoot.querySelectorAll('.sheet button, .sheet a, .sheet input')].filter(el => !el.disabled);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && this.shadowRoot.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && this.shadowRoot.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (this._presentedRoomId && !this._adjustment && !this._sheetOpen) {
      if (event.key === 'Tab') {
        const focusable = [...this.shadowRoot.querySelectorAll('.room-stage button, .room-stage a, .room-stage input')]
          .filter(el => !el.disabled && !el.closest('[inert]'));
        const first = focusable[0], last = focusable.at(-1), active = this.shadowRoot.activeElement;
        if (event.shiftKey && (active === first || active?.matches('h1'))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
      }
      if (['ArrowLeft', 'ArrowRight'].includes(event.key) && !event.target.closest('[data-control], input, textarea, select')) {
        event.preventDefault();
        const index = this._home.rooms.findIndex(room => room.id === this._presentedRoomId);
        const next = this._home.rooms[index + (event.key === 'ArrowRight' ? 1 : -1)];
        if (next) this._changeRoom(next.id);
        return;
      }
    }
    const button = event.target.closest('[data-control]');
    if (!button || button.disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const room = this._controlTarget(button), kind = button.dataset.control;
    if (!(kind === 'light' ? room?.light.canDim : room?.cover.canSetPosition)) return;
    event.preventDefault();
    this._openAdjustment(room, kind, button, true);
    this.shadowRoot.getElementById('adjust-range')?.focus();
  }
  _openAdjustment(room, kind, button, keyboard, anchorX) {
    if (this._adjustment) return;
    this._finishClosingAdjustment();
    const rect = button.getBoundingClientRect();
    const width = Math.min(358, window.innerWidth - 32);
    const left = Math.max(16, Math.min(window.innerWidth - width - 16, rect.right - width + 8));
    const top = Math.max(16, Math.min(window.innerHeight - (keyboard ? 154 : 108), rect.top + rect.height / 2 - 116));
    const actual = kind === 'light' ? room.light.brightness : room.cover.position;
    const value = actual ?? 50;
    this._adjustment = { room, kind, value, known: actual !== null, dirty: false, anchorValue: value, anchorX: anchorX ?? rect.x + rect.width / 2, left, width, button, keyboard };
    this.shadowRoot.getElementById('app-content').classList.add('is-adjusting');
    if (keyboard) this.shadowRoot.getElementById('app-content').inert = true;
    if (keyboard) this.shadowRoot.getElementById('room-root').inert = true;
    const label = kind === 'light' ? 'Licht' : 'Rollladen';
    this.shadowRoot.getElementById('overlay-root').innerHTML = `<div class="adjust-backdrop" data-dismiss></div>
      <div class="adjust-wrap ${kind}" style="left:${left}px;top:${top}px;width:${width}px" role="dialog" aria-modal="true" aria-label="${escape(room.name)}: ${label} einstellen">
        <div class="adjust-bar"><div class="adjust-fill" id="adjust-fill" style="width:${actual ?? 0}%"></div><div class="adjust-icon" id="adjust-icon">${kind === 'light' ? icon('light') : coverIcon(actual)}</div><span class="adjust-title">${escape(room.name)}</span><output id="adjust-value">${actual ?? '—'} %</output>
        ${keyboard ? `<input id="adjust-range" type="range" min="0" max="100" step="1" value="${value}" aria-label="${label}: ${kind === 'light' ? 'Helligkeit' : 'Öffnung'} in Prozent">` : ''}</div>
        ${keyboard ? '<div class="adjust-actions"><button data-dismiss>Abbrechen</button><button data-apply>Übernehmen</button></div>' : ''}
      </div>`;
    this._adjustment.morph = morphControl(this.shadowRoot.getElementById('overlay-root'), button);
  }
  _setAdjustment(value) {
    if (!this._adjustment) return;
    value = clamp(value);
    this._adjustment.dirty = !this._adjustment.known || value !== this._adjustment.anchorValue;
    this._adjustment.value = value;
    this.shadowRoot.getElementById('adjust-fill').style.width = `${value}%`;
    this.shadowRoot.getElementById('adjust-value').textContent = `${value} %`;
    if (this._adjustment.kind === 'cover') this.shadowRoot.getElementById('adjust-icon').innerHTML = coverIcon(value);
  }
  _commitAdjustment() {
    const adjustment = this._adjustment;
    if (!adjustment) return;
    this._closeAdjustment();
    if (!adjustment.dirty) return;
    this._run(`${adjustment.room.id}:${adjustment.kind}`, () => adjustment.kind === 'light'
      ? setRoomBrightness(this._hass, adjustment.room, adjustment.value)
      : setRoomCoverPosition(this._hass, adjustment.room, adjustment.value));
  }
  _closeAdjustment() {
    const adjustment = this._adjustment;
    if (!adjustment) return;
    this._adjustment = null;
    this._closingAdjustment = adjustment;
    const overlay = this.shadowRoot.getElementById('overlay-root');
    overlay.classList.add('is-closing');
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    // Input and HA commands finish immediately; only the visual surface returns.
    this.shadowRoot.getElementById('room-root').inert = false;
    this._lockRoomBackground(!!this._presentedRoomId);
    if (adjustment.keyboard) adjustment.button.focus({ preventScroll: true });
    const finish = () => { if (this._closingAdjustment === adjustment) this._finishClosingAdjustment(); };
    if (adjustment.morph && this.isConnected) adjustment.morph.close(finish);
    else finish();
  }
  _finishClosingAdjustment() {
    const adjustment = this._closingAdjustment;
    if (!adjustment) return;
    this._closingAdjustment = null;
    adjustment.morph?.dispose();
    const overlay = this.shadowRoot.getElementById('overlay-root');
    overlay.innerHTML = '';
    overlay.classList.remove('is-closing');
    overlay.inert = false;
    overlay.removeAttribute('aria-hidden');
    this.shadowRoot.getElementById('app-content').classList.remove('is-adjusting');
    this.shadowRoot.getElementById('room-root').inert = false;
    this._lockRoomBackground(!!this._presentedRoomId);
    this._update();
  }
  _showMore() {
    this._cancelGesture();
    this._finishClosingAdjustment();
    this._sheetOpen = true;
    const appearance = this._appearance();
    const restore = new URL(window.location.href);
    restore.searchParams.set('easy_hass_navigation', 'show');
    this.shadowRoot.getElementById('app-content').inert = true;
    this.shadowRoot.getElementById('overlay-root').innerHTML = `<div class="sheet-backdrop" data-dismiss></div><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="more-title"><div class="sheet-heading"><h2 id="more-title">Mehr</h2><button class="close" data-dismiss aria-label="Schließen">${icon('close')}</button></div><fieldset><legend>Darstellung</legend><div class="appearance">${[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([value, label]) => `<label><input type="radio" name="appearance" value="${value}" ${appearance === value ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div></fieldset><a href="${this._expertPath()}" data-easy-hass-exit>Expertenansicht <span aria-hidden="true">↗</span></a><a href="/profile" data-easy-hass-exit>Mein Profil <span aria-hidden="true">↗</span></a><a id="restore-navigation" href="${escape(restore.pathname + restore.search)}" data-easy-hass-exit>Home-Assistant-Menü anzeigen <span aria-hidden="true">↗</span></a></section>`;
    this.shadowRoot.querySelector('.sheet .close').focus();
  }
  _dismiss() {
    if (this._gesture || this._adjustment || this._closingAdjustment) {
      this._cancelGesture(); this._finishClosingAdjustment(); return;
    }
    if (this._sheetOpen) {
      this._sheetOpen = false;
      this.shadowRoot.getElementById('overlay-root').innerHTML = '';
      this.shadowRoot.getElementById('app-content').inert = false;
      this.shadowRoot.querySelector('[data-tab="more"]').focus();
      return;
    }
    if (this._presentedRoomId) this._returnHome();
  }
  _toast(message) {
    const toast = this.shadowRoot.getElementById('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { toast.hidden = true; }, 6500);
  }
}
if (!customElements.get('easy-hass-panel')) customElements.define('easy-hass-panel', EasyHassPanel);
