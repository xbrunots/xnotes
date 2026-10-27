# Especificação de notes

notes organiza notas visuais, sessões e grupos em uma aplicação Windows com biblioteca local completa e sincronização opcional pelo GitHub. Este documento descreve o comportamento que deve ser preservado em contribuições e aponta verificações existentes no repositório.

[Visão geral](../README.md) · [Arquitetura](ARQUITETURA.md) · [Decisões](DECISOES.md)

## Escopo do produto

- Windows x64, distribuído exclusivamente como portable.
- Edição visual com TipTap, organização por grupos/sessões e blocos de código editáveis com Monaco.
- Armazenamento local com recuperação e anexos; importação de Notion/Obsidian, Markdown, texto e backups compatíveis.
- Sincronização manual ou diária por Git e GitHub CLI para uma biblioteca privada identificada pelo aplicativo.
- Interface própria com teclado, temas globais, presets por nota e diferentes formas de distribuir o espaço de trabalho.
- Busca central com modo de pesquisa e IA opcional por Codex CLI, Claude Code ou ACP v1 para criar, editar e organizar a biblioteca.

O produto não executa o código das notas, não oferece um editor de fonte Markdown e não fornece colaboração em tempo real. A edição e a busca continuam locais e independentes da IA; os pedidos à IA usam um CLI configurado pelo usuário, que pode consultar a nuvem do provedor. O [desenvolvimento assistido por IA](DESENVOLVIMENTO_COM_IA.md) possui documentação própria. Google Drive pertence ao legado de fontes/testes e é excluído do portable atual, conforme [package.json](../package.json).

## Requisitos funcionais e critérios de aceite

Os links abaixo apontam para testes que exercitam cenários relevantes. Esta matriz é uma forma de rastrear requisitos; não é um relatório de execução, cobertura percentual ou auditoria.

