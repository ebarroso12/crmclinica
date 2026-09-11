'use strict';

// Quem recebe o resumo de atendimento (docs/RESUMOS.md).
//
// Decisão do Dr. Edson (11/09/2026): "quem tem de receber resumo é só a equipe,
// somente a equipe — a equipe da clínica recebe da clínica e a equipe da Alpins
// recebe da Alpins". Então:
//
//   clínica (conversa sem agente) → quem vê a clínica: admin sempre; gestor e
//                                   atendente com `acesso_clinica`;
//   agente                        → só quem está na equipe DAQUELE agente —
//                                   admin inclusive: fora da equipe, não recebe.
//
// E, nos dois casos: conta ativa, não excluída, `recebe_resumo` ligado e um
// WhatsApp do cadastro que a pessoa AUTORIZOU para uso operacional.
//
// Por que a autorização: o aviso-equipe (commit 49a5456) não lê o cadastro — usa
// a lista do ambiente —, e a única regra que o sistema tem para usar o número
// particular de alguém é a de P1-06 (`autorizarWhatsappParticular`, com quem e
// quando autorizou). Número cadastrado sem autorização não recebe nada. O campo
// livre `usuarios.telefone` não é usado: nada no sistema manda mensagem para ele.
//
// Número de pessoa nunca sai daqui para log, auditoria ou tela sem máscara.

const MOTIVOS = Object.freeze({
  pausado: 'resumos pausados pelo administrador',
  sem_whatsapp: 'sem WhatsApp no cadastro',
  whatsapp_nao_autorizado: 'WhatsApp cadastrado, mas sem autorização de uso',
});

const digitos = (valor) => String(valor ?? '').replace(/\D/g, '');

function partesDoWhatsapp(usuario) {
  const ddi = digitos(usuario?.whatsapp_ddi) || '55';
  const ddd = digitos(usuario?.whatsapp_ddd);
  const numero = digitos(usuario?.whatsapp_numero);
  if (!/^\d{1,3}$/.test(ddi) || !/^\d{2}$/.test(ddd) || !/^\d{8,9}$/.test(numero)) return null;
  return { ddi, ddd, numero };
}

/** O WhatsApp utilizável da pessoa, em E.164 — ou `null` sem número válido ou sem autorização. */
function telefoneDoPerfil(usuario) {
  if (usuario?.whatsapp_particular_autorizado !== true) return null;
  const partes = partesDoWhatsapp(usuario);
  return partes ? `+${partes.ddi}${partes.ddd}${partes.numero}` : null;
}

/** "+55 16 9****-3215": dá para a pessoa reconhecer o próprio número, não para discar. */
function mascararWhatsapp(usuario) {
  const partes = partesDoWhatsapp(usuario);
  if (!partes) return null;
  const { ddi, ddd, numero } = partes;
  return `+${ddi} ${ddd} ${numero.slice(0, numero.length - 8)}****-${numero.slice(-4)}`;
}

/** Por que esta pessoa não recebe — `null` quando recebe. */
function motivoSemEntrega(usuario) {
  if (usuario?.recebe_resumo === false) return 'pausado';
  if (!partesDoWhatsapp(usuario)) return 'sem_whatsapp';
  if (usuario.whatsapp_particular_autorizado !== true) return 'whatsapp_nao_autorizado';
  return null;
}

const veAClinica = (usuario) => usuario?.papel === 'admin' || usuario?.acesso_clinica !== false;
const estaNaEquipe = (usuario, agenteId) => (usuario?.agentes ?? []).map(Number).includes(Number(agenteId));

/**
 * Quem recebe o resumo de um grupo: `agenteId === null` é a clínica.
 * `pessoas` vem de `repositorio.listarDestinatariosDeResumo()` (já só contas ativas).
 */
function destinatariosDoGrupo(pessoas = [], agenteId = null) {
  return pessoas
    .filter((pessoa) => motivoSemEntrega(pessoa) === null)
    .filter((pessoa) => (agenteId === null ? veAClinica(pessoa) : estaNaEquipe(pessoa, agenteId)))
    .map((pessoa) => ({ usuario_id: Number(pessoa.id), nome: pessoa.nome, telefone: telefoneDoPerfil(pessoa) }));
}

/**
 * Instância da Evolution por onde sai o resumo de um agente. `null` = não sai:
 * mandar pelo número da clínica quebraria a invariante 2 de docs/AGENTES.md.
 */
function instanciaDoAgente(agente) {
  const canal = (agente?.canais ?? []).find((item) => item.canal === 'whatsapp' && item.ativo !== false);
  return canal ? canal.instancia : null;
}

/**
 * Os números que o atendimento trata como da equipe: todo WhatsApp autorizado de
 * conta ativa — com ou sem resumo ligado, porque quem pausou ainda pode responder
 * a um resumo antigo, e essa resposta não é cliente de ninguém.
 */
function telefonesInternosDoCadastro(pessoas = []) {
  return pessoas.map(telefoneDoPerfil).filter(Boolean);
}

/** O painel da tela de Usuários: destinatários efetivos por grupo, sempre mascarados. */
function montarPainelDeDestinatarios({ pessoas = [], agentes = [] } = {}) {
  const mascarar = (lista) => lista.map(({ usuario_id: id }) => {
    const pessoa = pessoas.find((item) => Number(item.id) === id);
    return { usuario_id: id, nome: pessoa.nome, whatsapp: mascararWhatsapp(pessoa) };
  });

  const grupos = [{
    grupo: 'clinica', agente_id: null, nome: 'Clínica', sai_pelo_numero: 'da clínica', sem_canal: false,
    destinatarios: mascarar(destinatariosDoGrupo(pessoas, null)),
  }];
  for (const agente of agentes) {
    const instancia = instanciaDoAgente(agente);
    grupos.push({
      grupo: 'agente', agente_id: Number(agente.id), nome: agente.nome,
      sai_pelo_numero: instancia ? 'do agente' : null, sem_canal: !instancia,
      destinatarios: mascarar(destinatariosDoGrupo(pessoas, agente.id)),
    });
  }

  // Quem estaria em algum grupo e não recebe: o que o admin precisa resolver.
  const semEntrega = pessoas
    .filter((pessoa) => veAClinica(pessoa) || (pessoa.agentes ?? []).length > 0)
    .map((pessoa) => ({ pessoa, motivo: motivoSemEntrega(pessoa) }))
    .filter(({ motivo }) => motivo !== null)
    .map(({ pessoa, motivo }) => ({ usuario_id: Number(pessoa.id), nome: pessoa.nome, motivo, explicacao: MOTIVOS[motivo] }));

  return { grupos, sem_entrega: semEntrega };
}

module.exports = {
  MOTIVOS,
  telefoneDoPerfil,
  mascararWhatsapp,
  motivoSemEntrega,
  destinatariosDoGrupo,
  instanciaDoAgente,
  telefonesInternosDoCadastro,
  montarPainelDeDestinatarios,
};
