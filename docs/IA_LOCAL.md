# IA local no notes

Crie, edite e organize sua biblioteca com um CLI instalado no computador. A busca central reúne **Buscar** e **Pedir à IA**, sem exigir um serviço do autor ou alterar seu login no provedor.

[Guia de uso](GUIA.md) · [Arquitetura](ARQUITETURA.md) · [Especificação](ESPECIFICACAO.md) · [Desenvolvimento](DESENVOLVIMENTO.md)

## Começar

1. Clique no campo de busca no centro da barra da janela ou pressione **Ctrl+K**.
2. Clique na **engrenagem** da busca. As Configurações abrem diretamente na seção **Inteligência artificial**.
3. Escolha **Codex CLI**, **Claude Code** ou **Agente ACP**. Use um CLI que já esteja instalado e autenticado fora do notes.
4. Em **Configuração avançada**, informe o executável se ele não for encontrado automaticamente. Para ACP, informe também os argumentos exigidos pelo agente, **um argumento por linha**.
5. Clique em **Salvar IA**, depois em **Detectar CLIs**. A detecção usa as configurações salvas; no ACP, ela consulta as opções anunciadas pelo agente.
6. Escolha agente/modo, esforço e, se necessário, modelo; salve novamente.
7. Volte à busca, selecione **Pedir à IA**, escreva seu pedido e pressione **Enter**.

Abrir a busca ou as configurações não inicia uma consulta ao modelo. **Detectar CLIs** consulta a versão dos CLIs nativos; para ACP, inicia a negociação e cria uma sessão sem enviar um pedido ao modelo nem iniciar autenticação. O notes não instala, atualiza ou autentica esses provedores.

No modo **Buscar**, digite para encontrar notas, grupos, sessões e comandos; use as setas e Enter para abrir um resultado. Trocar para **Pedir à IA** permite criar conteúdo ou alterar a organização. O aplicativo mostra progresso, resposta e as alterações efetivamente aplicadas.

## Configuração por provedor

| Campo | Codex CLI | Claude Code | Agente ACP |
| --- | --- | --- | --- |
| Provedor | Adaptador `codex exec` com resposta JSON. | Adaptador não interativo com resposta JSON. | Processo compatível com **ACP v1**, por JSON-RPC em stdio. |
| Agente | Agente padrão; o campo fica desabilitado. | Padrão ou identificador de agente configurado no CLI. | Agente/modo anunciado pela sessão. |
| Esforço | Opções oferecidas pelo adaptador; o CLI e o modelo precisam aceitá-las. | Opções oferecidas pelo adaptador; o CLI e o modelo precisam aceitá-las. | Opções anunciadas pelo agente. |
| Modelo | Opcional; vazio usa o padrão do provedor. | Opcional; vazio usa o padrão do provedor. | Opcional; um valor explícito precisa ter sido anunciado pelo agente. |
| Executável | Binário nativo detectado ou caminho informado. | Binário nativo detectado ou caminho informado. | Executável informado, com argumentos separados. |

**Padrão do provedor** evita forçar uma opção específica. A disponibilidade de modelos, agentes e níveis de esforço depende da versão do CLI, da conta e do modelo; detectar um executável não comprova acesso a todos eles. Se uma opção ACP não for anunciada, o notes recusa o pedido em vez de fingir que ela foi aplicada.

O campo de executável aceita um programa, não uma linha de shell. Para um agente ACP em JavaScript, por exemplo, use `node.exe` como executável e o caminho do script como um argumento separado. Não use wrappers `.cmd`, `.bat`, `.ps1` ou `.sh`, nem cole senhas, tokens ou chaves nos argumentos. Configure a autenticação no próprio CLI.

As preferências ficam em **`notes-data/ai/settings.json`**, ou na pasta de perfil usada pelo aplicativo. Elas pertencem ao dispositivo e ficam fora do workspace, do backup da biblioteca e do repositório Git sincronizado. O notes reutiliza a autenticação existente do CLI; não copia seus tokens para a interface.

## Pedidos que você pode fazer

Use nomes claros e descreva o destino ou o conteúdo desejado. Exemplos com dados fictícios:

