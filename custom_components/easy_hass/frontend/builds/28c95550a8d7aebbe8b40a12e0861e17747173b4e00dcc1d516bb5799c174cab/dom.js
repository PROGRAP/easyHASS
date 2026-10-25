/** Stable identities for the interactive items on the HA page. Keys are sibling-scoped. */
function key(node) {
  if (node.nodeType !== 1) return null;
  if (node.hasAttribute('data-room-card')) return JSON.stringify(['room', node.getAttribute('data-room-card')]);
  if (node.hasAttribute('data-room-slide')) return JSON.stringify(['room-slide', node.getAttribute('data-room-slide')]);
  if (node.hasAttribute('data-room-detail')) return JSON.stringify(['room-detail', node.getAttribute('data-room-detail')]);
  if (node.hasAttribute('data-entity-row')) return JSON.stringify(['entity', node.getAttribute('data-entity-row')]);
  if (node.hasAttribute('data-control')) return JSON.stringify(['control', node.getAttribute('data-room'), node.getAttribute('data-control')]);
  if (node.hasAttribute('data-vacuum')) return JSON.stringify(['vacuum', node.getAttribute('data-vacuum'), node.getAttribute('data-action')]);
  if (node.id) return JSON.stringify(['id', node.id]);
  return null;
}

function compatible(current, next) {
  return current.nodeType === next.nodeType && (current.nodeType !== 1
    || (current.localName === next.localName && current.namespaceURI === next.namespaceURI));
}

function patch(current, next) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  for (const attribute of [...current.attributes]) {
    if (!next.hasAttributeNS(attribute.namespaceURI, attribute.localName)) {
      current.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    }
  }
  for (const attribute of next.attributes) {
    if (current.getAttributeNS(attribute.namespaceURI, attribute.localName) !== attribute.value) {
      current.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    }
  }
  reconcile(current, next);
}

function reconcile(parent, nextParent) {
  const remaining = new Set(parent.childNodes);
  const keyed = new Map();
  for (const node of remaining) {
    const identity = key(node);
    if (identity !== null && !keyed.has(identity)) keyed.set(identity, node);
  }
  let cursor = parent.firstChild;
  for (const next of nextParent.childNodes) {
    const identity = key(next);
    let current = identity === null ? null : keyed.get(identity);
    if (current && (!remaining.has(current) || !compatible(current, next))) current = null;
    if (identity === null) {
      // Positional wrappers/text remain reusable, but never steal a keyed control.
      current = [...remaining].find(node => key(node) === null && compatible(node, next));
    }
    if (current) {
      remaining.delete(current);
      if (current !== cursor) parent.insertBefore(current, cursor);
      patch(current, next);
    } else {
      current = next.cloneNode(true);
      parent.insertBefore(current, cursor);
    }
    cursor = current.nextSibling;
  }
  for (const node of remaining) node.remove();
}

/**
 * Patch internally rendered, already escaped HTML without replacing room/control nodes.
 * This is not an HTML sanitizer. Page templates own attributes; property listeners survive.
 */
export function updateMarkup(parent, html) {
  const root = parent.getRootNode();
  const focused = root.activeElement;
  const template = parent.ownerDocument.createElement('template');
  template.innerHTML = html;
  reconcile(parent, template.content);
  // insertBefore preserves identity/listeners but browsers may blur a moved subtree.
  if (focused?.isConnected && parent.contains(focused) && root.activeElement !== focused) {
    focused.focus?.({ preventScroll: true });
  }
}
