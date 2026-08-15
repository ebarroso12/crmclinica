'use strict';

const crypto = require('node:crypto');
const { extrairQueixa, ofereceuFormulario } = require('./resumo-atendimento');
const { proximaAcao } = require('./qualificacao');
const {
  URL_FORMULARIO_PRE_CONSULTA, mensagemDeFormularioPreConsulta,
} = require('./formulario-pre-consulta');

// Fluxo comercial do CRM: o sino de acompanhamento, o encerramento com resumo
// interno e o formulário de pré-consulta.
//
// Três regras do produto atravessam este arquivo:
//
//   1. **O sino é idempotente.** O worker roda de minuto em minuto; a chave
//      determinística garante que a mesma inatividade gera UMA tarefa, não
//      1440 por dia.
//   2. **O resumo interno é interno.** Ele nasce marcado como privado e nunca
//      passa pelo canal. A prova está nos testes: encerrar conversa não gera
//      nenhum envio.
//   3. **Formulário só depois de agendamento confirmado.** A recusa vem antes
//      de qualquer efeito colateral, com erro que ensina o caminho.

const DIAS_DE_SILENCIO = 15;

class ErroDeFluxo extends Error {
  constructor(mensagem, codigo, status = 422) {
    super(mensagem);
    this.name = 'ErroDeFluxo';
    this.codigo = codigo;
    this.status = status;
  }
}

/**
 * A âncora do ciclo de acompanhamento: o instante da última atividade.
 *
 * A chave da tarefa deriva dela — se a equipe (ou o paciente) voltar a falar,
 * a âncora muda e um novo ciclo de 15 dias começa do zero, permitindo um novo
 * sino no futuro. Sem atividade nova, a âncora não muda e o sino não repete.
 */
function chaveDeAcompanhamento(lead) {
  const ancora = lead.ultima_msg_em ?? lead.atualizado_em ?? 'sem-atividade';
  return `acompanhamento_15d:lead:${lead.id}:${new Date(ancora).toISOString()}`;
}

/**
 * Monta o resumo interno do encerramento: nome, telefone, síntese, agendou
 * sim/não e pendência — exatamente os cinco campos que a equipe lê.
 *
 * A síntese cita o paciente, não interpreta: resumir sintoma é atividade
 * clínica, e este módulo recorta e transcreve.
 */
function montarResumoInterno({ contato, mensagens = [], agendamento = null, lead = null, agora = new Date() }) {
  const queixa = extrairQueixa(mensagens);
  const doPaciente = mensagens.filter((m) => m.autor_tipo === 'contato').length;
  const daClinica = mensagens.filter((m) => m.autor_tipo !== 'contato' && !m.privada).length;

  const pendencia = lead ? proximaAcao(lead) : null;

  const quando = agendamento
    ? new Date(agendamento.inicio).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    : null;

  return [
    'Resumo interno do atendimento',
    '',
    `Nome: ${contato?.nome?.trim() || 'não informado'}`,
    `Telefone: ${contato?.telefone ?? '—'}`,
    '',
    `Síntese: ${queixa ?? 'sem relato registrado'}`,
    `Mensagens: ${doPaciente} do paciente, ${daClinica} da clínica`,
    '',
    agendamento ? `Agendou: SIM — ${quando}` : 'Agendou: NÃO',
    `Formulário: ${ofereceuFormulario(mensagens) ? 'oferecido' : 'não oferecido'}`,
    `Pendência: ${pendencia ?? 'nenhuma registrada'}`,
    '',
    `Encerrado em ${agora.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })}`,
  ].join('\n');
}

