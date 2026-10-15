// Renders ParamDef lists as accessible form controls.
import type { ParamDef, ParamValue } from '../scenes/types.ts';
import { h } from './dom.ts';

let uid = 0;

function fmt(def: ParamDef, v: number): string {
  const step = def.step ?? 1;
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `${v.toFixed(digits)}${def.unit ? ' ' + def.unit : ''}`;
}

export interface ControlOptions {
  onChange: (key: string, value: ParamValue) => void;
  /** grouped heading rendering */
  grouped?: boolean;
  locked?: (def: ParamDef) => string | null;
}

export function renderParams(container: HTMLElement, defs: ParamDef[], values: Record<string, ParamValue>, opts: ControlOptions): void {
  let lastGroup: string | undefined;
  const buttons: HTMLElement[] = [];
  const flushButtons = () => {
    if (!buttons.length) return;
    container.append(h('div', { class: 'btnrow' }, ...buttons.splice(0)));
  };
  for (const def of defs) {
    if (def.visible && !def.visible(values)) continue;
    if (opts.grouped && def.group && def.group !== lastGroup) {
      flushButtons();
      lastGroup = def.group;
      container.append(h('div', { class: 'group-title' }, def.group));
    }
    const lockReason = opts.locked?.(def) ?? null;
    const id = `ctl-${def.key.replace(/[^a-z0-9]/gi, '-')}-${uid++}`;
    const tag = def.applies === 'restart' ? h('span', { class: 'tag', title: 'Takes effect when the scene restarts (press R or Restart)' }, 'restart') : null;
    const title = lockReason ?? def.hint ?? '';
    if (def.type === 'button') {
      buttons.push(h('button', { class: 'btn', type: 'button', title, disabled: !!lockReason, onclick: () => opts.onChange(def.key, true) }, def.label));
      continue;
    }
    flushButtons();
    const v = values[def.key];
    if (def.type === 'range') {
      const val = h('span', { class: 'val' }, fmt(def, Number(v)));
      const input = h('input', {
        id,
        type: 'range',
        min: def.min ?? 0,
        max: def.max ?? 1,
        step: def.step ?? 0.01,
        value: String(v),
        disabled: !!lockReason,
        'aria-describedby': def.hint ? `${id}-hint` : undefined,
      }) as HTMLInputElement;
      input.addEventListener('input', () => {
        const n = Number(input.value);
        val.textContent = fmt(def, n);
        opts.onChange(def.key, n);
      });
      container.append(
        h('div', { class: 'ctl', title }, h('label', { for: id }, def.label, tag), val, input, def.hint ? h('div', { class: 'hint', id: `${id}-hint` }, def.hint) : null),
      );
    } else if (def.type === 'select') {
      const sel = h('select', { id, disabled: !!lockReason }) as HTMLSelectElement;
      for (const o of def.options ?? []) {
        const opt = h('option', { value: o.value, disabled: !!o.disabled, title: o.disabled ?? '' }, o.label + (o.disabled ? ' — unavailable' : ''));
        sel.append(opt);
      }
      sel.value = String(v);
      sel.addEventListener('change', () => opts.onChange(def.key, sel.value));
      const reasons = (def.options ?? []).filter((o) => o.disabled);
      container.append(
        h(
          'div',
          { class: 'ctl', title },
          h('label', { for: id }, def.label, tag),
          h('span'),
          sel,
          def.hint ? h('div', { class: 'hint' }, def.hint) : null,
          reasons.length ? h('div', { class: 'hint' }, reasons.map((o) => `${o.label}: ${o.disabled}`).join(' · ')) : null,
        ),
      );
    } else if (def.type === 'toggle') {
      const cb = h('input', { id, type: 'checkbox', checked: v === true, disabled: !!lockReason }) as HTMLInputElement;
      cb.addEventListener('change', () => opts.onChange(def.key, cb.checked));
      container.append(h('div', { class: 'ctl toggle', title }, h('label', { for: id }, def.label, tag), cb, def.hint ? h('div', { class: 'hint' }, def.hint) : null));
    }
  }
  flushButtons();
}
