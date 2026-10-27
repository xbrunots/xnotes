# Contribuir com o notes

Obrigado pelo interesse em colaborar. O notes é mantido por [Bruno Brito](https://brunobrito.org); documentação, acessibilidade, cenários de importação e correções pequenas são bons pontos de entrada.

Leia [AGENTS.md](AGENTS.md), o [guia de desenvolvimento](docs/DESENVOLVIMENTO.md) e os contratos da [especificação](docs/ESPECIFICACAO.md) antes de alterar o projeto.

## Relatar um problema

Use o [formulário de bug](https://github.com/xbrunots/xnotes/issues/new?template=bug_report.yml). Inclua versão do notes/Windows, passos, resultado esperado e observado. Anexe somente exemplos fictícios. Se o problema envolve importação, uma fixture mínima vale mais que uma biblioteca pessoal inteira.

Relatos de vulnerabilidade seguem [SECURITY.md](SECURITY.md).

## Propor uma melhoria

Descreva quem se beneficia, o fluxo desejado e como perceberemos que funciona. Para mudanças amplas, converse em uma issue antes de escrever a implementação. A [lista de direções](docs/ROADMAP.md) oferece contexto; não limita boas propostas.

## Enviar um pull request

1. Faça um fork e crie uma branch com nome descritivo.
2. Prepare o ambiente com `npm ci`. Mantenha mudanças focadas e evite reformatação de arquivos inteiros sem necessidade.
3. Implemente e verifique os cenários afetados. Adicione regressão quando houver um comportamento relevante a proteger.
4. Atualize documentação e capturas se a experiência mudar.
5. No PR, explique problema, comportamento final e comandos executados com seus resultados. Para UI, inclua capturas com dados fictícios.

Não é necessário commitar binários: `portable/`, `app/`, ferramentas, caches e bibliotecas pessoais ficam fora do Git. Para mudanças que afetam o aplicativo distribuído, gere o portable e execute `npm run test:portable`, informando o resultado no PR.

## Contratos a preservar

- Marca **notes**, sem prefixos; monograma X aprovado.
- Edição sempre visual, um editor por nota e recursos locais/offline.
- Dez temas globais e vinte estilos fixos por nota; controles próprios acessíveis por teclado.
- Ctrl+S salva localmente. Upload só pelo fluxo manual/diário autorizado.
- Conflitos, corrupção e importações inválidas exigem tratamento explícito com preservação de dados.
- Nenhum force-push, reset destrutivo ou descarte automático de versões na sincronização.
- Somente portable Windows x64; sem instalador.
- Fontes geradas por `scripts/import-reference.cjs` devem ser corrigidas no gerador quando a mudança for de importação.

## IA nas contribuições

Você pode usar IA. Revise o resultado, entenda o código enviado e descreva brevemente onde houve assistência. Não envie segredos ou notas privadas ao modelo. Não publique testes, auditorias ou resultados que não executou. Consulte o [relato do projeto](docs/DESENVOLVIMENTO_COM_IA.md).

## Revisão e convivência

A revisão considera correção, compatibilidade, acessibilidade, preservação dos dados e clareza. O mantenedor pode pedir que uma proposta seja reduzida ou dividida em mudanças independentes. Mantenha a conversa respeitosa conforme o [código de conduta](CODE_OF_CONDUCT.md).

Contato e outros projetos: [brunobrito.org](https://brunobrito.org) · [LinkedIn](https://www.linkedin.com/in/brunosbrito/).
