/** Animate the surface, never scale the icon or replace the captured button. */
export function morphControl(root, button) {
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const bar = root.querySelector('.adjust-bar');
  if (media.matches || !bar?.animate) return null;
  const wrap = root.querySelector('.adjust-wrap');
  const glyph = root.querySelector('.adjust-icon');
  const backdrop = root.querySelector('.adjust-backdrop');
  const sourceStyle = getComputedStyle(button);
  const color = sourceStyle.color, backgroundColor = sourceStyle.backgroundColor;
  let animations = [], disposed = false, completeClose;
  const easing = 'cubic-bezier(.22, 1, .36, 1)';
  const origin = () => {
    const rect = button.getBoundingClientRect();
    const target = wrap.getBoundingClientRect();
    return {
      surface: { width: `${rect.width}px`, height: `${rect.height}px`,
        transform: `translate(${rect.left - target.left}px, ${rect.top - target.top}px)`,
        borderRadius: `${rect.width / 2}px`, backgroundColor, boxShadow: '0 0 0 0 transparent' },
      glyph: { left: `${(rect.width - 44) / 2}px`, top: `${(rect.height - 44) / 2}px`, color, backgroundColor },
    };
  };
  const start = origin();
  const styles = (element, keys) => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(keys.map(key => [key, computed[key]]));
  };
  const tracks = [
    { element: bar, from: start.surface },
    { element: glyph, from: start.glyph },
    { element: backdrop, from: { opacity: '0' } },
    ...[...root.querySelectorAll('.adjust-title, .adjust-bar output, .adjust-actions')]
      .map(element => ({ element, from: { opacity: '0', transform: 'translateY(4px)' }, reveal: true })),
    { element: root.querySelector('.adjust-fill'), from: { opacity: '0' }, reveal: true },
  ];
  const cancelAnimations = () => { animations.forEach(animation => animation.cancel()); animations = []; };
  for (const track of tracks) track.to = styles(track.element, Object.keys(track.from));
  button.setAttribute('data-morph-source', '');
  animations = tracks.map(({ element, from, to, reveal }) => element.animate(
    reveal ? [{ ...from, offset: 0 }, { ...from, offset: .25 }, { ...to, offset: 1 }] : [from, to],
    { duration: 320, easing, fill: 'both' },
  ));
  // The CSS reduced-motion rule cannot cancel Web Animations API effects.
  const onMotionChange = () => {
    if (!media.matches) return;
    cancelAnimations();
    completeClose?.();
  };
  media.addEventListener('change', onMotionChange);
  return {
    close(done) {
      if (disposed) return done();
      completeClose = done;
      if (media.matches || !button.isConnected) return done();
      const end = origin();
      // Sample before cancel: reversing an unfinished entrance must not jump.
      const current = tracks.map(track => styles(track.element, Object.keys(track.from)));
      cancelAnimations();
      animations = tracks.map((track, index) => track.element.animate(
        [current[index], index === 0 ? end.surface : index === 1 ? end.glyph : track.from],
        { duration: 220, easing, fill: 'both' },
      ));
      Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (!disposed) done();
      });
    },
    dispose() {
      disposed = true;
      cancelAnimations();
      button.removeAttribute('data-morph-source');
      media.removeEventListener('change', onMotionChange);
    },
  };
}
