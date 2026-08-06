'use strict';

const { ErroDeContrato } = require('../contratos/erros');

// API que a Serena usa para operar o CRM.
//
// Até agora ela só conversava: o `TOOLS.md` dela proibia qualquer escrita, e a
// consequência era a equipe transcrevendo à mão o que a conversa já dizia — quem
// é a pessoa, o que ela procura, em que ponto do funil está.
//
// ------------------------------------------------------------ o que ela pode
//
// Registrar contato, qualificar lead e mover etapa. É o que a conversa produz
// naturalmente, e o que se perde quando ninguém transcreve.
//
// ------------------------------------------------------- o que ela não pode
//
// Apagar, alterar agenda, mexer em usuário, ler dado clínico ou tocar em
// qualquer coisa financeira. Não é desconfiança do agente: é que essas ações
// não têm volta e não nascem de uma conversa — nascem de uma decisão de quem
// responde pela clínica.
//
// O token é próprio, e o escopo é este arquivo. Um agente com a credencial da
// aplicação teria, na prática, todo o poder da aplicação.

/** Ações permitidas, uma a uma. Lista fechada: o que não está aqui não existe. */
const ACOES = Object.freeze([
  'registrar_contato', 'qualificar_lead', 'mover_lead',
  // A Serena oferecia horario sem ter como consultar a agenda: dizia 'posso
  // verificar' e, se a pessoa aceitasse, nao tinha o que verificar.
  'consultar_horarios', 'agendar',
]);

