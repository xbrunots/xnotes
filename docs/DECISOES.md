# Decisões de engenharia de notes

Este registro explica escolhas presentes no código e suas consequências para manutenção. É uma documentação retrospectiva da implementação inspecionável, sem atribuir datas, autores, experimentos ou conversas de IA que não estejam comprovados no repositório.

[Visão geral](../README.md) · [Arquitetura](ARQUITETURA.md) · [Especificação](ESPECIFICACAO.md)

## D-01 · Separar interface e operações privilegiadas

**Decisão atual.** React roda em um renderer Electron com sandbox, isolamento de contexto e sem integração Node. Um preload expõe operações nomeadas em `window.notes`; o processo principal verifica a origem IPC e executa disco, rede, diálogos, clipboard e controles de janela.

**Consequências.** A interface não precisa receber um acesso genérico ao filesystem ou uma API de comandos arbitrários. Uma funcionalidade nova que atravesse essa fronteira exige contrato explícito no preload e validação no handler. A CSP restringe rede e recursos do renderer; não substitui validação no processo principal.

**Evidência.** [main.cjs](../desktop/main.cjs), [preload.cjs](../desktop/preload.cjs), [index.html](../src/index.html).

## D-02 · Versionar entidades em um journal imutável

**Decisão atual.** O snapshot da interface é decomposto em notas, grupos, sessões e preferências individuais. Revisões têm hash de conteúdo, relógio vetorial e tombstone; um checkpoint reúne as versões atuais. Gravações são serializadas e reconhecidas após persistência.

**Consequências.** Preferências e entidades independentes podem convergir sem sobrescrever o workspace inteiro. Relógios vetoriais detectam concorrência sem exigir relógios de parede sincronizados. O histórico e os tombstones têm custo de armazenamento; mudanças de formato precisam preservar a leitura e a recuperação desses registros. Hashes detectam alteração de conteúdo e não criptografam os dados.

**Evidência.** [storage.cjs](../desktop/storage.cjs), [storage.test.cjs](../tests/storage.test.cjs), [github-sync-storage.test.cjs](../tests/github-sync-storage.test.cjs).

## D-03 · Preservar Markdown e documento visual coerentes

**Decisão atual.** A nota persiste `body` e pode persistir `richText: { version, source, doc }`. O documento rico só vale se a fonte coincide exatamente com o corpo; caso contrário, o corpo é a referência para reconstruir o editor. Conteúdo inicial/remoto é aplicado fora do histórico de Undo.

**Consequências.** Exportações, importações e versões que alteram apenas Markdown continuam interoperáveis, enquanto o documento rico conserva formatação visual adicional. Há duas representações para manter coerentes; qualquer edição que altere o corpo deve atualizar a fonte associada ou aceitar o fallback. Undo permanece dedicado a ações locais em vez de ressuscitar uma versão remota antiga.

**Evidência.** [note-content.js](../src/note-content.js), [rich-editor.jsx](../src/rich-editor.jsx), [editor-content.js](../src/editor-content.js), [editor-history.test.cjs](../tests/editor-history.test.cjs).

## D-04 · Separar salvar localmente de enviar ao GitHub

**Decisão atual.** Autosave e `Ctrl+S` persistem localmente. A exportação para `notes-repository` também é local. Rede usa um comando explícito ou o prazo diário persistido; GitHub CLI autentica e Git transporta a biblioteca privada. O fluxo Google Drive foi substituído e seus módulos específicos são excluídos do pacote.

**Consequências.** Uma edição não depende da internet e não dispara upload. Um segundo dispositivo pode não ver a última alteração até uma sincronização; notas pendentes precisam continuar visíveis no estado da conexão. A disponibilidade do GitHub e o agendamento Windows afetam o transporte, não o contrato de escrita local. Testes legados de Drive não comprovam o fluxo atual.

**Evidência.** [notes.jsx](../src/notes.jsx), [github-sync.cjs](../desktop/github-sync.cjs), [github-sync.test.cjs](../tests/github-sync.test.cjs), [package.json](../package.json).

