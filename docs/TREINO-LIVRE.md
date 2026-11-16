# Treino livre: identificação e contagem por câmera

Segundo modo de entrada do app. Em vez do sensor na pilha de pesos, a câmera
estima a pose do corpo, identifica o exercício (halteres e peso do corpo) e
conta repetições e descanso. O modo com sensor não mudou.

> **Estado da verificação:** a lógica está coberta por testes com sequências
> sintéticas (boneco gerado por código) e o fluxo completo foi conferido no
> navegador com a demonstração. **Nada foi testado ainda com uma câmera e uma
> pessoa de verdade.** Os limiares das regras foram escolhidos para o boneco;
> é esperado que precisem de ajuste com gravações reais feitas no Lab da
> câmera. A biblioteca e o modelo carregam e rodam no navegador (conferido).

## Como usar

1. Em **Treinar**, toque em **Treino livre** e permita o uso da câmera.
2. Apoie o celular em pé, a 2 ou 3 metros, de modo que o corpo inteiro
   apareça. Um ângulo de uns 45° (nem de frente, nem de lado) é o que deixa
   braços e pernas mais visíveis.
3. Comece o exercício. Depois de 2 repetições o nome aparece e a contagem já
   inclui essas duas.
4. Alguns segundos parado encerram a série e o descanso começa, contado a
   partir da última repetição. Som, vibração e voz avisam.
5. Digite a carga quando quiser: no descanso, ela vale para a série que
   acabou. O app lembra a última carga de cada exercício.
6. Se o nome estiver errado, toque nele e escolha o certo. A contagem é
   mantida e o app passa a usar a sua escolha para aquele movimento.

## Exercícios reconhecidos

| Exercício | Grupo muscular | O que identifica |
|---|---|---|
| Rosca direta | Bíceps | cotovelo flexiona, em pé, braço colado ao tronco |
| Desenvolvimento | Ombros | cotovelo estende enquanto o braço sobe acima da cabeça |
| Elevação lateral | Ombros | braço sobe até a altura do ombro com o cotovelo quase reto |
| Tríceps acima da cabeça | Tríceps | cotovelo flexiona com o braço erguido o tempo todo |
| Remada curvada | Costas | cotovelo flexiona com o tronco inclinado |
| Agachamento | Quadríceps | os dois joelhos flexionam e o quadril desce, coxas simétricas |
| Afundo | Quadríceps | os dois joelhos flexionam, uma coxa à frente e a outra atrás |
| Flexão de braço | Peito | cotovelo flexiona com o corpo deitado (prancha) |

## Como funciona

1. **Pontos:** MediaPipe Pose Landmarker (modelo "lite") dá 33 pontos do
   corpo por quadro. Roda no aparelho, em WebAssembly; o vídeo nunca é
   enviado. Arquivos em `vendor/mediapipe/`, guardados pelo `sw.js`.
2. **Sinais** ([src/pose.js](../src/pose.js)): ângulos de cotovelo, ombro,
   quadril e joelho (esquerdo e direito), inclinação do tronco e das pernas, e
   postura (em pé, inclinado, deitado). Os ângulos usam os pontos em 3D.
   Pontos com visibilidade abaixo de 0,5 são ignorados, e os sinais são
   suavizados. A leitura de gravidade do celular corrige a inclinação do
   aparelho apoiado.
3. **Ciclos** ([src/posecounter.js](../src/posecounter.js)): cada articulação
   tem um detector de ida e volta por pontos de virada, com histerese de 15°,
   amplitude mínima e duração entre 0,4 e 8 s.
4. **Identificação:** cada ciclo é descrito (amplitudes de todas as
   articulações naquele intervalo, postura, quanto o quadril desceu) e passa
   pelas regras de `classifyCycle`. Cada exercício tem um sentido de ida
   (flexionar ou estender), o que evita contar o gesto de pegar ou largar os
   halteres.
5. **Série e descanso:** mesma semântica do sensor (`waiting`, `set`, `rest`;
   eventos `rep`, `setStart`, `setEnd`, `restDone`, mais `exercise`).

Regras de estabilidade:

- Exercício novo precisa de 2 repetições iguais; o mesmo exercício da série
  anterior abre a série na primeira.
- No meio de uma série, só troca de exercício depois de 3 repetições seguidas
  do outro. Um quadro ruim não troca nada.
- Os dois braços (ou pernas) fazendo o mesmo movimento contam uma vez.
- Corpo fora do quadro, mais de uma pessoa, pouca luz ou câmera sem ver
  ninguém: o app avisa e não conta.

## Limites conhecidos

- **Carga:** a câmera não enxerga os halteres; a carga é digitada.
- **Movimentos iguais:** rosca direta e rosca martelo, ou elevação lateral e
  frontal, têm os mesmos ângulos. O app mostra o mais provável e deixa trocar.
- **Rosca alternada:** conta cada braço como uma repetição.
- **Largar os halteres depois de uma série de agachamento** parece mais um
  agachamento e conta uma repetição a mais. Corrija com −1.
- **Câmera totalmente de frente:** inclinação do tronco e profundidade ficam
  menos confiáveis (remada e agachamento são os mais afetados).
- **Celular deitado (paisagem):** a correção de inclinação do aparelho não é
  aplicada.

## Lab da câmera

`camlab.html` mostra o vídeo com o esqueleto, os ângulos ao vivo, a taxa de
quadros, a postura e o contador (automático ou com o exercício escolhido à
mão). Também:

- **grava** os pontos em JSON, para reproduzir no próprio Lab e usar em testes;
- **reproduz** uma gravação ou uma sequência sintética, sem câmera.

Formato da gravação: `{ formato, frames: [{ dt, w: [[x, y, z, vis]...], i: [[x, y, vis]...] }] }`
(`packFrame` e `unpackFrame` em `src/pose.js`).

## Testes

`test/posecounter.test.js` usa o boneco de [src/posesim.js](../src/posesim.js):
identificação e contagem dos 8 exercícios, três séries de exercícios
diferentes com descanso, fim de série, correção manual, e os casos negativos
(andar, pegar os halteres do chão, ajeitar o celular, corpo fora do quadro,
mais de uma pessoa).

## Roteiro de verificação com câmera

- [ ] O treino livre abre, pede a câmera e mostra o esqueleto.
- [ ] No Lab, anotar a taxa de quadros no celular (o ideal é acima de 15).
- [ ] Cada um dos 8 exercícios é identificado em até 2 repetições.
- [ ] A contagem bate em uma série de 10 de cada exercício.
- [ ] Andar, pegar os halteres e ajeitar o celular não contam.
- [ ] Três séries de exercícios diferentes, sem tocar na tela, aparecem certas
      em Histórico e Progresso.
- [ ] Funciona sem internet depois da primeira abertura.
- [ ] Gravar no Lab uma série de cada exercício, para ajustar as regras.
