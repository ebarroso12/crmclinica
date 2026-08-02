'use strict';

function validarEventoMensagem(evento) {
  if (!evento || typeof evento !== 'object') throw new Error('Evento inválido');
  if (!String(evento.id_externo || '').trim()) throw new Error('id_externo obrigatório');
  if (!String(evento.canal || '').trim()) throw new Error('canal obrigatório');
  if (!String(evento.remetente || '').trim()) throw new Error('remetente obrigatório');
  if (!String(evento.texto || '').trim()) throw new Error('texto obrigatório');
  return {
    id_externo: String(evento.id_externo),
    canal: String(evento.canal),
    remetente: String(evento.remetente),
    texto: String(evento.texto),
    nome: evento.nome ? String(evento.nome) : null,
  };
}

module.exports = { validarEventoMensagem };
