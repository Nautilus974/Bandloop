// Petit utilitaire de création d'éléments, pour éviter innerHTML sur des données.

/**
 * h('button', { className: 'x', onclick: fn, 'aria-label': 'Lecture' }, 'texte', autreElement)
 * Les clés commençant par "on" deviennent des écouteurs, "dataset" et "style" sont fusionnés,
 * les autres clés sont des propriétés si elles existent sur l'élément, sinon des attributs.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'style') {
      // setProperty est nécessaire pour les variables CSS (--nom).
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    } else if (key in el && !key.includes('-')) {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Crée un élément à partir d'une chaîne SVG de confiance (icônes internes uniquement). */
export function svg(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstChild;
}
