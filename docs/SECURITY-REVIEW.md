# Revisão de segurança e operação — 12/11/2026

Revisão independente da implementação inicial do Harmony: autenticação, autorização, mídia, anexos, configuração, recuperação e fronteira Tauri. Os achados abaixo foram comunicados aos autores e as correções foram conferidas no código. Esta revisão não certifica segurança integral nem prontidão para produção.

## Achados corrigidos

| Problema encontrado | Correção conferida |
|---|---|
| Login com senha antiga podia terminar depois de um reset e criar sessão válida. | `auth.rs`: hash e versão verificados antes do cálculo da senha são comparados novamente sob bloqueio do usuário antes da criação da sessão. |
| Logout podia perder uma rotação concorrente do refresh token. | `auth.rs`: logout também encontra a sessão pelo histórico dos tokens consumidos. |
| Refresh do cliente podia restaurar sessão após logout ou salvar credencial na origem seguinte. | `api.ts`: geração da sessão, origem capturada, gravação serializada e rechecagem após leitura do corpo da resposta. |
| Tokens LiveKit renovados pelo servidor sobreviviam à curta validade do token inicial. | `media.rs` e Caddy: admissão consulta sessão/ACL/ban/mute atuais antes de cada conexão; reconciliação consulta participantes ativos, inclusive sem registro histórico local. |
| Polling de todo o histórico de mídia acumulava RPCs de remoção. | Reconciliação usa salas e participantes ativos, com quatro salas simultâneas. Remoção de membro desconecta apenas a comunidade correspondente. |
| Validação de anexos podia deixar cópias órfãs; reenvio tardio recriava objeto temporário. | `uploads.rs`: chave final determinística, limpeza posterior à expiração da URL também para anexos prontos e controle transacional da cota. |
| Limpeza podia apagar o objeto durante a conclusão do upload. | Limpeza trava a linha com `FOR UPDATE SKIP LOCKED`; conclusão revalida a expiração antes de marcar o anexo pronto. |
| API LiveKit podia escutar publicamente; proxy perdia IP real. | `configure.py`: controle LiveKit em loopback; TURN com bind separado; PROXYv2 nos hops web/mídia e confiança limitada ao proxy local. |
| Valores de exemplo podiam ser aceitos como segredos; cliente desktop ficava fora do CORS. | Rejeição dos placeholders de JWT/senha inicial; origens Tauri explícitas, sem wildcard. |
| Nova pasta de restauração podia reutilizar volumes Compose existentes. | `restore.sh`: projeto Compose novo e verificações de contêineres, volumes e porta antes de iniciar; backup interrompido encerra antes de religar os serviços. |

## Verificações independentes executadas

`scripts/test_media_proxy.py` passou com Caddy 2.11.9 e o módulo L4, usando a configuração gerada, TLS local, portas dinâmicas e backends HTTP controlados. Os 14 cenários verificam encaminhamento somente após autorização, precedência consistente de token por header/query, sobrescrita do header interno forjado, negação sem token, bloqueio de rotas administrativas e preservação do IP por PROXYv2 com remoção de X-Forwarded-For forjado.

```sh
CADDY_BIN=/caminho/para/caddy HARMONY_REQUIRE_CADDY=1 python3 scripts/test_media_proxy.py
```

Sem binário ou módulos, o teste informa `skipped`; com `HARMONY_REQUIRE_CADDY=1`, a ausência reprova a execução. O resultado local fica em `.local/security-media-proxy-result.json`, com hash de `configure.py` e versão do Caddy. A política do listener aceita conexões diretas de loopback; não exige PROXYv2 delas. O teste comprova o transporte e o roteamento com decisão de autorização controlada, não a integração completa com autenticação real ou mídia LiveKit.

Uma consulta anônima ao bucket S3 local retornou HTTP403. A inspeção Tauri conferiu comandos específicos para cofre/abertura de links, origem validada, navegação restrita e ausência de permissões remotas genéricas. Os testes funcionais executados pelos componentes e as provas da integração real são registrados em [VALIDATION.md](VALIDATION.md), separados deste teste de proxy.

Uma prova independente posterior com dois peers do SDK oficial confirmou áudio/vídeo sintéticos, remoção do transmissor após reset e rejeição de reconexão com token revogado ainda dentro da validade. Versões, contagens, tempo observado e limites estão em [MEDIA-RTC-VALIDATION.md](MEDIA-RTC-VALIDATION.md). Ela cobre RTC local em macOS arm64; não homologa captura ou instalação no Windows.

`npm audit --json` retornou zero vulnerabilidades conhecidas para o lockfile desta revisão (229 dependências totais, incluindo desenvolvimento). Isso representa a consulta ao catálogo naquele momento; não é garantia sobre todas as dependências Rust, os binários ou vulnerabilidades desconhecidas.

## Limites que permanecem

- Revogação de chamada depende da disponibilidade do controle LiveKit e da reconciliação. O intervalo de cinco segundos não constitui prazo máximo garantido sob falha ou sobrecarga; pacotes já entregues não são recuperáveis.
- O limite de bitrate solicitado ao encoder não impede um cliente modificado nem limita cobrança de tráfego. O host escolhido ainda precisa de limites efetivos de rede/disco e prova de recuperação; veja [OPERATIONS.md](OPERATIONS.md).
- Foram revisados os bloqueios de concorrência dos uploads; este relatório não declara ensaio completo de todas as falhas de S3, cópia interrompida ou esgotamento físico de disco.
- Captura, áudio, cofre, atalhos, firewall, instalação e desempenho precisam de execução em Windows real. Build e leitura de configuração não substituem essas provas.
- DNS, certificados públicos, TURN entre redes distintas e restauração Compose em host Linux continuam dependentes do ambiente escolhido. Não houve implantação pública nesta revisão.
- Não há alegação de E2EE, isolamento contra administrador do host ou custo futuro garantido. Auditoria de dependências não substitui revisão de código, licenças e binários distribuídos.

O estudo estático do Discord está separado em [REA-DISCORD.md](REA-DISCORD.md), com plataforma, hashes, evidências e limites próprios; seus artefatos privados não integram o repositório.
