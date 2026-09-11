'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');

const { ErroDeContrato } = require('../../contratos/erros');
const {
  LIMITES, normalizarConfiguracoes, validarAgente, validarTreinamento,
  validarAcoesDeInatividade, validarCanais,
} = require('./regras');

// Serviço dos agentes configuráveis (ver docs/AGENTES.md).
//
// É a camada entre a API e o repositório: valida tudo por `regras.js` (uma
// fonte só), confere se o agente existe antes de mexer em qualquer parte dele
// e audita cada mudança — com ids e nomes de campo, NUNCA com o texto do
// comportamento, de treinamento ou da conversa de teste. Auditoria é para
// saber quem mudou o quê e quando; o conteúdo já está no próprio agente.
//
// O que este arquivo NÃO prova: que o repositório real grava o que recebe
// (isso é da suíte de contrato do repositório) nem que o motor responde bem
// (suíte do motor). Os testes daqui usam fakes com as assinaturas do contrato.

const LIMITE_MENSAGENS_DE_TESTE = 30;
const LIMITE_TEXTO_DE_TESTE = 2000;

const PAGINA_PADRAO = Object.freeze({
  timeoutMs: 10_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirecionamentos: 3,
});

function erroComStatus(mensagem, status, codigo = null) {
  const erro = new Error(mensagem);
  erro.status = status;
  if (codigo) erro.codigo = codigo;
  return erro;
}

/** Falha de rede ou tempo esgotado ao buscar/ler o site: sempre 422, nunca 500. */
function erroDeAcesso(erro, timeoutMs, mensagemPadrao) {
  const expirou = erro?.name === 'TimeoutError' || erro?.name === 'AbortError';
  return erroComStatus(
    expirou ? `o site não respondeu em ${Math.round(timeoutMs / 1000)}s` : mensagemPadrao,
    422,
    'site_inacessivel',
  );
}

// ------------------------------------------------ guarda de endereço (SSRF)
//
// O treinamento por website faz o SERVIDOR buscar uma URL digitada na tela.
// Sem guarda, isso é uma porta para o servidor ler o que só ele alcança:
// metadados da nuvem (169.254.169.254), serviços locais, a rede interna do VPS.
// Por isso: só https na porta padrão, sem usuário/senha na URL, nada de nome
// local, nenhum IP reservado — nem no endereço digitado, nem no que o DNS
// devolve, nem em cada destino de redirecionamento.
//
// Risco residual conhecido, não resolvido aqui: entre a nossa consulta de DNS
// e a conexão que o `fetch` abre existe uma janela (DNS rebinding). Fechá-la
// exige fixar o IP na conexão, o que o `fetch` nativo não expõe sem
// dependência. A rota é só de admin, o que reduz — não elimina — o risco.
// O host é comparado sem o ponto final (`localhost.` é `localhost`), e a
// consulta de DNS tem o mesmo tempo limite da busca.

function ipv4ParaNumero(ip) {
  return ip.split('.').reduce((acumulado, parte) => (acumulado * 256) + Number(parte), 0);
}

const FAIXAS_IPV4_RESERVADAS = Object.freeze([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]);

function ipv4Reservado(ip) {
  const numero = ipv4ParaNumero(ip);
  return FAIXAS_IPV4_RESERVADAS.some(([base, prefixo]) => {
    const inicio = ipv4ParaNumero(base);
    return numero >= inicio && numero < inicio + (2 ** (32 - prefixo));
  });
}

function expandirIpv6(ip) {
  let endereco = ip.toLowerCase().split('%')[0];
  // IPv4 embutido no fim (::ffff:127.0.0.1) vira os dois últimos grupos.
  const embutido = endereco.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (embutido) {
    const numero = ipv4ParaNumero(embutido[1]);
    const alto = Math.floor(numero / 65536).toString(16);
    const baixo = (numero % 65536).toString(16);
    endereco = `${endereco.slice(0, -embutido[1].length)}${alto}:${baixo}`;
  }
  const temAbreviacao = endereco.includes('::');
  const [cabeca, cauda] = endereco.split('::');
  const gruposCabeca = cabeca ? cabeca.split(':') : [];
  const gruposCauda = temAbreviacao && cauda ? cauda.split(':') : [];
  const faltam = temAbreviacao ? 8 - gruposCabeca.length - gruposCauda.length : 0;
  return [...gruposCabeca, ...Array(Math.max(faltam, 0)).fill('0'), ...gruposCauda]
    .map((grupo) => Number.parseInt(grupo || '0', 16));
}

function ipv4DosDoisUltimosGrupos(grupos) {
  return [grupos[6] >> 8, grupos[6] & 255, grupos[7] >> 8, grupos[7] & 255].join('.');
}

