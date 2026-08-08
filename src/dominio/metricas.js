'use strict';

// Montagem do resumo de métricas — a materialização do dicionário oficial
// (docs/METRICAS.md) para os dashboards.
//
// As convenções obrigatórias do dicionário são cumpridas AQUI, não em cada
// tela: todo resumo carrega o período, o fuso, os filtros e os denominadores.
// Número que sai daqui sem denominador é bug, não estilo.

const TIMEZONE = 'America/Sao_Paulo';

class ErroDeMetricas extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroDeMetricas';
    this.status = 400;
  }
}

/** Percentil por interpolação simples. Lista vazia devolve null, não zero. */
function percentil(valores, p) {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((a, b) => a - b);
  const indice = Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1);
  return Math.round(ordenados[Math.max(0, indice)] * 10) / 10;
}

/** 'YYYY-MM-DD' válido, ou erro que aponta o campo. */
function validarDia(valor, campo) {
  const texto = String(valor ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto) || Number.isNaN(new Date(`${texto}T00:00:00Z`).getTime())) {
    throw new ErroDeMetricas(`campo "${campo}" deve ser uma data YYYY-MM-DD`);
  }
  return texto;
}

/** Período padrão: os últimos 30 dias, terminando amanhã (intervalo [de, ate)). */
function periodoPadrao(agora = new Date()) {
  const dia = (data) => new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(data);

  const amanha = new Date(agora.getTime() + 24 * 3_600_000);
  const inicio = new Date(agora.getTime() - 29 * 24 * 3_600_000);
  return { de: dia(inicio), ate: dia(amanha) };
}

function criarServicoDeMetricas({ repositorio, agora = () => new Date() }) {
  if (!repositorio) throw new Error('o serviço de métricas exige o repositório');

  return {
    /**
     * O resumo completo dos dashboards de leads/conversas e agenda/Serena.
     * `de`/`ate` em YYYY-MM-DD (fuso da clínica), intervalo fechado-aberto.
     */
    async resumo({ de = null, ate = null } = {}) {
      const padrao = periodoPadrao(agora());
      const periodo = {
        de: de ? validarDia(de, 'de') : padrao.de,
        ate: ate ? validarDia(ate, 'ate') : padrao.ate,
      };
      if (periodo.de >= periodo.ate) {
        throw new ErroDeMetricas('o início do período deve vir antes do fim');
      }

      const [porDia, funil, perdas, primeiras, picos, agenda, serena, aguardando] = await Promise.all([
        repositorio.metricasLeadsPorDia(periodo),
        repositorio.metricasFunil(),
        repositorio.metricasMotivosPerda(periodo),
        repositorio.metricasPrimeiraResposta(periodo),
        repositorio.metricasPicos(periodo),
        repositorio.metricasAgenda(periodo),
        repositorio.metricasSerena(periodo),
        repositorio.listarConversasAguardando({ limite: 500 }),
      ]);

      const novos = porDia.reduce((soma, linha) => soma + linha.total, 0);

      const porOrigem = new Map();
      for (const linha of porDia) {
        porOrigem.set(linha.origem, (porOrigem.get(linha.origem) ?? 0) + linha.total);
      }

      const respondidas = primeiras.filter((linha) => linha.minutos !== null);
      const minutos = respondidas.map((linha) => linha.minutos);

      const daAgenda = new Map(agenda.map((linha) => [linha.status, linha.total]));
      const compareceu = daAgenda.get('compareceu') ?? 0;
      const faltou = daAgenda.get('faltou') ?? 0;

      return {
        // As convenções do dicionário: sem elas o número não é publicável.
        periodo: { ...periodo, timezone: TIMEZONE, intervalo: '[de, ate)' },
        filtros: { dados_sinteticos: 'excluidos (faixa 5516900000xx)' },

        leads: {
          novos,
          por_dia: porDia,
          por_origem: [...porOrigem.entries()]
            .map(([origem, total]) => ({ origem, total, denominador: novos }))
            .sort((a, b) => b.total - a.total),
          // Fotografia do funil: estoque, não fluxo — não somar com o período.
          funil_fotografia: funil,
          motivos_perda: perdas,
        },

        conversas: {
          com_inbound: primeiras.length,
          respondidas: respondidas.length,
          sem_resposta_no_periodo: primeiras.length - respondidas.length,
          primeira_resposta_minutos: {
            mediana: percentil(minutos, 50),
            p90: percentil(minutos, 90),
            base: respondidas.length,
            observacao: 'conversas ainda sem resposta não entram na mediana; estão em backlog',
          },
          // Fotografia de agora, não do período.
          backlog_aguardando: aguardando.length,
          picos,
        },

        agenda: {
          por_status: agenda,
          comparecimento: {
            numerador: compareceu,
            denominador: compareceu + faltou,
            taxa: compareceu + faltou > 0
              ? Math.round((compareceu / (compareceu + faltou)) * 1000) / 10
              : null,
          },
        },

        serena: {
          por_acao: serena,
          handoffs: serena
            .filter((linha) => ['assumida_por_humano', 'escalonada'].includes(linha.acao))
            .reduce((soma, linha) => soma + linha.total, 0),
          respostas_automacao: serena
            .filter((linha) => linha.acao === 'respondida_pela_automacao')
            .reduce((soma, linha) => soma + linha.total, 0),
          silencios: serena
            .filter((linha) => linha.acao === 'automacao_silenciada')
            .reduce((soma, linha) => soma + linha.total, 0),
        },
      };
    },
  };
}

module.exports = { criarServicoDeMetricas, percentil, periodoPadrao, TIMEZONE, ErroDeMetricas };
