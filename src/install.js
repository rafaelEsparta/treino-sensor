// Convite para instalar o app no celular: aparece toda vez que a página abre
// no celular/tablet fora do app instalado.

/** Plataforma do aparelho: 'ios' | 'android' | 'outro'. */
export function detectPlatform(userAgent = '', maxTouchPoints = 0) {
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  // iPadOS 13+ se identifica como Mac, mas tem tela de toque.
  if (/macintosh/i.test(userAgent) && maxTouchPoints > 1) return 'ios';
  if (/android/i.test(userAgent)) return 'android';
  return 'outro';
}

/** Instruções de instalação manual, quando o navegador não oferece o botão direto. */
export function installInstructions(platform) {
  if (platform === 'ios') return 'Para instalar no iPhone/iPad: abra no Safari, toque em Compartilhar e depois em "Adicionar à Tela de Início".';
  if (platform === 'android') return 'Para instalar no Android: no Chrome, toque em ⋮ e depois em "Instalar app" (ou "Adicionar à tela inicial").';
  return 'Para instalar: use o menu do navegador e escolha "Instalar app" ou "Adicionar à tela inicial".';
}

export function isStandalone() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch {
    return false;
  }
}

/** Celular/tablet: tela de toque ou layout estreito. */
export function isMobile() {
  try {
    return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(max-width: 900px)').matches;
  } catch {
    return false;
  }
}

/**
 * Liga o bloco de convite. No Chrome do Android usa o botão nativo de instalar;
 * nos demais mostra as instruções manuais.
 * @param {{block: HTMLElement, button: HTMLButtonElement, text: HTMLElement}} els
 * @param {boolean} [force] mostra mesmo fora do celular (para testar)
 */
export function initInstall({ block, button, text }, force = false) {
  let deferred = null;
  const render = () => {
    if (block.hidden) return;
    button.hidden = !deferred;
    text.textContent = deferred
      ? 'Instale o Treino no celular para abrir em tela cheia, como um app.'
      : installInstructions(detectPlatform(navigator.userAgent, navigator.maxTouchPoints));
  };
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    render();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    block.hidden = true;
  });
  button.addEventListener('click', async () => {
    const prompt = deferred;
    if (!prompt) return;
    deferred = null;
    await prompt.prompt();
    await prompt.userChoice.catch(() => {});
    render();
  });
  block.hidden = !(force || isMobile()) || isStandalone();
  render();
}