| ID | Requisito | Critério de aceite | Verificação existente |
| --- | --- | --- | --- |
| RF-01 | Editar visualmente | Cada nota aberta tem título e um editor visual; colar Markdown produz formatação. Não aparecem textarea de fonte ou preview duplicado. | [ui-smoke.cjs](../tests/ui-smoke.cjs), [layout-ui.cjs](../tests/layout-ui.cjs) |
| RF-02 | Preservar edição local | Autosaves em sequência conservam as teclas digitadas enquanto uma gravação anterior está pendente. `Ctrl+S` salva localmente; fechar aguarda o flush. | [renderer.test.cjs](../tests/renderer.test.cjs), [storage.test.cjs](../tests/storage.test.cjs), [ui-smoke.cjs](../tests/ui-smoke.cjs) |
| RF-03 | Manter corpo e documento rico coerentes | `richText` só é reutilizado quando sua fonte corresponde ao `body`. Mudanças remotas prevalecem sobre um documento rico antigo e não entram no Undo como edição do usuário. | [note-content.test.cjs](../tests/note-content.test.cjs), [editor-history.test.cjs](../tests/editor-history.test.cjs) |
| RF-04 | Editar blocos de código | Colagem reconhecida ou conversão da seleção cria `codeBlock` editável. Texto e linguagem persistem; TABs, indentação e linhas vazias sobrevivem à serialização. O menu oferece 84 linguagens locais, com busca. | [code-languages.test.cjs](../tests/code-languages.test.cjs), [editor-history.test.cjs](../tests/editor-history.test.cjs), [code-widget-ui.cjs](../tests/code-widget-ui.cjs) |
| RF-05 | Organizar sem perder dados | Reordenar e mover grupos, sessões, notas e abas conserva IDs quando aplicável, documentos, anexos e metadados. Duplicação cria IDs independentes. | [workspace-layout.test.cjs](../tests/workspace-layout.test.cjs), [context-actions.test.cjs](../tests/context-actions.test.cjs) |
| RF-06 | Excluir com recuperação | Excluir grupo/sessão envia suas notas à lixeira e preserva anexos. Deve existir uma sessão válida para restaurar o conteúdo, inclusive ao excluir o último grupo/sessão. | [context-actions.test.cjs](../tests/context-actions.test.cjs) |
| RF-07 | Compor o espaço de trabalho | Padrão e Ilha funcionam com Uma nota, Lado a lado e Grid. Abrir a quinta nota não fecha abas antigas. Grid usa alturas naturais e rolagem vertical, com respiro nas bordas e sem faixa vazia sob referências. | [layout-ui.cjs](../tests/layout-ui.cjs), [advanced-workspace-ui.cjs](../tests/advanced-workspace-ui.cjs), [github-ui.cjs](../tests/github-ui.cjs), [masonry-layout.test.cjs](../tests/masonry-layout.test.cjs) |
| RF-08 | Redimensionar com persistência | Arraste e teclado alteram dimensões; o gesto pode ser cancelado. O valor concluído persiste, encolher a janela não apaga preferências e recalcular o mosaico não altera conteúdo. | [panel-sizing.test.cjs](../tests/panel-sizing.test.cjs), [panel-preferences.test.cjs](../tests/panel-preferences.test.cjs), [advanced-workspace-ui.cjs](../tests/advanced-workspace-ui.cjs) |
| RF-09 | Personalizar a interface | Configurações oferecem exatamente dez temas: cinco escuros e cinco claros, incluindo Obsidiana e Carbono. A escolha persiste e participa das preferências sincronizadas. | [themes.test.cjs](../tests/themes.test.cjs), [ui-smoke.cjs](../tests/ui-smoke.cjs), [portable-smoke.cjs](../tests/portable-smoke.cjs) |
| RF-10 | Aplicar estilo por nota | Exatamente 20 presets definem fundo, texto, bordas e controles. Somente o ID é salvo. O popover abre na bolinha da nota, responde ao teclado, fecha com Escape/clique fora e acompanha cópias e sync. | [note-themes.test.cjs](../tests/note-themes.test.cjs), [context-actions.test.cjs](../tests/context-actions.test.cjs), [github-ui.cjs](../tests/github-ui.cjs) |
| RF-11 | Importar preservando origem | Notion e Obsidian aceitam pasta/ZIP, preservam originais e anexos, convertem conteúdo compatível e mantêm hierarquia/links. Entradas inválidas falham antes de aplicar alterações ao workspace. | [importers.test.cjs](../tests/importers.test.cjs), [ui-smoke.cjs](../tests/ui-smoke.cjs) |
| RF-12 | Exportar e restaurar | Backup ZIP inclui notas, lixeira e bytes de anexos; restauração funciona em outro perfil. Nota pode ser exportada em Markdown. Exportação deve aguardar o salvamento pendente. | [backups.test.cjs](../tests/backups.test.cjs), [context-actions.test.cjs](../tests/context-actions.test.cjs), [ui-smoke.cjs](../tests/ui-smoke.cjs) |
| RF-13 | Conectar GitHub por ação explícita | Primeira abertura apresenta onboarding. Antes do clique não instala ferramentas nem faz login. Conectar reutiliza/prepara ferramentas oficiais verificadas e cria/adota apenas biblioteca privada compatível com marcador. | [github-tools.test.cjs](../tests/github-tools.test.cjs), [github-sync-onboarding.test.cjs](../tests/github-sync-onboarding.test.cjs), [github-ui.cjs](../tests/github-ui.cjs) |
| RF-14 | Controlar o envio | Botão e `Ctrl+Shift+S` sincronizam após flush local. Edição, importação, foco, `Ctrl+S` e fechamento não enviam. Rotina automática respeita o prazo diário persistido. | [github-sync.test.cjs](../tests/github-sync.test.cjs), [ui-smoke.cjs](../tests/ui-smoke.cjs) |
| RF-15 | Combinar versões com decisão explícita | Alterações compatíveis se combinam; conflitos incompatíveis abrem diff Local/GitHub. Escolhas obsoletas são recusadas. Falha no push ou interrupção conserva snapshots/stash, sem force-push ou reset destrutivo. | [github-sync.test.cjs](../tests/github-sync.test.cjs), [github-sync-storage.test.cjs](../tests/github-sync-storage.test.cjs), [github-ui.cjs](../tests/github-ui.cjs) |
| RF-16 | Agendar com ownership | Tarefa por usuário chama `--sync-only` com sessão Windows logada e menor privilégio. Registro/removal só altera tarefa reconhecida como própria. Falhas de agendamento ficam visíveis sem bloquear notas locais. | [github-scheduler.test.cjs](../tests/github-scheduler.test.cjs) |
| RF-17 | Usar controles próprios | Menus, seletores, toggles, sliders e checkboxes têm aparência do projeto e semântica/teclado adequados. Botões de criação usam +, tooltip e nome acessível; a barra Windows preserva controles e funções nativas. | [ui-smoke.cjs](../tests/ui-smoke.cjs), [context-menu-ui.cjs](../tests/context-menu-ui.cjs), [portable-smoke.cjs](../tests/portable-smoke.cjs) |

