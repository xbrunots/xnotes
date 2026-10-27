# Guia do notes

Instalação portable, edição visual, organização, importações, sincronização e recuperação. Para compilar ou contribuir, veja [Desenvolvimento](DESENVOLVIMENTO.md) e [Contribuição](../CONTRIBUTING.md).

## Executar

Abra **`portable/notes-1.0.0-Windows-x64-portable.exe`**. Não é necessário instalar Node, Electron ou o aplicativo. A primeira execução contém as notas de exemplo da referência, que podem ser editadas ou movidas para a lixeira.

Somente portable é gerado. O projeto não possui alvo de instalador. A pasta `portable/win-unpacked` é intermediária; o arquivo de entrega é o `.exe` portable na raiz de `portable/`.

O programa guarda sua biblioteca em `notes-data` ao lado do portable. Em uma pasta sem permissão de gravação, utiliza `%APPDATA%/notes`. A cópia local permite trabalhar sem Internet. Transporte também as pastas da biblioteca ou conecte a mesma conta GitHub no outro PC.

## GitHub

Na primeira abertura, o notes apresenta o onboarding. Clique em **Conectar GitHub**: o aplicativo verifica Git e GitHub CLI, baixa as versões portáteis oficiais que estiverem faltando e abre o login no navegador. Nenhum cadastro de aplicativo OAuth, token manual ou JSON é necessário. Se a conta já estiver conectada no GitHub CLI, ela é reutilizada.

As ferramentas ficam em **notes-tools** ao lado do portable. Downloads têm tamanho e SHA-256 verificados; não é necessário instalar GitHub Desktop ou conceder privilégios de administrador. A autenticação usa o cofre do Windows. Se o cofre não estiver disponível, o notes informa a falha e não trata credenciais em texto aberto como uma conexão segura.

O aplicativo cria um repositório **privado**, chamado **notes-library**, e uma pasta **notes-repository** ao lado do EXE. Em outro computador, entre na mesma conta: uma biblioteca existente só é adotada se tiver o marcador válido do notes e continuar privada. Um repositório de outro projeto com o mesmo nome é preservado; o notes escolhe outro nome disponível.

Notas, documentos visuais, grupos, sessões, tags, temas, lixeira e anexos são exportados para essa pasta. Arquivos que você adicionar diretamente nela também são versionados. O cache do dispositivo, os tokens, as ferramentas e as cópias locais de recuperação ficam fora do repositório. Não coloque credenciais na pasta da biblioteca.

**Sincronização diária ou manual:** o botão GitHub e **Ctrl+Shift+S** recebem as alterações remotas, mesclam mudanças compatíveis, criam um commit e fazem push. A rotina automática respeita um prazo persistido de 24 horas após o último sucesso. Editar, importar, focar ou fechar não inicia upload; **Ctrl+S** apenas salva localmente.

No portable, uma tarefa Windows por usuário verifica o prazo em segundo plano, inclusive com o notes fechado, enquanto a sessão do Windows estiver logada. Ao voltar de suspensão, a execução pendente é retomada. Se o Windows impedir o agendamento, o status informa a limitação e a rotina continua funcionando com o notes aberto. Não há necessidade de senha de administrador.

Arquivos presentes apenas no GitHub são recebidos automaticamente. Se houver duas alterações incompatíveis, abre-se **Comparar versões**, com Local e GitHub. Você pode manter a versão local, a remota ou ambas, quando aplicável. Se os dados mudarem durante a comparação, a escolha antiga é recusada e a comparação é atualizada.

O histórico usa revisões imutáveis, relógios por dispositivo, commits Git e snapshots de recuperação. Uma interrupção ou push rejeitado preserva alterações e permite retomar. Não há force-push ou descarte automático de versões. O Google Drive deixou de ser utilizado; as notas locais existentes são preservadas.

Anexos de até 256 MiB são divididos em partes de no máximo 32 MiB, com checksums, sem depender de Git LFS. Para arquivos adicionados diretamente à pasta, o limite individual é 100 MiB; arquivos maiores são preservados localmente e geram um erro explícito antes do envio. O uso continua sujeito aos limites da conta e do serviço GitHub.

Preserve **notes-data** e **notes-repository** ao transportar uma biblioteca offline. As ferramentas podem ser baixadas novamente. Em outro PC, a conta GitHub precisa de sua própria autorização no cofre daquele Windows.

## Importar do Notion e Obsidian

Use **Arquivo → Importar do Notion/Obsidian**, a busca `Ctrl+K` ou Configurações.