function ipv6Reservado(ip) {
  const grupos = expandirIpv6(ip);
  // Endereço que não conseguimos ler com certeza é negado, não liberado.
  if (grupos.length !== 8 || grupos.some((grupo) => Number.isNaN(grupo))) return true;
  if (grupos.every((grupo) => grupo === 0)) return true; // ::
  if (grupos.slice(0, 7).every((grupo) => grupo === 0) && grupos[7] === 1) return true; // ::1
  // IPv4 mapeado/compatível: quem decide é o IPv4 que está dentro.
  if (grupos.slice(0, 5).every((grupo) => grupo === 0) && (grupos[5] === 0xffff || grupos[5] === 0)) {
    return ipv4Reservado(ipv4DosDoisUltimosGrupos(grupos));
  }
  if (grupos[0] === 0x64 && grupos[1] === 0xff9b) return ipv4Reservado(ipv4DosDoisUltimosGrupos(grupos)); // NAT64
  // Faixas de transição e legadas: embrulham IPv4 arbitrário ou nunca são
  // destino público de site. Negadas inteiras — decidir pelo IPv4 de dentro
  // em cada formato é superfície de erro sem ganho para treinamento de agente.
  if (grupos.slice(0, 4).every((grupo) => grupo === 0) && grupos[4] === 0xffff && grupos[5] === 0) return true; // ::ffff:0:0/96 — IPv4-translated
  if (grupos[0] === 0x2002) return true; // 2002::/16 — 6to4
  if (grupos[0] === 0x2001 && grupos[1] === 0) return true; // 2001::/32 — Teredo
  if ((grupos[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 — site-local (legado)
  if (grupos[0] === 0x100 && grupos[1] === 0 && grupos[2] === 0 && grupos[3] === 0) return true; // 100::/64 — descarte
  if ((grupos[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 — rede local única
  if ((grupos[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
  if ((grupos[0] & 0xff00) === 0xff00) return true; // multicast
  if (grupos[0] === 0x2001 && grupos[1] === 0x0db8) return true; // documentação
  return false;
}

/** `true` para qualquer endereço que não seja IP público roteável — inclusive o que não é IP. */
function ehEnderecoPrivado(endereco) {
  const limpo = String(endereco ?? '').replace(/^\[|\]$/g, '');
  const versao = net.isIP(limpo);
  if (versao === 4) return ipv4Reservado(limpo);
  if (versao === 6) return ipv6Reservado(limpo);
  return true;
}

/** Confere a forma da URL, sem rede. Lança erro 422 com o motivo. */
function validarUrlPublica(texto) {
  let url;
  try {
    url = new URL(String(texto ?? '').trim());
  } catch {
    throw erroComStatus('endereço do site inválido', 422, 'url_invalida');
  }
  if (url.protocol !== 'https:') throw erroComStatus('só endereços https são aceitos', 422, 'url_nao_https');
  if (url.username || url.password) {
    throw erroComStatus('endereço com usuário ou senha não é aceito', 422, 'url_com_credencial');
  }
  if (url.port && url.port !== '443') {
    throw erroComStatus('só a porta padrão do https é aceita', 422, 'url_porta');
  }

  // Ponto final é o mesmo nome (`localhost.` = `localhost`): sem tirá-lo, a
  // lista de nomes locais abaixo não reconhecia e só o DNS barrava.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const ehIp = net.isIP(host) !== 0;
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host.endsWith('.internal') || (!ehIp && !host.includes('.'))) {
    throw erroComStatus('endereço local não é aceito', 422, 'url_local');
  }
  if (ehIp && ehEnderecoPrivado(host)) {
    throw erroComStatus('endereço de rede privada não é aceito', 422, 'url_privada');
  }
  return url;
}

async function conferirResolucao(host, lookup, timeoutMs) {
  if (net.isIP(host)) return; // IP literal já passou por validarUrlPublica
  let enderecos;
  let relogio = null;
  try {
    // DNS que não responde não pode segurar a requisição além do tempo
    // limite: a consulta do sistema ocupa a threadpool do Node enquanto espera.
    enderecos = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_resolver, rejeitar) => {
        relogio = setTimeout(() => rejeitar(new Error('dns sem resposta')), timeoutMs);
      }),
    ]);
  } catch {
    throw erroComStatus('não foi possível encontrar o site', 422, 'site_nao_encontrado');
  } finally {
    clearTimeout(relogio);
  }
  if (!Array.isArray(enderecos) || enderecos.length === 0) {
    throw erroComStatus('não foi possível encontrar o site', 422, 'site_nao_encontrado');
  }
  // Basta UM endereço reservado para recusar: o fetch pode escolher qualquer um.
  if (enderecos.some((item) => ehEnderecoPrivado(item?.address))) {
    throw erroComStatus('o site aponta para uma rede privada', 422, 'url_privada');
  }
}

async function lerCorpoLimitado(resposta, maxBytes) {
  if (!resposta.body?.getReader) {
    return Buffer.from(await resposta.text()).subarray(0, maxBytes);
  }
  const leitor = resposta.body.getReader();
  const pedacos = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await leitor.read();
    if (done) break;
    const falta = maxBytes - total;
    const pedaco = value.byteLength > falta ? value.subarray(0, falta) : value;
    pedacos.push(Buffer.from(pedaco));
    total += pedaco.byteLength;
  }
  // Página maior que o teto é cortada, não recusada: o começo de um site
  // costuma ter o que interessa, e o resto nem caberia no treinamento.
  await leitor.cancel().catch(() => {});
  return Buffer.concat(pedacos);
}

function decodificar(bytes, tipoDeConteudo) {
  const charset = /charset=([^;]+)/i.exec(tipoDeConteudo)?.[1]?.trim().replace(/["']/g, '') || 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const ENTIDADES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

function decodificarEntidades(texto) {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (inteira, corpo) => {
    if (corpo[0] === '#') {
      const codigo = corpo[1].toLowerCase() === 'x'
        ? Number.parseInt(corpo.slice(2), 16)
        : Number.parseInt(corpo.slice(1), 10);
      return Number.isFinite(codigo) && codigo > 0 && codigo <= 0x10ffff ? String.fromCodePoint(codigo) : inteira;
    }
    return ENTIDADES[corpo.toLowerCase()] ?? inteira;
  });
}

// Teto de caracteres de HTML convertidos. A página já chega limitada a 2 MB,
// mas o treinamento guarda no máximo 50 mil caracteres de texto: converter
// megabytes para jogar quase tudo fora só dá tempo de CPU a quem manda o HTML.
const LIMITE_HTML_CARACTERES = 300_000;

const ELEMENTOS_SEM_TEXTO = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'title']);
const FECHAMENTOS_DE_BLOCO = new Set([
  'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer',
  'ul', 'ol', 'table', 'blockquote',
]);

/** Posição de `</nome` como fechamento de verdade (seguido de `>`, espaço ou fim), a partir de `desde`. */
function acharFechamento(minusculo, nome, desde) {
  const alvo = `</${nome}`;
  for (let busca = desde; ;) {
    const posicao = minusculo.indexOf(alvo, busca);
    if (posicao < 0) return -1;
    const seguinte = minusculo[posicao + alvo.length];
    if (seguinte === undefined || seguinte === '>' || seguinte === '/' || seguinte.trim() === '') return posicao;
    busca = posicao + alvo.length;
  }
}

function extrairTitulo(bruto, minusculo) {
  for (let busca = 0; ;) {
    const inicio = minusculo.indexOf('<title', busca);
    if (inicio < 0) return null;
    const seguinte = minusculo[inicio + 6];
    if (seguinte === '>' || (seguinte !== undefined && seguinte.trim() === '')) {
      const abertura = minusculo.indexOf('>', inicio + 6);
      if (abertura < 0) return null;
      const fim = acharFechamento(minusculo, 'title', abertura + 1);
      return bruto.slice(abertura + 1, fim < 0 ? bruto.length : fim);
    }
    busca = inicio + 6;
  }
}

/**
 * HTML → texto para treinamento. Não é um parser: é o suficiente para tirar o
 * que não é conteúdo (script, estilo, cabeçalho técnico) e manter a leitura em
 * linhas. Página que depende de JavaScript para mostrar texto chega vazia — e
 * quem chama recusa com mensagem clara em vez de gravar um treinamento oco.
 *
 * Varredura linear com `indexOf`, de propósito. A versão anterior usava
 * expressões com retrocesso (`[\s\S]*?`, `<[^>]+>`) que ficavam quadráticas
 * com aberturas sem fechamento: 160 KB de `<!--` repetido travavam o processo
 * por 13 s, e o limite de tempo da busca não interrompe código síncrono
 * (achado MÉDIO da auditoria de segurança). Aqui cada caractere é visitado um
 * número constante de vezes, e a entrada é cortada antes de começar.
 *
 * Diferenças deliberadas: elemento sem texto (script, estilo…) ou comentário
 * sem fechamento leva o resto da página junto — script nunca vira treinamento.
 */
function htmlParaTexto(html) {
  const bruto = String(html ?? '').slice(0, LIMITE_HTML_CARACTERES);
  const minusculo = bruto.toLowerCase();
  const tituloBruto = extrairTitulo(bruto, minusculo);

  const partes = [];
  let posicao = 0;
  while (posicao < bruto.length) {
    const abre = bruto.indexOf('<', posicao);
    if (abre < 0) {
      partes.push(bruto.slice(posicao));
      break;
    }
    partes.push(bruto.slice(posicao, abre));

    if (minusculo.startsWith('<!--', abre)) {
      const fimDoComentario = bruto.indexOf('-->', abre + 4);
      if (fimDoComentario < 0) break;
      partes.push(' ');
      posicao = fimDoComentario + 3;
      continue;
    }

    const fecha = bruto.indexOf('>', abre + 1);
    if (fecha < 0) {
      // Nenhum `>` daqui para frente: nenhum `<` seguinte fecha tag também.
      // O resto é texto — e a varredura acaba aqui, sem voltar a procurar.
      partes.push(bruto.slice(abre));
      break;
    }

    const conteudoDaTag = minusculo.slice(abre + 1, fecha);
    const fechamento = conteudoDaTag.startsWith('/');
    const nome = /^\/?\s*([a-z][a-z0-9]*)/.exec(conteudoDaTag)?.[1] ?? '';

    if (!fechamento && ELEMENTOS_SEM_TEXTO.has(nome)) {
      // `title` sai do texto porque já volta separado; página sem <head> (comum
      // em HTML mal formado) repetiria o título como primeira linha do treinamento.
      const fimDoElemento = acharFechamento(minusculo, nome, fecha + 1);
      if (fimDoElemento < 0) break;
      const fimDaTag = bruto.indexOf('>', fimDoElemento);
      if (fimDaTag < 0) break;
      partes.push(' ');
      posicao = fimDaTag + 1;
      continue;
    }

    if (nome === 'br') partes.push('\n');
    else if (fechamento && FECHAMENTOS_DE_BLOCO.has(nome)) partes.push('\n');
    else partes.push(' ');
    posicao = fecha + 1;
  }

  const semMarcacao = partes.join('');
  const texto = decodificarEntidades(semMarcacao)
    .split('\n')
    .map((linha) => linha.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  const titulo = tituloBruto ? decodificarEntidades(tituloBruto).replace(/\s+/g, ' ').trim() : '';
  return { titulo: titulo || null, texto };
}

function criarBuscadorDePagina({
  fetchImpl = globalThis.fetch,
  lookup = dns.promises.lookup,
  timeoutMs = PAGINA_PADRAO.timeoutMs,
  maxBytes = PAGINA_PADRAO.maxBytes,
  maxRedirecionamentos = PAGINA_PADRAO.maxRedirecionamentos,
} = {}) {
  return async function buscarPagina(endereco) {
    let url = validarUrlPublica(endereco);

    for (let saltos = 0; ; saltos += 1) {
      await conferirResolucao(url.hostname.replace(/^\[|\]$/g, ''), lookup, timeoutMs);

      let resposta;
      try {
        resposta = await fetchImpl(url.href, {
          // Redirecionamento manual: o `fetch` seguiria sozinho para qualquer
          // lugar, inclusive um IP interno, sem passar pela guarda acima.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'text/html, text/plain;q=0.9', 'user-agent': 'crmclinica-treinamento/1.0' },
        });
      } catch (erro) {
        throw erroDeAcesso(erro, timeoutMs, 'não foi possível acessar o site');
      }

      if (resposta.status >= 300 && resposta.status < 400) {
        const destino = resposta.headers.get('location');
        if (!destino) throw erroComStatus('o site redirecionou sem dizer para onde', 422, 'site_redirecionamento');
        if (saltos >= maxRedirecionamentos) {
          throw erroComStatus('o site redirecionou vezes demais', 422, 'site_redirecionamento');
        }
        let proximo;
        try {
          proximo = new URL(destino, url).href;
        } catch {
          throw erroComStatus('o site redirecionou para um endereço inválido', 422, 'site_redirecionamento');
        }
        url = validarUrlPublica(proximo);
        continue;
      }

      if (!resposta.ok) throw erroComStatus(`o site respondeu HTTP ${resposta.status}`, 422, 'site_http');

      const tipo = (resposta.headers.get('content-type') || '').toLowerCase();
      // Só o tipo antes do `;` decide: `application/json; x=text/html` não é HTML.
      const tipoPrincipal = tipo.split(';')[0].trim();
      const ehHtml = tipoPrincipal === 'text/html' || tipoPrincipal === 'application/xhtml+xml';
      const ehTexto = tipoPrincipal === 'text/plain';
      if (!ehHtml && !ehTexto) throw erroComStatus('a página não é HTML nem texto', 422, 'site_tipo');

      let conteudo;
      try {
        // O tempo limite também vale para o corpo: um site que manda o
        // cabeçalho e goteja o resto estourava aqui fora do try e virava 500.
        conteudo = decodificar(await lerCorpoLimitado(resposta, maxBytes), tipo);
      } catch (erro) {
        throw erroDeAcesso(erro, timeoutMs, 'não foi possível ler a página');
      }
      const { titulo, texto } = ehHtml ? htmlParaTexto(conteudo) : { titulo: null, texto: conteudo.trim() };
      return { titulo, texto: texto.slice(0, LIMITES.conteudoTreinamento), urlFinal: url.href };
    }
  };
}

// ---------------------------------------------------------------- serviço

function exigirIdPositivo(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

function validarMensagensDeTeste(mensagens) {
  if (!Array.isArray(mensagens) || mensagens.length === 0) {
    throw new ErroDeContrato('informe as mensagens da conversa de teste', 'mensagens');
  }
  if (mensagens.length > LIMITE_MENSAGENS_DE_TESTE) {
    throw new ErroDeContrato(`a conversa de teste aceita no máximo ${LIMITE_MENSAGENS_DE_TESTE} mensagens`, 'mensagens');
  }
  const normalizadas = mensagens.map((mensagem, indice) => {
    const campo = `mensagens[${indice}]`;
    if (!mensagem || typeof mensagem !== 'object') throw new ErroDeContrato(`${campo} deve ser um objeto`, campo);
    if (mensagem.autor !== 'cliente' && mensagem.autor !== 'agente') {
      throw new ErroDeContrato(`${campo}.autor deve ser "cliente" ou "agente"`, `${campo}.autor`);
    }
    const texto = typeof mensagem.texto === 'string' ? mensagem.texto.trim() : '';
    if (!texto) throw new ErroDeContrato(`${campo}.texto é obrigatório`, `${campo}.texto`);
    if (texto.length > LIMITE_TEXTO_DE_TESTE) {
      throw new ErroDeContrato(`${campo}.texto excede ${LIMITE_TEXTO_DE_TESTE} caracteres`, `${campo}.texto`);
    }
    return { autor: mensagem.autor, texto };
  });
  // O motor responde ao cliente; pedir resposta a uma conversa que termina
  // com o próprio agente é pedir que ele fale sozinho.
  if (normalizadas.at(-1).autor !== 'cliente') {
    throw new ErroDeContrato('a última mensagem do teste precisa ser do cliente', 'mensagens');
  }
  return normalizadas;
}

// ------------------------------------------------ painel de operação (docs/AGENTES.md)

// Ações auditadas nas conversas de um agente que o painel conta. Os nomes são
// os do fluxo (fluxo.js) e do escalonamento de agente (atendimento.js).
const ACOES_DO_PAINEL = Object.freeze([
  'agente_respondida', 'transferida_para_humano', 'agente_escalonada',
  'agente_automacao_silenciada', 'agente_resposta_nao_entregue', 'agente_sem_resposta',
]);

// Auditoria do próprio agente que diz quando o status mudou e para quê.
const ACOES_DE_STATUS = Object.freeze([
  'agente_pausado', 'agente_retomado', 'agente_atualizado', 'agente_criado', 'agente_semeado',
]);

const LIMITE_MOTIVO_DE_PAUSA = 200;

/**
 * Meia-noite de hoje no fuso da clínica. O Brasil não tem horário de verão
 * desde 2019 — -03:00 o ano inteiro, mesma regra de rotas-conversas.js.
 */
function inicioDoDiaNaClinica(instante) {
  const data = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instante);
  return new Date(`${data}T00:00:00-03:00`);
}

/** Registro de auditoria do agente → `{ status, motivo, em, por }`, ou null se não mudou status. */
function mudancaDeStatus(registro) {
  const detalhe = registro?.detalhe ?? {};
  const porAcao = {
    agente_pausado: 'desativado',
    agente_retomado: 'ativo',
    agente_semeado: 'desativado',
    agente_criado: detalhe.status ?? null,
    agente_atualizado: detalhe.status_para ?? null,
  };
  const status = porAcao[registro?.acao] ?? null;
  if (!status) return null;
  return {
    acao: registro.acao,
    status,
    motivo: registro.acao === 'agente_pausado' && typeof detalhe.motivo === 'string' ? detalhe.motivo : null,
    em: registro.criado_em ?? null,
    por: registro.usuario_nome ?? null,
  };
}

/** O que o painel mostra de uma conversa: quem, estado e quando — nunca mensagem. */
function resumirConversaDoPainel(conversa) {
  return {
    id: conversa.id,
    status: conversa.status,
    contato_nome: conversa.contato?.nome ?? conversa.contato_nome ?? null,
    contato_telefone: conversa.contato?.telefone ?? conversa.contato_telefone ?? null,
    ultima_msg_em: conversa.ultima_msg_em ?? null,
    assumida_por_humano: conversa.assumida_por_humano === true,
    responsavel_nome: conversa.responsavel_nome ?? null,
  };
}

/** O canal de WhatsApp do agente: o ligado primeiro; sem ligado, o desligado (para o painel dizer isso). */
function canalDeWhatsapp(agente) {
  const canais = (agente?.canais ?? []).filter((canal) => canal.canal === 'whatsapp');
  return canais.find((canal) => canal.ativo !== false) ?? canais[0] ?? null;
}

function validarNumeroDePareamento(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor !== 'string') throw new ErroDeContrato('campo "numero" deve ser texto', 'numero');
  const digitos = valor.replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 15) {
    throw new ErroDeContrato('campo "numero" deve ter de 10 a 15 dígitos, com DDI e DDD', 'numero');
  }
  return digitos;
}

function validarMotivoDePausa(valor) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'string') throw new ErroDeContrato('campo "motivo" deve ser texto', 'motivo');
  // Sem caractere de controle: o motivo aparece na tela e na auditoria.
  const limpo = Array.from(valor).filter((caractere) => caractere.charCodeAt(0) >= 32).join('').trim();
  if (limpo.length > LIMITE_MOTIVO_DE_PAUSA) {
    throw new ErroDeContrato(`campo "motivo" excede ${LIMITE_MOTIVO_DE_PAUSA} caracteres`, 'motivo');
  }
  return limpo || null;
}