## Migração conectada do Notion

| ID | Requisito | Critério de aceite | Verificação |
| --- | --- | --- | --- |
| RF-18 | Conectar sem token manual | Login oficial OAuth com PKCE e cliente público; a abertura do diálogo não inicia leitura ou autorização. | [notion-client.test.cjs](../tests/notion-client.test.cjs), [notion-migration-ui.cjs](../tests/notion-migration-ui.cjs) |
| RF-19 | Conferir cobertura antes de importar | Inventário enumera raízes e descendentes, registra limites e não afirma completude de todo o workspace. Lacunas tornam explícita a importação do conteúdo encontrado. | [notion-migration.test.cjs](../tests/notion-migration.test.cjs), [notion-migration-ui.cjs](../tests/notion-migration-ui.cjs) |
| RF-20 | Retomar sem duplicar o mesmo plano | Interromper preserva o plano privado. Aplicar requer comando explícito; repetir um plano já salvo reconhece `notionMigrationId`. | [notion-migration.test.cjs](../tests/notion-migration.test.cjs), [notion-migration-ui.cjs](../tests/notion-migration-ui.cjs) |
| RF-21 | Preservar a alternativa por exportação | ZIPs HTML e Markdown/CSV passam pelo importador existente; relatório abre páginas e tabelas, que persistem após recarregar. | [importers.test.cjs](../tests/importers.test.cjs), [notion-import-ui.cjs](../tests/notion-import-ui.cjs) |

O [contrato completo da migração](IMPORTACAO_NOTION.md) descreve escopo, arquivos privados e limitações do provedor. Os testes de autenticação usam transporte controlado, sem login real.

## IA local por CLI/ACP

| ID | Requisito | Critério de aceite | Verificação |
| --- | --- | --- | --- |
| RF-22 | Unificar busca e IA | Campo central na barra da janela e Ctrl+K abrem modos Buscar/Pedir à IA; busca mantém notas, grupos, sessões e comandos com navegação por teclado. | [ai-ui.cjs](../tests/ai-ui.cjs), [renderer.test.cjs](../tests/renderer.test.cjs) |
| RF-23 | Configurar provedor no dispositivo | Engrenagem da busca abre diretamente a seção IA. Provedor, agente/modo, esforço e opções avançadas persistem localmente, fora do snapshot Git. Montar a interface não chama o modelo. | [ai-ui.cjs](../tests/ai-ui.cjs), [ai-runtime.test.cjs](../tests/ai-runtime.test.cjs), [renderer.test.cjs](../tests/renderer.test.cjs) |
| RF-24 | Usar CLI/ACP explicitamente | Seção IA descobre catálogos de modelos sem prompt/login; consulta usa o formulário atual sem salvá-lo. Lista pesquisável fica na área principal e esforços acompanham as capacidades do modelo. Execução usa stdin, JSON ou ACP v1, processo sem shell, opções confirmadas e cancelamento do processo próprio. | [ai-runtime.test.cjs](../tests/ai-runtime.test.cjs), [ai-ui.cjs](../tests/ai-ui.cjs) |
| RF-25 | Operar a biblioteca por contrato | Criar/editar grupos e sessões, criar/editar/acrescentar/duplicar/mover/abrir notas, ajustar tags/fixação e enviar/restaurar notas da lixeira usam somente ações tipadas válidas. | [ai-workspace.test.cjs](../tests/ai-workspace.test.cjs), [ai-ui.cjs](../tests/ai-ui.cjs) |
| RF-26 | Aplicar com integridade | Lote completo é validado; alteração de corpo exige leitura, invalida documento rico antigo e conserva anexos. Guarda de versão na fila recusa respostas obsoletas sem sobrescrever edições. | [ai-workspace.test.cjs](../tests/ai-workspace.test.cjs), [storage.test.cjs](../tests/storage.test.cjs), [ai-ui.cjs](../tests/ai-ui.cjs) |
| RF-27 | Mostrar e reverter o resultado | Progresso, cancelar, resposta e alterações são visíveis. Desfazer reverte o último lote em memória, preserva edições independentes e recusa entidades modificadas depois. | [ai-workspace.test.cjs](../tests/ai-workspace.test.cjs), [ai-ui.cjs](../tests/ai-ui.cjs) |