- “Crie o grupo Estudos, com uma sessão Leitura e uma nota chamada Plano da semana.”
- “Resuma a nota aberta em cinco tópicos, preservando os links.”
- “Acrescente uma seção Próximos passos à nota Planejamento.”
- “Mova a nota Ideias para a sessão Rascunhos e adicione a tag pesquisa.”
- “Renomeie a sessão Referências para Biblioteca e mova-a para Estudos.”
- “Duplique a nota Checklist, fixe a cópia e abra-a.”
- “Envie a nota Experimento à lixeira.”

Ações válidas são aplicadas e salvas **localmente** ao concluir o pedido. Não há uma etapa de aprovação por ação. A resposta lista o que mudou; o botão **Desfazer alterações** reverte o último lote da IA enquanto o aplicativo permanece aberto. Ele recusa a reversão se uma nota ou estrutura afetada tiver mudado depois, preservando suas edições.

Enviar notas, sessões ou grupos à lixeira preserva as notas e seus anexos em uma sessão válida. A IA também pode restaurar notas; a integração não oferece exclusão permanente. **Cancelar** interrompe a consulta em andamento e encerra os processos criados por aquela operação. Uma gravação local já iniciada é concluída pelo armazenamento; o desfazer trata um lote já aplicado.

Salvar pela IA segue a mesma política do editor: não dispara upload ao GitHub. O envio continua manual ou pelo prazo diário configurado. A consulta ao modelo é uma operação distinta da sincronização da biblioteca.

## Contexto e privacidade

**Local** descreve a execução do CLI no seu computador. A inferência pode acontecer na nuvem do provedor escolhido. Um agente configurado para um modelo local pode ter outro comportamento de rede; o notes não transforma um serviço remoto em inferência offline.

O contexto enviado contém a hierarquia de grupos/sessões, os títulos e metadados das notas, a nota focada e os corpos de até seis notas com correspondência ao pedido. Se faltar conteúdo, a IA pode pedir a leitura de notas pelo ID antes de continuar. O notes não inclui os bytes dos anexos no contexto.

Para pedidos de seguimento, o aplicativo mantém até seis turnos recentes em memória, com trechos limitados do pedido e da resposta. **Limpar resposta** apaga esse contexto de conversa; o registro do último lote para desfazer é independente. A conversa também desaparece ao encerrar o aplicativo.

O notes mantém pedido e resposta na memória da interface; não grava um histórico próprio de conversa. Os adaptadores nativos usam sessão efêmera/no-session-persistence, e o contexto segue por stdin. O diretório de trabalho é temporário, sem apontar para o perfil da biblioteca ou para seu clone Git; arquivos auxiliares, como o schema JSON, ficam nesse diretório. O histórico que um agente ACP mantenha por conta própria depende dele.

Os adaptadores nativos desabilitam ferramentas e integrações para solicitar apenas uma resposta estruturada. No ACP, o cliente anuncia que não fornece arquivos nem terminal, nega pedidos de ferramentas/permissão e não envia servidores MCP. Isso delimita as capacidades oferecidas pelo **cliente notes**. O executável ACP continua sendo um programa local escolhido por você, com as permissões do seu usuário; essa integração não cria uma sandbox do sistema operacional.

## Contrato da integração

| Camada | Responsabilidade | Código |
| --- | --- | --- |
| Busca e configurações | Modos de busca/IA, seleção acessível, progresso, cancelamento e desfazer. | [ai-ui.jsx](../src/ai-ui.jsx), [notes.jsx](../src/notes.jsx) |
| Ponte desktop | Operações nomeadas e origem IPC validada, sem API de shell genérica. | [preload.cjs](../desktop/preload.cjs), [main.cjs](../desktop/main.cjs) |
| Transporte local | Preferências do dispositivo, detecção, processos sem shell, CLI JSON e ACP v1. | [ai-runtime.cjs](../desktop/ai-runtime.cjs) |
| Operações da biblioteca | Contexto, schema, validação das ações, controle de concorrência e desfazer. | [ai-workspace.cjs](../desktop/ai-workspace.cjs) |
| Persistência | Gravação serializada, validação do snapshot, revisões e recuperação. | [storage.cjs](../desktop/storage.cjs) |

A resposta estruturada possui **`message`**, **`readNotes`** e **`actions`**. Uma rodada solicita leitura ou devolve ações, sem misturar os dois. IDs vêm do manifesto; criações podem definir uma referência temporária, como `new:estudos`, utilizada por ações seguintes do mesmo lote. Campos não utilizados são `null` no schema enviado ao provedor.

