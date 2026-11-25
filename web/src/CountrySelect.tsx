import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useI18n } from './i18n';
import { countryOptions, countries } from './market';
import { Icon } from './ui';
import './country-select.css';

interface Option {
  value: string;
  label: string;
}

interface Props {
  name: string;
  label: string;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  autoComplete?: 'country';
  placeholder?: string;
  leading?: Option[];
  hint?: ReactNode;
}

function positionList(trigger: HTMLElement, list: HTMLElement) {
  const rect = trigger.getBoundingClientRect();
  const gap = 8;
  const below = window.innerHeight - rect.bottom - gap;
  const above = rect.top - gap;
  const opensAbove = below < 250 && above > below;
  const width = Math.min(Math.max(rect.width, 232), window.innerWidth - gap * 2);
  list.style.width = width + 'px';
  list.style.left = Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap)) + 'px';
  list.style.top = opensAbove ? 'auto' : rect.bottom + 4 + 'px';
  list.style.bottom = opensAbove ? window.innerHeight - rect.top + 4 + 'px' : 'auto';
  list.style.maxHeight = Math.min(352, Math.max(0, (opensAbove ? above : below) - 4)) + 'px';
}

export function CountrySelect({
  name, label, value, defaultValue = '', onChange, required = false, autoComplete, placeholder, leading, hint,
}: Props) {
  const { t, locale } = useI18n();
  const id = useId();
  const [localValue, setLocalValue] = useState(defaultValue);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ prefix: '', at: 0 });
  const current = value ?? localValue;
  const extra = /^[A-Z]{2}$/.test(current) && !countries.includes(current) ? current : undefined;
  const orderedCountries = useMemo(() => countryOptions(locale, extra), [locale, extra]);
  const options = [...(leading ?? []), ...orderedCountries];
  const selected = options.find(option => option.value === current);
  const emptyLabel = placeholder ?? t('Выберите страну');
  const displayed = selected?.label ?? emptyLabel;
  const supportsPopover = typeof HTMLElement.prototype.showPopover === 'function';

  function choose(next: string) {
    setInvalid(false);
    if (value === undefined) setLocalValue(next);
    onChange?.(next);
    close();
  }

  function close() {
    if (list.current?.matches(':popover-open')) list.current.hidePopover();
    setOpen(false);
  }

  function show() {
    if (!trigger.current || !list.current || list.current.matches(':popover-open')) return;
    positionList(trigger.current, list.current);
    typeahead.current = { prefix: '', at: 0 };
    setActive(0);
    trigger.current.focus({ preventScroll: true });
    list.current.showPopover();
    list.current.scrollTop = 0;
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const reposition = (event: Event) => {
      if (event.target !== list.current && trigger.current && list.current) {
        positionList(trigger.current, list.current);
      }
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useEffect(() => {
    const popup = list.current;
    const item = popup?.children[active];
    if (!open || !popup || !item) return;
    const bounds = popup.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    if (row.top < bounds.top) popup.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) popup.scrollTop += row.bottom - bounds.bottom;
  }, [active, open]);

  function handleKeys(event: KeyboardEvent<HTMLButtonElement>) {
    const { key } = event;
    if (key === 'Tab') {
      close();
      return;
    }
    if (key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(key)) {
      event.preventDefault();
      if (!open) show();
      else {
        const offset = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : key === 'PageDown' ? 7 : -7;
        setActive(previous => key === 'Home' ? 0 : key === 'End' ? options.length - 1
          : Math.max(0, Math.min(options.length - 1, previous + offset)));
      }
    } else if ((key === 'Enter' || key === ' ') && open) {
      event.preventDefault();
      choose(options[active].value);
    } else if (key.length === 1 && /[\p{L}\p{N}]/u.test(key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!open) show();
      const now = Date.now();
      const letter = key.toLocaleLowerCase(locale);
      const prefix = now - typeahead.current.at < 600 ? typeahead.current.prefix + letter : letter;
      const matches = (query: string, start: number) => {
        for (let offset = 0; offset < options.length; offset++) {
          const index = (start + offset) % options.length;
          if (options[index].label.toLocaleLowerCase(locale).startsWith(query)) return index;
        }
        return -1;
      };
      let match = matches(prefix, open ? active + Number(prefix.length === 1) : 0);
      if (match < 0 && prefix.length > 1) {
        match = matches(letter, open ? active + 1 : 0);
        typeahead.current = { prefix: letter, at: now };
      } else typeahead.current = { prefix, at: now };
      if (match >= 0) setActive(match);
    }
  }

  const nativeChoices = <>
    {!options.some(option => option.value === '') && <option value="" disabled>{emptyLabel}</option>}
    {options.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
  </>;

  if (!supportsPopover) return <label className="field">
    <span>{label}</span>
    <select name={name} autoComplete={autoComplete} value={current} required={required} onChange={event => choose(event.currentTarget.value)}>
      {nativeChoices}
    </select>
    {hint && <small>{hint}</small>}
  </label>;

  return <div className="field country-select">
    <label htmlFor={id} id={id + '-label'}>{label}</label>
    <button
      ref={trigger}
      type="button"
      id={id}
      className="country-select-trigger"
      role="combobox"
      data-country-field={name}
      aria-expanded={open}
      aria-controls={id + '-list'}
      aria-labelledby={id + '-label'}
      aria-describedby={invalid ? id + '-error' : hint ? id + '-hint' : undefined}
      aria-activedescendant={open ? id + '-' + active : undefined}
      aria-required={required || undefined}
      aria-invalid={invalid || undefined}
      onClick={() => open ? close() : show()}
      onKeyDown={handleKeys}
    >
      <span>{displayed}</span>
      <Icon name="chevron-down" size={15} />
    </button>
    <select
      className="country-select-native"
      name={name}
      autoComplete={autoComplete}
      value={current}
      tabIndex={-1}
      aria-hidden="true"
      required={required}
      onChange={event => choose(event.currentTarget.value)}
      onInvalid={event => {
        event.preventDefault();
        setInvalid(true);
        trigger.current?.focus();
      }}
    >
      {nativeChoices}
    </select>
    <div
      ref={list}
      id={id + '-list'}
      className="country-select-options"
      role="listbox"
      aria-labelledby={id + '-label'}
      popover="auto"
      onToggle={event => setOpen(event.currentTarget.matches(':popover-open'))}
    >
      {open && options.map((option, index) => <div
        key={option.value}
        id={id + '-' + index}
        role="option"
        aria-selected={option.value === current}
        data-value={option.value}
        data-active={index === active || undefined}
        onClick={() => { choose(option.value); trigger.current?.focus({ preventScroll: true }); }}
      >{option.label}</div>)}
    </div>
    {hint && <small id={id + '-hint'}>{hint}</small>}
    {invalid && <small id={id + '-error'} role="alert" className="country-select-error">{t('Выберите страну.')}</small>}
  </div>;
}