**Conexão direta com o Notion:** clique em **Conectar ao Notion**, autorize no navegador e confira o inventário antes de importar. Interrupções permitem retomada; limites, páginas truncadas e arquivos ausentes aparecem como pendências. O acesso depende das permissões da conexão, com conferência adicional para teamspaces. Veja o [guia completo de migração](IMPORTACAO_NOTION.md).

- **Notion:** exporte o workspace em **HTML** ou **Markdown e CSV**, incluindo subpáginas e arquivos. Selecione o ZIP ou a pasta extraída. Páginas, subpáginas e bancos CSV tornam-se notas. ZIPs internos são expandidos até três níveis, preservando também os ZIPs originais.
- **Obsidian:** selecione o cofre completo ou um ZIP. Notas Markdown, caminhos, frontmatter, tags, aliases e links são importados. Canvas e bases mantêm seu conteúdo, e as configurações são arquivadas.
- **Originais:** todos os arquivos capturados, inclusive recursos sem referência, ficam preservados com seus bytes e caminhos na sessão **Arquivos da importação**. Anexos podem ser salvos novamente e participam do sync e dos backups. Scripts e plugins ficam guardados como arquivos inertes.
- **Links:** links entre páginas são associados às notas importadas, inclusive quando títulos se repetem. Imagens locais são exibidas no leitor. Incorporações de notas tornam-se links, mantendo a sintaxe original nos arquivos arquivados. Âncoras e metadados originais ficam preservados; o leitor abre a nota, sem navegar até blocos específicos.

O relatório mostra arquivos excluídos, links não resolvidos e outras observações, com atalhos para abrir as notas e tabelas recebidas. `.git`, `node_modules`, `.trash`, links simbólicos/junctions e tipos especiais são ignorados explicitamente. A importação não altera a fonte nem substitui notas existentes. Importar um ZIP novamente cria um grupo independente; reaplicar o mesmo inventário conectado não duplica o grupo já salvo.

Na importação por ZIP, o notes trabalha com o conteúdo que a exportação disponibiliza. Histórico de versões, permissões, visualizações, automações e recursos não exportados não são reconstruídos como funções do notes. Comentários dependem do material exportado; a conexão direta tenta lê-los quando o serviço os disponibiliza. Funcionalidades de plugins do Obsidian também não são executadas.

Limites por importação: 20 mil entradas, 1 GiB de arquivos, 256 MiB por arquivo e 16 MiB por nota de texto. A operação falha explicitamente em dados inválidos ou ao exceder os limites. Nenhum estado parcial é salvo na biblioteca; blobs já copiados podem permanecer sem referência na cópia local.

## Notas e janela

