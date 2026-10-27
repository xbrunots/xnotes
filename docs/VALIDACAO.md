# Validação de notes — Windows x64

## Atualização — ícones dos menus

O glifo de texto que parecia uma letra foi substituído por um indicador triangular preenchido em SVG de 14 × 14 px nos botões Aa e de linguagem do Monaco. O indicador acompanha as cores do tema e inverte ao abrir o menu. Os nomes acessíveis e as ações dos botões foram preservados.

- `node --test tests/editor-history.test.cjs tests/code-languages.test.cjs`: **12/12 passaram**.
- `node tests/code-widget-ui.cjs`: **passou** no Electron real, incluindo abertura do seletor de linguagens, edição e persistência. A seleção parcial do teste agora usa duplo clique real e preserva também o espaço final selecionado pelo Windows.
- `npm run dist` e `npm run test:portable`: **passaram**; 50 verificações no novo EXE, com perfil temporário. Renderer, estilos, HTML e cinco workers conferidos no ASAR.
- A validação do portable desta atualização está registrada em Portable final.

## Atualização — popover de cor e código Monaco

A cor da nota agora é escolhida pela bolinha no canto superior direito, revelada no hover e no foco por teclado. O botão reflete o estilo atual e abre um popover com os 20 presets, sem modal/backdrop. Escape, clique fora, teclado, reset e encaixe nas bordas foram exercitados nas seis combinações Padrão/Ilha × Uma nota/Lado a lado/Grid, incluindo 1024 × 720.

Código reconhecido ao colar, blocos importados e seleções convertidas usam Monaco editável. O menu direito próprio oferece 84 linguagens locais com busca, cópia, seleção, conversão para texto e exclusão. Código e linguagem persistem; cores herdam cada nota simultaneamente. O comando separado de alto contraste do Monaco foi excluído, sem escolha própria de cores. Cinco workers e os recursos do editor são locais, com CSP restrita ao próprio aplicativo e sem execução de código.

- **166/166 testes unitários passaram** na rodada atual, para todos os `*.test.cjs` exceto `github-*.test.cjs`. Os testes do backend GitHub estão registrados no marco anterior abaixo; esse backend não foi alterado nesta atualização.
- `npm run test:code-ui`: **passou** no Electron real. Colagem, edição, Undo/Redo, menu direito, 84 linguagens, cópia exata, herança de cores entre notas, conversão de seleção parcial preservando texto ao redor, recebimento remoto e reinício. Workers TypeScript/editor foram efetivamente carregados pelo protocolo local.
- `npm run test:github-ui`: **passou** com o novo botão/popover. Hover, foco, fechamento, navegação por teclado, 20 estilos e persistência/sincronização permanecem funcionais.
- `npm run test:ui`: **passou** após integrar Monaco, preservando edição visual, formatação, menus, temas e importação com anexos recebidos por outro perfil.
- Revisão independente do código: **aprovada**. Além de 17 testes dirigidos, 36 round-trips preservaram TABs, linhas vazias, CRLF e entidades literais em listas/citações; entradas malformadas foram recusadas. Código aninhado usa serialização inerte com decoder restrito, sem payload duplicado. Código com crases internas também é preservado. Cópia e diff não interpretam sintaxe de links de notas dentro de código.
- `npm audit --omit=dev --json`: **zero vulnerabilidades reportadas**. DOMPurify fixado em 3.4.17. O pacote fonte do Monaco não é duplicado no ASAR; o renderer e os workers compilados são suficientes.
- `npm run test:portable`: **50 verificações passaram**, incluindo a criação real de um widget no EXE, linguagem TypeScript, herança da cor Pêssego e preservação após fechar e reabrir. A inspeção do ASAR confirmou os cinco workers e a correspondência do renderer/CSS/HTML com o build validado.

Ambiente de QA: Windows x64, `notes://app/index.html`, Electron real/Playwright, perfis temporários. Browser plugin not available; foi utilizado o fluxo Electron do próprio projeto. Evidências adicionais: `notes-monaco.png`, `notes-monaco-widget.png` e `portable-code.png` na pasta de QA já indicada abaixo.

## Escopo desta entrega

