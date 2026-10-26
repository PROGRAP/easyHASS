import { averageImagePalette, coverCrop, FALLBACK_PALETTE } from './image-palette.js';

// Small per-panel caches: no image bytes, URLs or palettes leave the browser.
const CACHE_LIMIT = 64;
const remember = (cache, key, value) => {
  cache.delete(key); cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
};

export class RoomPhotoPalette {
  constructor(root) {
    this.root = root;
    this.photos = new Map();
    this.cache = new Map();
    this.probes = new Map();
    this.disposed = false;
    this.resize = new ResizeObserver(entries => {
      for (const { target } of entries) this.refresh(target);
    });
    this.onImage = event => {
      const image = event.target;
      if (!image.matches?.('img[data-room-picture]')) return;
      image.hidden = event.type === 'error';
      image.parentElement?.classList.toggle('picture-failed', image.hidden);
      const photo = image.closest('.detail-photo');
      if (photo) this.refresh(photo);
    };
    root.addEventListener('load', this.onImage, true);
    root.addEventListener('error', this.onImage, true);
  }

  sync() {
    for (const image of this.root.querySelectorAll('.room-picture > img[data-room-picture]')) {
      const failed = image.complete && !image.naturalWidth;
      image.hidden = failed;
      image.parentElement.classList.toggle('picture-failed', failed);
    }
    const current = new Set(this.root.querySelectorAll('.detail-header > .detail-photo'));
    for (const photo of this.photos.keys()) if (!current.has(photo)) {
      this.resize.unobserve(photo); this.photos.delete(photo);
    }
    for (const photo of current) {
      if (!this.photos.has(photo)) { this.photos.set(photo, {}); this.resize.observe(photo); }
      // The DOM reconciler owns attributes; restore cached CSS variables even
      // when an unrelated HA state change patches the same header in place.
      this.refresh(photo);
    }
  }

  apply(photo, palette, state) {
    if (this.disposed || !this.photos.has(photo) || !photo.isConnected) return;
    const header = photo.closest('.detail-header');
    if (!header) return;
    header.style.setProperty('--room-photo-base', palette.base);
    header.style.setProperty('--room-photo-shade', palette.shade);
    header.dataset.photoPalette = state;
  }

  sample(image, width, height) {
    const crop = coverCrop(image.naturalWidth, image.naturalHeight, width, height);
    const canvas = document.createElement('canvas');
    const scale = 64 / Math.max(width, height);
    canvas.width = Math.max(8, Math.round(width * scale));
    canvas.height = Math.max(8, Math.round(height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !crop.sw || !crop.sh) throw new Error('Image unavailable');
    context.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
    return averageImagePalette(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  }

  readableImage(url) {
    if (this.probes.has(url)) return this.probes.get(url);
    // A separate anonymous request can read CORS-enabled external photos without
    // making the displayed image depend on CORS or sending credentials off-site.
    const promise = new Promise(resolve => {
      const image = new Image();
      const timer = setTimeout(() => finish(null), 6000);
      const finish = result => { clearTimeout(timer); image.onload = image.onerror = null; resolve(result); };
      image.crossOrigin = 'anonymous';
      image.onload = () => finish(image);
      image.onerror = () => finish(null);
      image.src = url;
    });
    // Keep failed probes cached, but release successfully decoded full-size
    // images once callers have sampled them. Only the tiny palettes persist.
    promise.then(image => { if (image && this.probes.get(url) === promise) this.probes.delete(url); });
    return remember(this.probes, url, promise);
  }

  refresh(photo) {
    const record = this.photos.get(photo), image = photo.querySelector('img');
    if (this.disposed || !record || !image) return;
    const width = photo.clientWidth, height = photo.clientHeight;
    if (!width || !height) return;
    const failed = image.complete && !image.naturalWidth;
    image.hidden = failed;
    photo.classList.toggle('picture-failed', failed);
    const header = photo.closest('.detail-header'), intro = header?.querySelector('.detail-intro');
    if (intro) {
      const copyHeight = intro.offsetHeight - Number.parseFloat(getComputedStyle(intro).paddingTop);
      header.style.setProperty('--room-photo-copy-height', `${copyHeight}px`);
    }
    const url = image.src;
    const key = `${url}|${Math.round(width / height * 1000)}`;
    record.key = key;
    const cached = this.cache.get(key);
    if (cached) { this.apply(photo, cached.palette, cached.state); return; }
    this.apply(photo, FALLBACK_PALETTE, 'fallback');
    // Reuse the already decoded home-card photo for the first morph frame.
    const source = image.complete && image.naturalWidth ? image
      : [...this.root.querySelectorAll('img[data-room-picture]')].find(other => other.src === image.src && other.complete && other.naturalWidth);
    if (!source) return;
    const commit = (palette, state) => {
      if (this.disposed) return;
      remember(this.cache, key, { palette, state });
      if (this.photos.get(photo) === record && record.key === key && image.src === url) this.apply(photo, palette, state);
    };
    try { commit(this.sample(source, width, height), 'ready'); }
    catch {
      if (record.pending === key) return;
      record.pending = key;
      this.readableImage(url).then(readable => {
        let palette = FALLBACK_PALETTE, state = 'fallback';
        try { if (readable) { palette = this.sample(readable, width, height); state = 'ready'; } } catch { /* Tainted/unsupported image: neutral readable fallback. */ }
        if (record.pending === key) record.pending = null;
        commit(palette, state);
      });
    }
  }

  dispose() {
    this.disposed = true;
    this.resize.disconnect(); this.photos.clear(); this.cache.clear(); this.probes.clear();
    this.root.removeEventListener('load', this.onImage, true);
    this.root.removeEventListener('error', this.onImage, true);
  }
}
