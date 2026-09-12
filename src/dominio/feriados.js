'use strict';

// Feriados em que a clínica não abre — e, por isso, em que a Serena atende o
// dia inteiro.
//
// Arquivo puro: recebe uma data, devolve se é feriado. Não fala com banco.
//
// ------------------------------------------------------------------ por quê
//
// A grade da Serena entende dia da SEMANA, não data. Num feriado que cai numa
// terça, ela lê "terça-feira" e cala das 7:45 às 18:30 — exatamente no dia em
// que não há ninguém na clínica para atender. É o contrário do que o horário
// existe para fazer.
//
// Regra do Dr. Edson (12/09/2026): dia útil das 7:45 às 18:30 é da equipe;
// fim de semana E FERIADO são da Serena, integral.
//
// ------------------------------------------------------------- quais entram
//
// Só feriado que PARA a cidade: nacional (Lei 662/1949, 6.802/1949 e
// 14.759/2023) e municipal de Franca-SP (Lei Municipal 6.730/2006 — 28/11,
// aniversário da cidade, e 08/12, Nossa Senhora da Conceição, padroeira).
//
// Ponto facultativo NÃO entra por padrão (Carnaval e Corpus Christi): não são
// feriado por lei federal, e cada clínica decide se abre. Ficam numa lista
// separada, que o admin liga se quiser — em Franca a prática costuma ser não
// abrir, mas essa é uma decisão da clínica, não um fato que eu possa presumir.

/**
 * Domingo de Páscoa (algoritmo de Meeus/Butcher, calendário gregoriano).
 *
 * Precisa ser calculado: Carnaval, Sexta-feira Santa e Corpus Christi mudam
 * todo ano, e uma tabela fixa ficaria errada no ano seguinte — em silêncio.
 */
function domingoDePascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  // Meio-dia UTC evita que fuso ou horário de verão empurrem para o dia vizinho.
  return new Date(Date.UTC(ano, mes - 1, dia, 12));
}

/** Uma data deslocada em dias, mantendo o meio-dia UTC. */
function somarDias(data, dias) {
  return new Date(data.getTime() + dias * 24 * 60 * 60 * 1000);
}

/** "2026-12-25" — a chave que o resto do arquivo compara. */
function comoChave(data) {
  return data.toISOString().slice(0, 10);
}

/** Feriados de data fixa que param o país e a cidade. */
const FIXOS = [
  ['01-01', 'Confraternização Universal', 'nacional'],
  ['04-21', 'Tiradentes', 'nacional'],
  ['05-01', 'Dia do Trabalho', 'nacional'],
  ['09-07', 'Independência do Brasil', 'nacional'],
  ['10-12', 'Nossa Senhora Aparecida', 'nacional'],
  ['11-02', 'Finados', 'nacional'],
  ['11-15', 'Proclamação da República', 'nacional'],
  // Nacional desde a Lei 14.759/2023.
  ['11-20', 'Consciência Negra', 'nacional'],
  ['12-25', 'Natal', 'nacional'],
  // Franca-SP, Lei Municipal 6.730/2006.
  ['11-28', 'Aniversário de Franca', 'municipal'],
  ['12-08', 'Nossa Senhora da Conceição (padroeira de Franca)', 'municipal'],
];

/** Dependem da Páscoa. `facultativo` sai da lista padrão. */
const MOVEIS = [
  [-48, 'Carnaval (segunda)', 'facultativo'],
  [-47, 'Carnaval (terça)', 'facultativo'],
  [-2, 'Sexta-feira Santa', 'nacional'],
  [60, 'Corpus Christi', 'facultativo'],
];

/**
 * Todos os feriados de um ano, como `{ '2026-12-25': { nome, tipo } }`.
 *
 * @param ano
 * @param opcoes.incluirFacultativos  Carnaval e Corpus Christi entram também.
 */
function feriadosDoAno(ano, { incluirFacultativos = false } = {}) {
  const numero = Number(ano);
  if (!Number.isInteger(numero) || numero < 1900 || numero > 2200) return {};

  const mapa = {};
  for (const [diaMes, nome, tipo] of FIXOS) {
    mapa[`${numero}-${diaMes}`] = { nome, tipo };
  }

  const pascoa = domingoDePascoa(numero);
  for (const [deslocamento, nome, tipo] of MOVEIS) {
    if (tipo === 'facultativo' && !incluirFacultativos) continue;
    mapa[comoChave(somarDias(pascoa, deslocamento))] = { nome, tipo };
  }

  return mapa;
}

/**
 * É feriado nesta data, no fuso da clínica?
 *
 * O fuso importa: o servidor roda em UTC, e às 21h de 24/12 em São Paulo já é
 * dia 25 em UTC — a Serena entraria em modo feriado um dia antes.
 *
 * @param instante   Date
 * @param opcoes.fuso
 * @param opcoes.extras  Datas marcadas à mão pelo admin: `{ '2026-10-13': 'Emenda' }`
 * @param opcoes.removidos  Datas que a clínica decidiu ABRIR mesmo sendo feriado
 */
function feriadoEm(instante, { fuso = 'America/Sao_Paulo', extras = {}, removidos = [], incluirFacultativos = false } = {}) {
  const data = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(data.getTime())) return null;

  let chave;
  try {
    // en-CA formata como YYYY-MM-DD, que é exatamente a chave usada aqui.
    chave = new Intl.DateTimeFormat('en-CA', { timeZone: fuso }).format(data);
  } catch {
    chave = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(data);
  }

  if (Array.isArray(removidos) && removidos.includes(chave)) return null;

  // O que o admin marcou vence a lista: é decisão humana sobre um dia concreto
  // (emenda de feriado, recesso), e ela sabe coisas que a lei não diz.
  if (extras && Object.prototype.hasOwnProperty.call(extras, chave)) {
    const nome = extras[chave];
    return { data: chave, nome: typeof nome === 'string' && nome.trim() ? nome.trim() : 'Feriado', tipo: 'manual' };
  }

  const ano = Number(chave.slice(0, 4));
  const doAno = feriadosDoAno(ano, { incluirFacultativos });
  const achado = doAno[chave];
  return achado ? { data: chave, ...achado } : null;
}

/** Os próximos feriados a partir de uma data — para a tela mostrar. */
function proximosFeriados(instante, { quantidade = 5, fuso = 'America/Sao_Paulo', extras = {}, incluirFacultativos = false } = {}) {
  const data = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(data.getTime())) return [];

  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: fuso }).format(data);
  const ano = Number(hoje.slice(0, 4));

  const todos = {
    ...feriadosDoAno(ano, { incluirFacultativos }),
    // O ano seguinte entra junto: em dezembro, "os próximos" são de janeiro.
    ...feriadosDoAno(ano + 1, { incluirFacultativos }),
  };
  for (const [chave, nome] of Object.entries(extras ?? {})) {
    todos[chave] = { nome: typeof nome === 'string' ? nome : 'Feriado', tipo: 'manual' };
  }

  return Object.entries(todos)
    .filter(([chave]) => chave >= hoje)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, Math.max(1, Number(quantidade) || 5))
    .map(([data, info]) => ({ data, ...info }));
}

module.exports = {
  FIXOS,
  MOVEIS,
  domingoDePascoa,
  feriadosDoAno,
  feriadoEm,
  proximosFeriados,
};
