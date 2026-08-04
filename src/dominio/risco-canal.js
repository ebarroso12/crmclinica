'use strict';

// Vigia do canal: diz quando o WhatsApp da clínica passou a correr risco real.
//
// O número atende por uma sessão pareada com QR — o mesmo mecanismo do WhatsApp
// Web. Não é a API oficial da Meta, e o WhatsApp derruba números que se
// comportam como disparador de massa. O bloqueio chega sem aviso e sem recurso
// prático: um dia a clínica simplesmente para de falar com os pacientes.
//
// Migrar para a API oficial resolveria isso, mas cobra por lembrete, exige
// aprovação de modelo de mensagem e — o que pesa mais — tira o número do
// celular da recepção. Não é uma troca que se faça por precaução vaga.
//
// Então este módulo existe para transformar "vaga" em "medida". Ele olha o que
// o próprio sistema já registra e responde uma pergunta só: **ainda dá para
// ficar como está?**
//
// ------------------------------------------------------------------ os sinais
//
// Nenhum sinal isolado condena. O que condena é o padrão que o WhatsApp
// reconhece como abuso:
//
//   • volume  — clínica manda dezenas por dia, disparador manda milhares
//   • recusa  — quem recebe o que não pediu responde PARAR ou denuncia
//   • falha   — envio que começa a falhar em série é bloqueio em andamento
//   • queda   — sessão que cai e volta o tempo todo é sessão sob suspeita
//
// A recusa é o mais importante e o menos óbvio. O WhatsApp não publica o que
// mede, mas a denúncia do destinatário é o gatilho conhecido — e o opt-out é o
// sinal mais próximo disso que temos, porque é a mesma intenção ("não quero
// isto") manifestada dentro de casa, antes de virar denúncia lá fora.

/** Acima disto, o volume deixa de parecer clínica e começa a parecer campanha. */
const VOLUME_ATENCAO_DIA = 80;
const VOLUME_RISCO_DIA = 200;

// Referência de mercado para mensagem consentida é bem abaixo de 1%. Passar de
// 2% significa que uma parte relevante de quem recebe não queria receber — e
// essas pessoas denunciam antes de pedir para parar, não depois.
const RECUSA_ATENCAO = 0.02;
const RECUSA_RISCO = 0.05;

// Falha isolada é rede. Falha em série, com o gateway de pé, é o WhatsApp
// recusando as mensagens deste número.
const FALHA_ATENCAO = 0.15;
const FALHA_RISCO = 0.35;

/** Sessão saudável cai raramente. Cair todo dia é sintoma, não acaso. */
const QUEDAS_ATENCAO = 3;
const QUEDAS_RISCO = 8;

const NIVEIS = Object.freeze({ tranquilo: 0, atencao: 1, risco: 2 });

function pior(a, b) {
  return NIVEIS[a] >= NIVEIS[b] ? a : b;
}

function classificar(valor, limiteAtencao, limiteRisco) {
  if (valor >= limiteRisco) return 'risco';
  if (valor >= limiteAtencao) return 'atencao';
  return 'tranquilo';
}

function proporcao(parte, total) {
  return total > 0 ? parte / total : 0;
}

/**
 * Avalia o canal a partir do que o sistema já registra.
 *
 * @param {object} medidas
 *   `enviadosPorDia`   média diária de mensagens que partiram daqui (30 dias)
 *   `enviados`         total enviado no período
 *   `falhas`           quantos falharam de vez no período
 *   `contatos`         quantos contatos receberam ao menos um lembrete
 *   `optouts`          quantos pediram PARAR no período
 *   `quedasEm24h`      desconexões da sessão nas últimas 24 horas
 * @returns {{nivel: string, motivos: Array, indicadores: object, recomendacao: string}}
 */
