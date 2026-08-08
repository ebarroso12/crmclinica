'use strict';

// Controle de acesso por papel.
//
// A matriz é explícita e pequena de propósito: dá para ler inteira e responder
// "quem pode fazer isso?" sem seguir herança entre papéis. Papéis novos entram
// listando suas permissões, não herdando as de outro.

const PAPEIS = Object.freeze(['admin', 'gestor', 'atendente']);

const PERMISSOES = Object.freeze({
  // Inbox
  'conversas:ler': ['admin', 'gestor', 'atendente'],
  'conversas:responder': ['admin', 'gestor', 'atendente'],
  'conversas:assumir': ['admin', 'gestor', 'atendente'],
  'conversas:etiquetar': ['admin', 'gestor', 'atendente'],
  'conversas:resolver': ['admin', 'gestor', 'atendente'],
  'conversas:priorizar': ['admin', 'gestor'],

  // Ficha do contato
  'contatos:ler': ['admin', 'gestor', 'atendente'],
  'contatos:editar': ['admin', 'gestor'],
  // Excluir é soft delete, mas some da operação inteira: fica com quem responde
  // pela base, não com quem atende.
  'contatos:excluir': ['admin', 'gestor'],

  // Serena: ler o estado é de todos — quem atende precisa saber se a automação
  // está no ar. Mexer nela é só do admin: desligar a Serena muda o atendimento
  // da clínica inteira, e publicar prompt muda o que ela diz a pacientes.
  'serena:ler': ['admin', 'gestor', 'atendente'],
  'serena:gerenciar': ['admin'],
  'serena:voz': ['admin', 'gestor', 'atendente'],

  // Leads
  'leads:ler': ['admin', 'gestor', 'atendente'],

  // Operação
  'usuarios:gerenciar': ['admin'],
  'auditoria:ler': ['admin', 'gestor'],

  // Sincronia com o Google (P2-04): acompanhar a saúde é do gestor também —
  // é ele quem percebe a agenda parada. Operar (reenfileirar, resolver
  // conflito, forçar sync) mexe no vínculo com o calendário: só o admin.
  'sincronia:ler': ['admin', 'gestor'],
  'sincronia:operar': ['admin'],
});

const PERMISSOES_CONHECIDAS = Object.freeze(Object.keys(PERMISSOES));

/** Um papel desconhecido não recebe nada — a falta de regra nega, não permite. */
function podeFazer(papel, permissao) {
  const permitidos = PERMISSOES[permissao];
  if (!permitidos) return false;
  return permitidos.includes(papel);
}

function permissoesDoPapel(papel) {
  return PERMISSOES_CONHECIDAS.filter((permissao) => podeFazer(papel, permissao));
}

/**
 * Erro de autorização, distinto do de autenticação.
 * 401 é "não sei quem você é"; 403 é "sei, e você não pode".
 */
class ErroDeAutorizacao extends Error {
  constructor(permissao) {
    super(`sem permissão para "${permissao}"`);
    this.name = 'ErroDeAutorizacao';
    this.status = 403;
    this.permissao = permissao;
  }
}

function exigirPermissao(usuario, permissao) {
  if (!usuario) {
    const erro = new Error('autenticação obrigatória');
    erro.status = 401;
    throw erro;
  }
  if (!podeFazer(usuario.papel, permissao)) throw new ErroDeAutorizacao(permissao);
}

module.exports = { PAPEIS, PERMISSOES, PERMISSOES_CONHECIDAS, podeFazer, permissoesDoPapel, exigirPermissao, ErroDeAutorizacao };
