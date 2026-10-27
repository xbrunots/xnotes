# notes

- A marca é **notes**, sempre sem prefixo. Use esse nome na interface, documentação, arquivos e executável. O monograma X foi pedido separadamente e permanece.
- Nunca exiba widgets padrão do navegador. Listas de opções, seletores, toggles, sliders e checkboxes devem ser componentes próprios, totalmente estilizados e acessíveis por teclado. Campos de texto e botões também devem ter aparência definida pelo projeto.

Leia este arquivo antes de alterar o projeto.

- A referência visual é `Notas.html`. Preserve as fontes, cores, transparências e composição internas. O usuário pediu explicitamente retirar o card externo e todos os controles de Mac.
- Use janela Windows com barra customizada integrada e controles Windows; preserve arrastar, redimensionar, minimizar, maximizar/restaurar, fechar, Snap e menus.
- O logo aprovado pela implementação é o X tipográfico em `build/logo-original.png`. Os derivados são `build/icon.ico` e `src/assets/{icon.png,favicon.ico,logo.png}`.
- Indicadores de abertura de menu usam SVG, sem glifos como ⌄ que parecem letras. Nos controles Aa e de linguagem do Monaco, use a seta preenchida de 14 px, invertida ao abrir.
- **Gere somente portable Windows x64, nunca instalador.** A pasta de entrega obrigatória é `portable/` na raiz. Execute `npm run dist` e `npm run test:portable` após as verificações pertinentes. Entregue o caminho absoluto do portable novo validado.
- Não confunda `portable/win-unpacked/notes.exe` com o portable final `portable/notes-1.0.0-Windows-x64-portable.exe`.
- Dados reais não entram em testes. Use perfis temporários e remotos Git bare locais. Nunca instale ferramentas, faça login, crie repositórios ou tarefas Windows reais durante QA.
- A sincronização atual usa Git e GitHub CLI, com repositório privado notes-library reconhecido por marcador e clone notes-repository na raiz portable. O Drive foi substituído. Cache local completo, sincronização a cada 24 horas ou pelo botão; nunca envie ao digitar, importar, focar ou fechar. Ctrl+S salva localmente; Ctrl+Shift+S sincroniza.
- O onboarding aparece na primeira abertura e um clique em Conectar prepara Git/CLI oficiais, abre login no navegador e cria/adota a biblioteca privada. Instalações portáteis ficam em notes-tools, com SHA-256 verificado e sem admin. Tokens ficam no cofre do Windows, fora do repo/renderer. Não peça OAuth próprio ou JSON.
- A tarefa Windows por usuário chama --sync-only em segundo plano, com sessão Windows logada. Ela verifica o prazo sem enviar mais de uma vez por dia automaticamente. Preserve ownership da tarefa e mostre falhas reais de agendamento.
- Faça pull, merge compatível, commit e push normal. Nunca force-push, reset destrutivo ou descarte versões. Conflitos de notas/arquivos abrem diff Local/GitHub com decisão e guarda contra comparações obsoletas. Interrupções preservam snapshots/stash até sucesso confirmado.
- `scripts/import-reference.cjs` gera `src/reference-*` e `desktop/seed.json` a partir de `Notas.html`. Faça ajustes de importação no gerador; extensões funcionais ficam em `src/notes.jsx`.
- `npm test` valida armazenamento, conflitos, ZIPs, importações, anexos, backups e autosave. `npm run test:ui` valida o Electron real em perfis temporários. Não entregue com teste pertinente falhando.
- Nunca sobrescreva silenciosamente dados ilegíveis ou conflitos. Preserve cópias e faça erro explícito antes de gravar uma importação inválida.

## Temas, edição e cartões — direção atual do usuário

- Ofereça exatamente cinco temas escuros e cinco claros, incluindo Obsidiana e Carbono fortemente escuros. A escolha de tema participa das preferências sincronizadas.
- Além dos temas globais, cada nota aceita exatamente 20 estilos fixos no grid Cor e tema da nota. Cada estilo define fundo, texto, bordas e controles em conjunto. Não ofereça cor livre; salve apenas o ID do preset na nota e preserve-o em cópias e sync.
- A paleta da nota abre em popover ancorado na bolinha do canto superior direito, visível no hover e no foco por teclado. A bolinha reflete a cor atual. Não use modal nem backdrop para essa escolha; mantenha o popover dentro da janela, com Escape e clique fora para fechar.
- Código reconhecido ao colar ou convertido a partir da seleção vira widget Monaco editável, com linguagem e texto persistidos no codeBlock. O menu direito próprio oferece 84 linguagens com busca. Cores herdam o tema global/da nota e não têm seletor próprio. Monaco e workers são locais/offline; não execute o código. Preserve indentação, TABs e linhas vazias também na exportação/reimportação e no recebimento remoto. Undo/Redo participa do histórico do editor.
- A edição é sempre visual. Não ofereça textarea de Markdown, modo código ou alternância entre fonte e preview. Colar Markdown deve produzir conteúdo formatado; selecionar texto abre ferramentas próprias de estilo.
- O minimalismo pedido aplica-se aos cartões das notas. Preserve grupos, sessões e lista de navegação. A lista exibe títulos sem repetir o corpo; cada nota aberta tem título e um único editor visual, sem preview duplicado.
- Ofereça aparência Padrão e Ilha independentemente da exibição Uma nota, Lado a lado ou Grid em mosaico. Grid tem alturas naturais e rolagem vertical. Não feche abas antigas automaticamente ao abrir a quinta nota.
- O mosaico mantém respiro no topo, nas laterais e no fim da rolagem, com o mesmo espaçamento dos intervalos entre cartões. Não zere esse padding no modo Ilha.
- Quando um cartão do Grid tem rodapé de referências, o cartão termina no rodapé, sem faixa vazia abaixo dele.
- No modo Ilha, a moldura da área de notas inclui as abas e começa na mesma altura dos painéis vizinhos. No Padrão, o rodapé de referências é transparente, sem divisórias ou bordas.
- Barra lateral, lista, notas lado a lado/Grid e divisão grupos/tags têm redimensionamento por arraste e teclado. Salve as dimensões ao concluir o gesto, preserve preferências ao encolher a janela e não altere conteúdo dos editores ao reorganizar o mosaico.
- A escolha de tema fica apenas nas Configurações, sem seletor Claro/Escuro na barra lateral.
- Todo botão de criação usa o ícone +. Mantenha tooltip e nome acessível para indicar o que será criado.
- Gere o corpo visual apenas no contêiner de rolagem do conteúdo. O antigo cabeçalho também possui `p.editing`; não use essa expressão isolada para identificar o contêiner, pois isso monta a mesma nota duas vezes.
- Menus de contexto de notas, grupos e sessões são customizados, com ações reais. Exclusão de grupo/sessão preserva notas e anexos na lixeira com uma sessão válida.
- Conteúdo inicial/remoto não entra no histórico de Undo. Preserve o corpo compatível e o documento rico associado; se o corpo remoto mudou, um documento rico antigo nunca pode escondê-lo.
