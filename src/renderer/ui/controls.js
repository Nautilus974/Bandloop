// Contrôles génériques générés à partir des descripteurs de paramètres
// (vocal/settings.js, vocal/fx/catalog.js) : curseur, interrupteur, liste.
import { normalizeValue } from '../vocal/settings.js';
import { h } from './dom.js';

const SLIDER_STEPS = 1000;

/** Position 0..1 du curseur pour une valeur (échelle logarithmique si demandé). */
export function toSlider(param, value) {
  if (param.scale === 'log') return Math.log(value / param.min) / Math.log(param.max / param.min);
  return (value - param.min) / (param.max - param.min);
}

export function fromSlider(param, t) {
  const raw =
    param.scale === 'log' ? param.min * Math.pow(param.max / param.min, t) : param.min + t * (param.max - param.min);
  return normalizeValue(param, raw);
}

const trimNumber = (v, step) => {
  const decimals = step >= 1 ? 0 : Math.min(2, Math.ceil(-Math.log10(step)));
  return v.toFixed(decimals).replace('-', '−');
};

/** Affichage d'une valeur avec son unité. */
export function formatValue(param, value) {
  if (param.type === 'bool') return value ? 'Oui' : 'Non';
  if (param.type === 'choice') return param.options.find(([v]) => v === value)?.[1] ?? value;
  if (param.format) return param.format(value);
  const text = trimNumber(value, param.step);
  const signed = ['dt', 'dB', 'ct'].includes(param.unit) && value > 0 ? `+${text}` : text;
  if (param.unit === 'Hz' && value >= 1000)
    return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2).replace('.', ',')} kHz`;
  return param.unit ? `${signed.replace('.', ',')} ${param.unit}` : signed.replace('.', ',');
}

/** Interrupteur accessible (role="switch"). */
export function toggleSwitch({ checked, label, onChange }) {
  const el = h('button', {
    className: 'switch',
    role: 'switch',
    type: 'button',
    'aria-checked': String(checked),
    'aria-label': label,
    title: label,
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', String(next));
      onChange(next);
    },
  });
  return el;
}

/**
 * Ligne « libellé — contrôle — valeur ».
 * @param {object} param           Descripteur
 * @param {*} value
 * @param {(v: *) => void} onInput Appelé à chaque changement (valeur validée)
 */
export function paramRow(param, value, onInput) {
  const output = h('output', { className: 'param-value' }, formatValue(param, value));
  let control;
  if (param.type === 'bool') {
    control = toggleSwitch({
      checked: value,
      label: param.label,
      onChange: (v) => {
        output.textContent = formatValue(param, v);
        onInput(v);
      },
    });
  } else if (param.type === 'choice') {
    control = h(
      'select',
      {
        className: 'select',
        'aria-label': param.label,
        onchange: () => {
          output.textContent = formatValue(param, control.value);
          onInput(control.value);
        },
      },
      param.options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
    );
  } else {
    control = h('input', {
      type: 'range',
      className: 'param-slider',
      min: 0,
      max: SLIDER_STEPS,
      step: 1,
      'aria-label': param.label,
      title: 'Double-clic : valeur par défaut',
    });
    const show = (v) => {
      const t = toSlider(param, v);
      control.value = String(Math.round(t * SLIDER_STEPS));
      control.style.setProperty('--fill', t);
      output.textContent = formatValue(param, v);
    };
    show(value);
    let current = value;
    control.addEventListener('input', () => {
      const v = fromSlider(param, Number(control.value) / SLIDER_STEPS);
      control.style.setProperty('--fill', Number(control.value) / SLIDER_STEPS);
      output.textContent = formatValue(param, v);
      if (v !== current) onInput((current = v));
    });
    control.addEventListener('dblclick', () => {
      current = param.default;
      show(current);
      onInput(current);
    });
  }
  return h(
    'div',
    { className: `param param-${param.type}` },
    h('span', { className: 'param-label' }, param.label),
    control,
    param.type === 'number' ? output : null,
  );
}