O Google Drive foi substituído por GitHub. A primeira abertura apresenta o onboarding; Conectar GitHub prepara Git e GitHub CLI portáteis oficiais, solicita autorização no navegador quando necessária e cria/adota um repositório privado reconhecido pelo notes. A biblioteca fica em `notes-repository` ao lado do portable; ferramentas e cache ficam fora do repositório.

Cada nota oferece exatamente 20 estilos fixos no grid **Cor e tema da nota**, acessível pela bolinha no topo direito e pelo botão direito. O estilo combina fundo, texto, links, bordas e controles, persiste no documento e acompanha cópias e sincronização. Não há seletor de cor livre. Os dez temas globais continuam nas Configurações.

O Grid mantém 12 px nas bordas em janelas amplas e 9 px abaixo de 1100 px, iguais aos intervalos entre cartões. Cartões com referências terminam no rodapé, sem faixa vazia abaixo dele. Em Padrão, o rodapé permanece transparente e sem divisória. Grupos, sessões e lista mostram a navegação; cada nota aberta tem um único editor visual.

## Marco anterior — migração GitHub e 20 estilos

- Testes unitários anteriores e da paleta: **156/156 passaram**, executados com `node --test` para os arquivos `*.test.cjs` exceto `github-*.test.cjs`. Incluem armazenamento, importações Notion/Obsidian, anexos, backups, editor, organização, dimensões e contraste dos 20 estilos. Testes legados de Drive continuam no código-fonte como regressão, mas seus módulos são excluídos do aplicativo distribuído.
- GitHub Tools e Scheduler: **25/25 passaram** — 16 casos de ferramentas e nove de agendamento. Downloads oficiais, checksums, extração segura, cancelamento reutilizável, cofre de credenciais, identidade e ownership das tarefas são exercitados com respostas e processos isolados.
- Motor GitHub: **28/28 passaram** — rodada consolidada de 27 testes e regressão adicional de retomada após stash com revisões reexportadas. São 15 casos com Git real e 13 de armazenamento, cancelamento e onboarding. O total unitário desta entrega é **209 casos aprovados**, somando os três grupos, sem conta GitHub real.
- `npm run test:ui`: **passou** no Electron real. Edição visual, colagem de Markdown, popover, dez temas, controles próprios, menus de contexto e importação Obsidian pelo seletor real. Um segundo perfil recebeu a nota e os mesmos bytes do anexo pelo Git. Editar, importar, focar e Ctrl+S não provocaram upload.
- `npm run test:layout`: **passou**. Editores distintos sem duplicação, arraste real de abas, notas, sessões e grupos, geometria Padrão/Ilha e janela 1024 × 720 sem overflow global.
- `npm run test:workspace`: **passou**. Oito abas abertas, redimensionamento de painéis e notas, persistência, cancelamento, teclado, mosaico com texto/imagem e janela menor.
- `npm run test:github-ui`: **passou**. Onboarding sem efeitos antes do clique, 20 fundos efetivamente distintos, cores iguais em Uma nota/Lado a lado/Grid, persistência e propagação entre dois perfis. Um conflito real abriu o diff Local/GitHub; a escolha foi versionada e propagada preservando o tema. O texto do diff não exibe sintaxe Markdown. A geometria do rodapé foi medida com folga inferior de no máximo 1 px.
- Revisão crítica independente: **aprovada**, sem achado concreto pendente. Foram corrigidas e reproduzidas regressões de relógios restaurados, interrupções entre stash/merge/gravação, origem alternativa de push, atributos Git que transformavam anexos e edição externa concorrente. A revisão também recuperou o perfil temporário que antes bloqueava ao reaplicar um stash.
- `npm run dist`: **passou**, gerando somente portable Windows x64. Inspeção do ASAR confirmou ausência dos módulos Drive/Google e identidade dos oito módulos principais GitHub/armazenamento com o código-fonte validado.
- `npm run test:portable`: **43 verificações passaram** no novo EXE. Primeira abertura GitHub, 20 estilos, persistência da cor Pêssego após reiniciar, editor visual, formatação, menus, importação Notion, dimensões, Grid, respiros e rodapé sem espaço inferior. O teste usou um perfil temporário.

