# Créditos e componentes de terceiros

O notes é criado e mantido por **[Bruno Brito](https://brunobrito.org)**, com assistência de IA. Componentes externos mantêm suas próprias licenças e avisos.

## Referência visual e identidade

[Notas.html](Notas.html) é a referência visual fornecida para o projeto e preservada para rastreabilidade. O [gerador](scripts/import-reference.cjs) extrai a base React/CSS e as fontes locais; o aplicativo não executa o runtime externo da referência. [reference/](reference/) guarda material de apoio.

O monograma X aprovado está em [build/logo-original.png](build/logo-original.png). O README anterior registra sua criação pelo imagegen integrado. Os derivados usados pelo Windows e pela interface são gerados a partir desse desenho; o nome do produto é sempre **notes**.

O banner editorial e as capturas públicas estão em [docs/assets/](docs/assets/). As capturas são produzidas pelo próprio Electron com conteúdo fictício, conforme [capture-showcase.cjs](scripts/capture-showcase.cjs).

## Fontes

Geist e Geist Mono são distribuídas localmente em `src/assets/` a partir da referência. O [projeto oficial Geist](https://github.com/vercel/geist-font) distribui as fontes sob a SIL Open Font License 1.1. O aviso e o texto completo acompanham os recursos em [OFL-Geist.txt](src/assets/OFL-Geist.txt), copiado da [fonte oficial](https://github.com/vercel/geist-font/blob/main/OFL.txt).

## Bibliotecas principais

| Componente | Uso |
| --- | --- |
| [Electron](https://github.com/electron/electron) | Runtime desktop, janela, protocolo local e IPC. |
| [React](https://github.com/facebook/react) | Composição e estado da interface. |
| [TipTap](https://github.com/ueberdosis/tiptap) e [ProseMirror](https://github.com/ProseMirror) | Edição visual e modelo de documento. |
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | Widgets de código e workers offline. |
| [Floating UI](https://github.com/floating-ui/floating-ui) | Posicionamento de popovers. |
| [markdown-it](https://github.com/markdown-it/markdown-it) e [Turndown](https://github.com/mixmark-io/turndown) | Conversão entre conteúdo visual e Markdown. |
| [yauzl](https://github.com/thejoshwolfe/yauzl) e [yazl](https://github.com/thejoshwolfe/yazl) | Leitura e criação de ZIPs. |
| [esbuild](https://github.com/evanw/esbuild) e [electron-builder](https://github.com/electron-userland/electron-builder) | Compilação e empacotamento. |
| [Playwright](https://github.com/microsoft/playwright) | Automação do Electron e verificação do portable. |

Esta lista destaca os componentes centrais; dependências transitivas também possuem termos próprios. As versões exatas estão em [package-lock.json](package-lock.json). Avisos de licença do bundle são mantidos por `legalComments: 'eof'` em [scripts/build.cjs](scripts/build.cjs); o mesmo build copia o `LICENSE` e o `ThirdPartyNotices.txt` completos do Monaco para `app/licenses/`, incluído no portable, já que o pacote fonte do editor é excluído. O pacote Electron inclui seus próprios arquivos de licença. Consulte os arquivos `LICENSE`/`NOTICE` dos pacotes ao redistribuir componentes.

Algumas dependências incorporam código de outras bibliotecas. Por exemplo, Monaco inclui uma cópia própria de DOMPurify; o `override` do pacote npm `dompurify` não substitui automaticamente essa cópia. Um relatório `npm audit` do lockfile não equivale a uma auditoria de todo código vendorizado no bundle.

Git e GitHub CLI, quando preparados pelo onboarding, vêm das distribuições oficiais e ficam em `notes-tools`, fora do repositório da biblioteca e do código versionado do notes. Os downloads são definidos em [github-tools.cjs](desktop/github-tools.cjs).
