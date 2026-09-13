'use strict';

// Service worker do crmclinica — existe por UM motivo só: sem ele registrado,
// o Chrome no Android não oferece instalar o site como app.
//
// ELE NÃO GUARDA NADA EM CACHE, DE PROPÓSITO.
//
// Em 12/09/2026 este projeto acabou de corrigir o problema de a equipe ter de
// dar Ctrl+Shift+R para ver a versão nova (HTML com `no-store`, JS e CSS
// revalidando sempre). Um service worker que servisse arquivo do cache
// desfaria essa correção da pior maneira possível: a pessoa passaria a ver uma
// versão velha do CRM mesmo depois de recarregar, e ninguém ligaria o sintoma
// ao worker. Num sistema onde a tela mostra conversa de paciente em andamento,
// servir tela velha é risco de atendimento, não incômodo.
//
// Por isso o `fetch` aqui só repassa para a rede, sem tocar em cache. Se um dia
// alguém quiser modo offline de verdade, isso precisa ser desenhado com cuidado
// (o que pode ser guardado, por quanto tempo, o que nunca pode) — não sair de
// uma linha acrescentada aqui.

const VERSAO = 'crmclinica-sem-cache-1';

self.addEventListener('install', () => {
  // Assume o controle na primeira visita, sem esperar a aba fechar.
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    // Limpa qualquer cache que uma versão futura (ou um experimento) tenha
    // deixado para trás: o worker sem cache não pode conviver com sobras.
    for (const nome of await caches.keys()) await caches.delete(nome);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (evento) => {
  // Repasse puro. É o mínimo que torna o site instalável, e o máximo que se
  // pode fazer sem arriscar servir tela velha.
  evento.respondWith(fetch(evento.request));
});

self.addEventListener('message', (evento) => {
  if (evento.data === 'versao') evento.source?.postMessage({ versao: VERSAO });
});

// ---------------------------------------------------------------------------
// Aviso no celular (12/09/2026)
//
// O empurrão chega SEM CONTEÚDO, de propósito (ver src/seguranca/webpush.js): a
// notificação aparece na tela de bloqueio, à vista de quem estiver por perto, e
// nome de paciente ali é vazamento de dado clínico. Por isso o texto é fixo e
// não diz de quem é nem o que foi dito — quem quiser saber abre o CRM, onde
// precisa estar logado.

const TEXTO_DO_AVISO = {
  titulo: 'CRM Clínica',
  corpo: 'Alguém está esperando resposta no atendimento.',
};

self.addEventListener('push', (evento) => {
  // `userVisibleOnly` é obrigatório no Chrome: receber um push e NÃO mostrar
  // notificação faz o navegador revogar a permissão depois de algumas vezes.
  evento.waitUntil(self.registration.showNotification(TEXTO_DO_AVISO.titulo, {
    body: TEXTO_DO_AVISO.corpo,
    icon: '/marca-crmclinica.png',
    badge: '/favicon.png',
    // Mesma tag: três mensagens seguidas empilham em um aviso só, em vez de
    // encher a barra de notificações.
    tag: 'crmclinica-atendimento',
    renotify: true,
    data: { url: '/' },
  }));
});

self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const destino = evento.notification.data?.url ?? '/';

  // Se o CRM já está aberto numa aba, foca aquela em vez de abrir outra: com o
  // app instalado, abrir de novo criaria uma segunda janela do mesmo CRM.
  evento.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const janela of janelas) {
      if (new URL(janela.url).pathname === destino && 'focus' in janela) return janela.focus();
    }
    return self.clients.openWindow(destino);
  })());
});

// O aparelho troca o endereço de entrega de tempos em tempos. Sem tratar isso,
// a inscrição vira lixo e o celular para de tocar sem ninguém entender por quê.
// Aqui só avisamos a página aberta; quem regrava é o app.js, que tem a sessão.
self.addEventListener('pushsubscriptionchange', (evento) => {
  evento.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const janela of janelas) janela.postMessage({ tipo: 'reinscrever-avisos' });
  })());
});