As esperas de IPC aguardam resultados assíncronos com polling em Node. Os testes de interface usam Playwright no Electron real. Perfis temporários e remotos Git bare isolados mantêm `portable/notes-data` fora de QA.

## Sincronização e recuperação

O botão GitHub e Ctrl+Shift+S verificam ferramentas/conta e executam recebimento, merge, commit e push normal. A rotina automática respeita 24 horas após o último sucesso, com prazo persistido. A tarefa Windows por usuário chama `--sync-only` em segundo plano enquanto a sessão Windows estiver logada. Falhas reais de agendamento aparecem na interface. Edição, importação, foco e fechamento não iniciam upload; Ctrl+S salva localmente.

Arquivos remotos novos são recebidos automaticamente. Alterações compatíveis são mescladas; conflitos reais pedem uma decisão Local/GitHub/ambas, conforme o tipo de dado. A decisão é recusada se os dados mudarem durante a comparação. Revisões, anexos, arquivos externos e snapshots de recuperação são preservados em interrupções. Não se usa force-push, reset destrutivo ou descarte automático de versões.

A validação cobre duas bibliotecas com Git real: sincronização, convergência, conflitos, versões obsoletas, anexos fragmentados, arquivos arbitrários, cancelamento e recuperação de falhas. Credenciais não são enviadas ao renderer nem versionadas. O protocolo de arquivos local é habilitado apenas por fixture com `NOTES_TEST=1`; a produção aceita GitHub HTTPS e verifica a origem de fetch e push.

**Limite da validação:** login no GitHub, download/instalação das ferramentas e registro de tarefa Windows reais não foram executados na conta do usuário. Esses fluxos foram verificados com fixtures; transporte, commits, merge, push/pull e recuperação usam Git real com remotos locais. A autorização da conta continua sendo feita pelo usuário no navegador. Nenhum cliente OAuth próprio ou token manual é exigido.

Referências oficiais: [login do GitHub CLI](https://cli.github.com/manual/gh_auth_login), [criação de repositórios](https://cli.github.com/manual/gh_repo_create) e [limites de arquivos](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).

## Referência e evidências

`Notas.html` permaneceu intacto. SHA-256: `30ed9250b734f16aa109a033ec38e73debb88f829dc68bae6f352af65d60e2ea`. Fontes e recursos são locais. As mudanças de composição correspondem às solicitações do usuário. O editor continua visual, sem textarea ou alternância para código Markdown e sem widgets padrão do navegador.

Evidências em `F:/Users/xbrun/AppData/Local/Temp/notes-qa/`:

- `notes-note-palette.png` e `notes-note-colors.png`: os 20 estilos e notas coloridas.
- `notes-github.png` e `notes-github-diff.png`: onboarding e comparação real entre Local/GitHub.
- `notes-advanced-grid.png` e `notes-advanced-small.png`: mosaico, ilhas e redimensionamento.
- `notes-grid-spacing-wide.png`, `notes-grid-spacing-small.png`, `notes-grid-spacing-standard.png` e `grid-spacing-metrics.json`: medidas dos respiros no Grid.
- `notes-layout-standard.png`, `notes-layout-islands.png` e `notes-layout-split.png`: aparências e editores distintos.
- `notes-selection-popover.png`, `notes-custom-controls.png`, `notes-imported.png` e `notes-context-menu.png`: edição, controles, importação e menus.
- `portable-running.png`, `portable-grid.png` e `portable-validation.json`: execução e evidência do portable final.

## Portable final

- Arquivo: `C:/Projects/xNodex/portable/notes-1.0.0-Windows-x64-portable.exe`.
- Tamanho: **137401188 bytes**.
- SHA-256: `9ecb73153849bf41fb51e330b937920d62d0994eb67313196f4b13efcafb1a9e`.
- Validação do executável: **2026-10-27T19:04:23.938Z** — 50 verificações aprovadas.
- Somente portable; nenhum instalador foi gerado.
- As pastas existentes `portable/notes-data`, `portable/notes-repository` e `portable/notes-tools` foram preservadas e não participaram dos testes. Intermediários são movidos para a pasta temporária do Windows após a validação.
