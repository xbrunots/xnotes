// Imported from the supplied Notas.html; behavior extensions live in notes.jsx.
import React from "react";
import {renderReference} from "./reference-view";
import {plainText} from "./note-content";

const ACCENTS = {
  'Azul': { c: '#3B82F6', tl: '#1D5FD1', td: '#8DB8FF', on: '#ffffff' },
  'Grafite': { c: '#8E8E98', tl: '#4A4A55', td: '#C9C9D2', on: '#ffffff' },
  'Âmbar': { c: '#F2B225', tl: '#8A5E00', td: '#FFD36E', on: '#2a1d00' },
  'Violeta': { c: '#8B6CFF', tl: '#5536D6', td: '#BBA9FF', on: '#ffffff' },
  'Menta': { c: '#22B89A', tl: '#0A7560', td: '#76E4CB', on: '#03241d' },
  'Coral': { c: '#FF6B57', tl: '#BE3523', td: '#FFA092', on: '#2b0904' }
};
const LIGHT = { '--wall': '#ECE8F1', '--b1': '#FFD3A0', '--b2': '#C6BEFF', '--b3': '#A6E6D4', '--b4': '#FFC0D0', '--win': 'rgba(255,255,255,.26)', '--side': 'rgba(250,249,252,.42)', '--list': 'rgba(255,255,255,.38)', '--glass-strong': 'rgba(255,255,255,.74)', '--field': 'rgba(255,255,255,.55)', '--foot': 'rgba(250,249,252,.55)', '--line': 'rgba(30,24,60,.08)', '--line-strong': 'rgba(255,255,255,.7)', '--ink': '#1B1A21', '--ink-2': 'rgba(27,26,33,.68)', '--ink-3': 'rgba(27,26,33,.48)', '--hover': 'rgba(30,24,60,.05)', '--hover-2': 'rgba(30,24,60,.09)', '--sel': 'rgba(30,24,60,.07)', '--scrim': 'rgba(240,236,246,.3)', '--shadow': '0 40px 100px -30px rgba(60,40,110,.35), 0 8px 24px -12px rgba(60,40,110,.18)', '--pane-shadow': '0 12px 40px -18px rgba(60,40,110,.28)' };
const DARK = { '--wall': '#0B0A10', '--b1': '#6A4212', '--b2': '#3A2C8C', '--b3': '#0E4C45', '--b4': '#5A1E3A', '--win': 'rgba(18,17,24,.42)', '--side': 'rgba(22,21,28,.5)', '--list': 'rgba(26,25,33,.45)', '--glass-strong': 'rgba(34,33,42,.72)', '--field': 'rgba(255,255,255,.05)', '--foot': 'rgba(255,255,255,.03)', '--line': 'rgba(255,255,255,.08)', '--line-strong': 'rgba(255,255,255,.12)', '--ink': '#F3F2F7', '--ink-2': 'rgba(243,242,247,.68)', '--ink-3': 'rgba(243,242,247,.45)', '--hover': 'rgba(255,255,255,.05)', '--hover-2': 'rgba(255,255,255,.1)', '--sel': 'rgba(255,255,255,.08)', '--scrim': 'rgba(5,4,10,.35)', '--shadow': '0 40px 120px -30px rgba(0,0,0,.7), 0 8px 30px -12px rgba(0,0,0,.5)', '--pane-shadow': '0 18px 50px -20px rgba(0,0,0,.6)' };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
const slug = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const TAG_RE = /(^|\s)#([A-Za-zÀ-ÿ][\wÀ-ÿ-]*)/g;
const tagsOf = (b, importedTags=[]) => { const o = [...new Set(importedTags.filter(t=>typeof t==='string'))]; let m; TAG_RE.lastIndex = 0; while ((m = TAG_RE.exec(b))) if (!o.includes(m[2])) o.push(m[2]); return o; };
const snippetOf = b => plainText(b).replace(/\n+/g,'  ').slice(0,140);

