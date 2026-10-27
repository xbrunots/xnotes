# Segurança do notes

O notes é um aplicativo desktop com arquivos locais, importação e sincronização opcional por GitHub. Este documento descreve o canal de relato e os limites relevantes para quem usa ou contribui.

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

Os detalhes estão na [arquitetura](docs/ARQUITETURA.md). Testes usam perfis temporários e remotos Git locais, conforme o [guia de desenvolvimento](docs/DESENVOLVIMENTO.md).
