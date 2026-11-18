// Imagem do resumo do treino, para compartilhar (1080 × 1350, formato de post).
// Desenhada em canvas; não usa nada de fora do aparelho.

const PALETTE = {
  light: { page: '#f6f7f4', card: '#ffffff', line: '#dfe3d8', text: '#14170f', text2: '#4d5445', muted: '#7b8372', mark: '#3f7a0a', accent: '#b6f24a', accentBg: '#eaf8cf' },
  dark: { page: '#0c0e12', card: '#151920', line: '#262c36', text: '#f2f4ee', text2: '#b9c0b0', muted: '#858d7c', mark: '#b6f24a', accent: '#b6f24a', accentBg: '#1c2a10' },
};
const FONT = 'system-ui, "Segoe UI", Roboto, sans-serif';

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
/** Corta o texto com reticências para caber na largura. */
function fit(c, text, max) {
  if (c.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && c.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/**
 * @param {object} sum resultado de daySummary
 * @param {string} dateLabel data por extenso
 * @param {{dark?:boolean}} [opts]
 * @returns {Promise<Blob>} PNG
 */
export function summaryImage(sum, dateLabel, { dark = false } = {}) {
  const W = 1080;
  const H = 1350;
  const P = PALETTE[dark ? 'dark' : 'light'];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d');
  const n = (v) => Math.round(v).toLocaleString('pt-BR');
  const kg = (v) => `${String(Math.round(v * 2) / 2).replace('.', ',')} kg`;

  c.fillStyle = P.page;
  c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(W / 2, 0, 0, W / 2, 0, 760);
  glow.addColorStop(0, P.accentBg);
  glow.addColorStop(1, `${P.accentBg}00`); // mesma cor, transparente (preto transparente acinzenta)
  c.fillStyle = glow;
  c.fillRect(0, 0, W, 760);

  const M = 72;
  c.textBaseline = 'alphabetic';
  c.fillStyle = P.mark;
  c.font = `700 30px ${FONT}`;
  c.fillText('T R E I N O   D O   D I A', M, 118);
  c.fillStyle = P.text;
  c.font = `800 78px ${FONT}`;
  c.fillText(fit(c, sum.workout || 'Treino concluído', W - 2 * M), M, 214);
  c.fillStyle = P.text2;
  c.font = `500 38px ${FONT}`;
  c.fillText(dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1), M, 274);

  // quatro números
  const tiles = [[String(sum.exercises.length), sum.exercises.length === 1 ? 'exercício' : 'exercícios'], [String(sum.sets), 'séries'], [sum.volume >= 1000 ? `${(sum.volume / 1000).toFixed(1).replace('.', ',')} t` : `${n(sum.volume)} kg`, 'volume'], [`${sum.minutes}`, 'minutos']];
  const gap = 20;
  const tw = (W - 2 * M - 3 * gap) / 4;
  tiles.forEach(([value, label], i) => {
    const x = M + i * (tw + gap);
    c.fillStyle = P.card;
    roundRect(c, x, 324, tw, 168, 28);
    c.fill();
    c.strokeStyle = P.line;
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = P.text;
    c.font = `800 60px ${FONT}`;
    c.fillText(fit(c, value, tw - 40), x + 22, 410);
    c.fillStyle = P.muted;
    c.font = `500 28px ${FONT}`;
    c.fillText(label, x + 22, 458);
  });

  // exercícios
  const MAX = 8;
  const rows = sum.exercises.slice(0, sum.exercises.length > MAX ? MAX - 1 : MAX);
  const top = 536;
  const rh = 80;
  const listH = (rows.length + (sum.exercises.length > rows.length ? 1 : 0)) * rh + 24;
  c.fillStyle = P.card;
  roundRect(c, M, top, W - 2 * M, listH, 28);
  c.fill();
  c.strokeStyle = P.line;
  c.stroke();
  rows.forEach((x, i) => {
    const y = top + 12 + i * rh;
    if (i) {
      c.fillStyle = P.line;
      c.fillRect(M + 28, y, W - 2 * M - 56, 2);
    }
    const same = x.sets.every((r) => r === x.sets[0]);
    const detail = `${same ? `${x.sets.length} × ${x.sets[0]}` : x.sets.join(' · ')}${x.topLoad ? `  ·  ${kg(x.topLoad)}` : ''}`;
    c.font = `600 34px ${FONT}`;
    c.textAlign = 'right';
    c.fillStyle = x.pr ? P.mark : P.text2;
    const right = `${detail}${x.pr ? '  ★' : ''}`;
    c.fillText(right, W - M - 28, y + 52);
    const used = c.measureText(right).width;
    c.textAlign = 'left';
    c.fillStyle = P.text;
    c.font = `700 36px ${FONT}`;
    c.fillText(fit(c, x.name, W - 2 * M - 56 - used - 30), M + 28, y + 52);
  });
  if (sum.exercises.length > rows.length) {
    c.fillStyle = P.muted;
    c.font = `500 32px ${FONT}`;
    c.fillText(`+ ${sum.exercises.length - rows.length} exercícios`, M + 28, top + 12 + rows.length * rh + 52);
  }

  // rodapé
  if (sum.prs) {
    c.fillStyle = P.mark;
    c.font = `700 36px ${FONT}`;
    c.fillText(`★ ${sum.prs} ${sum.prs === 1 ? 'recorde batido' : 'recordes batidos'}`, M, H - 124);
  }
  c.fillStyle = P.muted;
  c.font = `500 28px ${FONT}`;
  c.fillText(`${n(sum.reps)} repetições`, M, H - 70);
  c.textAlign = 'right';
  c.fillText('treino-sensor', W - M, H - 70);
  c.textAlign = 'left';

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('sem imagem'))), 'image/png'));
}
