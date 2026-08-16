'use strict';

// Cliente REST do Supabase Storage — sem SDK (`@supabase/supabase-js` não é
// dependência deste projeto; a regra é sem terceiros além de `pg`, ver
// testes/auditoria.test.js). Duas operações, ambas via `fetch` puro, mesmo
// padrão defensivo de evolution-envio.js (timeout, erro claro):
//
//   1. gerarUploadAssinado — o BACKEND pede ao Storage uma URL de upload de
//      uso único. O ARQUIVO em si nunca passa pelo nosso servidor: o
//      navegador do atendente sobe direto para o Storage com essa URL,
//      contornando o limite de corpo da function (configuracao.limiteCorpoBytes,
//      64KB por padrão — inviável para foto/documento real) e o teto de
//      payload da plataforma serverless.
//   2. gerarLeituraAssinada — o bucket é privado (dado de paciente não é
//      público): para exibir o anexo depois, cada leitura pede uma URL
//      assinada nova, de vida curta.

function criarClienteStorage(configuracao = {}, dependencias = {}) {
  const fetchImpl = dependencias.fetchImpl || globalThis.fetch;
  const disponivel = Boolean(configuracao.supabaseUrl && configuracao.chaveServico);
  const timeoutMs = configuracao.timeoutMs ?? 15000;

  async function chamar(caminho, corpo) {
    if (!disponivel) throw new Error('Storage de anexos não configurado (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)');
    if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');

    const url = `${configuracao.supabaseUrl}/storage/v1${caminho}`;
    let resposta;
    try {
      resposta = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: configuracao.chaveServico,
          authorization: `Bearer ${configuracao.chaveServico}`,
        },
        body: JSON.stringify(corpo ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (erro) {
      throw new Error(`falha de rede ao chamar o Storage: ${erro.message}`);
    }

    if (!resposta.ok) {
      const texto = await resposta.text().catch(() => '');
      throw new Error(`Storage respondeu HTTP ${resposta.status}${texto ? `: ${texto.slice(0, 300)}` : ''}`);
    }
    return resposta.json();
  }

  return {
    disponivel,
    bucket: configuracao.bucket,

    /**
     * URL de uso único para o navegador subir o arquivo direto ao Storage.
     * `caminho` já deve vir com o path completo dentro do bucket (ver
     * caminhoDeAnexo em rotas-conversas.js — sanitizado, sem atravessar
     * diretório).
     */
    async gerarUploadAssinado(caminho) {
      const dados = await chamar(`/object/upload/sign/${configuracao.bucket}/${caminho}`, {});
      if (!dados?.url) throw new Error('Storage não devolveu URL de upload assinada');
      // Absoluta, não relativa: quem chama isto é o navegador do atendente,
      // que não conhece (e não precisa conhecer) a URL base do Supabase.
      return { urlDeUpload: `${configuracao.supabaseUrl}/storage/v1${dados.url}` };
    },

    /** URL de leitura de vida curta — o bucket é privado, media_url guarda só o path. */
    async gerarLeituraAssinada(caminho, expiraEmSegundos = 3600) {
      const dados = await chamar(`/object/sign/${configuracao.bucket}/${caminho}`, { expiresIn: expiraEmSegundos });
      if (!dados?.signedURL) throw new Error('Storage não devolveu URL de leitura assinada');
      return `${configuracao.supabaseUrl}/storage/v1${dados.signedURL}`;
    },
  };
}

module.exports = { criarClienteStorage };
