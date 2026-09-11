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
 * Contato visível? Decisão do Dr. Edson (11/09): a base de contatos é
 * COMPARTILHADA — quem vê a clínica vê todos os contatos, com selos de origem
 * (ver `selosDoContato`). Quem não vê a clínica só vê o contato que tem
 * conversa com um agente da própria equipe.
 *
 * `agentesDasConversas`: o `agente_id` de cada conversa do contato (null =
 * clínica). O que o contato conversou fica sempre sujeito a `veConversaDe`.
 */
function veContato(escopo, agentesDasConversas) {
  if (!escopo) return false;
  if (escopo.clinica === true) return true;
  return (agentesDasConversas ?? []).some((id) => id !== null && id !== undefined && veAgente(escopo, id));
}

/**
 * Selos automáticos de origem do contato, calculados das conversas — nada é
 * gravado. "Clínica" quando há conversa sem agente ou nenhuma conversa (contato
 * criado à mão ou importado); um selo por agente com quem conversou.
 *
 * Para quem NÃO vê a clínica, o selo "Clínica" nunca aparece: dizer ao
 * colaborador da loja que aquele cliente também é paciente já é dado de saúde.
 * Quem vê a clínica enxerga o selo de todo agente (o contato é compartilhado),
 * mesmo fora da equipe — a conversa e a prévia continuam fora do alcance dele.
 *
 * @param {{clinica: boolean, agentes: number[]}} origens  do repositório
 * @param {Map<number,string>|Record<number,string>} nomes  nome de cada agente
 */
function selosDoContato(escopo, origens, nomes = new Map()) {
  if (!escopo || !origens) return { clinica: false, agentes: [] };
  const nomeDe = (id) => (nomes instanceof Map ? nomes.get(Number(id)) : nomes?.[id]) ?? null;
  const agentes = [...new Set((origens.agentes ?? []).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0)
    .filter((id) => escopo.clinica === true || veAgente(escopo, id))
    .sort((a, b) => a - b)
    .map((id) => ({ id, nome: nomeDe(id) }));
  return { clinica: escopo.clinica === true && origens.clinica === true, agentes };
}

// Rotas que quem NÃO vê a clínica ainda alcança. Tudo que não está aqui é da
// clínica e responde 403 para essa pessoa — lista de permissão, não de
// proibição: rota nova nasce fechada para o colaborador da loja. `metodos`
// ausente = qualquer método (o RBAC e o escopo da própria rota decidem).
//
// De fora, de propósito (clínica): fila de SLA, tarefas, notificações, resumo
// do painel Hoje, "liberar todas", leads, agenda (inclusive a da conversa),
// temperatura e encerramento de conversa (funil de leads), métricas, IA,
// Serena, Instagram, auditoria, bloqueios, sincronia, lembretes, cadastro,
// exclusão, restauração, duplicatas e qualidade de contatos, usuários. Dentro
// das liberadas, conversa e contato ainda passam pelo escopo (404 quando não
// são dele).
const ROTAS_SEM_CLINICA = Object.freeze([
  { padrao: /^\/api\/auth(\/.*)?$/ },
  { padrao: /^\/api\/perfil$/ },
  { padrao: /^\/api\/usuarios\/termos\/vigente$/, metodos: ['GET'] },
  { padrao: /^\/api\/usuarios\/termos\/\d+\/assinar$/, metodos: ['POST'] },
  { padrao: /^\/api\/usuarios\/onboarding\/trilha$/, metodos: ['GET'] },
  { padrao: /^\/api\/usuarios\/ajuda$/, metodos: ['GET'] },
  { padrao: /^\/api\/conversas$/, metodos: ['GET'] },
  { padrao: /^\/api\/conversas\/filas$/, metodos: ['GET'] },
  { padrao: /^\/api\/conversas\/escopo$/, metodos: ['GET'] },
  { padrao: /^\/api\/conversas\/eventos(\/ticket)?$/ },
  { padrao: /^\/api\/conversas\/\d+(\/(mensagens|anexos|assumir|etiquetas|prioridade|estado|notas|ficha))?$/ },
  { padrao: /^\/api\/contatos$/, metodos: ['GET'] },
  { padrao: /^\/api\/contatos\/gestao$/, metodos: ['GET'] },
  { padrao: /^\/api\/contatos\/\d+$/, metodos: ['GET', 'PUT'] },
  { padrao: /^\/api\/contatos\/\d+\/conversas$/, metodos: ['GET'] },
  { padrao: /^\/api\/agentes(\/.*)?$/ },
]);

function rotaLiberadaSemClinica(rota, metodo = 'GET') {
  const alvo = String(rota ?? '');
  const verbo = String(metodo ?? '').toUpperCase();
  return ROTAS_SEM_CLINICA.some((regra) => regra.padrao.test(alvo) && (!regra.metodos || regra.metodos.includes(verbo)));
}

class ErroSemAcessoAClinica extends Error {
  constructor() {
    super('sem acesso à clínica');
    this.name = 'ErroSemAcessoAClinica';
    this.status = 403;
    this.codigo = 'sem_acesso_clinica';
  }
}

/**
 * O contato como chega a quem NÃO vê a clínica (auditoria de acesso A2): LISTA
 * BRANCA, nunca lista negra. A mesma pessoa pode ser paciente — nome completo,
 * nascimento, responsável, consentimento, e-mail, identificador, observações,
 * atributos, documentos, opt-out e agenda são da clínica. Campo novo do contato
 * nasce FECHADO para o colaborador. `selos` já vem recortada por `selosDoContato`
 * (só os agentes dele); as datas de conversa vêm das conversas que ele vê.
 */
function contatoParaColaborador(contato, { selos = null } = {}) {
  if (!contato) return contato;
  return {
    id: contato.id,
    nome: contato.nome ?? null,
    telefone: contato.telefone ?? null,
    ...(selos ? { selos } : {}),
  };
}

module.exports = {
  TODOS,
  ROTAS_SEM_CLINICA,
  contatoParaColaborador,
  montarEscopo,
  veAgente,
  veConversaDe,
  veContato,
  selosDoContato,
  recortarPedidoDeAgente,
  filtroDeEscopo,
  rotaLiberadaSemClinica,
  ErroSemAcessoAClinica,
};