## D-05 · Adotar somente bibliotecas reconhecidas e ferramentas verificadas

**Decisão atual.** O onboarding procura um repositório privado com marcador de formato/identidade compatível. Repositórios públicos, não marcados e colisões são preservados. Git/GitHub CLI oficiais podem ser preparados de forma portátil após validação de tamanho e SHA-256. O CLI gerencia o login no cofre do Windows; fallback em texto puro é recusado.

**Consequências.** Um nome coincidente não basta para autorizar adoção ou sobrescrita. As ferramentas não exigem um cliente OAuth próprio nem instalação administrativa. Versões e hashes fixados exigem manutenção deliberada quando os downloads forem atualizados; indisponibilidade do cofre deve resultar em erro real. Os dados pessoais da biblioteca não devem acompanhar fixtures, documentação ou distribuição do código.

**Evidência.** [github-tools.cjs](../desktop/github-tools.cjs), [github-sync.cjs](../desktop/github-sync.cjs), [github-tools.test.cjs](../tests/github-tools.test.cjs), [github-sync-onboarding.test.cjs](../tests/github-sync-onboarding.test.cjs).

## D-06 · Combinar conteúdo explicitamente e preservar recuperação

**Decisão atual.** O motor planeja merges de campos e textos, pede decisão nos conflitos incompatíveis e verifica se a comparação ainda é atual. O fluxo preserva snapshots e stash antes de modificar a árvore, registra operações interrompidas e usa push normal. O merge Git registra ancestralidade; a árvore final vem do plano de conteúdo validado.

**Consequências.** Uma rejeição de push ou interrupção pode pedir nova tentativa/revisão em vez de descartar uma versão. Decisões de conflito deixam de valer se o usuário ou o remoto avançar durante a comparação. Arquivos de recuperação consomem espaço e são parte do mecanismo de segurança dos dados; removê-los indiscriminadamente prejudica a retomada. Contribuições não devem introduzir force-push, reset destrutivo ou aceitação silenciosa de comparação obsoleta.

**Evidência.** [github-merge.cjs](../desktop/github-merge.cjs), [github-sync.cjs](../desktop/github-sync.cjs), [github-sync.test.cjs](../tests/github-sync.test.cjs), [github-sync-storage.test.cjs](../tests/github-sync-storage.test.cjs).

## D-07 · Tratar arquivos externos como dados

**Decisão atual.** Anexos são armazenados por SHA-256; o repositório usa chunks de 32 MiB e manifests verificados. Importadores preservam originais e validam caminhos, limites e estrutura antes de aplicar o snapshot. Scripts e plugins importados permanecem anexos inertes. Monaco e seus workers são distribuídos localmente e editam código sem executá-lo.

**Consequências.** Importação e sincronização podem recuperar bytes originais e reconhecer corrupção. Importar não instala plugins de um cofre externo. Hash de integridade não equivale a análise de malware; exportar e abrir um arquivo em outro programa fica fora da execução do editor. Alterar serialização de código exige verificar TABs, linhas vazias, entidades, blocos aninhados e linguagem.

**Evidência.** [assets.cjs](../desktop/assets.cjs), [github-repo.cjs](../desktop/github-repo.cjs), [importers.cjs](../desktop/importers.cjs), [monaco-setup.js](../src/monaco-setup.js), [code-serialization.js](../src/code-serialization.js), [importers.test.cjs](../tests/importers.test.cjs), [code-widget-ui.cjs](../tests/code-widget-ui.cjs).

## D-08 · Manter personalização por presets e composição independente

**Decisão atual.** Dez temas globais e vinte estilos por nota usam catálogos de tokens visuais. A nota guarda o ID de seu preset. Aparência Padrão/Ilha e exibição Uma nota/Lado a lado/Grid são preferências independentes; tamanhos salvos são limitados e normalizados sem reescrever o conteúdo.

**Consequências.** Fundo, texto, bordas, controles e Monaco permanecem coerentes ao compartilhar uma nota. Não existe cor livre por nota para persistir. Alterações nos catálogos devem preservar IDs e verificar contraste; mudanças de layout devem conservar documentos, abas e preferências mesmo em janelas menores. Controles próprios também precisam manter teclado, foco e nomes acessíveis.

