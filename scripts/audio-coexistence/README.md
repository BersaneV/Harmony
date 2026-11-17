# Coexistência de áudio no Windows

O workflow manual [`audio-coexistence.yml`](../../.github/workflows/audio-coexistence.yml) executa o EXE versionado do Harmony (0.4.13 por padrão) em uma VM descartável Windows Server 2025 do GitHub Actions. Usa um segundo participante no Edge, voz gerada e um processo .NET independente reproduzindo um tom de 440 Hz. A execução exige versão e SHA-256 exatos do instalador e do EXE; o download vem somente do repositório pessoal, incluindo rascunhos acessíveis ao token de leitura do próprio workflow. O EXE usa os dispositivos reais de entrada/saída do Windows da VM, sem flags de áudio falso, mute ou desativação de áudio.

O medidor WASAPI loopback lê PCM do mixer do Windows e separa o tom externo de 440 Hz da voz recebida de 880 Hz. A automação opera a interface publicada e o seletor nativo de compartilhamento. O cenário exige faixa de áudio do sistema e confirma que o outro participante decodifica o tom externo transmitido. Interromper o player deve remover somente seu tom; retomá-lo deve restaurar esse áudio durante a chamada.

Apenas o navegador receptor fica com sua saída silenciada, para não reproduzir a transmissão de volta no mesmo dispositivo da VM. Ele continua decodificando as faixas recebidas. Seu microfone é gerado em Web Audio; o EXE abre o microfone virtual pelo caminho normal do Windows. Essa bancada não avalia a qualidade de um microfone físico nem constitui um teste entre redes diferentes.

## Critérios

- Calibração independente: áudio externo mensurável antes de abrir o Harmony.
- Cada fase exige pelo menos seis intervalos completos, cada um com no mínimo 30 mil frames PCM válidos.
- Nas fases com gate de coexistência, amplitude externa média de pelo menos 85% da calibração e nenhum intervalo abaixo de 65%.
- Nas fases de voz, componente de 880 Hz acima de 0,01 no mixer do Windows.
- Transmissão exige faixa de áudio capturada, vídeo decodificado no receptor e componente de 440 Hz acima de 0,01 em uma faixa recebida.
- Controle negativo exige componente de 440 Hz abaixo de 10% da calibração ao encerrar o player, enquanto a voz permanece mensurável.
- As fases iniciais com a preferência Windows configurada para atenuar são diagnósticas: medem o comportamento, sem presumir que o endpoint virtual reproduzirá o defeito relatado. Depois, a automação aciona o botão de áudio da versão publicada, verifica a preferência do Windows, sai e retorna à chamada.

Os testes de `measurements.test.mjs` verificam que ausência de PCM, mute, atenuação ou voz ausente reprovam os gates. São complementares à execução no Windows.

## Dispositivo e dependências

O dispositivo virtual de entrada/saída é o [Virtual Audio Driver 25.7.14](https://github.com/VirtualDrivers/Virtual-Audio-Driver/releases/tag/25.7.14), do projeto [VirtualDrivers/Virtual-Audio-Driver](https://github.com/VirtualDrivers/Virtual-Audio-Driver). O ZIP é fixado por SHA-256 e o catálogo deve apresentar assinatura válida antes da instalação. Projeto sob MIT, com partes dos exemplos Microsoft sob MS-PL; consulte os avisos do fornecedor. O pacote não é redistribuído no Harmony.

O probe usa [NAudio](https://github.com/naudio/NAudio), MIT, com NAudio.Wasapi 2.2.1 e dependências fixadas no lockfile. A restauração é executada em modo locked.

Instalação de driver, permissão para o microfone virtual e alteração da preferência de atenuação ocorrem exclusivamente na VM descartável. A bancada recusa execução fora do repositório pessoal e de um runner hospedado pelo GitHub. Não altera políticas de assinatura de drivers, Secure Boot ou certificados confiáveis. Não deve ser executada em computadores de usuários.

O cenário cria duas contas e uma comunidade privadas de teste no piloto; as sessões são encerradas ao final. Não modifica a comunidade dos usuários. Os registros locais ficam em `.local/qa-audio-coexistence`; o resultado agregado aparece no log do job. Senhas e tokens são mascarados e não entram no Git.

## Limites obrigatórios do resultado

Uma aprovação comprova coexistência digital no endpoint virtual dessa VM e nessa versão do EXE. Fone com fio, Bluetooth físico, mudança A2DP/HFP, drivers de fabricantes, áudio exclusivo e o defeito no computador afetado continuam sem validação física. Não atribuir PASS a esses casos. O resultado também não certifica oito participantes, qualidade acústica ou desempenho de vídeo em 1080p/1440p.

Para versões com diagnóstico exportável, o cenário também salva o arquivo pela interface real durante voz e transmissão, lê o JSON de Downloads, verifica a presença das faixas ativas e dos endpoints reais e exige ausência dos dados conhecidos das contas/comunidade/tokens/IDs de dispositivo do teste. O arquivo de teste é removido ao final dessa conferência.
