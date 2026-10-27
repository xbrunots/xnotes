# Direções de evolução

O notes já possui editor visual, Monaco offline, organização, temas, importação, backup, sincronização GitHub e [IA por CLI/ACP na busca central](IA_LOCAL.md). O comportamento atual está na [especificação](ESPECIFICACAO.md).

As ideias abaixo orientam conversas e contribuições. Não são promessas de implementação ou prazo. O mantenedor define a prioridade depois de avaliar uso, custo e preservação de dados.

| Direção proposta | Resultado desejado | Como avaliar uma proposta |
| --- | --- | --- |
| Acessibilidade contínua | Operações completas por teclado e leitura mais clara por tecnologia assistiva. | Cenário reproduzível, foco previsível e validação no Electron. |
| Bibliotecas maiores | Edição e navegação confortáveis com mais notas e anexos. | Benchmark com dados sintéticos, tamanho conhecido e comparação antes/depois. |
| Compatibilidade de importação | Mais exemplos de exportações Notion/Obsidian suportadas. | Fixture sintética pequena, conteúdo preservado e relatório explícito de limites. |
| Compatibilidade de agentes | Manter os adaptadores CLI e ACP alinhados aos provedores e às opções anunciadas. | Teste de transporte sintético, configuração confirmada, cancelamento e integridade das ações. |
| Onboarding e recuperação | Mensagens que ajudem a entender conexão, conflito e recuperação. | Fluxo completo de sucesso/falha, sem ocultar perda de dados ou erro de sync. |
| Documentação internacional | Guias técnicos também em inglês. | Traduções alinhadas ao código, sem alterar contratos existentes. |
| Entregas públicas | Releases identificáveis com portable e checksum. | Build novo, teste no EXE final, notas de versão e revisão dos arquivos publicados. |

Proponha melhorias por [issue](https://github.com/xbrunots/xnotes/issues/new/choose), descrevendo a necessidade e o comportamento esperado. Mudanças em formato de dados, autenticação ou sincronização precisam considerar compatibilidade e recuperação desde o início.

O foco atual continua em **Windows x64 portable**. Outras plataformas e provedores de sync exigem uma decisão de produto e validação próprias.
