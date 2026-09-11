'use strict';

// Quem vê o quê entre a clínica e os agentes (docs/AGENTES.md, "Quem vê o quê").
//
// Decisão do Dr. Edson (11/09/2026), migration 047:
//
//   • admin vê tudo, sempre — clínica e todos os agentes, com ou sem marca;
//   • os demais veem a clínica conforme `usuarios.acesso_clinica` (padrão sim);
//   • conversa de agente só para quem está na equipe daquele agente
//     (`agente_equipe`);
//   • quem não vê a clínica (o colaborador da loja) só alcança as rotas de
//     `ROTAS_SEM_CLINICA` — o resto responde 403, antes de qualquer consulta.
//
// O papel (`rbac.js`) continua dizendo O QUE a pessoa pode fazer; este arquivo
// diz SOBRE O QUÊ. Um não substitui o outro: atendente da equipe do Alpins
// responde conversa do Alpins porque tem `conversas:responder` E vê o Alpins.
//
// Tudo aqui é puro e síncrono: a leitura da marca e da equipe acontece antes
// (`repositorio.obterEscopoDeAcesso`), uma vez por requisição. Falta de dado
// NEGA: usuário que não existe mais não vê clínica nem agente.

const TODOS = 'todos';

/**
 * @param {{papel: string}|null} usuario  o usuário da sessão
 * @param {{acesso_clinica: boolean, agentes: number[]}|null} dados  o que o banco diz dele
 */
function montarEscopo(usuario, dados) {
  if (!usuario) return null;
  if (usuario.papel === 'admin') return Object.freeze({ admin: true, clinica: true, agentes: TODOS });
  if (!dados) return Object.freeze({ admin: false, clinica: false, agentes: Object.freeze([]) });

  const agentes = [...new Set((dados.agentes ?? [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))]
    .sort((a, b) => a - b);
  return Object.freeze({
    admin: false,
    // Só `false` explícito tira a clínica: é o padrão da coluna, e ninguém
    // perde acesso por um valor ausente na leitura.
    clinica: dados.acesso_clinica !== false,
    agentes: Object.freeze(agentes),
  });
}

function veAgente(escopo, agenteId) {
  if (!escopo) return false;
  if (escopo.agentes === TODOS) return true;
  const id = Number(agenteId);
  return Number.isInteger(id) && escopo.agentes.includes(id);
}

/** `agenteId` nulo = conversa da clínica. */
function veConversaDe(escopo, agenteId) {
  if (!escopo) return false;
  if (agenteId === null || agenteId === undefined) return escopo.clinica === true;
  return veAgente(escopo, agenteId);
}

/**
 * Recorta o filtro de agente que a tela pediu (`undefined` = todas, `null` =
 * clínica, id = aquele agente) pelo escopo. Devolve `null` quando o pedido é
 * de algo que a pessoa não vê: a lista sai vazia, sem dizer que existe.
 */
function recortarPedidoDeAgente(escopo, agenteId) {
  if (!escopo) return null;
  if (agenteId === null) return escopo.clinica ? { agenteId: null } : null;
  if (agenteId !== undefined) return veAgente(escopo, agenteId) ? { agenteId: Number(agenteId) } : null;
  return { agenteId: undefined };
}

/** O que o repositório precisa para filtrar no SQL. */
function filtroDeEscopo(escopo) {
  if (!escopo) return { clinica: false, agentes: [] };
  return { clinica: escopo.clinica === true, agentes: escopo.agentes === TODOS ? TODOS : [...escopo.agentes] };
}

/**
 * Contato visível? `agentesDasConversas` é o `agente_id` de cada conversa dele
 * (null = clínica). Contato sem conversa, ou com alguma conversa da clínica, é
 * da clínica. Contato só com conversas de agente é daqueles agentes.
 */
function veContato(escopo, agentesDasConversas) {
  if (!escopo) return false;
  if (escopo.admin) return true;
  const lista = agentesDasConversas ?? [];
  const soDeAgente = lista.length > 0 && lista.every((id) => id !== null && id !== undefined);
  if (escopo.clinica && !soDeAgente) return true;
  return lista.some((id) => id !== null && id !== undefined && veAgente(escopo, id));
}

// Rotas que quem NÃO vê a clínica ainda alcança. Tudo que não está aqui é da
// clínica e responde 403 para essa pessoa — lista de permissão, não de
// proibição: rota nova nasce fechada para o colaborador da loja.
//
// De fora, de propósito (clínica): fila de SLA, tarefas, notificações, resumo
// do painel Hoje, "liberar todas", leads, agenda (inclusive a da conversa),
// temperatura e encerramento de conversa (funil de leads), métricas, IA,
// Serena, Instagram, auditoria, bloqueios, sincronia, lembretes, gestão e busca
// de contatos, usuários. Dentro das liberadas, conversa e contato ainda passam
// pelo escopo (404 quando não são dele).
const ROTAS_SEM_CLINICA = Object.freeze([
  /^\/api\/auth(\/.*)?$/,
  /^\/api\/perfil$/,
  /^\/api\/usuarios\/termos\/vigente$/,
  /^\/api\/usuarios\/termos\/\d+\/assinar$/,
  /^\/api\/usuarios\/onboarding\/trilha$/,
  /^\/api\/usuarios\/ajuda$/,
  /^\/api\/conversas$/,
  /^\/api\/conversas\/filas$/,
  /^\/api\/conversas\/escopo$/,
  /^\/api\/conversas\/eventos(\/ticket)?$/,
  /^\/api\/conversas\/\d+(\/(mensagens|anexos|assumir|etiquetas|prioridade|estado|notas|ficha))?$/,
  /^\/api\/contatos\/\d+(\/conversas)?$/,
  /^\/api\/agentes(\/.*)?$/,
]);

function rotaLiberadaSemClinica(rota) {
  return ROTAS_SEM_CLINICA.some((padrao) => padrao.test(String(rota ?? '')));
}

class ErroSemAcessoAClinica extends Error {
  constructor() {
    super('sem acesso à clínica');
    this.name = 'ErroSemAcessoAClinica';
    this.status = 403;
    this.codigo = 'sem_acesso_clinica';
  }
}

module.exports = {
  TODOS,
  ROTAS_SEM_CLINICA,
  montarEscopo,
  veAgente,
  veConversaDe,
  veContato,
  recortarPedidoDeAgente,
  filtroDeEscopo,
  rotaLiberadaSemClinica,
  ErroSemAcessoAClinica,
};
