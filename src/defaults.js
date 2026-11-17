// Exercícios que já vêm preenchidos no app. Módulo puro (sem DOM).

export const DEFAULT_REST = 90; // s
export const DEFAULT_STEP = 5; // kg de aumento quando bate a meta

/**
 * [nome, carga sugerida em kg, grupo muscular, desce primeiro?]
 * O quarto item marca os exercícios em que se parte de cima: a repetição é
 * descer e subir, ao contrário da pilha de pesos.
 * As cargas são pontos de partida conservadores para um iniciante de 80 kg;
 * a numeração varia bastante entre máquinas, então a primeira série serve
 * para ajustar.
 */
export const DEFAULT_EXERCISES = [
  // pernas
  ['Agachamento livre', 40, 'Quadríceps', true], // barra de 20 kg + 10 kg de cada lado
  ['Leg press 45', 80, 'Quadríceps', true],
  ['Leg press horizontal', 60, 'Quadríceps'],
  ['Cadeira extensora', 30, 'Quadríceps'],
  ['Cadeira abdutora', 30, 'Glúteos'],
  ['Cadeira adutora', 30, 'Adutores'],
  ['Stiff', 30, 'Posteriores'],
  ['Mesa flexora', 20, 'Posteriores'],
  ['Cadeira flexora', 25, 'Posteriores'],
  ['Panturrilha sentado', 30, 'Panturrilhas'],
  // costas
  ['Puxada alta', 30, 'Costas'],
  ['Remada baixa', 30, 'Costas'],
  ['Remada máquina', 25, 'Costas'],
  // peito
  ['Supino máquina', 20, 'Peito'],
  ['Crucifixo máquina', 20, 'Peito'],
  // ombros
  ['Desenvolvimento máquina', 15, 'Ombros'],
  ['Elevação lateral máquina', 10, 'Ombros'],
  // braços
  ['Rosca na polia', 15, 'Bíceps'],
  ['Tríceps na polia', 15, 'Tríceps'],
  // abdômen
  ['Abdominal máquina', 20, 'Abdômen'],
];

/** Cria o registro de um exercício padrão. */
export function newDefault([name, load, muscle, downFirst = false], id) {
  return { id, name, rest: DEFAULT_REST, sets: 3, reps: 12, load, step: DEFAULT_STEP, muscle, downFirst, suggested: true };
}
