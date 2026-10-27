# Histórico de mudanças

O histórico abaixo descreve o estado do projeto; uma entrada não significa que há um release publicado. Consulte [Releases](https://github.com/xbrunots/xnotes/releases) para distribuições e [VALIDACAO.md](docs/VALIDACAO.md) para execuções registradas.

## Em preparação — apresentação pública

- README com identidade visual, capturas reais, autoria de Bruno Brito e versão em inglês.
- Guias de uso, arquitetura, especificação, decisões, desenvolvimento e processo assistido por IA.
- Orientações de contribuição, conduta, segurança e formulários de issues/PRs.
- Workflow Windows para testes, verificação Electron e portable.
- Metadados de autoria, site, repositório e requisitos do ambiente.
- Aviso OFL das fontes e inclusão dos textos de licença/terceiros do Monaco no build.

## Em preparação — migração Notion conectada

- Conexão oficial com login no navegador, OAuth/PKCE e autorização cifrada pelo sistema operacional.
- Inventário retomável de páginas, bancos e arquivos acessíveis, com contagens e pendências antes da aplicação.
- Reaplicação idempotente do mesmo plano; preservação da origem e gravação pelo armazenamento transacional.
- Alternativa por ZIP ou pasta e relatório com acesso direto às páginas e tabelas importadas.
- Testes controlados de autenticação, migração e interface Electron; veja o [registro de validação](docs/VALIDACAO.md) para as execuções realizadas.
- Correção de colagem antes do callback de inicialização do editor, com regressões de Markdown e código usando teclado/clipboard reais.

## Base 1.0.0

Estado funcional que antecede a apresentação pública: editor visual, blocos Monaco offline, grupos e sessões, abas, aparências Padrão/Ilha, modos Uma nota/Lado a lado/Grid, dez temas globais, vinte estilos por nota, importação Notion/Obsidian, backup ZIP e sincronização GitHub com recuperação.

Esta descrição é uma referência de escopo, sem atribuir uma data de lançamento ou reconstruir um histórico de versões inexistente.