function criarServicoDeFluxo({ repositorio, canal = null, agora = () => new Date() }) {
  if (!repositorio) throw new Error('o serviço de fluxo exige o repositório');

  return {
    /**
     * Varre leads parados há N dias e cria a tarefa de acompanhamento.
     * Idempotente por chave: rodar duas vezes no mesmo ciclo não duplica.
     */
    async gerarTarefasDeAcompanhamento({ dias = DIAS_DE_SILENCIO } = {}) {
      const inativos = await repositorio.listarLeadsInativos({ dias });

      let criadas = 0;
      for (const lead of inativos) {
        const { duplicada } = await repositorio.criarTarefa({
          chave: chaveDeAcompanhamento(lead),
          tipo: 'acompanhamento_15d',
          titulo: `Retomar contato com ${lead.nome ?? 'lead sem nome'}`,
          detalhe: `Sem atividade há ${dias}+ dias no estágio "${lead.estagio}". Próximo passo registrado: ${lead.proximo_passo ?? 'nenhum'}.`,
          leadId: lead.id,
          conversaId: lead.conversa_id,
          contatoId: lead.contato_id,
        });
        if (!duplicada) criadas += 1;
      }

      return { avaliados: inativos.length, criadas };
    },

    /**
     * Encerra a conversa com resumo interno.
     *
     * O resumo fica na conversa e numa mensagem PRIVADA de sistema — os dois
     * caminhos que nunca chegam ao paciente: mensagens privadas não entram no
     * contexto da IA nem passam pelo canal.
     */
    async encerrarConversa(conversaId, { usuarioId = null } = {}) {
      const conversa = await repositorio.obterConversa(conversaId);
      if (!conversa) {
        const erro = new Error('conversa não encontrada');
        erro.status = 404;
        throw erro;
      }

      const [contato, mensagens, lead] = await Promise.all([
        repositorio.obterContato(conversa.contato_id),
        repositorio.listarMensagens(conversaId, { incluirPrivadas: false }),
        repositorio.obterLeadPorContato(conversa.contato_id),
      ]);
      const agendamento = await (repositorio.obterAgendamentoDoContato?.(conversa.contato_id) ?? null);

      const resumo = montarResumoInterno({
        contato, mensagens, agendamento, lead, agora: agora(),
      });

      await repositorio.definirResumoInterno(conversaId, resumo);
      await repositorio.registrarMensagem(conversaId, {
        direcao: 'saida',
        tipo: 'sistema',
        conteudo: resumo,
        autor_tipo: 'sistema',
        privada: true,
      });
      await repositorio.atualizarConversa(conversaId, { status: 'resolvida' });
      await repositorio.registrarAuditoria({
        entidade: 'conversa',
        entidadeId: conversaId,
        acao: 'encerrada_com_resumo',
        detalhe: { agendou: Boolean(agendamento) },
        usuarioId,
      });

      return { conversa_id: Number(conversaId), resumo, agendou: Boolean(agendamento) };
    },

    /**
     * Cria (ou reaproveita) o formulário de pré-consulta de um agendamento.
     *
     * A regra do produto, na ordem em que é conferida:
     *   1. o agendamento existe;
     *   2. o status é `confirmado` — nem `agendado` serve: confirmação é o
     *      aceite explícito, e formulário antes disso é triagem sem consulta;
     *   3. um formulário por agendamento — reenviar reaproveita o existente.
     */
    async enviarFormularioPreConsulta(agendamentoId, { usuarioId = null } = {}) {
      const agendamento = await repositorio.obterAgendamento(agendamentoId);
      if (!agendamento) {
        const erro = new Error('agendamento não encontrado');
        erro.status = 404;
        throw erro;
      }

      if (agendamento.status !== 'confirmado') {
        throw new ErroDeFluxo(
          `o formulário de pré-consulta só sai depois do agendamento confirmado; este está "${agendamento.status}"`,
          'agendamento_nao_confirmado',
          409,
        );
      }

      const { formulario, duplicado } = await repositorio.criarFormularioPreConsulta({
        agendamentoId: agendamento.id,
        contatoId: agendamento.contato_id,
        token: crypto.randomUUID(),
      });

      // Entrega pelo canal quando houver um. A chave determinística garante:
      // reenvio do mesmo formulário não bombardeia o paciente.
      let entrega = { enviada: false, motivo: 'canal_nao_configurado' };
      if (canal?.enviar) {
        try {
          const contato = await repositorio.obterContato(agendamento.contato_id);
          if (contato?.telefone) {
            // O texto e o LINK vêm do módulo canônico. Antes, esta mensagem
            // prometia um formulário "que a equipe vai te enviar" e não
            // mandava link nenhum — o que empurrava o envio do link para fora
            // do CRM (a Serena, ou alguém no WhatsApp na mão), que é
            // exatamente onde o questionário errado tinha como entrar.
            await canal.enviar({
              telefone: contato.telefone,
              texto: mensagemDeFormularioPreConsulta({ nome: contato.nome ?? null }),
              chave: `formulario:${agendamento.id}`,
            });
            entrega = { enviada: true };
          } else {
            entrega = { enviada: false, motivo: 'contato_sem_telefone' };
          }
        } catch (erro) {
          entrega = { enviada: false, motivo: erro.message };
        }
      }

      await repositorio.marcarFormularioEnviado(formulario.id);
      await repositorio.registrarAuditoria({
        entidade: 'agendamento',
        entidadeId: agendamento.id,
        acao: 'formulario_pre_consulta_enviado',
        // `url` entra no livro de propósito: é o que permite provar, depois,
        // QUAL link foi para o paciente — sem guardar telefone, nome, texto
        // da mensagem nem qualquer resposta do formulário (essas ficam em
        // `formularios_pre_consulta.respostas`, de leitura humana apenas).
        detalhe: {
          formulario_id: formulario.id,
          duplicado,
          entregue: entrega.enviada,
          url: URL_FORMULARIO_PRE_CONSULTA,
        },
        usuarioId,
      });

      return { formulario, duplicado, entrega };
    },
  };
}

module.exports = {
  criarServicoDeFluxo,
  montarResumoInterno,
  chaveDeAcompanhamento,
  ErroDeFluxo,
  DIAS_DE_SILENCIO,
};
