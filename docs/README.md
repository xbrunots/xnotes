# Documentação do notes

O notes é um aplicativo de notas para Windows desenvolvido por [Bruno Brito](https://brunobrito.org), com assistência de IA. Esta documentação conecta a experiência do produto aos contratos do código e à sua validação.

| Documento | O que você encontra |
| --- | --- |
| [Guia de uso](GUIA.md) | Instalação portable, edição, temas, atalhos, importação, sync e backups. |
| [Arquitetura](ARQUITETURA.md) | Camadas, fluxo de dados, modelo persistido e fronteiras de confiança. |
| [Especificação](ESPECIFICACAO.md) | Escopo implementado, invariantes e critérios de aceite ligados a testes. |
| [Migração do Notion](IMPORTACAO_NOTION.md) | Conexão oficial, inventário, retomada, cobertura e exportações completas. |
| [IA local](IA_LOCAL.md) | Busca central, CLI/ACP, configuração de provedor/agente/esforço, ações e privacidade. |
| [Decisões](DECISOES.md) | Escolhas técnicas e de produto, benefícios e consequências. |
| [Desenvolvimento](DESENVOLVIMENTO.md) | Ambiente, comandos, isolamento de QA, capturas e portable. |
| [Desenvolvimento com IA](DESENVOLVIMENTO_COM_IA.md) | Direção humana, contratos para agentes, evidências e limites do relato. |
| [Validação](VALIDACAO.md) | Registro de verificações e identificação do último artefato local validado. |
| [Roadmap](ROADMAP.md) | Direções propostas para evolução, sem compromissos de prazo. |
| [Histórico](../CHANGELOG.md) | Mudanças da apresentação pública e escopo da base atual. |
| [Contribuição](../CONTRIBUTING.md) | Como propor, implementar e validar mudanças. |
| [Segurança](../SECURITY.md) | Relato responsável e limites de proteção. |
| [Créditos](../THIRD_PARTY_NOTICES.md) | Referência visual, fontes, ícone e dependências. |

Para uma avaliação técnica rápida, siga **arquitetura → decisões → especificação → desenvolvimento → validação**. Para conhecer o produto, comece pelo [README](../README.md) e pelo guia de uso.

## Como ler as evidências

O código e os testes descrevem o comportamento implementado. A especificação organiza esses contratos; não substitui sua execução. Um workflow de CI é uma configuração de verificação: só uma execução concluída demonstra seu resultado. O registro de validação identifica rodadas locais e suas limitações.

As imagens em [assets](assets/) foram capturadas no aplicativo real usando dados fictícios e um perfil temporário. O [gerador das capturas](../scripts/capture-showcase.cjs) permite reproduzi-las.

Autoria e contato: [brunobrito.org](https://brunobrito.org) · [LinkedIn de Bruno Brito](https://www.linkedin.com/in/brunosbrito/).