function criarRotasDoAgente({ repositorio, leads, agenda = null, configuracao }) {
  const segredo = configuracao?.agente?.token ?? '';

  /**
   * Confere o token do agente.
   *
   * Comparação de tamanho constante seria melhor, mas o ganho aqui é teórico: o
   * token não viaja por rede pública (o agente roda no mesmo servidor) e o
   * limitador de tentativas já cobre o resto.
   */
  function autorizar(cabecalhos) {
    if (!segredo) {
      const erro = new Error('API do agente não configurada');
      erro.status = 503;
      throw erro;
    }

    const recebido = String(cabecalhos?.['x-agente-token'] ?? '').trim();
    if (recebido !== segredo) {
      const erro = new Error('token do agente inválido');
      erro.status = 401;
      throw erro;
    }
  }

  return {
    ACOES,

    /**
     * POST /api/agente/acao — a única porta.
     *
     * Uma rota só, com a ação no corpo, em vez de uma rota por operação: torna
     * a lista de permissões literal — quem lê `ACOES` sabe tudo o que o agente
     * consegue fazer, sem procurar rotas espalhadas pelo servidor.
     */
    async executar(cabecalhos, corpo) {
      autorizar(cabecalhos);

      const acao = String(corpo?.acao ?? '').trim();
      if (!ACOES.includes(acao)) {
        throw new ErroDeContrato(`ação desconhecida: "${acao}"`, 'acao');
      }

      // Consultar horário não é sobre ninguém: a pessoa pode perguntar "quando
      // tem vaga?" antes de dizer quem é, e exigir telefone aqui obrigaria a
      // Serena a pedir o número para responder uma pergunta que não precisa dele.
      if (acao === 'consultar_horarios') {
        if (!agenda) {
          const erro = new Error('agenda não configurada');
          erro.status = 503;
          throw erro;
        }

        const profissionais = await repositorio.listarProfissionais?.({ apenasAtivos: true }) ?? [];
        const profissional = profissionais[0];
        if (!profissional) return { horarios: [], motivo: 'nenhum profissional ativo' };

        // Uma semana à frente. Mais que isso devolveria uma lista que ninguém
        // lê no WhatsApp; menos deixaria a agenda parecer vazia por causa da
        // carência de três dias, que come os primeiros.
        const dias = Math.min(Number(corpo?.dias) || 7, 14);
        const encontrados = [];

        for (let salto = 0; salto <= dias && encontrados.length < 6; salto += 1) {
          const dia = new Date();
          dia.setDate(dia.getDate() + salto);
          dia.setHours(12, 0, 0, 0);

          const { horarios } = await agenda.oferecerHorarios({
            profissionalId: profissional.id, dia: dia.toISOString(),
          });
          encontrados.push(...horarios.slice(0, 3));
        }

        return {
          profissional: profissional.nome,
          duracao_min: profissional.duracao_min,
          horarios: encontrados.slice(0, 6).map((h) => ({
            inicio: h.inicio,
            fim: h.fim,
            // Já formatado: pedir ao modelo que converta ISO para "quinta, 14h"
            // é como ele erra data — e data errada vira paciente no dia errado.
            quando: new Date(h.inicio).toLocaleString('pt-BR', {
              timeZone: 'America/Sao_Paulo',
              weekday: 'long', day: '2-digit', month: '2-digit',
              hour: '2-digit', minute: '2-digit',
            }),
          })),
        };
      }

      const telefone = String(corpo?.telefone ?? '').trim();
      if (!telefone) throw new ErroDeContrato('informe o telefone do paciente', 'telefone');

      const contato = await repositorio.encontrarOuCriarContato({
        telefone,
        nome: corpo?.nome ?? null,
        canal: 'whatsapp',
      });

      if (acao === 'registrar_contato') {
        // Nome que chega depois do primeiro contato é o caso comum: a pessoa se
        // apresenta na segunda mensagem, e a ficha nasceu sem nome.
        if (corpo?.nome && !contato.nome) {
          await repositorio.atualizarContato?.(contato.id, { nome: corpo.nome });
        }
        return { contato_id: contato.id, registrado: true };
      }

      const lead = await repositorio.obterLeadPorContato(contato.id)
        ?? await repositorio.salvarLead(contato.id, { origem: 'whatsapp' });

      if (acao === 'qualificar_lead') {
        const campos = corpo?.qualificacao ?? {};
        await leads.qualificar(lead.id, campos, { origem: 'automacao' });
        return { lead_id: lead.id, qualificado: true };
      }

      if (acao === 'agendar') {
        if (!agenda) {
          const erro = new Error('agenda não configurada');
          erro.status = 503;
          throw erro;
        }

        const profissionais = await repositorio.listarProfissionais?.({ apenasAtivos: true }) ?? [];
        const profissional = profissionais[0];
        if (!profissional) throw new ErroDeContrato('nenhum profissional ativo', 'profissional');

        const proposta = await agenda.propor({
          profissionalId: profissional.id,
          contatoId: contato.id,
          leadId: lead.id,
          inicio: corpo?.inicio,
          fim: corpo?.fim,
          tipo: 'consulta',
        });

        // Confirma na mesma ação: o paciente já escolheu o horário na conversa,
        // e deixar a consulta "proposta" a faria existir para ele e não para a
        // clínica — ninguém confirmaria, e ele apareceria num dia sem vaga.
        //
        // A trava de conflito continua sendo do banco: se alguém pegou o horário
        // entre a oferta e este ponto, a gravação falha e o erro sobe.
        const agendamento = await agenda.confirmar(proposta.token, { observacoes: corpo?.observacoes ?? null });

        // O lead avança sozinho: quem marcou não está mais pesquisando, e deixar
        // o funil parado obrigaria alguém a arrastar o card para refletir algo
        // que já aconteceu.
        //
        // O nome é o do funil ('agendado'), não o do ato ('agendamento') — a
        // auditoria pegou esta rota avançando para uma etapa que não existe, com
        // o catch engolindo a recusa: 34 consultas marcadas, nenhum card movido.
        // A consulta vale mais que o card, então a falha continua não desfazendo
        // o agendamento — mas agora ela aparece no log em vez de sumir.
        await leads.moverEstagio(lead.id, 'agendado', { origem: 'automacao' }).catch((erro) => {
          console.error(`[agente] lead ${lead.id} não avançou para "agendado": ${erro.message}`);
        });

        return {
          lead_id: lead.id,
          agendamento_id: agendamento.id,
          confirmado: true,
          quando: new Date(agendamento.inicio).toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
          }),
        };
      }

      // mover_lead
      const estagio = String(corpo?.estagio ?? '').trim();
      if (!estagio) throw new ErroDeContrato('informe a etapa do funil', 'estagio');

      // A autoria fica registrada como automação, não como pessoa: quem ler o
      // histórico daqui a um mês precisa saber que quem moveu foi a Serena.
      const atualizado = await leads.moverEstagio(lead.id, estagio, { origem: 'automacao' });
      return { lead_id: lead.id, estagio: atualizado?.estagio ?? estagio };
    },
  };
}

module.exports = { criarRotasDoAgente, ACOES };
