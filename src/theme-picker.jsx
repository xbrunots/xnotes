import React, {useEffect, useId, useRef, useState} from 'react';
import {THEMES, resolveTheme} from './themes';

function ModeIcon({mode}) {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {mode === 'dark' ? <path d="M20.8 14.2A8.8 8.8 0 0 1 9.8 3.2 9 9 0 1 0 20.8 14.2Z"/> : <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>}
  </svg>;
}

export function ThemePicker({value, onChange}) {
  const selected = resolveTheme(value);
  const [active, setActive] = useState(selected.id);
  const root = useRef(null);
  const id = useId();
  useEffect(() => { setActive(selected.id); }, [selected.id]);

  const choose = theme => { setActive(theme.id); onChange(theme.id); };
  const keyDown = (event, index) => {
    const directions = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!directions.includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...root.current.querySelectorAll('[role="radio"]')];
    let next = index;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = THEMES.length - 1;
    else if (event.key === 'ArrowLeft') next = (index + THEMES.length - 1) % THEMES.length;
    else if (event.key === 'ArrowRight') next = (index + 1) % THEMES.length;
    else {
      // Follow the actual rendered rows when a narrow dialog wraps the previews.
      const current = buttons[index].getBoundingClientRect();
      const down = event.key === 'ArrowDown';
      const candidates = buttons.map((button, candidate) => ({candidate, rect: button.getBoundingClientRect()}))
        .filter(({rect}) => down ? rect.top > current.top + 2 : rect.top < current.top - 2)
        .sort((a, b) => {
          const vertical = Math.abs(a.rect.top - current.top) - Math.abs(b.rect.top - current.top);
          return Math.abs(vertical) > 2 ? vertical : Math.abs(a.rect.left - current.left) - Math.abs(b.rect.left - current.left);
        });
      next = candidates[0]?.candidate ?? (down ? index % 5 : 5 + index % 5);
    }
    choose(THEMES[next]);
    buttons[next].focus();
  };

  return <section className="theme-picker" aria-labelledby={id + '-heading'}>
    <div className="theme-picker-heading"><strong id={id + '-heading'}>Temas</strong><span>5 escuros · 5 claros</span></div>
    <div ref={root} role="radiogroup" aria-label="Tema da interface" className="theme-choices">
      {['dark', 'light'].map(mode => <div key={mode} role="group" aria-labelledby={id + '-' + mode} className="theme-mode-group">
        <div className="theme-mode-heading" id={id + '-' + mode}><ModeIcon mode={mode}/><span>{mode === 'dark' ? 'Escuros' : 'Claros'}</span></div>
        <div className="theme-options">{THEMES.filter(theme => theme.mode === mode).map(theme => {
          const index = THEMES.indexOf(theme), checked = theme.id === selected.id;
          return <button type="button" key={theme.id} className={'theme-option' + (checked ? ' selected' : '')} role="radio" aria-label={theme.name} aria-checked={checked} aria-describedby={id + '-' + theme.id + '-description'} tabIndex={theme.id === active ? 0 : -1} onFocus={() => setActive(theme.id)} onKeyDown={event => keyDown(event, index)} onClick={() => choose(theme)} data-theme-option={theme.id}>
            <span className="theme-miniature" style={theme.variables} aria-hidden="true">
              <span className="theme-mini-sidebar"><i/><i/><i/></span>
              <span className="theme-mini-list"><i/><i/><i/></span>
              <span className="theme-mini-note"><b/><i/><i/><i/></span>
              {checked && <span className="theme-selected-mark"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4 10-10"/></svg></span>}
            </span>
            <span className="theme-option-name">{theme.name}</span>
            <span className="theme-description-hidden" id={id + '-' + theme.id + '-description'}>{theme.description}</span>
          </button>;
        })}</div>
      </div>)}
    </div>
    <p className="theme-current" aria-live="polite"><span>{selected.name}</span>{selected.description}</p>
  </section>;
}