const GROUPS0 = [
  { id: 'g1', name: 'Pessoal', color: '#FF9F0A', sessions: [{ id: 's1', name: 'Diário' }, { id: 's2', name: 'Viagem a Lisboa' }] },
  { id: 'g2', name: 'Trabalho', color: '#7D7AFF', sessions: [{ id: 's3', name: 'Projeto Atlas' }, { id: 's4', name: 'Reuniões' }] },
  { id: 'g3', name: 'Estudos', color: '#30D158', sessions: [{ id: 's5', name: 'Design de interação' }] }
];
const NOTES0 = [
  { id: 'n1', s: 's3', t: '09:42', title: 'Atlas — visão geral', body: '# Objetivo\nUnificar notas, tarefas e referências num só espaço, sem trocar de tela.\n\n## Próximos passos\n- [x] Definir escopo do MVP\n- [ ] Revisar [[Roadmap Q4]] com o time\n- [ ] Validar fluxo em [[Pesquisa com usuários]]\n\nReferência visual em [[Moodboard]]. #produto' },
  { id: 'n2', s: 's3', t: 'Ontem', title: 'Roadmap Q4', body: '# Outubro\n- [x] Editor com links\n- [ ] Sessões salvas\n\n# Novembro\n- [ ] Sincronização\n- [ ] Versão web\n\nDepende de [[Atlas — visão geral]]. #planejamento' },
  { id: 'n3', s: 's3', t: 'Seg', title: 'Pesquisa com usuários', body: '## Achados\n- Pessoas mantêm 3–4 notas abertas ao mesmo tempo\n- Pastas profundas confundem; preferem grupos rasos\n- A busca é o atalho principal\n\nLigado a [[Roadmap Q4]] e [[Arquitetura de sync]]. #pesquisa' },
  { id: 'n4', s: 's3', t: '12 out', title: 'Moodboard', body: 'Vidro, desfoque, luz suave.\nMovimento que explica de onde as coisas vêm.\n\n- Superfícies translúcidas em camadas\n- Tipografia neutra, muito respiro\n\n#design' },
  { id: 'n5', s: 's4', t: '08:30', title: 'Daily — segunda', body: '## Pauta\n- [ ] Status do [[Atlas — visão geral]]\n- [ ] Bloqueios do time\n\nAnotações rápidas aqui. #reunião' },
  { id: 'n6', s: 's4', t: 'Sex', title: '1:1 com Marina', body: '- Feedback sobre o [[Moodboard]]\n- Plano de carreira\n- [ ] Enviar resumo #reunião' },
  { id: 'n7', s: 's1', t: 'Dom', title: 'Domingo', body: 'Café na varanda, chuva fina.\nComecei a ler sobre [[Hábitos]].\n\n#diário' },
  { id: 'n8', s: 's1', t: 'Sáb', title: 'Hábitos', body: '- [x] Caminhar 30 min\n- [ ] Ler 20 páginas\n- [ ] Dormir antes da meia-noite' },
  { id: 'n9', s: 's2', t: '3 out', title: 'Roteiro Lisboa', body: '# Dia 1\n- Alfama ao entardecer\n- Pastéis em Belém\n\n# Dia 2\n- Sintra\n\nOrçamento em [[Gastos da viagem]]. #viagem' },
  { id: 'n10', s: 's2', t: '2 out', title: 'Gastos da viagem', body: '- Voo: €420\n- Hotel: €610\n- Extras: €200\n\n#viagem' },
  { id: 'n11', s: 's5', t: '20 set', title: 'Leis do movimento na UI', body: '# Princípios\n- Continuidade: o elemento vem de algum lugar\n- Duração curta, curva suave\n- Desfoque sugere profundidade\n\nAplicar no [[Moodboard]]. #estudo #design' }
];

export class ReferenceNotes extends React.Component {
  render() { return renderReference.call(this); }
  activeNotes() { return this.state.notes.filter(n => !n.deletedAt); }

  state = {
    theme: null, groups: GROUPS0, notes: NOTES0,
    openBy: { s1: ['n7', 'n8'], s2: ['n9'], s3: ['n1', 'n2', 'n3'], s4: ['n5'], s5: ['n11'] },
    focusBy: { s1: 'n7', s2: 'n9', s3: 'n1', s4: 'n5', s5: 'n11' },
    session: 's3', view: 'session', tag: null,
    expanded: { g1: true, g2: true, g3: false },
    layout: 'split', sidebar: typeof window === 'undefined' || window.innerWidth >= 900,
    palette: false, pq: '', psel: 0, editing: null,
    w: typeof window === 'undefined' ? 1440 : window.innerWidth
  };
  paneWrap = React.createRef(); listRef = React.createRef(); pInput = React.createRef(); winRef = React.createRef();