function avaliarRiscoDoCanal(medidas = {}) {
  const enviadosPorDia = Number(medidas.enviadosPorDia) || 0;
  const enviados = Number(medidas.enviados) || 0;
  const falhas = Number(medidas.falhas) || 0;
  const contatos = Number(medidas.contatos) || 0;
  const optouts = Number(medidas.optouts) || 0;
  const quedasEm24h = Number(medidas.quedasEm24h) || 0;

  const taxaDeRecusa = proporcao(optouts, contatos);
  const taxaDeFalha = proporcao(falhas, enviados + falhas);

  const sinais = [
    {
      chave: 'volume',
      nivel: classificar(enviadosPorDia, VOLUME_ATENCAO_DIA, VOLUME_RISCO_DIA),
      valor: enviadosPorDia,
      texto: `${Math.round(enviadosPorDia)} mensagens por dia`,
      porque: 'volume alto é o que faz o WhatsApp olhar para um número',
    },
    {
      chave: 'recusa',
      nivel: classificar(taxaDeRecusa, RECUSA_ATENCAO, RECUSA_RISCO),
      valor: taxaDeRecusa,
      texto: `${(taxaDeRecusa * 100).toFixed(1)}% dos contatos pediram PARAR`,
      porque: 'quem não queria receber denuncia antes de pedir para parar',
    },
    {
      chave: 'falha',
      nivel: classificar(taxaDeFalha, FALHA_ATENCAO, FALHA_RISCO),
      valor: taxaDeFalha,
      texto: `${(taxaDeFalha * 100).toFixed(1)}% dos envios falharam`,
      porque: 'falha em série com o gateway de pé costuma ser bloqueio começando',
    },
    {
      chave: 'queda',
      nivel: classificar(quedasEm24h, QUEDAS_ATENCAO, QUEDAS_RISCO),
      valor: quedasEm24h,
      texto: `${quedasEm24h} quedas da sessão em 24h`,
      porque: 'sessão que cai sem parar é sessão sob suspeita',
    },
  ];

  // Sem histórico não há o que julgar. Dizer "tranquilo" para uma clínica que
  // nunca enviou nada seria uma garantia que este módulo não pode dar.
  if (enviados === 0 && falhas === 0 && contatos === 0) {
    return {
      nivel: 'tranquilo',
      semDados: true,
      motivos: [],
      indicadores: { enviadosPorDia, taxaDeRecusa, taxaDeFalha, quedasEm24h },
      recomendacao: 'Ainda não há envios suficientes para avaliar. '
        + 'A vigilância começa sozinha assim que os lembretes rodarem.',
    };
  }

  const nivel = sinais.reduce((maior, sinal) => pior(maior, sinal.nivel), 'tranquilo');
  const motivos = sinais.filter((sinal) => sinal.nivel !== 'tranquilo');

  return {
    nivel,
    semDados: false,
    motivos,
    indicadores: { enviadosPorDia, taxaDeRecusa, taxaDeFalha, quedasEm24h },
    recomendacao: recomendar(nivel),
  };
}

function recomendar(nivel) {
  if (nivel === 'risco') {
    return 'Migre para a API oficial do WhatsApp (Meta Cloud). '
      + 'Nesta faixa, o bloqueio do número deixa de ser hipótese — e ele chega '
      + 'sem aviso, deixando a clínica sem canal de um dia para o outro.';
  }
  if (nivel === 'atencao') {
    return 'Ainda dá para ficar como está, mas convém preparar a migração '
      + 'antes de precisar dela: criar o aplicativo na Meta e aprovar os modelos '
      + 'leva dias, e não dá para fazer isso com o número já bloqueado.';
  }
  return 'O uso está dentro do que se espera de uma clínica. '
    + 'Não há motivo para trocar de tecnologia agora.';
}

module.exports = {
  avaliarRiscoDoCanal,
  VOLUME_ATENCAO_DIA,
  VOLUME_RISCO_DIA,
  RECUSA_ATENCAO,
  RECUSA_RISCO,
  FALHA_ATENCAO,
  FALHA_RISCO,
  QUEDAS_ATENCAO,
  QUEDAS_RISCO,
};
