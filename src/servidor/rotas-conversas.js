'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { validarEventoChatwoot } = require('../contratos/evento-chatwoot');
const { webhookAutentico } = require('../integracoes/chatwoot');
const { FILAS, PRIORIDADES, ESTADOS, TEMPERATURAS } = require('../dominio/conversas');
const { projetarLead, agruparPorColuna } = require('../dominio/leads');

// Rotas da camada de conversas. Elas são uma fachada fina sobre o Chatwoot:
// nenhuma mensagem é armazenada aqui, e o token do Chatwoot nunca chega ao navegador.

function exigirTexto(valor, campo, limite = 4000) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  if (!bruto) throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
  if (bruto.length > limite) throw new ErroDeContrato(`campo "${campo}" excede ${limite} caracteres`, campo);
  return bruto;
}

function exigirEnum(valor, campo, permitidos) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  if (!permitidos.includes(bruto)) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um de: ${permitidos.join(', ')}`, campo);
  }
  return bruto;
}

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

/**
 * Monta as rotas de conversas.
 * `contexto` traz o cliente do Chatwoot, o sincronizador, o registro de idempotência
 * e a configuração — todos injetáveis para teste.
 */
function criarRotasDeConversas(contexto) {
  const { chatwoot, sincronizador, idempotencia, configuracao } = contexto;

  function exigirChatwoot() {
    if (!chatwoot?.disponivel) {
      const erro = new Error('Integração com o Chatwoot não está configurada');
      erro.codigo = 'chatwoot_nao_configurado';
      throw erro;
    }
  }

  return {
    /** GET /api/conversas/filas — as três filas que a equipe usa. */
    async listarFilas() {
      return {
        filas: Object.entries(FILAS).map(([chave, definicao]) => ({
          chave,
          rotulo: definicao.rotulo,
        })),
        prioridades: PRIORIDADES,
        estados: ESTADOS,
        temperaturas: Object.keys(TEMPERATURAS),
      };
    },

    /** GET /api/conversas?fila=…&estado=… */
    async listarConversas(parametros) {
      exigirChatwoot();
      const fila = parametros.get('fila') || 'nao_atribuidas';
      if (!FILAS[fila]) throw new ErroDeContrato(`fila desconhecida: ${fila}`, 'fila');

      const estado = parametros.get('estado') || 'open';
      if (!ESTADOS.includes(estado)) throw new ErroDeContrato(`estado desconhecido: ${estado}`, 'estado');

      return chatwoot.listarConversas({ fila, estado });
    },

    /** GET /api/conversas/:id — conversa, thread e ficha do contato juntas. */
    async obterConversa(conversaId) {
      exigirChatwoot();
      const id = exigirIdentificador(conversaId, 'conversa_id');

      const conversa = await chatwoot.obterConversa(id);
      const mensagens = await chatwoot.listarMensagens(id);

      let ficha = null;
      if (conversa.contato?.id) {
        const [contato, anteriores, notas] = await Promise.all([
          chatwoot.obterContato(conversa.contato.id),
          chatwoot.listarConversasDoContato(conversa.contato.id),
          chatwoot.listarNotas(conversa.contato.id),
        ]);
        ficha = {
          ...contato,
          notas,
          conversas_anteriores: anteriores
            .filter((anterior) => anterior.id !== id)
            .map((anterior) => ({ id: anterior.id, estado: anterior.estado, em: anterior.ultimaAtividadeEm })),
        };
      }

      return { conversa, mensagens, ficha, lead: projetarLead(conversa) };
    },

    /** POST /api/conversas/:id/mensagens — resposta humana da equipe. */
    async responder(conversaId, corpo) {
      exigirChatwoot();
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const texto = exigirTexto(corpo?.texto, 'texto');
      const privada = Boolean(corpo?.privada);

      return chatwoot.responder(id, texto, { privada });
    },

    /** POST /api/conversas/:id/atribuicao — agente ou time. */
    async atribuir(conversaId, corpo) {
      exigirChatwoot();
      const id = exigirIdentificador(conversaId, 'conversa_id');

      if (corpo?.agente_id !== undefined) {
        return chatwoot.atribuirAgente(id, exigirIdentificador(corpo.agente_id, 'agente_id'));
      }
      if (corpo?.time_id !== undefined) {
        return chatwoot.atribuirTime(id, exigirIdentificador(corpo.time_id, 'time_id'));
      }
      throw new ErroDeContrato('informe agente_id ou time_id', 'agente_id');
    },

    /** POST /api/conversas/:id/prioridade */
    async definirPrioridade(conversaId, corpo) {
      exigirChatwoot();
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const prioridade = exigirEnum(corpo?.prioridade, 'prioridade', PRIORIDADES);

      return chatwoot.definirPrioridade(id, prioridade);
    },

    /** POST /api/conversas/:id/estado — resolver, reabrir ou deixar pendente. */
    async definirEstado(conversaId, corpo) {
      exigirChatwoot();
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const estado = exigirEnum(corpo?.estado, 'estado', ESTADOS);

      return chatwoot.definirEstado(id, estado);
    },

    /** POST /api/conversas/:id/temperatura — preserva as demais etiquetas. */
    async definirTemperatura(conversaId, corpo) {
      exigirChatwoot();
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const temperatura = exigirEnum(corpo?.temperatura, 'temperatura', Object.keys(TEMPERATURAS));

      return sincronizador.definirTemperatura(id, temperatura);
    },

    /** POST /api/conversas/:id/notas — nota na ficha do contato. */
    async criarNota(conversaId, corpo) {
      exigirChatwoot();
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const texto = exigirTexto(corpo?.texto, 'texto');

      const conversa = await chatwoot.obterConversa(id);
      if (!conversa.contato?.id) throw new ErroDeContrato('conversa sem contato associado', 'conversa_id');

      await chatwoot.criarNota(conversa.contato.id, texto);
      return { contato_id: conversa.contato.id, registrada: true };
    },

    /** GET /api/leads — kanban montado a partir das conversas do inbox. */
    async listarLeads(parametros) {
      exigirChatwoot();
      const estado = parametros.get('estado') || 'open';
      const { conversas } = await chatwoot.listarConversas({ fila: 'todos', estado });
      const leads = conversas.map(projetarLead);

      return { total: leads.length, colunas: agruparPorColuna(leads) };
    },

    /** POST /api/integracoes/chatwoot/etiquetas — cria as etiquetas de temperatura. */
    async garantirEtiquetas() {
      exigirChatwoot();
      return chatwoot.garantirEtiquetasDeTemperatura();
    },

    /**
     * POST /api/webhooks/chatwoot — recepção dos eventos do inbox.
     * Autenticidade primeiro, contrato depois, idempotência por último.
     */
    async receberWebhook({ corpoBruto, cabecalhos }) {
      const segredo = configuracao.chatwoot.segredoWebhook;

      if (segredo) {
        const autentico = webhookAutentico({
          corpoBruto,
          assinaturaRecebida: cabecalhos['x-chatwoot-assinatura'] || cabecalhos['x-chatwoot-signature'],
          tokenRecebido: cabecalhos['x-crmclinica-token'],
          segredo,
        });
        if (!autentico) {
          const erro = new Error('webhook não autenticado');
          erro.status = 401;
          throw erro;
        }
      } else if (configuracao.producao) {
        const erro = new Error('recepção indisponível sem segredo configurado');
        erro.status = 503;
        throw erro;
      }

      let entrada;
      try {
        entrada = JSON.parse(corpoBruto);
      } catch {
        throw new ErroDeContrato('corpo não é JSON válido');
      }

      const evento = validarEventoChatwoot(entrada);

      const jaProcessado = idempotencia.consultar(evento.chave_idempotencia);
      if (jaProcessado) return { ...jaProcessado, duplicado: true, status: 200 };

      const decisao = await sincronizador.tratarEvento(evento);
      const recibo = {
        aceito: true,
        duplicado: false,
        chave_idempotencia: evento.chave_idempotencia,
        evento: evento.evento,
        conversa_id: evento.conversa_id,
        decisao: decisao.acao,
        recebido_em: new Date().toISOString(),
      };

      idempotencia.registrar(evento.chave_idempotencia, recibo);
      return { ...recibo, status: 202 };
    },
  };
}

module.exports = { criarRotasDeConversas };
