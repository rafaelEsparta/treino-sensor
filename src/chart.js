// Gráfico de linhas rolante em canvas (janela dos últimos N segundos),
// com cursor e tooltip ao passar o mouse.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function niceStep(span, target = 4) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

export class RollingChart {
  /**
   * @param {HTMLElement} host elemento .chart já contendo <canvas> e .tip
   * @param {{series:{name:string,color:string}[], unit:string, minSpan:number, digits?:number, window?:number}} opts
   */
  constructor(host, opts) {
    this.host = host;
    this.canvas = host.querySelector('canvas');
    this.tip = host.querySelector('.tip');
    this.opts = { window: 10, digits: 2, ...opts };
    this.t = [];
    this.v = opts.series.map(() => []);
    this.hoverX = null;
    this.dirty = true;
    this.canvas.addEventListener('mousemove', (e) => {
      this.hoverX = e.offsetX;
      this.dirty = true;
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.tip.hidden = true;
      this.dirty = true;
    });
    new ResizeObserver(() => (this.dirty = true)).observe(this.canvas);
  }

  push(t, values) {
    this.t.push(t);
    values.forEach((x, i) => this.v[i].push(x));
    const cut = t - this.opts.window - 1;
    let n = 0;
    while (n < this.t.length && this.t[n] < cut) n++;
    if (n > 200) {
      this.t.splice(0, n);
      this.v.forEach((a) => a.splice(0, n));
    }
    this.dirty = true;
  }

  clear() {
    this.t = [];
    this.v = this.opts.series.map(() => []);
    this.dirty = true;
  }

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const { canvas, opts } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 44, r: 8, t: 6, b: 18 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const tEnd = this.t.length ? this.t[this.t.length - 1] : opts.window;
    const tStart = tEnd - opts.window;
    let first = 0;
    while (first < this.t.length && this.t[first] < tStart) first++;

    let lo = Infinity;
    let hi = -Infinity;
    for (const arr of this.v) {
      for (let i = first; i < arr.length; i++) {
        if (arr[i] < lo) lo = arr[i];
        if (arr[i] > hi) hi = arr[i];
      }
    }
    if (!Number.isFinite(lo)) {
      lo = -opts.minSpan / 2;
      hi = opts.minSpan / 2;
    }
    if (hi - lo < opts.minSpan) {
      const mid = (hi + lo) / 2;
      lo = mid - opts.minSpan / 2;
      hi = mid + opts.minSpan / 2;
    }
    const step = niceStep(hi - lo);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;

    const x = (t) => pad.l + ((t - tStart) / opts.window) * pw;
    const y = (val) => pad.t + (1 - (val - lo) / (hi - lo)) * ph;

    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    for (let val = lo; val <= hi + step / 2; val += step) {
      const yy = Math.round(y(val)) + 0.5;
      const isZero = Math.abs(val) < step / 1e6;
      ctx.strokeStyle = css(isZero ? '--axis' : '--grid');
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.fillStyle = css('--muted');
      ctx.fillText(val.toFixed(decimals), pad.l - 6, yy);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let s = 0; s <= opts.window; s += 2) {
      ctx.fillText(s === opts.window ? 'agora' : `-${opts.window - s} s`, pad.l + (s / opts.window) * pw - (s === opts.window ? 12 : 0), h - 4);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, pw, ph);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    opts.series.forEach((s, k) => {
      const arr = this.v[k];
      ctx.strokeStyle = css(s.color);
      ctx.beginPath();
      for (let i = first; i < arr.length; i++) {
        const px = x(this.t[i]);
        const py = y(arr[i]);
        if (i === first) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    ctx.restore();

    this.#hover(ctx, { pad, pw, ph, w, x, y, tStart, first });
  }

  #hover(ctx, g) {
    if (this.hoverX === null || this.t.length <= g.first) return;
    const tHover = g.tStart + ((this.hoverX - g.pad.l) / g.pw) * this.opts.window;
    let idx = g.first;
    for (let i = g.first; i < this.t.length; i++) {
      if (Math.abs(this.t[i] - tHover) < Math.abs(this.t[idx] - tHover)) idx = i;
    }
    const px = g.x(this.t[idx]);
    ctx.strokeStyle = css('--axis');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, g.pad.t);
    ctx.lineTo(Math.round(px) + 0.5, g.pad.t + g.ph);
    ctx.stroke();
    this.opts.series.forEach((s, k) => {
      ctx.fillStyle = css(s.color);
      ctx.strokeStyle = css('--surface');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, g.y(this.v[k][idx]), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    const ago = this.t[this.t.length - 1] - this.t[idx];
    const rows = this.opts.series
      .map((s, k) => `<div><i style="background:var(${s.color})"></i>${s.name}<b>${this.v[k][idx].toFixed(this.opts.digits)} ${this.opts.unit}</b></div>`)
      .join('');
    this.tip.innerHTML = `<small>${ago < 0.05 ? 'agora' : `há ${ago.toFixed(1)} s`}</small>${rows}`;
    this.tip.hidden = false;
    const left = px + 12 + this.tip.offsetWidth > g.w ? px - 12 - this.tip.offsetWidth : px + 12;
    this.tip.style.left = `${left}px`;
  }
}