  theme() { return this.state.theme || (this.props.theme === 'Claro' ? 'light' : 'dark'); }
  motion() { return this.props.motion ?? true; }

  componentDidMount() {
    this.onKey = e => {
      const mod = e.metaKey || e.ctrlKey, k = (e.key || '').toLowerCase();
      if (mod && k === 'k') { e.preventDefault(); this.setState(s => ({ palette: !s.palette, pq: '', psel: 0 })); }
      else if (e.altKey && e.code === 'KeyN') { e.preventDefault(); this.newNote(); }
      else if (k === 'escape') { if (this.state.palette) this.setState({ palette: false }); else if (this.state.editing) this.setState({ editing: null }); }
    };
    this.onResize = () => this.setState({ w: window.innerWidth });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    requestAnimationFrame(() => this.intro());
  }
  componentWillUnmount() { window.removeEventListener('keydown', this.onKey); window.removeEventListener('resize', this.onResize); }

  componentDidUpdate(pp, ps) {
    const s = this.state;
    if (pp.theme !== this.props.theme && s.theme !== null) this.setState({ theme: null });
    if (ps.session !== s.session || ps.view !== s.view || ps.tag !== s.tag) this.animList();
    if (ps.session !== s.session || ps.layout !== s.layout) this.animPanes(null);
    else {
      const prev = ps.openBy[ps.session] || [], cur = s.openBy[s.session] || [];
      const added = cur.filter(id => !prev.includes(id));
      if (added.length) this.animPanes(s.layout === 'focus' ? null : added);
      else if (s.layout === 'focus' && ps.focusBy[s.session] !== s.focusBy[s.session]) this.animPanes(null);
    }
    if (!ps.palette && s.palette) setTimeout(() => this.pInput.current && this.pInput.current.focus(), 20);
    if(s.editing && ps.editing!==s.editing) this.focusEditor?.(s.editing);
  }