**Evidência.** [themes.js](../src/themes.js), [note-themes.js](../src/note-themes.js), [panel-sizing.js](../src/panel-sizing.js), [themes.test.cjs](../tests/themes.test.cjs), [note-themes.test.cjs](../tests/note-themes.test.cjs), [panel-preferences.test.cjs](../tests/panel-preferences.test.cjs), [advanced-workspace-ui.cjs](../tests/advanced-workspace-ui.cjs).

## D-09 · Distribuir portable Windows x64 e validar o artefato final

**Decisão atual.** O build reúne recursos locais e gera somente portable Windows x64 em `portable/`. O executável final difere do intermediário `win-unpacked`. QA usa perfis temporários e remotos Git bare locais; dependências de instalação, login e agendamento são controladas nos testes.

**Consequências.** A entrega deve incluir geração e validação do novo portable, não apenas sucesso no código-fonte. Permissão de escrita e localização do executável influenciam dados e ownership da tarefa Windows. O escopo atual não garante execução em Linux/macOS, instalador ou registro real de login/tarefa durante QA. Resultados precisam identificar o artefato efetivamente testado.

**Evidência.** [package.json](../package.json), [package-portable.cjs](../scripts/package-portable.cjs), [portable-smoke.cjs](../tests/portable-smoke.cjs), [github-test.cjs](../desktop/github-test.cjs), [github-scheduler.test.cjs](../tests/github-scheduler.test.cjs).

## D-10 · Preservar a referência visual no gerador

**Decisão atual.** `Notas.html` é a referência de composição, tipografia e materiais. [import-reference.cjs](../scripts/import-reference.cjs) gera a base `src/reference-*`, recursos e `desktop/seed.json`; a implementação funcional é estendida por `src/notes.jsx` e módulos dedicados. A janela usa controles Windows integrados, sem a moldura externa e os controles Mac da referência.

**Consequências.** Ajustes em material gerado precisam ser feitos no gerador para sobreviver à próxima importação. A regeneração deve ser revisada como mudança de código e conteúdo inicial, sem misturar dados reais. A base visual não elimina a necessidade de verificar geometria, foco, acessibilidade e recursos Windows no Electron real.

**Evidência.** [Notas.html](../Notas.html), [import-reference.cjs](../scripts/import-reference.cjs), [notes.jsx](../src/notes.jsx), [main.cjs](../desktop/main.cjs), [layout-ui.cjs](../tests/layout-ui.cjs).

## D-11 · Conferir a migração antes de aplicar

**Decisão atual.** A conexão Notion usa o MCP oficial com OAuth/PKCE para cliente nativo público. Ferramentas de leitura alimentam um plano privado retomável; o usuário confere contagens, escopo e pendências antes da aplicação pelo armazenamento existente. ZIP e pasta continuam disponíveis como alternativa e complemento.

**Consequências.** Não é necessário um backend do autor nem token copiado manualmente. Permissões, cotas e respostas incompletas do provedor precisam aparecer como lacunas; uma conexão não autoriza afirmar que todo o workspace foi recebido. Repetir a aplicação do mesmo plano usa um marcador persistido, enquanto uma nova verificação cria outra migração. Credenciais dependem da proteção do sistema operacional e ficam fora da biblioteca sincronizada.

**Evidência.** [Guia e contrato da migração](IMPORTACAO_NOTION.md), [notion-client.test.cjs](../tests/notion-client.test.cjs), [notion-migration.test.cjs](../tests/notion-migration.test.cjs), [notion-migration-ui.cjs](../tests/notion-migration-ui.cjs).

## Como evoluir estas decisões

Uma contribuição que altere uma decisão deve explicar o comportamento antes/depois, a migração de dados quando aplicável, as consequências e os testes executados. Atualize este registro junto com o código e os critérios da [especificação](ESPECIFICACAO.md). Propostas futuras não são compromissos de roadmap; a implementação e as evidências determinam o estado descrito aqui.
