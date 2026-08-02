'use strict';

const net = require('node:net');

// Descoberta do IP de origem.
//
// Direto, `req.socket.remoteAddress` é a verdade. Atrás de um proxy reverso, é o
// IP do proxy — e o limite por IP passaria a valer para todo mundo junto.
//
// A correção não é "ler `X-Forwarded-For`": confiar no cabeçalho de qualquer
// origem é pior que não lê-lo, porque permite **forjar** o IP e contornar o
// limite escrevendo qualquer coisa ali. A regra é ler o cabeçalho **apenas**
// quando a conexão vem de um proxy que declaramos confiável.

/** Normaliza o IPv4 mapeado em IPv6 (`::ffff:10.0.0.1`) para a forma simples. */
function normalizar(endereco) {
  if (typeof endereco !== 'string' || !endereco) return null;

  const limpo = endereco.trim();
  const mapeado = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(limpo);
  return mapeado ? mapeado[1] : limpo;
}

/** Converte IPv4 em número, para comparar com faixas CIDR. */
function paraNumero(ipv4) {
  return ipv4.split('.').reduce((total, parte) => (total << 8) + Number(parte), 0) >>> 0;
}

function dentroDaFaixa(ip, faixa) {
  const [rede, bits] = faixa.split('/');
  if (!net.isIPv4(ip) || !net.isIPv4(rede)) return false;

  const prefixo = Number(bits ?? 32);
  if (!Number.isInteger(prefixo) || prefixo < 0 || prefixo > 32) return false;
  if (prefixo === 0) return true;

  const mascara = (0xffffffff << (32 - prefixo)) >>> 0;
  return (paraNumero(ip) & mascara) === (paraNumero(rede) & mascara);
}

/**
 * Um proxy é confiável quando está na lista configurada.
 * A lista aceita IP exato (`10.0.0.5`) ou faixa CIDR (`10.0.0.0/8`).
 */
function ehProxyConfiavel(ip, confiaveis = []) {
  if (!ip || confiaveis.length === 0) return false;

  return confiaveis.some((entrada) => {
    const alvo = normalizar(entrada);
    if (!alvo) return false;
    return alvo.includes('/') ? dentroDaFaixa(ip, alvo) : alvo === ip;
  });
}

/**
 * Descobre o IP do cliente.
 *
 * @param {object} req requisição HTTP
 * @param {string[]} proxiesConfiaveis IPs ou faixas dos proxies à frente
 * @returns {string|null}
 */
function descobrirIp(req, proxiesConfiaveis = []) {
  const daConexao = normalizar(req?.socket?.remoteAddress);
  if (!daConexao) return null;

  // Sem proxy confiável declarado, o cabeçalho é ignorado — é o padrão seguro.
  if (!ehProxyConfiavel(daConexao, proxiesConfiaveis)) return daConexao;

  const cabecalho = req.headers?.['x-forwarded-for'];
  if (typeof cabecalho !== 'string' || !cabecalho) return daConexao;

  // `X-Forwarded-For: cliente, proxy1, proxy2`. Percorremos da direita para a
  // esquerda, descartando os proxies que confiamos; o primeiro endereço que não
  // é proxy nosso é o cliente. Pegar o primeiro da lista às cegas aceitaria o
  // valor que o próprio cliente escreveu.
  const cadeia = cabecalho.split(',').map((parte) => normalizar(parte)).filter(Boolean);

  for (let indice = cadeia.length - 1; indice >= 0; indice -= 1) {
    const candidato = cadeia[indice];
    if (!net.isIP(candidato)) continue;
    if (!ehProxyConfiavel(candidato, proxiesConfiaveis)) return candidato;
  }

  // Cadeia inteira formada por proxies confiáveis: fica o da conexão.
  return daConexao;
}

module.exports = { descobrirIp, ehProxyConfiavel, normalizar };
