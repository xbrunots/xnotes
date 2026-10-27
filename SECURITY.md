# Segurança do notes

O notes é um aplicativo desktop com arquivos locais, importação, IA opcional por CLI/ACP e sincronização opcional por GitHub. Este documento descreve o canal de relato e os limites relevantes para quem usa ou contribui.

## Relatar uma vulnerabilidade

Use [Report a vulnerability](https://github.com/xbrunots/xnotes/security/advisories/new) se o canal privado do GitHub estiver habilitado. Se estiver indisponível, contate [Bruno Brito pelo LinkedIn](https://www.linkedin.com/in/brunosbrito/) e peça um canal privado antes de enviar detalhes sensíveis.

Envie versão, cenário, impacto e um exemplo mínimo com dados fictícios. Não publique tokens, notas pessoais, arquivos privados ou um exploit que exponha outros usuários. Não há programa de recompensa nem prazo garantido de correção.

## Manutenção

A investigação parte do estado atual do código e da versão mais recente distribuída. Não há política de backport ou suporte de longo prazo para versões anteriores. O registro de testes não representa auditoria externa ou certificação de segurança.

## Fronteiras de proteção

- O renderer executa sem Node, com `contextIsolation` e sandbox. Operações de sistema passam pelo preload e pelo processo principal.
- Conteúdo, fontes e workers são locais. A CSP do renderer restringe conexões; o processo principal realiza as operações de rede necessárias ao GitHub, Notion e às ferramentas.
- As credenciais de conexão ficam no cofre do Windows. Não devem entrar no renderer, nos backups ou no repositório da biblioteca.
- O repositório de sincronização precisa ser privado e reconhecido pelo marcador do notes. **Não há criptografia ponta a ponta implementada**; privacidade do repositório e criptografia são propriedades diferentes.
- Notas e anexos ficam em arquivos no dispositivo. O notes não substitui controle de acesso do Windows, criptografia do disco ou backup independente.
- Importações e arquivos ZIP têm validações e limites. Plugins e scripts importados são preservados como arquivos inertes; não são executados como plugins do notes.
- Blocos Monaco são conteúdo editável, sem execução de código.
- O cliente Notion usa OAuth com PKCE e ferramentas MCP de leitura. Credenciais cifradas pelo sistema operacional e planos privados ficam fora das revisões sincronizadas. A importação arquiva conteúdo recebido, portanto os mesmos cuidados de privacidade das notas se aplicam aos originais e anexos. Veja [Migração do Notion](docs/IMPORTACAO_NOTION.md).

## IA por CLI/ACP

O notes executa o CLI escolhido sem shell, com diretório de trabalho temporário e contexto por stdin. Não fornece o perfil da biblioteca nem seu clone Git como diretório do agente. Os adaptadores nativos desabilitam ferramentas e usam sessões sem persistência de conversa; no ACP v1, o cliente não oferece filesystem ou terminal e recusa solicitações dessas capacidades. A saída bruta de diagnóstico não é mostrada na interface nem registrada pelo adaptador.

Apenas ações tipadas podem alterar a biblioteca. O aplicativo valida campos e limites, verifica se o conteúdo a editar foi lido e recusa respostas baseadas em entidades modificadas durante a consulta. O lote passa pela fila de persistência com nova guarda contra concorrência. Remoções preservam notas e anexos na lixeira; o desfazer do último lote recusa sobrescrever edições posteriores.

As preferências ficam em `ai/settings.json` no perfil local, fora das revisões e backups da biblioteca. Autenticação e credenciais continuam no CLI; o renderer recebe somente preferências sem tokens. O contexto inclui metadados da biblioteca, corpos selecionados e leituras adicionais limitadas, sem bytes dos anexos. Pedido, resposta e contexto de seguimento ficam em memória no notes.

Processo local não implica inferência offline: o provedor pode enviar contexto ao seu serviço. Um agente ACP é um executável de confiança escolhido pelo usuário, com as permissões desse usuário; restringir as capacidades oferecidas pelo cliente não constitui sandbox do sistema operacional. Histórico e políticas de retenção do próprio agente/provedor são externos ao notes. Veja [IA local](docs/IA_LOCAL.md) para o contrato e os limites de execução.

Os detalhes estão na [arquitetura](docs/ARQUITETURA.md). Testes usam perfis temporários e remotos Git locais, conforme o [guia de desenvolvimento](docs/DESENVOLVIMENTO.md).