function exigirObjetoOuVazio(dados) {
  if (dados === undefined || dados === null) return {};
  if (typeof dados !== 'object' || Array.isArray(dados)) throw new ErroDeContrato('o corpo deve ser um objeto');
  return dados;
}

function criarServicoDeAgentes({
  repositorio, motor = null, buscarPagina = null, evolution = null, agora = () => new Date(),
} = {}) {
  if (!repositorio) throw new Error('o serviço de agentes exige o repositório');
  const buscar = buscarPagina ?? criarBuscadorDePagina();

  /** Auditoria não derruba a ação: registrar importa, mas não é o produto. */
  async function auditar(acao, agenteId, detalhe, usuarioId = null) {
    try {
      await repositorio.registrarAuditoria({ entidade: 'agente', entidadeId: agenteId, acao, detalhe, usuarioId });
    } catch (erro) {
      console.error(`[agentes] falha ao auditar "${acao}": ${erro.message}`);
    }
  }

  async function exigirAgente(id) {
    const agente = await repositorio.obterAgente(exigirIdPositivo(id, 'agente_id'));
    if (!agente) throw erroComStatus('agente não encontrado', 404, 'agente_nao_encontrado');
    return agente;
  }

  async function recusarSlugOcupado(slug, idAtual = null) {
    const dono = await repositorio.obterAgentePorSlug(slug);
    if (dono && dono.id !== idAtual) {
      throw erroComStatus(`já existe um agente com o slug "${slug}"`, 409, 'slug_em_uso');
    }
  }

  return {
    async listar() {
      return repositorio.listarAgentes();
    },

    async obter(id) {
      const agente = await exigirAgente(id);
      const [treinamentos, historico] = await Promise.all([
        repositorio.listarTreinamentos(agente.id),
        repositorio.listarHistoricoDeComportamento(agente.id, { limite: 20 }),
      ]);
      return { agente, treinamentos, historico };
    },

    async criar(dados, { usuarioId = null } = {}) {
      const validado = validarAgente(dados);
      await recusarSlugOcupado(validado.slug);
      const agente = await repositorio.criarAgente({
        ...validado,
        configuracoes: normalizarConfiguracoes(validado.configuracoes),
      }, { usuarioId });
      await auditar('agente_criado', agente.id, { slug: agente.slug, status: agente.status }, usuarioId);
      return agente;
    },

    async atualizar(id, campos, { usuarioId = null } = {}) {
      const atual = await exigirAgente(id);
      const validado = validarAgente(campos, { parcial: true });
      if (Object.keys(validado).length === 0) throw new ErroDeContrato('nada para atualizar');

      // Achado B3: status só muda por POST /pausar e /retomar, que têm a
      // confirmação do GPTMaker na tela e auditoria própria. Uma aba antiga com
      // o select de status no perfil não pode religar nem pausar por aqui.
      if (Object.prototype.hasOwnProperty.call(validado, 'status')) {
        if (validado.status !== atual.status) {
          throw erroComStatus('para pausar ou retomar use os botões do Controle', 409, 'status_pelo_controle');
        }
        delete validado.status;
        if (Object.keys(validado).length === 0) return atual;
      }

      if (validado.slug && validado.slug !== atual.slug) await recusarSlugOcupado(validado.slug, atual.id);
      if (validado.configuracoes) {
        // A tela pode mandar só o interruptor que mudou: mescla com o que o
        // agente já tem, para "desligar emojis" não zerar o resto.
        validado.configuracoes = normalizarConfiguracoes({ ...atual.configuracoes, ...validado.configuracoes });
      }

      const agente = await repositorio.atualizarAgente(atual.id, validado, { usuarioId });
      const detalhe = { campos: Object.keys(validado) };
      if (validado.status && validado.status !== atual.status) {
        detalhe.status_de = atual.status;
        detalhe.status_para = validado.status;
      }
      await auditar('agente_atualizado', atual.id, detalhe, usuarioId);
      return agente;
    },

    async restaurarComportamento(id, historicoId, { usuarioId = null } = {}) {
      const atual = await exigirAgente(id);
      const alvo = exigirIdPositivo(historicoId, 'historico_id');
      const historico = await repositorio.listarHistoricoDeComportamento(atual.id, { limite: 200 });
      const versao = historico.find((item) => Number(item.id) === alvo);
      if (!versao) throw erroComStatus('versão do comportamento não encontrada', 404, 'historico_nao_encontrado');

      const agente = await repositorio.atualizarAgente(atual.id, { comportamento: versao.comportamento }, { usuarioId });
      await auditar('agente_comportamento_restaurado', atual.id, { historico_id: alvo }, usuarioId);
      return agente;
    },

    async adicionarTreinamento(id, dados, { usuarioId = null } = {}) {
      const agente = await exigirAgente(id);
      if (!dados || typeof dados !== 'object' || Array.isArray(dados)) {
        throw new ErroDeContrato('treinamento deve ser um objeto');
      }

      let bruto = dados;
      if ((dados.tipo ?? 'texto') === 'video') {
        // Fase 2 (docs/AGENTES.md): recusar é melhor do que gravar um link que
        // o motor não sabe ler e o agente fingir que aprendeu.
        throw erroComStatus('treinamento por vídeo ainda não é suportado', 422, 'tipo_nao_suportado');
      }
      if (dados.tipo === 'website') {
        const pagina = await buscar(dados.url ?? dados.origem);
        if (!pagina.texto) {
          throw erroComStatus('a página não tem texto aproveitável (pode depender de JavaScript)', 422, 'site_sem_texto');
        }
        bruto = {
          tipo: 'website',
          titulo: dados.titulo ?? (pagina.titulo ? pagina.titulo.slice(0, LIMITES.tituloTreinamento) : null),
          conteudo: pagina.texto,
          origem: pagina.urlFinal.slice(0, LIMITES.origemTreinamento),
        };
      }

      const treinamento = await repositorio.criarTreinamento(agente.id, validarTreinamento(bruto));
      await auditar('agente_treinamento_criado', agente.id, { treinamento_id: treinamento.id, tipo: treinamento.tipo }, usuarioId);
      return treinamento;
    },

    async removerTreinamento(id, treinamentoId, { usuarioId = null } = {}) {
      const agente = await exigirAgente(id);
      const alvo = exigirIdPositivo(treinamentoId, 'treinamento_id');
      const removido = await repositorio.removerTreinamento(agente.id, alvo);
      if (!removido) throw erroComStatus('treinamento não encontrado', 404, 'treinamento_nao_encontrado');
      await auditar('agente_treinamento_removido', agente.id, { treinamento_id: alvo }, usuarioId);
      return true;
    },

    async definirInatividade(id, acoes, { usuarioId = null } = {}) {
      const agente = await exigirAgente(id);
      const validadas = validarAcoesDeInatividade(acoes);
      const gravadas = await repositorio.definirAcoesDeInatividade(agente.id, validadas);
      await auditar('agente_inatividade_definida', agente.id, { quantidade: validadas.length }, usuarioId);
      return gravadas;
    },

    async definirCanais(id, canais, { usuarioId = null } = {}) {
      const agente = await exigirAgente(id);
      const validados = validarCanais(canais);
      // Canal de outro agente vira 409 no repositório — e sobe como está: a
      // tela precisa dizer "essa instância já é de outro agente".
      const gravados = await repositorio.definirCanaisDoAgente(agente.id, validados);
      await auditar('agente_canais_definidos', agente.id, {
        canais: validados.map((canal) => `${canal.canal}:${canal.instancia}`),
      }, usuarioId);
      return gravados;
    },

    // ------------------------------------------ painel de operação

    /**
     * Tudo que o painel do agente mostra de uma vez, sem conteúdo de mensagem:
     * status e quem mudou por último, números de hoje e dos últimos 7 dias,
     * conversas aguardando a equipe e as recentes.
     */
    async operacao(id) {
      const agente = await exigirAgente(id);
      const instante = agora();
      const hojeDesde = inicioDoDiaNaClinica(instante).toISOString();
      const semanaDesde = new Date(instante.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [resumo, historico, aguardando, recentes] = await Promise.all([
        repositorio.resumirOperacaoDoAgente(agente.id, { acoes: [...ACOES_DO_PAINEL], hojeDesde, semanaDesde }),
        repositorio.listarAuditoriaDoAgente(agente.id, { acoes: [...ACOES_DE_STATUS], limite: 50 }),
        repositorio.listarConversasDoAgenteAguardandoEquipe(agente.id, { limite: 20 }),
        repositorio.listarConversas({ agenteId: agente.id, limite: 10 }),
      ]);

      const porAcao = Object.fromEntries(ACOES_DO_PAINEL.map((acao) => [acao, { hoje: 0, semana: 0, ultima: null }]));
      for (const item of resumo.acoes) {
        if (porAcao[item.acao]) porAcao[item.acao] = { hoje: item.hoje, semana: item.semana, ultima: item.ultima };
      }

      return {
        agente: { id: agente.id, nome: agente.nome, status: agente.status },
        status_alterado: historico.map(mudancaDeStatus).find(Boolean) ?? null,
        numeros: { conversas_novas: resumo.conversas_novas, por_acao: porAcao },
        aguardando: aguardando.map(resumirConversaDoPainel),
        conversas: recentes.map(resumirConversaDoPainel),
      };
    },

    /** Conversas de agente esperando a equipe, contadas por agente — para o selo do menu. */
    async aguardandoPorAgente() {
      const por_agente = await repositorio.contarConversasAguardandoEquipePorAgente();
      return { total: por_agente.reduce((soma, item) => soma + item.total, 0), por_agente };
    },

    /**
     * Estado do WhatsApp do agente na Evolution. Falha da Evolution vira estado
     * `erro` com o motivo curto, nunca exceção: o painel inteiro não pode cair
     * porque um serviço externo piscou (já aconteceu com a tela da Serena).
     */
    async whatsapp(id) {
      const agente = await exigirAgente(id);
      const canal = canalDeWhatsapp(agente);
      const vazio = { numero: null, perfil: null };
      if (!canal) return { instancia: null, canal_ativo: false, estado: 'sem_canal', ...vazio };

      const base = { instancia: canal.instancia, canal_ativo: canal.ativo !== false };
      if (!evolution?.disponivel) return { ...base, estado: 'nao_configurado', ...vazio };
      try {
        return { ...base, ...(await evolution.estado(canal.instancia)) };
      } catch (erro) {
        return { ...base, estado: 'erro', ...vazio, erro: erro.message };
      }
    },

    /**
     * Pede à Evolution o código de pareamento (com número) e o QR da instância
     * do agente. Não cria instância nem mexe em webhook (docs/AGENTES.md).
     */
    async conectarWhatsapp(id, dados, { usuarioId = null } = {}) {
      const agente = await exigirAgente(id);
      const numero = validarNumeroDePareamento(exigirObjetoOuVazio(dados).numero);
      const canal = canalDeWhatsapp(agente);
      if (!canal) {
        throw erroComStatus('o agente não tem canal de WhatsApp — cadastre a instância na aba Canais', 422, 'agente_sem_canal');
      }
      if (!evolution?.disponivel) {
        throw erroComStatus('a Evolution API não está configurada no servidor', 503, 'evolution_nao_configurada');
      }

      const resultado = await evolution.conectar(canal.instancia, { numero });
      // Sem o número: é o do negócio, mas não é dado de diagnóstico.
      await auditar('agente_whatsapp_conexao_pedida', agente.id, {
        instancia: canal.instancia, por_codigo: Boolean(numero), ja_conectado: resultado.ja_conectado === true,
      }, usuarioId);
      return { instancia: canal.instancia, ...resultado };
    },

    /**
     * Pausa o agente (status `desativado` — a 046 não tem estado "pausado", e
     * para quem responde clientes pausar e desligar são o mesmo efeito). Motivo
     * opcional, escrito pela equipe; nunca texto de cliente.
     */
    async pausar(id, dados, { usuarioId = null } = {}) {
      const atual = await exigirAgente(id);
      const motivo = validarMotivoDePausa(exigirObjetoOuVazio(dados).motivo);
      if (atual.status === 'desativado') return { agente: atual, mudou: false };

      const agente = await repositorio.atualizarAgente(atual.id, { status: 'desativado' }, { usuarioId });
      await auditar('agente_pausado', atual.id, { status_de: atual.status, ...(motivo ? { motivo } : {}) }, usuarioId);
      return { agente, mudou: true };
    },

    /** Retoma o atendimento automático do agente (status `ativo`). */
    async retomar(id, { usuarioId = null } = {}) {
      const atual = await exigirAgente(id);
      if (atual.status === 'ativo') return { agente: atual, mudou: false };

      const agente = await repositorio.atualizarAgente(atual.id, { status: 'ativo' }, { usuarioId });
      await auditar('agente_retomado', atual.id, { status_de: atual.status }, usuarioId);
      return { agente, mudou: true };
    },

    /**
     * Conversa de teste: gera a resposta como o agente geraria, sem gravar
     * mensagem nem enviar nada. Vale para agente desativado — é justamente
     * como se testa antes de ligar.
     */
    async testar(id, { mensagens } = {}) {
      if (!motor?.gerarResposta) throw erroComStatus('motor dos agentes não configurado', 503, 'motor_indisponivel');
      const agente = await exigirAgente(id);
      const conversa = validarMensagensDeTeste(mensagens);
      const treinamentos = await repositorio.listarTreinamentos(agente.id);

      const base = agora().getTime() - conversa.length * 1000;
      const resultado = await motor.gerarResposta({
        agente,
        treinamentos,
        mensagens: conversa.map((mensagem, indice) => ({
          autor_tipo: mensagem.autor === 'cliente' ? 'contato' : 'automacao',
          conteudo: mensagem.texto,
          privada: false,
          tipo: 'texto',
          criado_em: new Date(base + indice * 1000).toISOString(),
        })),
        contato: { nome: 'Teste', telefone: null },
        // Chave única por pedido: repetir a mesma pergunta no teste precisa de
        // resposta nova, não da cópia guardada pela idempotência do gateway.
        chaveIdempotencia: `agente:${agente.id}:teste:${crypto.randomUUID()}`,
      });

      return {
        partes: Array.isArray(resultado?.partes) ? resultado.partes : [],
        transferir: resultado?.transferir === true,
        motivo: resultado?.motivo ?? null,
        provedor: resultado?.provedor ?? null,
        modelo: resultado?.modelo ?? null,
      };
    },
  };
}

module.exports = {
  criarServicoDeAgentes,
  criarBuscadorDePagina,
  validarUrlPublica,
  ehEnderecoPrivado,
  htmlParaTexto,
  LIMITE_HTML_CARACTERES,
  PAGINA_PADRAO,
  LIMITE_MENSAGENS_DE_TESTE,
};
