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
const ACOES = Object.freeze(['registrar_contato', 'qualificar_lead', 'mover_lead']);

function criarRotasDoAgente({ repositorio, leads, configuracao }) {
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
