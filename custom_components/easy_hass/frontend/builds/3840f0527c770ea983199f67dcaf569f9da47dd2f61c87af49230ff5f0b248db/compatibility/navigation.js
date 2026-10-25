/**
 * Temporary HA shell adaptation. No user preferences or HA files are modified.
 * Structure reference: home-assistant/frontend tag 20260930.4, ha-drawer.ts.
 * Unknown layouts deliberately keep the original navigation visible.
 */
const PANEL_PATH = "/easy-hass";
const MAIN_CSS = `
  ha-drawer { --ha-sidebar-width: 0px !important; --ha-top-app-bar-width: 100% !important; }
  ha-sidebar { display: none !important; }
`;
const DRAWER_CSS = `
  .sidebar-shell { display: none !important; }
  .app-content { padding-inline-start: 0 !important; transition: none !important; }
`;

function findMain(element) {
  for (let node = element; node; node = node.parentElement || node.getRootNode()?.host) {
    if (node.localName === "home-assistant-main") return node;
  }
  return null;
}

function makeStyle(document, css) {
  const style = document.createElement("style");
  style.dataset.easyHassNavigation = "";
  style.textContent = css;
  return style;
}

export class NavigationGuard {
  constructor(panel) {
    this.panel = panel;
    this.window = panel.ownerDocument.defaultView;
    this.styles = [];
    this.started = false;
    this.refresh = this.refresh.bind(this);
    this.release = this.release.bind(this);
    this.scheduleRefresh = () => {
      if (!this.frame) {
        this.frame = this.window.requestAnimationFrame(() => {
          this.frame = 0;
          this.refresh();
        });
      }
    };
    this.onMenu = (event) => {
      // Prevent reopening a modal drawer while this page owns the navigation.
      if (this.styles.length && event.detail?.open !== false) {
        event.stopImmediatePropagation();
      }
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (const event of ["location-changed", "popstate", "pageshow"]) {
      this.window.addEventListener(event, this.refresh);
    }
    this.window.addEventListener("resize", this.scheduleRefresh);
    this.window.addEventListener("pagehide", this.release);
    this.refresh();
  }

  stop() {
    this.started = false;
    this.closeRequestedFor = null;
    for (const event of ["location-changed", "popstate", "pageshow"]) {
      this.window.removeEventListener(event, this.refresh);
    }
    this.window.removeEventListener("resize", this.scheduleRefresh);
    this.window.removeEventListener("pagehide", this.release);
    if (this.frame) this.window.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.release();
  }

  refresh() {
    if (!this.started) return;
    try {
      const { pathname, search } = this.window.location;
      const active = pathname === PANEL_PATH || pathname.startsWith(`${PANEL_PATH}/`);
      const showNavigation = new URLSearchParams(search).get("easy_hass_navigation") === "show";
      // Rendered escape link is required before touching the surrounding shell.
      const escape = this.panel.shadowRoot?.querySelector("[data-easy-hass-exit]");
      if (!this.panel.isConnected || !active || showNavigation || !escape?.getAttribute("href")) {
        this.closeRequestedFor = null;
        this.release();
        return;
      }

      const main = findMain(this.panel);
      const root = main?.shadowRoot;
      const drawer = root?.querySelector("ha-drawer");
      const drawerRoot = drawer?.shadowRoot;
      const sidebar = drawer?.querySelector("ha-sidebar");
      const content = drawer?.querySelector('partial-panel-resolver[slot="appContent"]');
      const desktop = drawerRoot?.querySelector(".sidebar-shell") && drawerRoot.querySelector(".app-content");
      const modal = drawer?.type === "modal" && drawerRoot?.querySelector("wa-drawer");
      if (!root || !sidebar || !content || !drawerRoot || (!desktop && !modal)) {
        this.release();
        return;
      }

      // Never hide an open modal: it can make the rest of the page inert.
      // Ask HA to close it, then wait for its next render before hiding anything.
      // If HA ignores the request (e.g. sidebar edit mode), leave its UI intact.
      if (modal && (drawer.open || modal.open)) {
        this.release();
        if (this.closeRequestedFor !== drawer) {
          this.closeRequestedFor = drawer;
          this.panel.dispatchEvent(new CustomEvent("hass-toggle-menu", {
            detail: { open: false }, bubbles: true, composed: true,
          }));
          this.scheduleRefresh();
        }
        return;
      }
      this.closeRequestedFor = null;

      if (this.main !== main || this.drawer !== drawer || this.styles.some((style) => !style.isConnected)) {
        this.release();
        this.main = main;
        this.drawer = drawer;
        this.styles = [makeStyle(this.panel.ownerDocument, MAIN_CSS), makeStyle(this.panel.ownerDocument, DRAWER_CSS)];
        root.append(this.styles[0]);
        drawerRoot.append(this.styles[1]);
        main.addEventListener("hass-toggle-menu", this.onMenu, true);
        this.observer = new this.window.MutationObserver(this.scheduleRefresh);
        this.observer.observe(root, { childList: true, subtree: true });
        this.observer.observe(drawerRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "type"] });
        this.observer.observe(drawer, { attributes: true, attributeFilter: ["open", "type"] });
      }

    } catch (error) {
      this.release();
      console.warn("Easy-Hass: HA-Navigation bleibt sichtbar.", error);
    }
  }

  release() {
    this.observer?.disconnect();
    this.observer = null;
    this.main?.removeEventListener("hass-toggle-menu", this.onMenu, true);
    for (const style of this.styles) style.remove();
    this.styles = [];
    this.main = null;
    this.drawer = null;
  }
}