O [contrato de IA local](IA_LOCAL.md) define o contexto enviado, as ações e os limites. A integração reaproveita autenticação existente; QA usa processos/provedores sintéticos sem modelos reais. Executar um CLI no dispositivo não garante inferência offline nem cria uma sandbox do sistema operacional para um agente ACP escolhido pelo usuário.

## Requisitos de integridade e isolamento

| ID | Contrato | Evidência no código e nos testes |
| --- | --- | --- |
| RI-01 | Snapshot e revisões inválidos ou acima dos limites não podem gerar uma gravação parcial. | [storage.cjs](../desktop/storage.cjs), [storage.test.cjs](../tests/storage.test.cjs) |
| RI-02 | Checkpoint corrompido tenta recuperação com cópias/journal, preserva evidências e nunca é silenciosamente trocado pelo seed quando irrecuperável. | [storage.cjs](../desktop/storage.cjs), [storage.test.cjs](../tests/storage.test.cjs) |
| RI-03 | Recebimento concorrente não pode ser apagado por autosave baseado em um snapshot antigo; exclusões não podem ressuscitar por revisões dominadas. | [storage.test.cjs](../tests/storage.test.cjs), [github-sync-storage.test.cjs](../tests/github-sync-storage.test.cjs) |
| RI-04 | Anexos devem manter os mesmos bytes e falhar explicitamente em caso de corrupção/ausência. Chunks remotos são validados antes de aplicar notas dependentes. | [assets.test.cjs](../tests/assets.test.cjs), [github-sync.test.cjs](../tests/github-sync.test.cjs) |
| RI-05 | Caminhos hostis, symlinks/junctions, submódulos e árvores Git incompatíveis devem ser recusados sem substituir conteúdo válido. | [importers.test.cjs](../tests/importers.test.cjs), [github-sync-onboarding.test.cjs](../tests/github-sync-onboarding.test.cjs) |
| RI-06 | Tokens não entram no renderer, biblioteca ou mensagens de erro. Login em armazenamento de texto puro não pode ser aceito como login seguro. | [github-tools.cjs](../desktop/github-tools.cjs), [github-tools.test.cjs](../tests/github-tools.test.cjs) |
| RI-07 | Renderer não acessa Node diretamente nem rede pelo conteúdo; scripts/workers são locais e IPC verifica origem. | [main.cjs](../desktop/main.cjs), [preload.cjs](../desktop/preload.cjs), [index.html](../src/index.html) |
| RI-08 | Cancelamento encerra operações/processos pertencentes à instância e permite nova tentativa sem reutilizar resultado obsoleto. | [github-tools.test.cjs](../tests/github-tools.test.cjs), [github-sync-cancel.test.cjs](../tests/github-sync-cancel.test.cjs) |
| RI-09 | A autorização Notion exige proteção do sistema operacional e só permite ferramentas de leitura. O bearer não pode ser encaminhado a hosts de anexos. | [notion-client.cjs](../desktop/notion-client.cjs), [notion-client.test.cjs](../tests/notion-client.test.cjs), [notion-migration.test.cjs](../tests/notion-migration.test.cjs) |
| RI-10 | IA não recebe uma API genérica de shell ou um snapshot para substituir a biblioteca; ações desconhecidas, campos inválidos, leituras ausentes e limites excedidos são recusados antes da aplicação. | [ai-workspace.cjs](../desktop/ai-workspace.cjs), [ai-workspace.test.cjs](../tests/ai-workspace.test.cjs) |
| RI-11 | Preferências e autenticação de IA não entram nas revisões da biblioteca; os CLIs usam processos próprios, saída limitada e diagnóstico sem conteúdo bruto de stderr. QA bloqueia CLIs reais sem injeção controlada. | [ai-runtime.cjs](../desktop/ai-runtime.cjs), [ai-runtime.test.cjs](../tests/ai-runtime.test.cjs), [renderer.test.cjs](../tests/renderer.test.cjs) |

