'use strict';

// Service worker mínimo: existe só para o Chrome considerar o app instalável
// (critério de instalabilidade exige um worker com handler de fetch). Não faz
// cache — os dados do CRM são sempre em tempo real, cache aqui só arriscaria
// mostrar tela velha depois de um deploy ou uma reconexão.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Sem respondWith: a requisição segue pra rede normalmente.
});
