'use strict';

// Gateway multi-IA do crmclinica.
//
// Regras que este arquivo existe para garantir:
//
//   1. **Segredos só no servidor.** As chaves entram pela configuração e não
//      saem daqui — nem em log, nem em resposta, nem em telemetria.
//   2. **Catálogo e allowlist são do backend.** O chamador pede provedor e
//      modelo pelo NOME; se não estiverem no catálogo ativo, a chamada é
//      recusada — não existe "modelo digitado livre".
//   3. **Retry é idempotente.** A mesma chave devolve o MESMO resultado, sem
//      nova cobrança. É a telemetria que sustenta isso.
//   4. **Fallback é técnico, nunca semântico.** Timeout, rede e 5xx passam ao
//      próximo provedor com a mesma chave; recusa de conteúdo não é retentada.
//   5. **Telemetria sem raciocínio interno.** Modelo, versão de prompt,
//      latência, tokens, custo, erro e fallback — e o texto final. Nada mais.

class ErroDeIA extends Error {
  constructor(mensagem, codigo, { status = 502, tecnico = true } = {}) {
    super(mensagem);
    this.name = 'ErroDeIA';
    this.codigo = codigo;
    this.status = status;
    this.tecnico = tecnico;
  }
}

/** Chamada HTTP com prazo. Timeout NUNCA vira sucesso. */
async function pedirComPrazo(url, opcoes, timeoutMs) {
  const controlador = new AbortController();
  const relogio = setTimeout(() => controlador.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opcoes, signal: controlador.signal });
  } catch (erro) {
    if (erro.name === 'AbortError') {
      throw new ErroDeIA(`o provedor não respondeu em ${timeoutMs}ms`, 'ia_timeout');
    }
    throw new ErroDeIA(`falha de rede com o provedor: ${erro.message}`, 'ia_rede');
  } finally {
    clearTimeout(relogio);
  }
}

async function interpretarErroHttp(resposta, provedor) {
  let detalhe = '';
  try {
    detalhe = (await resposta.text()).slice(0, 200);
  } catch { /* corpo ilegível não muda a decisão */ }

  // 5xx e 429 são problemas do provedor: fallback resolve. 4xx de chave ou
  // permissão também é "este provedor não serve agora". Só recusa de conteúdo
  // (400 com corpo explicando) não deve ser retentada em outro provedor — mas
  // distinguir isso com segurança exige contrato por provedor; o conservador
  // aqui é tratar 400 como não-técnico e parar.
  const tecnico = resposta.status >= 500 || resposta.status === 429
    || resposta.status === 401 || resposta.status === 403;
  throw new ErroDeIA(
    `${provedor} respondeu HTTP ${resposta.status}: ${detalhe}`,
    `ia_http_${resposta.status}`,
    { tecnico },
  );
}

/**
 * Adaptadores por provedor. Todos com o mesmo contrato:
 * `({ modelo, sistema, prompt, chave, timeoutMs })` → `{ texto, tokensEntrada, tokensSaida }`.
 */
