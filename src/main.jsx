import './monaco-setup';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Notes} from './notes';
import './assets/reference.css';
import './desktop.css';
import './themes.css';
import './rich-editor.css';
import './code-widget.css';
import './context-menu.css';
import './workspace.css';
import './workspace-layout.css';
import './resizable-panels.css';
import './masonry-workspace.css';
import './note-themes.css';
import './github-ui.css';

async function start() {
  const initial = await window.notes.bootstrap();
  createRoot(document.getElementById('root')).render(<Notes {...initial} theme="Escuro" accent="Azul" blur={28} motion={true} frame="Desktop"/>);
}
start().catch(error=>{
  const message = document.createElement('p');
  message.style.cssText='color:#F3F2F7;font:15px system-ui;padding:40px';
  message.textContent='Não foi possível carregar as notas: '+error.message+'. Seus arquivos foram preservados.';
  document.getElementById('root').append(message);
});