| Ações aceitas | Efeito |
| --- | --- |
| `create_group`, `update_group`, `trash_group` | Criar, renomear/alterar cor ou remover um grupo preservando suas notas na lixeira. |
| `create_session`, `update_session`, `trash_session` | Criar, renomear/mover ou remover uma sessão preservando suas notas na lixeira. |
| `create_note`, `update_note`, `append_note` | Criar, alterar título/corpo/tags/fixação ou acrescentar texto. Um resumo é conteúdo produzido por essas ações. |
| `duplicate_note`, `move_note`, `open_note` | Duplicar com metadados e anexos, mover entre sessões ou abrir uma nota. |
| `trash_note`, `restore_note` | Enviar à lixeira ou restaurar uma nota. |

O modelo não devolve um snapshot completo, caminhos de anexos, comandos de sistema ou código executável. Ações desconhecidas e campos fora do contrato são recusados. Substituir ou acrescentar corpo exige que a nota existente tenha sido lida; mudar o corpo invalida o documento rico antigo para que ele não esconda o texto recebido. Outros metadados e anexos são preservados.

Antes de gravar, a aplicação valida o lote e confere se as entidades usadas ainda correspondem à base da consulta. A guarda é verificada novamente dentro da fila de persistência. Alterações incompatíveis durante a resposta resultam em erro explícito, sem sobrescrever a edição nova. O lote completo precisa ser válido antes de gerar uma gravação.

## Limites de execução

| Recurso | Limite atual |
| --- | --- |
| Pedido | 16.000 caracteres. |
| Ações em uma resposta | 100. |
| Corpo fornecido por ação | 200.000 caracteres. |
| Conteúdos reunidos no contexto | 420.000 caracteres. |
| Contexto JSON serializado | 800.000 caracteres. |
| Histórico de seguimento | Até seis turnos em memória, com 4.000 caracteres por pedido e 6.000 por resposta. |
| Manifesto da biblioteca | 10.000 notas, incluindo lixeira. |
| Leitura adicional | Até 12 IDs por rodada, em até quatro rodadas totais. |
| Consulta ao processo | Cinco minutos por execução do transporte. |
| Saída do processo | 8 MiB, contando stdout e stderr. |

Limites excedidos, resposta inválida, cancelamento e falha do provedor geram erro sem aplicar ações daquela resposta. Para pedidos grandes, divida o trabalho em etapas. Saída de diagnóstico bruta do CLI não é encaminhada à interface nem persistida pelo adaptador.

## Validação reproduzível

```powershell
node --test tests/ai-runtime.test.cjs tests/ai-workspace.test.cjs tests/renderer.test.cjs
npm run test:ai-ui
```

[Testes de runtime](../tests/ai-runtime.test.cjs) usam processos controlados para verificar argumentos, JSON/ACP, configurações, cancelamento e limites. [Testes do workspace](../tests/ai-workspace.test.cjs) verificam ações tipadas, leituras, lixeira, integridade e proteção contra edições concorrentes. [Testes do renderer](../tests/renderer.test.cjs) incluem a fronteira de preferências locais. A [suíte Electron](../tests/ai-ui.cjs) exercita a busca, o atalho de configurações e operações da biblioteca com provedor sintético.

QA usa perfis temporários e bloqueia CLIs reais sem um adaptador de teste explícito. Não faz login, instala provedores nem envia notas para modelos reais. A existência desses testes descreve o contrato; os resultados efetivamente executados e o portable validado ficam em [Validação](VALIDACAO.md).

## Referências dos adaptadores

O Codex usa a configuração documentada de esforço e os controles do CLI; consulte a [referência oficial de configuração](https://learn.chatgpt.com/docs/config-file/config-reference). O Claude Code oferece execução não interativa, saída estruturada e seleção de agente/modelo/esforço na [referência oficial do CLI](https://code.claude.com/docs/en/cli-reference). Para ACP, o notes usa as opções anunciadas pela sessão e sua confirmação ao alterá-las, conforme [Session Config Options — ACP v1](https://agentclientprotocol.com/protocol/v1/session-config-options).

As referências descrevem os provedores; os arquivos e testes deste repositório definem o subconjunto implementado pelo notes. Versões incompatíveis precisam ser ajustadas no CLI/configuração, sem fallback silencioso para execução irrestrita.

Projeto de **[Bruno Brito](https://brunobrito.org)** · **[LinkedIn](https://www.linkedin.com/in/brunosbrito/)**.
