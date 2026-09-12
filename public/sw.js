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
