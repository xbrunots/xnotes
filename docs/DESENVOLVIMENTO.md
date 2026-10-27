# Desenvolver e validar o notes

O ambiente de referência é **Windows x64, Node.js 24, npm e Git**. O aplicativo usa Electron e não precisa de um servidor web de desenvolvimento. O código atual e a distribuição são orientados a Windows; não há artefato Linux ou macOS validado neste projeto.

## Preparar o ambiente

```powershell
git clone https://github.com/xbrunots/xnotes.git notes
cd notes
npm ci
npm start
```

`npm start` compila a interface e abre o Electron. Isso é uma execução normal do aplicativo: a biblioteca local de desenvolvimento fica em `%APPDATA%/notes`. Para QA e capturas, use os comandos isolados descritos abaixo.

Se o download inicial do Electron tiver sido bloqueado pelo gerenciador, rode `node node_modules/electron/install.js` após corrigir o bloqueio de rede. Não são necessários login GitHub, tokens ou cadastro OAuth para compilar ou executar testes.

`npm run dev` recompila `src/` quando os arquivos mudam. O watcher recompila os arquivos; recarregue a janela para observar a nova interface.

## Mapa do repositório

| Caminho | Responsabilidade |
| --- | --- |
| [src/](../src/) | Interface React, editor visual, código, temas e layout. |
| [desktop/](../desktop/) | Processo principal, preload, dados, anexos, backup, importação e GitHub. |
| [scripts/](../scripts/) | Build, importação da referência, ícones, capturas e verificações documentais. |
| [tests/](../tests/) | Testes de lógica, integrações e automação Electron/portable. |
| [docs/](./) | Guias, contratos, decisões e evidências. |
| [build/](../build/) | Logo aprovado e ícones de distribuição. |
| `app/` | Interface compilada e workers locais; gerado e ignorado pelo Git. |
| `portable/` | Artefatos e dados locais da distribuição; ignorado pelo Git. |

Leia [AGENTS.md](../AGENTS.md) antes de alterar a interface. A importação de [Notas.html](../Notas.html) é implementada em [scripts/import-reference.cjs](../scripts/import-reference.cjs); corrija o gerador para mudanças na referência importada. Extensões funcionais ficam em `src/notes.jsx` e componentes associados.

## Escolher as verificações

| Comando | Escopo |
| --- | --- |
| `npm run docs:check` | Links e recursos locais da documentação; não consulta serviços externos. |
| `npm test` | Testes `*.test.cjs`: dados, conteúdo, merge, anexos, imports, backups, temas e ferramentas. |
| `npm run test:ui` | Electron real: edição, controles, importação e sync com remoto local. |
| `npm run test:layout` | Aparências, abas, drag-and-drop e geometria em diferentes larguras. |
| `npm run test:workspace` | Painéis, redimensionamento, persistência e mosaico. |
| `npm run test:github-ui` | Onboarding, estilos de nota, comparação de conflitos e propagação entre perfis. |
| `npm run test:code-ui` | Colagem, Monaco, linguagens, histórico, persistência e workers locais. |
| `npm run test:notion-ui` | ZIP HTML/Markdown e migração conectada com MCP sintético, retomada, pendências e persistência no Electron. |
| `npm run test:ai-ui` | Busca central, configuração de IA e ações da biblioteca no Electron com provedor sintético, sem CLI/modelo real. |
| `npm run dist` | Compila e gera somente o portable Windows x64. |
| `npm run test:portable` | Executa o EXE final, verifica operações reais e reabre o mesmo perfil temporário. |
| `npm run docs:screenshots` | Compila e captura dois temas no Electron com conteúdo fictício. |

Cada `test:*ui`, `test:layout` e `test:workspace` recompila a interface conforme o script correspondente. Rode os comandos de UI **sequencialmente**: eles usam janelas, foco e clipboard do desktop.

Para uma entrega completa, execute:

```powershell
npm run docs:check
npm test
npm run test:ui
npm run test:layout
npm run test:workspace
npm run test:github-ui
npm run test:code-ui
npm run test:notion-ui
npm run test:ai-ui
npm run dist
npm run test:portable
```

## Isolamento de QA

Os testes criam perfis temporários com `NOTES_TEST=1` e `NOTES_TEST_DATA_DIR` definido explicitamente. O aplicativo recusa QA sem essa pasta; não recorre à biblioteca real. As integrações usam Git real contra remotos bare locais. Ferramentas, conta GitHub e tarefas agendadas são simuladas nas suas fronteiras.

Não use bibliotecas pessoais como fixtures. Durante QA, não faça login, não instale ferramentas Git/CLI pelo onboarding, não crie repositórios GitHub e não registre tarefas Windows reais. Para validar uma mudança nessas integrações, use os adaptadores e cenários existentes.

Para IA, [ai-runtime.test.cjs](../tests/ai-runtime.test.cjs) injeta processos controlados e [ai-workspace.test.cjs](../tests/ai-workspace.test.cjs) usa respostas estruturadas sintéticas. O modo de teste bloqueia CLIs reais sem injeção explícita. [ai-ui.cjs](../tests/ai-ui.cjs) verifica a integração no Electron com um provedor fictício, sem usar login existente ou consultar um modelo. Não use um agente real para tornar um teste de UI dependente de conta, rede ou cobrança. O guia [IA local](IA_LOCAL.md) documenta configuração e contrato.

Evidências de UI e do portable ficam em `%TEMP%/notes-qa` por padrão. Alguns testes aceitam `NOTES_QA_DIR`; o teste do portable usa a pasta padrão. Perfis temporários podem ser retidos para diagnóstico. Não publique esses diretórios inteiros: selecione somente evidências revisadas e sem caminhos ou dados privados.

## Capturas públicas

```powershell
npm run docs:screenshots
```

O [script](../scripts/capture-showcase.cjs) abre um perfil novo e usa notas fictícias definidas no próprio arquivo. As capturas `docs/assets/notes-dark.png` e `notes-light.png` mostram a interface real. Revise visualmente os PNGs antes de versioná-los. O banner [cover.svg](assets/cover.svg) é uma ilustração editorial; os PNGs são capturas do produto.

## Gerar a entrega portable

```powershell
npm run dist
npm run test:portable
Get-FileHash -Algorithm SHA256 -LiteralPath portable/notes-1.0.0-Windows-x64-portable.exe
```

O pipeline usa `electron-builder --win portable --x64`. **Não gera instalador.** O arquivo de entrega é `portable/notes-1.0.0-Windows-x64-portable.exe`; `portable/win-unpacked/notes.exe` é intermediário.

Não apague `notes-data`, `notes-repository` ou `notes-tools` para limpar um build. Essas pastas podem conter a biblioteca e a configuração do usuário. Não inclua nenhuma delas em um release. Distribua somente o EXE, checksum e os documentos/avisos necessários.

Atualize [VALIDACAO.md](VALIDACAO.md) com comandos efetivamente executados, resultado, data e hash do novo EXE. Não apresente um artefato anterior como uma nova entrega.

## Integração contínua

O [workflow Windows](../.github/workflows/windows.yml) instala as dependências, verifica documentação e testes, executa as suítes Electron em sequência e gera/testa o portable. O upload do artefato ocorre após sucesso, usando caminhos explícitos para o EXE e o checksum. O workflow não publica um release nem exige uma conta GitHub conectada ao aplicativo.

O workflow é uma configuração versionada. Consulte [Actions](https://github.com/xbrunots/xnotes/actions) para verificar resultados remotos reais. A validação local registrada em `VALIDACAO.md` é uma evidência separada.
