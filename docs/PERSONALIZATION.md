# Personalização avançada

Preferências oferece quatro temas prontos, modos claro/escuro, alto contraste, cores de fundo/destaque, tamanho de texto, densidade das mensagens, largura de canais e posição da lista de membros. As cores de texto e destaque são ajustadas para preservar contraste. Alto contraste desativa o fundo com imagem.

As mudanças têm prévia imediata. **Aplicar preferências** grava o tema na conta; **Cancelar** retorna ao último tema salvo. **Restaurar padrão na prévia** permite avaliar o padrão antes de aplicar. A versão 2 do esquema migra os campos antigos. Importação/exportação JSON aceita somente o esquema conhecido, até 16 KiB, sem CSS, HTML, scripts ou URLs arbitrárias.

Imagens e fontes são locais ao dispositivo. A biblioteca IndexedDB separa cada origem de servidor e ID de usuário; o servidor recebe apenas opções e identificadores UUID dos arquivos. O JSON exportado também não contém bytes. Outro dispositivo precisa importar novamente os arquivos e selecioná-los. A biblioteca permanece ao cancelar uma prévia; remover arquivos é uma ação separada. Limpar os dados do aplicativo ou navegador apaga essa biblioteca.

Limites por conta/servidor: 16 arquivos e 40 MiB totais. PNG/JPEG/WebP estáticos até 8 MiB, dimensão máxima 4096 px e 16 milhões de pixels; fontes WOFF2/WOFF/TTF/OTF até 2 MiB. A validação combina cabeçalhos/estrutura, limites e decodificação nativa. SVG, imagens animadas e formatos desconhecidos são recusados. Fontes importadas passam pelo decoder FontFace do WebView/navegador; o aplicativo não expõe instalação de fonte no sistema. Fontes do catálogo usam alternativas quando não estão instaladas.

Arquivos são lidos por blob URLs locais, revogadas quando substituídas, ao sair ou trocar a conta. Não há execução de tema externo nem permissão de rede para importar fundos. A aplicação não altera as preferências do Windows.

A validação automatizada cobre migração, dados maliciosos, contraste, limites e corrida de quota IndexedDB, isolamento entre contas/origens, anexos e concorrência de atualização de sessão. A validação de UI cobre importar imagem/fonte, rejeitar JSON inválido, cancelar prévia, aplicar, exportar/reimportar e recuperar preferências após novo login. As provas finais constam em VALIDATION.md.