function criarAdaptadores(configuracao) {
  const compativelOpenAi = (baseUrl, chaveDeApi, provedor) => async ({ modelo, sistema, prompt, timeoutMs }) => {
    const resposta = await pedirComPrazo(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${chaveDeApi}` },
      body: JSON.stringify({
        model: modelo,
        messages: [
          ...(sistema ? [{ role: 'system', content: sistema }] : []),
          { role: 'user', content: prompt },
        ],
        max_tokens: 2048,
      }),
    }, timeoutMs);

    if (!resposta.ok) await interpretarErroHttp(resposta, provedor);
    const corpo = await resposta.json();
    return {
      texto: corpo.choices?.[0]?.message?.content ?? '',
      tokensEntrada: corpo.usage?.prompt_tokens ?? null,
      tokensSaida: corpo.usage?.completion_tokens ?? null,
    };
  };

  const adaptadores = {};

  if (configuracao.ia?.openaiKey) {
    adaptadores.openai = compativelOpenAi('https://api.openai.com/v1', configuracao.ia.openaiKey, 'openai');
  }
  if (configuracao.ia?.deepseekKey) {
    adaptadores.deepseek = compativelOpenAi('https://api.deepseek.com/v1', configuracao.ia.deepseekKey, 'deepseek');
  }
  if (configuracao.kimi?.habilitado) {
    adaptadores.kimi = compativelOpenAi(configuracao.kimi.baseUrl, configuracao.kimi.chave, 'kimi');
  }

  if (configuracao.ia?.anthropicKey) {
    adaptadores.anthropic = async ({ modelo, sistema, prompt, timeoutMs }) => {
      const resposta = await pedirComPrazo('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': configuracao.ia.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: modelo,
          max_tokens: 2048,
          ...(sistema ? { system: sistema } : {}),
          messages: [{ role: 'user', content: prompt }],
        }),
      }, timeoutMs);

      if (!resposta.ok) await interpretarErroHttp(resposta, 'anthropic');
      const corpo = await resposta.json();
      return {
        texto: corpo.content?.map((bloco) => bloco.text ?? '').join('') ?? '',
        tokensEntrada: corpo.usage?.input_tokens ?? null,
        tokensSaida: corpo.usage?.output_tokens ?? null,
      };
    };
  }

  if (configuracao.ia?.googleKey) {
    adaptadores.google = async ({ modelo, sistema, prompt, timeoutMs }) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;
      const resposta = await pedirComPrazo(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': configuracao.ia.googleKey },
        body: JSON.stringify({
          ...(sistema ? { systemInstruction: { parts: [{ text: sistema }] } } : {}),
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
      }, timeoutMs);

      if (!resposta.ok) await interpretarErroHttp(resposta, 'google');
      const corpo = await resposta.json();
      return {
        texto: corpo.candidates?.[0]?.content?.parts?.map((parte) => parte.text ?? '').join('') ?? '',
        tokensEntrada: corpo.usageMetadata?.promptTokenCount ?? null,
        tokensSaida: corpo.usageMetadata?.candidatesTokenCount ?? null,
      };
    };
  }

  return adaptadores;
}

function custoEstimado(modelo, tokensEntrada, tokensSaida) {
  if (!modelo || (tokensEntrada === null && tokensSaida === null)) return null;
  const entrada = (Number(tokensEntrada) || 0) * (Number(modelo.custo_entrada_usd_mi) || 0) / 1_000_000;
  const saida = (Number(tokensSaida) || 0) * (Number(modelo.custo_saida_usd_mi) || 0) / 1_000_000;
  return Math.round((entrada + saida) * 1_000_000) / 1_000_000;
}

function criarGatewayDeIA({ configuracao, repositorio, adaptadores = null, agora = () => Date.now() }) {
  if (!repositorio) throw new Error('o gateway de IA exige o repositório');
  const provedores = adaptadores ?? criarAdaptadores(configuracao ?? {});
  const timeoutMs = configuracao?.ia?.timeoutMs ?? 30000;

  /** O que o menu da interface mostra: provedores e, por provedor, os modelos. */
  async function catalogo() {
    const modelos = await repositorio.listarModelosDeIA({ apenasAtivos: true });
    const porProvedor = new Map();
    for (const modelo of modelos) {
      if (!porProvedor.has(modelo.provedor)) porProvedor.set(modelo.provedor, []);
      porProvedor.get(modelo.provedor).push({
        modelo: modelo.modelo,
        rotulo: modelo.rotulo,
        padrao: modelo.padrao === true,
      });
    }
    return [...porProvedor.entries()].map(([provedor, lista]) => ({
      provedor,
      // "Disponível" = tem chave no servidor. O menu mostra tudo; o indisponível
      // aparece desabilitado, para a equipe saber o que existe e o que falta.
      disponivel: Boolean(provedores[provedor]),
      modelos: lista,
    }));
  }

  /**
   * Gera texto com fallback técnico e telemetria completa.
   * A chave de idempotência é obrigatória: sem ela, retry viraria custo dobrado.
   */
  async function gerar({
    finalidade, prompt, sistema = null, provedor = null, modelo = null,
    chaveIdempotencia, promptVersion = null,
  }) {
    if (!chaveIdempotencia) throw new ErroDeIA('chamada de IA sem chave de idempotência', 'ia_sem_chave', { status: 400, tecnico: false });
    if (!prompt || !String(prompt).trim()) throw new ErroDeIA('chamada de IA sem prompt', 'ia_sem_prompt', { status: 400, tecnico: false });

    // Retry com a mesma chave devolve o mesmo resultado, sem nova chamada.
    const anterior = await repositorio.obterChamadaDeIA(chaveIdempotencia);
    if (anterior && anterior.resposta && !anterior.erro) {
      return { ...anterior, de_cache: true };
    }

    const catalogoAtivo = await repositorio.listarModelosDeIA({ apenasAtivos: true });
    if (catalogoAtivo.length === 0) {
      throw new ErroDeIA('o catálogo de modelos está vazio', 'ia_sem_catalogo', { status: 503 });
    }

    // Allowlist: o pedido precisa apontar para o catálogo.
    let escolhido = null;
    if (provedor || modelo) {
      escolhido = catalogoAtivo.find((linha) => (!provedor || linha.provedor === provedor)
        && (!modelo || linha.modelo === modelo));
      if (!escolhido) {
        throw new ErroDeIA(
          `modelo fora do catálogo: ${provedor ?? '?'}/${modelo ?? '?'}`,
          'ia_fora_do_catalogo',
          { status: 400, tecnico: false },
        );
      }
    }

    // Ordem de tentativa: o escolhido, depois o padrão, depois o resto —
    // sempre restrito a provedores com chave configurada.
    const candidatos = [];
    const incluir = (linha) => {
      if (!linha || !provedores[linha.provedor]) return;
      if (candidatos.some((c) => c.provedor === linha.provedor && c.modelo === linha.modelo)) return;
      candidatos.push(linha);
    };
    incluir(escolhido);
    incluir(catalogoAtivo.find((linha) => linha.padrao));
    for (const linha of catalogoAtivo) incluir(linha);

    if (candidatos.length === 0) {
      throw new ErroDeIA('nenhum provedor de IA com chave configurada', 'ia_indisponivel', { status: 503 });
    }

    let ultimoErro = null;
    let fallbackDe = null;

    for (const candidato of candidatos) {
      const inicio = agora();
      try {
        const resultado = await provedores[candidato.provedor]({
          modelo: candidato.modelo, sistema, prompt, timeoutMs,
        });

        const registro = {
          chaveIdempotencia,
          finalidade,
          provedor: candidato.provedor,
          modelo: candidato.modelo,
          promptVersion,
          latenciaMs: agora() - inicio,
          tokensEntrada: resultado.tokensEntrada,
          tokensSaida: resultado.tokensSaida,
          custoEstimadoUsd: custoEstimado(candidato, resultado.tokensEntrada, resultado.tokensSaida),
          resposta: resultado.texto,
          erro: null,
          fallbackDe,
        };
        await repositorio.registrarChamadaDeIA(registro);

        return {
          resposta: resultado.texto,
          provedor: candidato.provedor,
          modelo: candidato.modelo,
          latencia_ms: registro.latenciaMs,
          tokens_entrada: registro.tokensEntrada,
          tokens_saida: registro.tokensSaida,
          custo_estimado_usd: registro.custoEstimadoUsd,
          fallback_de: fallbackDe,
          de_cache: false,
        };
      } catch (erro) {
        ultimoErro = erro;
        // Só falha TÉCNICA passa ao próximo provedor. Recusa semântica para.
        if (erro instanceof ErroDeIA && erro.tecnico === false) break;
        fallbackDe = fallbackDe ?? candidato.provedor;
      }
    }

    await repositorio.registrarChamadaDeIA({
      chaveIdempotencia,
      finalidade,
      provedor: candidatos[0].provedor,
      modelo: candidatos[0].modelo,
      promptVersion,
      latenciaMs: null,
      tokensEntrada: null,
      tokensSaida: null,
      custoEstimadoUsd: null,
      resposta: null,
      erro: `${ultimoErro?.codigo ?? 'erro'}: ${ultimoErro?.message ?? 'desconhecido'}`.slice(0, 300),
      fallbackDe,
    }).catch(() => {});

    throw ultimoErro ?? new ErroDeIA('nenhum provedor respondeu', 'ia_indisponivel', { status: 503 });
  }

  return { catalogo, gerar, disponiveis: Object.keys(provedores) };
}

module.exports = { criarGatewayDeIA, criarAdaptadores, custoEstimado, ErroDeIA };