- Em **Configurações → Aparência da área de trabalho**, escolha **Padrão** (área contínua) ou **Ilha** (painéis separados de grupos, lista e notas). Grupos, sessões e lista permanecem disponíveis; a lista mostra títulos sem repetir o corpo das notas.
- Abra notas em abas e escolha **Uma nota**, **Lado a lado** ou **Grid**. No Grid, cartões de altura natural formam um mosaico que preenche as colunas livres e rola verticalmente. Editar, carregar imagens e mudar a largura reorganiza o mosaico sem duplicar o editor. As abas não são fechadas automaticamente ao abrir a quinta nota.
- Em Ilha, as abas ficam dentro da moldura da área de notas, alinhada com os painéis vizinhos. No modo Padrão, o rodapé de referências não tem fundo, divisória ou bordas.
- Arraste a borda direita da barra lateral, da lista ou de uma nota lado a lado/Grid para redimensionar. Arraste a divisão entre grupos/sessões e tags para ajustar suas alturas. Os tamanhos são salvos ao soltar, respeitam limites mínimos e se adaptam à janela. As setas ajustam o separador focado; Shift acelera, Esc cancela e duplo clique restaura o tamanho padrão.
- Arraste grupos para reordenar, sessões entre grupos, notas entre sessões e abas para mudar sua ordem. Nos itens da navegação, `Alt+↑/↓` também reordena por teclado. Conteúdo, IDs, anexos e documentos visuais acompanham a nota.
- Os botões de criação usam **+**, com tooltip e nomes acessíveis: nova nota, novo grupo e nova sessão.
- Passe o mouse sobre uma nota para revelar a **bolinha de cor no canto superior direito**. Ela mostra a cor atual e abre um popover com **20 estilos exclusivos** em grid, sem escurecer a tela. Cada opção combina fundo, texto, bordas, links e controles. Escape ou clique fora fecha a paleta. A cor persiste e sincroniza; **Usar tema do aplicativo** remove a personalização. O menu de contexto também abre a mesma paleta.
- O conteúdo é sempre editado visualmente, incluindo notas importadas. Markdown colado é convertido em títulos, listas, tarefas, tabelas, imagens e links; não existe modo de código ou textarea de Markdown.
- Selecione texto para abrir o popover: negrito, itálico, sublinhado, tachado, destaque, títulos, listas, tarefas, citação, alinhamento, links e tabelas. O botão **Aa** ou `Alt+F10` abre as ferramentas sem seleção. Links internos podem ser inseridos como `nota:Nome da nota`; clicar neles abre ou cria a nota de destino.
- Cole código reconhecível para criar um **bloco Monaco** automaticamente. Blocos de código de notas importadas também usam o widget. Para outro texto, selecione o trecho e use **Transformar em código (Monaco)** nas ferramentas ou no menu direito. A detecção conserva prosa e Markdown misto no editor visual; snippets ambíguos podem ser convertidos manualmente.
- No widget, clique com o botão direito para escolher entre **84 linguagens com busca**, copiar o código, selecionar tudo, transformar em texto ou excluir o bloco. Cores acompanham o tema de cada nota, inclusive em notas lado a lado; não há escolha de tema dentro do Monaco. O editor e seus workers são distribuídos localmente, sem CDN. Código não é executado. Escape ou Ctrl+Enter volta à nota; Undo/Redo, salvamento e sincronização incluem o conteúdo e a linguagem.
- Botão direito em uma nota: renomear, duplicar com anexos e estilo, fixar, mover/copiar entre sessões, copiar texto visual/título, exportar, ver anexos, fechar e enviar à lixeira. No editor também há desfazer/refazer, recortar, copiar, colar e selecionar tudo.
- Botão direito em grupos e sessões: criar, renomear, duplicar com conteúdo, reordenar, ordenar, alterar cores de grupos, mover sessões ou notas, expandir/recolher e excluir. Exclusão de grupo/sessão pede confirmação e preserva notas e anexos na lixeira.
- Em **Configurações → Temas**, escolha entre **Obsidiana, Carbono, Meia-noite, Bosque, Ametista** (escuros) e **Neve, Papel, Areia, Bruma, Lavanda** (claros). A seleção de tema fica apenas nas Configurações. Obsidiana e Carbono são especialmente escuros. Tema, destaque, movimento e desfoque persistem e sincronizam com as preferências.
- A barra integrada inclui Arquivo, Editar, Visualizar, busca, GitHub e configurações. Os controles Windows preservam minimizar, maximizar/restaurar, fechar, Snap, arraste e redimensionamento. Tela cheia fica em Visualizar (`F11`).
- Dropdowns, seletores de cor, toggles, sliders e checkboxes são desenhados pelo projeto, com suporte a teclado; nenhum widget padrão do navegador é exibido.

| Atalho | Ação |
|---|---|
| Ctrl+K | Buscar notas, sessões e comandos |
| Alt+N | Nova nota |
| Ctrl+S | Salvar localmente |
| Ctrl+Shift+S | Sincronizar GitHub agora |
| Alt+↑ / Alt+↓ | Reordenar item de navegação focado |
| Ctrl+B | Negrito no editor; mostrar/ocultar barra lateral fora dele |
| Ctrl+I / Ctrl+U | Itálico / sublinhado no editor |
| Alt+F10 | Abrir ferramentas da nota |
| Ctrl+, | Configurações |
| Ctrl+Delete | Mover a nota focada para a lixeira, fora do editor |
| Esc | Fechar busca, popover ou menu |

## Backups e recuperação

**Exportar backup** cria um ZIP com a biblioteca inteira, inclusive lixeira e anexos. Importe pelo menu de backup para adicionar a outra biblioteca. Os bytes dos anexos e o checksum dos metadados são verificados. A exportação recusa previamente um arquivo que o próprio leitor não poderia restaurar. Limites do backup completo: 200 mil anexos, 32 GiB totais, 512 MiB de metadados e 256 MiB por anexo.

O armazenamento local mantém um journal e três checkpoints de segurança. Corrupções recuperáveis são sinalizadas e os arquivos problemáticos são preservados. Dados irrecuperáveis geram um erro explícito, sem redefinir silenciosamente a biblioteca para as notas de exemplo. Cada revisão admite até 64 MiB e o checkpoint até 512 MiB; os limites são verificados antes das gravações.

## Próximas leituras

- [Arquitetura](ARQUITETURA.md) e [especificação](ESPECIFICACAO.md).
- [Como desenvolver e validar](DESENVOLVIMENTO.md).
- [Uso de IA no projeto](DESENVOLVIMENTO_COM_IA.md).
- [Voltar à apresentação](../README.md).