Revisões e anexos usam hashes para integridade; isso não equivale a criptografia da biblioteca. A arquitetura e os limites de tamanho estão descritos em [ARQUITETURA.md](ARQUITETURA.md).

## Como verificar uma mudança

Os comandos oficiais estão em [package.json](../package.json). Escolha primeiro os testes relacionados ao comportamento alterado; use a suíte completa em marcos de integração.

| Comando | O que exercita |
| --- | --- |
| `npm test` | Arquivos `tests/*.test.cjs`: unidades, contratos, integração de armazenamento e sincronização, incluindo regressões legadas. |
| `npm run test:ui` | Fluxos de edição e importação no Electron real. |
| `npm run test:layout` | Geometria, organização e layouts. |
| `npm run test:workspace` | Abas, redimensionamento, persistência e mosaico. |
| `npm run test:github-ui` | Onboarding, presets e comparação de conflitos no Electron. |
| `npm run test:code-ui` | Colagem, edição, linguagens e persistência de widgets Monaco. |
| `npm run test:notion-ui` | Importação ZIP e migração conectada com respostas sintéticas, cancelamento, retomada e lacunas de cobertura. |
| `npm run test:ai-ui` | Busca central, configurações e ações de IA no Electron com provedor sintético, persistência e desfazer. |
| `node tests/context-menu-ui.cjs` | Menus de contexto reais de notas, grupos e sessões. |
| `npm run dist` | Compila recursos locais e produz o portable Windows x64. |
| `npm run test:portable` | Abre o executável final com perfil temporário, exercita ações e reinicia para verificar persistência. |

QA deve usar perfis temporários e remotos Git bare locais. Não usar dados reais, instalar ferramentas, autenticar conta, criar repositório GitHub ou registrar tarefa Windows real durante os testes. Os testes de ferramentas/agendador usam dependências controladas; os testes de Git usam Git real com remotos locais. Essa separação permite reproduzir falhas sem operar a conta pessoal.

Os testes de interface verificam cenários específicos; eles não certificam toda a acessibilidade, todos os estados do sistema operacional ou a disponibilidade de serviços externos. Relatórios de validação devem registrar comando, resultado e commit/artefato efetivamente exercitados, sem extrapolar a presença destes arquivos de teste.

## Aceite de uma entrega portable

1. Executar as verificações pertinentes e corrigir falhas relacionadas à mudança.
2. Executar `npm run dist`, somente para Windows x64 portable.
3. Executar `npm run test:portable` sobre o novo artefato.
4. Entregar `portable/notes-1.0.0-Windows-x64-portable.exe` para a versão atual de [package.json](../package.json), com caminho absoluto e evidência da validação realizada.

`portable/win-unpacked/notes.exe` é um intermediário e não substitui o portable final. Um executável antigo ou somente uma configuração de CI também não satisfaz esse aceite. Se a versão mudar, o nome do artefato acompanha `artifactName` em `package.json`.