  ease = 'cubic-bezier(.2,.8,.2,1)';
  intro() {
    if (!this.motion()) return;
    const w = this.winRef.current;
    if (w) w.animate([{ opacity: 0, transform: 'scale(.97) translateY(14px)', filter: 'blur(14px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 900, easing: this.ease, fill: 'backwards' });
    this.animList(250); this.animPanes(null, 350);
  }
  animList(base = 0) {
    if (!this.motion() || !this.listRef.current) return;
    [...this.listRef.current.children].slice(0, 14).forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateY(10px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 480, delay: base + i * 35, easing: this.ease, fill: 'backwards' }));
  }
  animPanes(ids, base = 0) {
    if (!this.motion() || !this.paneWrap.current) return;
    let i = 0;
    this.paneWrap.current.querySelectorAll('[data-pane]').forEach(el => {
      if (ids && !ids.includes(el.dataset.pane)) return;
      el.animate([{ opacity: 0, transform: 'translateY(18px) scale(.97)', filter: 'blur(12px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 620, delay: base + (i++) * 70, easing: this.ease, fill: 'backwards' });
    });
  }

  setTheme(t, e) {
    if (t === this.theme()) return;
    if (this.motion() && document.startViewTransition) {
      const r = document.documentElement.style;
      if (e && e.clientX != null) { r.setProperty('--vx', e.clientX + 'px'); r.setProperty('--vy', e.clientY + 'px'); }
      document.startViewTransition(() => new Promise(res => this.setState({ theme: t }, res)));
    } else this.setState({ theme: t });
  }
  selectSession(id) { this.setState({ session: id, view: 'session', tag: null, editing: null }); }
  setFocus(id) { this.setState(s => s.focusBy[s.session] === id ? null : { focusBy: { ...s.focusBy, [s.session]: id } }); }
  openNote(id) {
    this.setState(st => {
      const s = st.session; let list = [...(st.openBy[s] || [])];
      if (!list.includes(id)) { list.push(id);  }
      return { openBy: { ...st.openBy, [s]: list }, focusBy: { ...st.focusBy, [s]: id } };
    });
  }
  removePane(id, cb) {
    this.setState(st => {
      const s = st.session, list = (st.openBy[s] || []).filter(x => x !== id);
      let f = st.focusBy[s]; if (f === id) f = list[list.length - 1] || null;
      return { openBy: { ...st.openBy, [s]: list }, focusBy: { ...st.focusBy, [s]: f }, editing: st.editing === id ? null : st.editing };
    }, cb);
  }
  closeNote(id) {
    const el = this.paneWrap.current && this.paneWrap.current.querySelector(`[data-pane="${id}"]`);
    if (!el || !this.motion()) return this.removePane(id);
    const a = el.animate([{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'scale(.95) translateY(8px)', filter: 'blur(10px)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    a.onfinish = () => this.removePane(id, () => a.cancel());
  }
  newNote(title, body) {
    const id = 'n' + Date.now();
    this.setState(st => {
      const s = st.session; let list = [...(st.openBy[s] || []), id]; if (list.length > 4) list.shift();
      return { notes: [{ id, s, t: 'Agora', title: title || '', body: body || '' }, ...st.notes], openBy: { ...st.openBy, [s]: list }, focusBy: { ...st.focusBy, [s]: id }, editing: id, view: 'session', tag: null };
    });
  }
  updateNote(id, patch) { this.setState(st => ({ notes: st.notes.map(n => n.id === id ? { ...n, ...patch, t: 'Agora' } : n) })); }
  toggleTodo(id, line) {
    this.setState(st => ({ notes: st.notes.map(n => { if (n.id !== id) return n; const L = n.body.split('\n'); L[line] = /^- \[x\]/.test(L[line]) ? L[line].replace('- [x]', '- [ ]') : L[line].replace('- [ ]', '- [x]'); return { ...n, body: L.join('\n') }; }) }));
  }
  openByTitle(t) { const n = this.activeNotes().find(x => x.title.toLowerCase() === t.toLowerCase()); if (n) this.openNote(n.id); else this.newNote(t); }
  addSession(gid) {
    const id = 's' + Date.now();
    this.setState(st => ({ groups: st.groups.map(g => g.id === gid ? { ...g, sessions: [...g.sessions, { id, name: 'Nova sessão' }] } : g), expanded: { ...st.expanded, [gid]: true }, openBy: { ...st.openBy, [id]: [] }, session: id, view: 'session', tag: null }));
  }
  renameSession(name) { this.setState(st => ({ groups: st.groups.map(g => ({ ...g, sessions: g.sessions.map(s => s.id === st.session ? { ...s, name } : s) })) })); }
  daily() {
    const title = new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
    this.setState(st => ({ session: 's1', view: 'session', tag: null, expanded: { ...st.expanded, g1: true } }), () => {
      const ex = this.activeNotes().find(n => n.title === title);
      if (ex) this.openNote(ex.id); else this.newNote(title, '## Intenção do dia\n- [ ] \n\n## Notas\n');
    });
  }

  blocksFor(note, onLink, onTag, exists) {
    return note.body.split('\n').map((raw, i) => {
      let type = 'p', text = raw, done = false;
      if (/^#\s/.test(raw)) { type = 'h1'; text = raw.slice(2); }
      else if (/^##\s/.test(raw)) { type = 'h2'; text = raw.replace(/^##\s/, ''); }
      else if (/^- \[( |x)\]/.test(raw)) { type = 'todo'; done = raw[3] === 'x'; text = raw.replace(/^- \[( |x)\]\s?/, ''); }
      else if (/^- /.test(raw)) { type = 'li'; text = raw.slice(2); }
      else if (!raw.trim()) type = 'gap';
      const segs = [];
      if (type !== 'gap') {
        const re = /\[\[([^\]]+)\]\]|#([A-Za-zÀ-ÿ][\wÀ-ÿ-]*)/g; let last = 0, m;
        while ((m = re.exec(text))) {
          if (m[2] !== undefined && m.index > 0 && !/\s/.test(text[m.index - 1])) continue;
          if (m.index > last) segs.push({ text: text.slice(last, m.index), isText: true });
          if (m[1] !== undefined) { const t = m[1], ex = exists(t); segs.push({ text: t, isLink: true, line: ex ? 'solid' : 'dashed', tip: ex ? 'Abrir ao lado' : 'Criar esta nota', onClick: e => { e.stopPropagation(); onLink(t); } }); }
          else { const t = m[2]; segs.push({ text: t, isTag: true, onClick: e => { e.stopPropagation(); onTag(t); } }); }
          last = re.lastIndex;
        }
        if (last < text.length) segs.push({ text: text.slice(last), isText: true });
      }
      const S = { h1: ['21px', 650, '10px', '-0.02em'], h2: ['16.5px', 620, '6px', '-0.01em'] }[type] || ['15px', 400, '0', '0'];
      return {
        fs: S[0], fw: S[1], mt: i === 0 ? '0' : S[2], ls: S[3], minH: type === 'gap' ? '10px' : '0',
        isTodo: type === 'todo', isBullet: type === 'li', done,
        color: done ? 'var(--ink-3)' : 'var(--ink)', deco: done ? 'line-through' : 'none',
        cbBorder: done ? 'var(--accent)' : 'var(--ink-3)', cbBg: done ? 'var(--accent)' : 'transparent',
        onToggle: e => { e.stopPropagation(); this.toggleTodo(note.id, i); }, segs
      };
    });
  }

  renderVals() {
    const st = { ...this.state, layout:["split","grid"].includes(this.state.noteDisplay)?"split":"focus", notes: this.activeNotes() }, dark = this.theme() === 'dark', a = ACCENTS[this.state.accent || this.props.accent] || ACCENTS['Azul'];
    const vars = { ...(dark ? DARK : LIGHT), '--accent': a.c, '--acc-ink': dark ? a.td : a.tl, '--acc-soft': rgba(a.c, dark ? .18 : .16), '--acc-soft-2': rgba(a.c, .3), '--acc-line': rgba(a.c, .55), '--on-accent': a.on, '--blur': (this.state.blur ?? this.props.blur ?? 28) + 'px' };
    const sMap = {}; st.groups.forEach(g => g.sessions.forEach(s => { sMap[s.id] = { ...s, g }; }));
    const cur = sMap[st.session] || Object.values(sMap)[0];
    const byId = Object.fromEntries(st.notes.map(n => [n.id, n]));
    const open = (st.openBy[st.session] || []).filter(id => byId[id]);
    const focusId = open.includes(st.focusBy[st.session]) ? st.focusBy[st.session] : open[open.length - 1];
    const exists = t => st.notes.some(n => n.title.toLowerCase() === t.toLowerCase());
    const onLink = t => this.openByTitle(t), onTag = t => this.setState({ view: 'tag', tag: t });
    const sel = on => on ? 'inset 0 0 0 999px var(--sel)' : 'none';
    const isWeb = this.props.frame === 'Web';

    const groups = st.groups.map(g => ({
      id: g.id, name: g.name, color: g.color, open: !!st.expanded[g.id], rot: st.expanded[g.id] ? '90deg' : '0deg',
      onToggle: () => this.setState(s => ({ expanded: { ...s.expanded, [g.id]: !s.expanded[g.id] } })),
      onAdd: e => { e.stopPropagation(); this.addSession(g.id); },
      sessions: g.sessions.map(s => { const on = st.view === 'session' && st.session === s.id; return { id:s.id, name: s.name, count: st.notes.filter(n => n.s === s.id).length, sel: sel(on), dot: on ? 'var(--accent)' : 'var(--ink-3)', weight: on ? 600 : 450, onSelect: () => this.selectSession(s.id) }; })
    }));
    const tagSet = []; st.notes.forEach(n => tagsOf(n.body,n.tags).forEach(t => { if (!tagSet.includes(t)) tagSet.push(t); }));
    const tags = tagSet.sort().map(t => ({ name: t, sel: sel(st.view === 'tag' && st.tag === t), onClick: () => this.setState({ view: 'tag', tag: t }) }));

    const src = st.view === 'all' ? st.notes : st.view === 'tag' ? st.notes.filter(n => tagsOf(n.body,n.tags).includes(st.tag)) : st.notes.filter(n => n.s === st.session);
    const list = src.map(n => {
      const where = st.view === 'session' ? (tagsOf(n.body,n.tags)[0] ? '#' + tagsOf(n.body,n.tags)[0] : '') : (sMap[n.s] ? sMap[n.s].name : '');
      return { id:n.id, title: n.title || 'Sem título', snippet: snippetOf(n.body) || 'Sem texto adicional', time: n.t, where, hasWhere: !!where, isOpen: open.includes(n.id), sel: sel(n.id === focusId), onOpen: () => this.openNote(n.id) };
    });
    const listTitle = st.view === 'all' ? 'Todas as notas' : st.view === 'tag' ? '#' + st.tag : cur.name;
    const listCrumb = st.view === 'all' ? 'Biblioteca' : st.view === 'tag' ? 'Tag' : cur.g.name;

    const visible = st.layout === 'focus' ? (focusId ? [focusId] : []) : open;
    const panes = visible.map(id => {
      const n = byId[id], s = sMap[n.s] || cur, editing = st.editing === id;
      const isF = id === focusId && visible.length > 1;
      const backlinks = n.title ? st.notes.filter(o => o.id !== id && o.body.toLowerCase().includes('[[' + n.title.toLowerCase() + ']]')) : [];
      const lc = (n.body.match(/\[\[[^\]]+\]\]/g) || []).length, words = n.body.split(/\s+/).filter(Boolean).length;
      return {
        id, note:n, imported:!!n.imported, attachments:n.attachments || [], title: n.title, gName: s.g.name, sName: s.name, gColor: s.g.color, maxW: st.layout === 'focus' ? '860px' : 'none',
        time: n.t === 'Agora' ? 'Editado agora' : 'Editado ' + n.t, words: words + (words === 1 ? ' palavra' : ' palavras'), links: lc === 1 ? '1 link' : lc + ' links',
        editing, reading: !editing, isEmpty: !editing && !n.body.trim(), body: n.body,
        blocks: n.body.trim() ? this.blocksFor(n, onLink, onTag, exists) : [],
        border: isF ? 'var(--line-strong)' : 'var(--line)', shadow: isF ? '0 0 0 4px var(--sel), var(--pane-shadow)' : 'var(--pane-shadow)',
        hasBacklinks: backlinks.length > 0, backlinks: backlinks.map(b => ({ title: b.title, onClick: e => { e.stopPropagation(); this.openNote(b.id); } })),
        onFocus: () => this.setFocus(id), onClose: e => { e.stopPropagation(); this.closeNote(id); },
        onExpand: e => { e.stopPropagation(); this.setState(s2 => ({ layout: s2.layout === 'focus' ? 'split' : 'focus', focusBy: { ...s2.focusBy, [s2.session]: id } })); },
        onEdit: () => this.setState({ editing: id }),
        onTitle: e => this.updateNote(id, { title: e.target.value }), onBody: e => this.updateNote(id, { body: e.target.value }),
        onBlur: () => this.setState(s2 => s2.editing === id ? { editing: null } : null)
      };
    });
    const tabs = open.map(id => { const on = id === focusId; return { id, title: byId[id].title || 'Sem título', bg: on ? 'var(--glass-strong)' : 'transparent', border: on ? 'var(--line)' : 'transparent', color: on ? 'var(--ink)' : 'var(--ink-2)', onFocus: () => this.setFocus(id), onClose: e => { e.stopPropagation(); this.closeNote(id); } }; });

    const q = st.pq.trim().toLowerCase();
    const sections = [];
    const pn = st.notes.filter(n => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)).slice(0, q ? 8 : 5)
      .map(n => ({ label: n.title || 'Sem título', sub: sMap[n.s] ? sMap[n.s].g.name + ' › ' + sMap[n.s].name : '', isNote: true, iconColor: 'var(--ink-2)', kbd: open.includes(n.id) ? 'aberta' : '', run: () => this.openNote(n.id) }));
    if (pn.length) sections.push([q ? 'Notas' : 'Recentes', pn]);
    if (q) {
      const ps = Object.values(sMap).filter(s => s.name.toLowerCase().includes(q) || s.g.name.toLowerCase().includes(q)).map(s => ({ label: s.name, sub: s.g.name, isSession: true, iconColor: s.g.color, run: () => this.selectSession(s.id) }));
      if (ps.length) sections.push(['Sessões', ps]);
    }
    const acts = [];
    const createAction = q && !exists(st.pq.trim()) ? { label: `Criar nota “${st.pq.trim()}”`, sub: 'em ' + cur.name, isAction: true, iconColor: 'var(--acc-ink)', kbd: '↵', run: () => this.newNote(st.pq.trim()) } : null;
    [{ label: 'Nova nota', sub: 'em ' + cur.name, kbd: 'Alt+N', run: () => this.newNote() },
     { label: 'Abrir nota do dia', run: () => this.daily() }, ...(this.extraCommands?.() || [])]
      .filter(x => !q || x.label.toLowerCase().includes(q)).forEach(x => acts.push({ ...x, isAction: true, iconColor: 'var(--acc-ink)' }));
    if(createAction) acts.push(createAction);
    if (acts.length) sections.push(['Ações', acts]);
    const items = sections.flatMap(s => s[1]);
    const psel = Math.min(st.psel, Math.max(items.length - 1, 0));
    const runItem = it => { this.setState({ palette: false, pq: '', psel: 0 }); it.run(); };
    let idx = 0; const pRows = [];
    sections.forEach(([h, its]) => {
      pRows.push({ isHeader: true, label: h });
      its.forEach(it => { const i = idx++; pRows.push({ ...it, isItem: true, hasSub: !!it.sub, hasKbd: !!it.kbd, isNote: !!it.isNote, isSession: !!it.isSession, isAction: !!it.isAction, sel: i === psel ? 'inset 0 0 0 999px var(--acc-soft)' : 'none', onClick: () => runItem(it), onHover: () => { if (this.state.psel !== i) this.setState({ psel: i }); } }); });
    });

    const sbW = st.w < 1100 ? 220 : 244, lsW = st.w < 1100 ? 264 : 300;
    return {
      vars, playState: this.motion() ? 'running' : 'paused', isWeb, isDesktop: !isWeb,
      urlPath: slug(cur.g.name) + '/' + slug(cur.name),
      cols: `${st.sidebar ? sbW : 0}px ${lsW}px minmax(0,1fr)`, sbClosed: !st.sidebar,
      toggleSidebar: () => this.setState(s => ({ sidebar: !s.sidebar })),
      winRef: this.winRef, listRef: this.listRef, paneWrap: this.paneWrap, pInput: this.pInput,
      openPalette: () => this.setState({ palette: true, pq: '', psel: 0 }),
      closePalette: () => this.setState({ palette: false }), stop: e => e.stopPropagation(),
      showAll: () => this.setState({ view: 'all', tag: null }), allSel: sel(st.view === 'all'), totalCount: st.notes.length,
      openDaily: () => this.daily(),
      groups, tags,
      themeX: dark ? '100%' : '0%', setLight: e => this.setTheme('light', e), setDark: e => this.setTheme('dark', e),
      crumbColor: st.view === 'session' ? cur.g.color : 'var(--ink-3)', listCrumb, listTitle, listRO: st.view !== 'session',
      onListTitle: e => this.renameSession(e.target.value),
      listCount: list.length === 1 ? '1 nota' : list.length + ' notas', list, listEmpty: list.length === 0,
      newNote: () => this.newNote(),
      tabs, panes, noPanes: panes.length === 0,
      layoutX: st.layout === 'focus' ? '100%' : '0%',
      setSplit: () => this.setState({ layout: 'split' }), setFocusMode: () => this.setState({ layout: 'focus' }),
      paletteOpen: st.palette, pq: st.pq, pRows, pEmpty: items.length === 0,
      onPq: e => this.setState({ pq: e.target.value, psel: 0 }),
      onPKey: e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.setState({ psel: Math.min(psel + 1, items.length - 1) }); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.setState({ psel: Math.max(psel - 1, 0) }); }
        else if (e.key === 'Enter' && items[psel]) { e.preventDefault(); runItem(items[psel]); }
      }
    };
  }
}
