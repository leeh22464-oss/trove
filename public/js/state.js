export const state = {
  view: { type: 'inbox' },
  kind: '',
  q: '',
  rows: [],
  total: 0,
  selectedId: null,
  sel: new Set(),          // 批量选择集
  selectMode: false,        // 是否处于批量选择模式
  tags: [],
  pendingTags: [],
  collections: [],
  counts: { inbox: 0, all: 0, favorite: 0, trash: 0 },
  expanded: new Set(JSON.parse(localStorage.getItem('catch.expanded') || '[]')),
  settings: {},
};

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

export function saveExpanded() {
  localStorage.setItem('catch.expanded', JSON.stringify([...state.expanded]));
}

export function viewKey(v = state.view) {
  return v.type === 'tag' || v.type === 'collection' ? `${v.type}:${v.id ?? v.name}` : v.type;
}

export function buildQuery() {
  const v = state.view;
  const parts = [];
  if (v.type === 'tag') parts.push(`tag:${/\s/.test(v.name) ? `"${v.name}"` : v.name}`);
  if (state.kind) parts.push(`kind:${state.kind}`);
  if (state.q.trim()) parts.push(state.q.trim());
  return parts.join(' ');
}

export function buildTagTree(tags) {
  const root = { children: new Map(), count: 0, full: '' };
  for (const t of tags) {
    const parts = t.name.split('/');
    let node = root;
    parts.forEach((p, i) => {
      if (!node.children.has(p)) node.children.set(p, { name: p, full: parts.slice(0, i + 1).join('/'), children: new Map(), count: 0, own: 0, tag: null });
      node = node.children.get(p);
      if (i === parts.length - 1) { node.tag = t; node.own = t.count || 0; }
    });
  }
  const sum = (n) => { n.count = n.own || 0; for (const c of n.children.values()) n.count += sum(c); return n.count; };
  for (const c of root.children.values()) sum(c);
  return root;
}
