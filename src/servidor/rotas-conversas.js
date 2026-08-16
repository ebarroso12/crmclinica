'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { FILAS, ESTADOS, PRIORIDADES, TEMPERATURAS, lerTemperatura } = require('../dominio/conversas');
const { agruparPorColuna, sugerirTemperatura } = require('../dominio/leads');
const { proximaAcao } = require('../dominio/qualificacao');

// API do inbox local. O banco do crmclinica é a fonte de dados; não há
// serviço externo de conversas por trás destas rotas.

const LIMITE_TEXTO = 4000;
const ORDENACOES = ['asc', 'desc'];
const REGEX_DATA = /^\d{4}-\d{2}-\d{2}$/;

// O dia da recepção é o dia em Franca/SP, não o UTC do servidor. Sem fuso
// fixo, filtrar "hoje" às 21h viraria "amanhã" para o banco. O Brasil não
// observa mais horário de verão desde 2019, então -03:00 vale o ano inteiro.
function limitesDoDia(data) {
  return {
    inicio: `${data}T00:00:00-03:00`,
    fim: `${data}T23:59:59.999-03:00`,
  };
}

function exigirTexto(valor, campo, limite = LIMITE_TEXTO) {
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

async function exigirConversa(repositorio, id) {
  const conversa = await repositorio.obterConversa(id);
  if (!conversa) {
    const erro = new Error('conversa não encontrada');
    erro.status = 404;
    throw erro;
  }
  return conversa;
}

function criarRotasDeConversas({ repositorio, atendimento, emissorDeConversas = null }) {
  return {
    /** GET /api/conversas/filas — vocabulário do inbox, para a interface montar os controles. */
    async listarFilas() {
      const etiquetas = await repositorio.listarEtiquetas();
      return {
        filas: Object.entries(FILAS).map(([chave, definicao]) => ({ chave, ...definicao })),
        estados: ESTADOS,
        prioridades: PRIORIDADES,
        temperaturas: TEMPERATURAS,
        etiquetas,
      };
    },

    /** GET /api/conversas?fila=…&status=…&busca=…&contato=… */
    async listarConversas(parametros) {
      const fila = parametros.get('fila') || 'todos';
      if (!FILAS[fila]) throw new ErroDeContrato(`fila desconhecida: ${fila}`, 'fila');

      const status = parametros.get('status');
      if (status && !ESTADOS.includes(status)) {
        throw new ErroDeContrato(`status desconhecido: ${status}`, 'status');
      }

      const ordenacao = parametros.get('ordenacao') || 'desc';
      if (!ORDENACOES.includes(ordenacao)) {
        throw new ErroDeContrato(`ordenacao desconhecida: ${ordenacao}`, 'ordenacao');
      }

      // Filtro por data: um dia só, o mesmo que a interface mostra num seletor.
      // Início e fim viram o intervalo do dia inteiro, no fuso da clínica.
      const dataParam = parametros.get('data');
      if (dataParam && !REGEX_DATA.test(dataParam)) {
        throw new ErroDeContrato('campo "data" deve estar no formato AAAA-MM-DD', 'data');
      }
      const { inicio: dataInicio, fim: dataFim } = dataParam ? limitesDoDia(dataParam) : {};

      const contatoParam = parametros.get('contato');
      const conversas = await repositorio.listarConversas({
        status: status || null,
        busca: parametros.get('busca') || null,
        contatoId: contatoParam ? exigirIdentificador(contatoParam, 'contato') : null,
        dataInicio: dataInicio || null,
        dataFim: dataFim || null,
        ordenacao,
        limite: 50,
      });

      // A fila é um recorte de quem responde, não um filtro do banco.
      const filtradas = fila === 'minhas'
        ? conversas.filter((conversa) => conversa.assumida_por_humano || conversa.atribuido_a)
        : fila === 'nao_atribuidas'
          ? conversas.filter((conversa) => !conversa.assumida_por_humano && !conversa.atribuido_a)
          : conversas;

      // A próxima ação vai junto: é o que a recepção lê sem abrir a conversa.
      const comAcao = filtradas.map((conversa) => ({
        ...conversa,
        proxima_acao: conversa.lead_id ? proximaAcao(conversa) : null,
      }));

      return { fila, rotulo: FILAS[fila].rotulo, total: comAcao.length, conversas: comAcao };
    },

    /** GET /api/conversas/:id — conversa, ficha, notas e conversas anteriores. */
    async obterConversa(conversaId) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const conversa = await exigirConversa(repositorio, id);

      const [contato, notas, anteriores] = await Promise.all([
        repositorio.obterContato(conversa.contato_id),
        repositorio.listarNotas(conversa.contato_id),
        repositorio.listarConversas({ contatoId: conversa.contato_id, limite: 20 }),
      ]);

      return {
        // A próxima ação acompanha a conversa aberta, não só a lista: quem já
        // está na thread precisa ver o que perguntar sem voltar para a esquerda.
        conversa: {
          ...conversa,
          proxima_acao: conversa.lead_id ? proximaAcao(conversa) : null,
        },
        ficha: {
          ...contato,
          notas,
          conversas_anteriores: anteriores
            .filter((anterior) => anterior.id !== id)
            .map((anterior) => ({
              id: anterior.id,
              status: anterior.status,
              canal: anterior.canal,
              em: anterior.ultima_msg_em || anterior.criado_em,
            })),
        },
        temperatura: lerTemperatura(conversa.etiquetas),
      };
    },

    /**
     * GET /api/conversas/:id/mensagens — a thread completa.
     *
     * Bug B, item 2 ("chat completo"): antes só devolvia `mensagens` — quem
     * assumiu, devolveu ou resolveu a conversa, e qualquer envio abortado
     * pela barreira final, ficava invisível na tela mesmo depois de
     * recarregar. Agora mescla `mensagens` com os eventos operacionais da
     * mesma conversa (conversas_eventos, migration 037), ordenados por
     * `criado_em` — as duas fontes têm sequências (`id`) INDEPENDENTES, não
     * comparáveis entre si, então a ordem determinística possível aqui é por
     * tempo; `Array.prototype.sort` é estável no Node, e mensagens entram
     * primeiro na concatenação, então um empate exato de timestamp mantém a
     * mensagem antes do evento — nunca o contrário, nunca aleatório.
     */
    async listarMensagens(conversaId) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);

      const mensagens = (await repositorio.listarMensagens(id))
        .map((mensagem) => ({ ...mensagem, tipo_item: 'mensagem' }));

      if (!repositorio.listarEventosOperacionaisDaConversa) return mensagens;

      // BLOQUEADOR 2 (auditoria PR #34): um rollback da migration 037 (ou um
      // deploy deste código ANTES da migration rodar) faz `conversas_eventos`
      // sumir. Antes desta correção, o erro do Postgres (42P01,
      // `undefined_table`) subia sem tratamento e virava HTTP 500 — a
      // recepção perdia a THREAD INTEIRA (`mensagens`, que sempre existiu),
      // não só os eventos operacionais que esta consulta adiciona. Só
      // `42P01` ativa o fallback (checado pelo CÓDIGO do erro, nunca pela
      // mensagem de texto); qualquer outro (permissão — 42501 —, conexão,
      // corrupção) propaga — nunca finge "sem eventos" quando o problema é
      // outro.
      let eventos;
      try {
        eventos = (await repositorio.listarEventosOperacionaisDaConversa(id))
          .map((evento) => ({ ...evento, tipo_item: 'evento' }));
      } catch (erro) {
        if (erro.code !== '42P01') throw erro;
        console.error(`[rotas-conversas] conversas_eventos ausente (42P01) — thread degradada para só mensagens (conversa ${id}): ${erro.message}`);
        return mensagens;
      }

      return [...mensagens, ...eventos]
        .sort((a, b) => new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime());
    },

    /** POST /api/conversas/:id/mensagens — resposta humana; assumir vem junto. */
    async responder(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);

      const texto = exigirTexto(corpo?.texto, 'texto');
      const privada = Boolean(corpo?.privada);

      const mensagem = await atendimento.responderComoEquipe(id, texto, {
        usuarioId: corpo?.usuario_id ?? null,
        autorNome: corpo?.autor ?? null,
        privada,
      });

      // Dizer "enviada" quando o envio falhou é o pior desfecho possível: quem
      // respondeu vai embora achando que resolveu, e o paciente continua sem
      // resposta. A tela precisa saber a diferença.
      const naoSaiu = mensagem?.enviada === false;

      return {
        mensagem,
        enviada: privada ? null : mensagem?.enviada !== false,
        ...(naoSaiu ? { motivo_falha: mensagem.motivo_falha ?? null } : {}),
        // Responder assume a conversa: é o gesto que diz "eu cuido deste".
        detalhe: privada
          ? 'Nota interna registrada.'
          : (naoSaiu
            ? 'A mensagem foi gravada, mas NÃO chegou ao paciente. Verifique o WhatsApp e reenvie.'
            : 'Mensagem enviada. A resposta automática está pausada.'),
      };
    },

    /** POST /api/conversas/:id/assumir — assume e pausa a IA. */
    async assumir(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);

      if (corpo?.liberar === true) {
        return { conversa: await atendimento.liberar(id), detalhe: 'Conversa devolvida à automação.' };
      }

      const conversa = await atendimento.assumir(id, corpo?.usuario_id ?? null, {
        pausarMinutos: corpo?.pausar_minutos ?? null,
      });
      return { conversa, detalhe: 'Conversa assumida. A resposta automática está pausada.' };
    },

    /** POST /api/conversas/:id/etiquetas — substitui o conjunto de etiquetas. */
    async definirEtiquetas(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);

      if (!Array.isArray(corpo?.etiquetas)) {
        throw new ErroDeContrato('campo "etiquetas" deve ser uma lista', 'etiquetas');
      }

      const nomes = corpo.etiquetas.map((nome) => String(nome).trim()).filter(Boolean);
      const aplicadas = await repositorio.definirEtiquetasDaConversa(id, nomes);

      // A temperatura vive nas etiquetas; o lead precisa refletir a mesma verdade.
      const temperatura = lerTemperatura(aplicadas);
      const conversa = await repositorio.obterConversa(id);
      if (temperatura) await repositorio.salvarLead(conversa.contato_id, { conversaId: id, temperatura });

      const ignoradas = nomes.filter((nome) => !aplicadas.includes(nome));
      return { conversa_id: id, etiquetas: aplicadas, temperatura, ignoradas };
    },

    /** PUT /api/conversas/:id/ficha — dados do contato e atributos livres. */
    async atualizarFicha(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const conversa = await exigirConversa(repositorio, id);

      const campos = {};
      for (const campo of ['nome', 'telefone', 'email', 'identificador', 'observacoes']) {
        if (corpo?.[campo] !== undefined) {
          campos[campo] = corpo[campo] === null ? null : String(corpo[campo]).trim().slice(0, 300);
        }
      }
      if (corpo?.atributos !== undefined) {
        if (typeof corpo.atributos !== 'object' || corpo.atributos === null || Array.isArray(corpo.atributos)) {
          throw new ErroDeContrato('campo "atributos" deve ser um objeto', 'atributos');
        }
        campos.atributos = corpo.atributos;
      }
      if (Object.keys(campos).length === 0) {
        throw new ErroDeContrato('informe ao menos um campo da ficha');
      }

      const contato = await repositorio.atualizarContato(conversa.contato_id, campos);
      await repositorio.registrarAuditoria({
        entidade: 'contato',
        entidadeId: conversa.contato_id,
        acao: 'ficha_atualizada',
        detalhe: { campos: Object.keys(campos) },
      });

      return { ficha: contato };
    },

    /** POST /api/conversas/:id/prioridade */
    async definirPrioridade(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);
      const prioridade = exigirEnum(corpo?.prioridade, 'prioridade', PRIORIDADES);

      return { conversa: await repositorio.atualizarConversa(id, { prioridade }) };
    },

    /** POST /api/conversas/:id/estado — resolver e reabrir. */
    async definirEstado(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);
      const status = exigirEnum(corpo?.status, 'status', ESTADOS);

      // Achado da auditoria adversarial deste lote: este era o único caminho
      // que ainda publicava evento e auditava INCONDICIONALMENTE — dois
      // cliques em "Resolver" (ou um retry de rede) gravavam dois eventos
      // `conversa_resolvida`, e a thread passava a mostrar "Conversa marcada
      // como resolvida." duas vezes. Mesmo padrão que `assumir`/`liberar` já
      // usam: `null` = não houve transição de verdade, nada a anunciar.
      const transicao = repositorio.definirStatusSeNecessario
        ? await repositorio.definirStatusSeNecessario(id, status)
        : await repositorio.atualizarConversa(id, { status });

      if (!transicao) return { conversa: await repositorio.obterConversa(id) };

      if (status === 'resolvida') {
        emissorDeConversas?.publicarConversaResolvida?.(id);
      }
      await repositorio.registrarAuditoria({
        entidade: 'conversa',
        entidadeId: id,
        acao: status === 'resolvida' ? 'resolvida' : 'reaberta',
      });

      return { conversa: transicao };
    },

    /** POST /api/conversas/:id/temperatura */
    async definirTemperatura(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);
      const temperatura = exigirEnum(corpo?.temperatura, 'temperatura', TEMPERATURAS);

      return atendimento.definirTemperatura(id, temperatura);
    },

    /** POST /api/conversas/:id/notas — nota na ficha do contato. */
    async criarNota(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const conversa = await exigirConversa(repositorio, id);
      const texto = exigirTexto(corpo?.texto, 'texto');

      const nota = await repositorio.criarNota(conversa.contato_id, texto, corpo?.usuario_id ?? null);
      return { nota, contato_id: conversa.contato_id };
    },

    /**
     * GET /api/leads — kanban; cada card sabe qual conversa abrir.
     * Aceita a lista já enriquecida com score e próxima ação.
     */
    async listarLeads(jaEnriquecidos = null) {
      const leads = jaEnriquecidos ?? await repositorio.listarLeads();
      return { total: leads.length, colunas: agruparPorColuna(leads) };
    },

    /** GET /api/contatos/:id/conversas — histórico ao clicar no nome. */
    async historicoDoContato(contatoId) {
      const id = exigirIdentificador(contatoId, 'contato_id');
      const contato = await repositorio.obterContato(id);
      if (!contato) {
        const erro = new Error('contato não encontrado');
        erro.status = 404;
        throw erro;
      }

      const [conversas, notas] = await Promise.all([
        repositorio.listarConversas({ contatoId: id, limite: 50 }),
        repositorio.listarNotas(id),
      ]);

      return { contato, notas, conversas };
    },

    /** Usado pelo webhook de canal: grava a mensagem e roda o ciclo de atendimento. */
    async receberMensagemDeCanal(evento, opcoes = {}) {
      return atendimento.receberMensagem(evento, opcoes);
    },

    /** Diagnóstico: o que a automação faria com esta conversa agora. */
    async sugerir(conversaId) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const conversa = await exigirConversa(repositorio, id);
      return { conversa_id: id, sugestao: sugerirTemperatura(conversa) };
    },
  };
}

module.exports = { criarRotasDeConversas };
