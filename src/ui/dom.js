// Tiny DOM helpers for building the tool panels.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** A labelled control bound to `obj[key]`. kind: number | range | checkbox | select | text | color */
export function field(label, obj, key, kind = 'number', opts = {}) {
  let input;
  const set = (v) => { obj[key] = v; opts.onChange?.(v); };
  if (kind === 'checkbox') {
    input = h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => set(e.target.checked) });
    return h('label', { class: 'field check', title: opts.title ?? '' }, input, h('span', {}, label));
  }
  if (kind === 'select') {
    input = h('select', { onchange: (e) => set(opts.numeric ? Number(e.target.value) : e.target.value) },
      ...(opts.options ?? []).map((o) => {
        const [value, text] = Array.isArray(o) ? o : [o, o];
        return h('option', { value, selected: String(obj[key]) === String(value) }, text);
      }));
  } else if (kind === 'range') {
    const out = h('span', { class: 'value' }, fmt(obj[key]));
    input = h('input', { type: 'range', min: opts.min ?? 0, max: opts.max ?? 1, step: opts.step ?? 0.01, value: obj[key],
      oninput: (e) => { out.textContent = fmt(Number(e.target.value)); set(Number(e.target.value)); } });
    return h('label', { class: 'field', title: opts.title ?? '' }, h('span', {}, label), input, out);
  } else {
    input = h('input', { type: kind, value: obj[key] ?? '', step: opts.step ?? 'any', min: opts.min, max: opts.max,
      onchange: (e) => set(kind === 'number' ? Number(e.target.value) : e.target.value) });
  }
  return h('label', { class: 'field', title: opts.title ?? '' }, h('span', {}, label), input);
}

function fmt(v) { return Number.isInteger(v) ? String(v) : Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); }

export function section(title, ...children) {
  const body = h('div', { class: 'section-body' }, ...children);
  const head = h('button', { class: 'section-head', onclick: () => el.classList.toggle('collapsed') }, title);
  const el = h('section', { class: 'tool-section' }, head, body);
  return el;
}

export function button(text, onClick, opts = {}) {
  return h('button', { class: `btn ${opts.primary ? 'primary' : ''}`, title: opts.title ?? '', onclick: onClick, disabled: opts.disabled ?? false }, text);
}

export function row(...children) { return h('div', { class: 'row' }, ...children); }
export function note(text) { return h('p', { class: 'note' }, text); }
