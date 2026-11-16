# Comparação isolada da agenda de captura

Duas VMs públicas Windows2022 executaram o núcleo de captura real, uma por perfil. Em cada VM, o mesmo Capture, HWND/PID consentidos, Vec, perfil60 e FramePacer passaram por A–B–B–A: início real mais período versus prazo nominal. Cada fase teve5s de acomodação e10s medidos; o piso de espera positiva foi500µs nos dois braços. Não há SharedBuffer, JavaScript, encoder, receptor ou chamada com oito participantes neste binário de diagnóstico.

As médias simples de FPS brutos/distintos foram55,2355/54,3865→58,4208/56,6718 em1080p e52,6473/49,1975→55,6809/51,5823 em1440p. As quatro fases1080 passaram apenas o gate curto do núcleo; as quatro1440 falharam porque conteúdo distinto ficou abaixo54. Isso não aprova60FPS ou o gate de180s do aplicativo.

O nominal teve732 intervalos abaixo do período em1080 e654 em1440, com mínimos de3,0711 e6,5959ms. Os controles relativos não tiveram intervalos abaixoT. Empty polls somaram3830 contra594 e2415 contra914, respectivamente. Em1080, o custo de captura ficou próximo; em1440, as medianas de captura nominal foram maiores. O ganho de cadência não demonstra GPU mais rápida nem elimina a adaptaçãoCPU do WebRTC. Todos os FAIL, quantis, dimensões e contadores originais estão preservados no agregado.
