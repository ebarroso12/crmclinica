'use strict';

const crypto = require('node:crypto');
const { ErroDeContrato } = require('../contratos/erros');
const { FILAS, ESTADOS, PRIORIDADES, TEMPERATURAS, lerTemperatura } = require('../dominio/conversas');
const { agruparPorColuna, sugerirTemperatura } = require('../dominio/leads');
const { proximaAcao } = require('../dominio/qualificacao');
const {
  TODOS, veConversaDe, veContato, selosDoContato, recortarPedidoDeAgente, filtroDeEscopo, contatoParaColaborador,
  ErroSemAcessoAClinica,
} = require('../seguranca/escopo');

// Migration 047 + auditoria de acesso A2 (docs/AGENTES.md, "Quem vê o quê").
// Quem não vê a clínica recebe o contato por LISTA BRANCA — antes só
// observações e atributos saíam, e nome completo, nascimento, responsável,
// consentimento e documentos iam junto. Notas da ficha também não vão.
function fichaSemDadoClinico(contato) {
  return contatoParaColaborador(contato);
}

/** A conversa como o colaborador a recebe: o contato embutido também por lista branca. */
function conversaSemDadoClinico(conversa) {
  if (!conversa) return conversa;
  return { ...conversa, contato: contatoParaColaborador(conversa.contato) };
}

function erroNaoEncontrado(mensagem) {
  const erro = new Error(mensagem);
  erro.status = 404;
  return erro;
}

async function nomesDosAgentes(repositorio) {
  const agentes = repositorio.listarAgentes ? await repositorio.listarAgentes() : [];
  return new Map(agentes.map((agente) => [agente.id, agente.nome]));
}

// API do inbox local. O banco do crmclinica é a fonte de dados; não há
// serviço externo de conversas por trás destas rotas.

// Anexo de arquivo no chat: MIME aceito → tipo do schema (mensagens.tipo já
// suporta os quatro desde a migration 001). Fechado por allowlist — um MIME
// fora desta lista nunca vira upload, então nunca vira envio ao paciente.
const MIME_PARA_TIPO = Object.freeze({
  'image/jpeg': 'imagem',
  'image/png': 'imagem',
  'image/webp': 'imagem',
  'application/pdf': 'documento',
  'audio/ogg': 'audio',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/webm': 'audio',
  'video/mp4': 'video',
});

/**
 * Nome de arquivo sanitizado para virar parte de um path de Storage: sem
 * separador de diretório (path traversal), sem caractere de controle, sem
 * nome vazio. Trunca para não estourar o limite de path do bucket.
 */
function sanitizarNomeDeArquivo(valor) {
  const semSeparadorDeDiretorio = String(valor == null ? '' : valor)
    .replace(/[/\\]/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/\s+/g, '_')
    .trim();
  const semPontoInicial = semSeparadorDeDiretorio.replace(/^\.+/, '');
  // Caractere de controle fora por código, não por classe de regex de range
  // — um range mal escrito nesse ponto já corrompeu este arquivo com um byte
  // nulo literal uma vez nesta mesma tarefa; filtrar por charCodeAt não tem
  // essa armadilha de escaping.
  const semControle = Array.from(semPontoInicial).filter((c) => c.charCodeAt(0) >= 32).join('');
  return (semControle || 'arquivo').slice(0, 120);
}

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

const TIPOS_DE_MIDIA = Object.freeze(['imagem', 'documento', 'audio', 'video']);

/**
 * Confere um anexo já enviado ao Storage antes de deixá-lo virar mensagem.
 *
 * A checagem que importa de verdade é o prefixo do caminho: `prepararAnexo`
 * sempre devolve um path começando com `conversas/{id}/`, então um caminho
 * que não bate com a conversa atual só pode vir de alguém reaproveitando (ou
 * adivinhando) o path de OUTRA conversa — a mensagem final ficaria apontando
 * para um anexo que não é dela.
 */
function validarAnexoRecebido(anexoBruto, conversaId) {
  if (anexoBruto === undefined || anexoBruto === null) return null;
  if (typeof anexoBruto !== 'object' || Array.isArray(anexoBruto)) {
    throw new ErroDeContrato('campo "anexo" deve ser um objeto', 'anexo');
  }

  const caminho = typeof anexoBruto.caminho === 'string' ? anexoBruto.caminho.trim() : '';
  if (!caminho) throw new ErroDeContrato('campo "anexo.caminho" é obrigatório', 'anexo.caminho');

  const prefixoEsperado = `conversas/${conversaId}/`;
  if (!caminho.startsWith(prefixoEsperado)) {
    throw new ErroDeContrato('anexo não pertence a esta conversa', 'anexo.caminho');
  }

  const tipo = exigirEnum(anexoBruto.tipo, 'anexo.tipo', TIPOS_DE_MIDIA);
  const nome = typeof anexoBruto.nome === 'string' ? anexoBruto.nome.trim().slice(0, 200) : null;

  return { caminho, tipo, nome };
}

function criarRotasDeConversas({
  repositorio, atendimento, emissorDeConversas = null, storage = null, limiteAnexoBytes = 10 * 1024 * 1024,
  orientacoes = null,
}) {
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

    /** GET /api/conversas?fila=…&status=…&busca=…&contato=…&agente=… */
    async listarConversas(parametros, { escopo = null } = {}) {
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

      // De quem é a conversa (docs/AGENTES.md): sem parâmetro, todas; `clinica`,
      // só as sem agente; um id, só as daquele agente. Valor estranho é 400 —
      // ignorar o filtro mostraria a lista inteira como se fosse o recorte pedido.
      const agenteParam = parametros.get('agente');
      const agenteId = !agenteParam
        ? undefined
        : agenteParam === 'clinica' ? null : exigirIdentificador(agenteParam, 'agente');
      const contatoParam = parametros.get('contato');
      const contatoId = contatoParam ? exigirIdentificador(contatoParam, 'contato') : null;

      // Migration 047: o escopo de quem pede recorta o filtro. Pedir um agente
      // (ou "só da clínica") que a pessoa não vê devolve lista vazia — nem 403,
      // nem a lista inteira, e nada que confirme que aquilo existe.
      let recorte = { agenteId };
      if (escopo) {
        recorte = recortarPedidoDeAgente(escopo, agenteId);
        if (!recorte) return { fila, rotulo: FILAS[fila].rotulo, total: 0, conversas: [] };
      }

      const conversas = await repositorio.listarConversas({
        status: status || null,
        busca: parametros.get('busca') || null,
        contatoId,
        dataInicio: dataInicio || null,
        dataFim: dataFim || null,
        ordenacao,
        limite: 50,
        agenteId: recorte.agenteId,
        escopo: escopo ? filtroDeEscopo(escopo) : null,
      });

      // A fila é um recorte de quem responde, não um filtro do banco.
      const filtradas = fila === 'minhas'
        ? conversas.filter((conversa) => conversa.assumida_por_humano || conversa.atribuido_a)
        : fila === 'nao_atribuidas'
          ? conversas.filter((conversa) => !conversa.assumida_por_humano && !conversa.atribuido_a)
          : conversas;

      // A próxima ação vai junto: é o que a recepção lê sem abrir a conversa.
      // Quem não vê a clínica recebe o contato de cada conversa por lista branca.
      const listaSemClinica = Boolean(escopo) && escopo.clinica !== true;
      const comAcao = filtradas.map((conversa) => ({
        ...(listaSemClinica ? conversaSemDadoClinico(conversa) : conversa),
        proxima_acao: conversa.lead_id ? proximaAcao(conversa) : null,
      }));

      return { fila, rotulo: FILAS[fila].rotulo, total: comAcao.length, conversas: comAcao };
    },

    /** GET /api/conversas/:id — conversa, ficha, notas e conversas anteriores. */
    async obterConversa(conversaId, { escopo = null } = {}) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      const conversa = await exigirConversa(repositorio, id);
      // Mesma resposta de "não existe": fora do escopo não confirma nada.
      if (escopo && !veConversaDe(escopo, conversa.agente_id ?? null)) throw erroNaoEncontrado('conversa não encontrada');
      const semClinica = Boolean(escopo) && escopo.clinica !== true;

      const [contatoBruto, notasBrutas, anteriores, orientacaoPendente] = await Promise.all([
        repositorio.obterContato(conversa.contato_id),
        semClinica ? [] : repositorio.listarNotas(conversa.contato_id),
        // As outras conversas do mesmo contato também passam pelo escopo: o
        // paciente que falou com a loja não leva a conversa da clínica junto.
        repositorio.listarConversas({
          contatoId: conversa.contato_id, limite: 20, escopo: escopo ? filtroDeEscopo(escopo) : null,
        }),
        // A dúvida que a assistente deixou para a clínica. Vem no detalhe da
        // conversa porque é aqui que a pessoa está quando pode responder — um
        // painel separado significaria a equipe ler a dúvida sem o contexto da
        // conversa que a gerou. Ausente enquanto a migration 052 não rodar.
        repositorio.obterOrientacaoPendente
          ? repositorio.obterOrientacaoPendente(id).catch(() => null)
          : null,
      ]);
      const contato = semClinica ? fichaSemDadoClinico(contatoBruto) : contatoBruto;
      const notas = notasBrutas;

      return {
        // A próxima ação acompanha a conversa aberta, não só a lista: quem já
        // está na thread precisa ver o que perguntar sem voltar para a esquerda.
        conversa: {
          ...(semClinica ? conversaSemDadoClinico(conversa) : conversa),
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
        orientacao_pendente: orientacaoPendente
          ? {
            id: orientacaoPendente.id,
            duvida: orientacaoPendente.duvida,
            criado_em: orientacaoPendente.criado_em,
          }
          : null,
      };
    },

    /**
     * POST /api/conversas/:id/orientacao — a clínica responde à dúvida.
     *
     * O texto que chega aqui é BASTIDOR: escrito depressa, para um colega, e
     * pode conter recado interno, margem de desconto ou opinião. Ele nunca vai
     * ao paciente como veio — a assistente compila, e uma barreira confere
     * antes de sair (ver `respostaPodeSair`). Quando a barreira barra, a
     * orientação fica registrada e quem responde é uma pessoa.
     */
    async responderOrientacao(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);

      if (!orientacoes) {
        const erro = new Error('o fluxo de orientação não está configurado neste servidor');
        erro.status = 503;
        throw erro;
      }

      const pendente = await repositorio.obterOrientacaoPendente(id);
      if (!pendente) throw erroNaoEncontrado('não há dúvida pendente nesta conversa');

      const texto = exigirTexto(corpo?.orientacao, 'orientacao', 2000);

      return orientacoes.responder({
        orientacaoId: pendente.id,
        orientacao: texto,
        usuarioId: corpo?.usuario_id ?? null,
        enviar: (compilada) => atendimento.responderComoAssistente(id, compilada, {
          usuarioId: corpo?.usuario_id ?? null,
          orientacaoId: pendente.id,
        }),
      });
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

      const brutas = (await repositorio.listarMensagens(id))
        .map((mensagem) => ({ ...mensagem, tipo_item: 'mensagem' }));

      // O bucket é privado — `media_url` no banco guarda só o path interno,
      // nunca uma URL utilizável pelo navegador direto. Resolve para uma
      // leitura assinada de vida curta aqui, em paralelo, uma vez por
      // mensagem com anexo. Falha ao assinar UMA mensagem (arquivo sumiu,
      // rede) não pode derrubar a THREAD INTEIRA — vira null nessa mensagem
      // só, o resto da conversa continua de pé.
      const mensagens = await Promise.all(brutas.map(async (mensagem) => {
        if (!mensagem.media_url || !storage?.disponivel) return mensagem;
        try {
          return { ...mensagem, media_url: await storage.gerarLeituraAssinada(mensagem.media_url) };
        } catch (erro) {
          console.error(`[rotas-conversas] falha ao assinar leitura de anexo (mensagem ${mensagem.id}): ${erro.message}`);
          return { ...mensagem, media_url: null };
        }
      }));

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

    /**
     * POST /api/conversas/:id/anexos — passo 1 do envio de arquivo: devolve
     * uma URL de upload de uso único. O ARQUIVO em si nunca passa por este
     * servidor (o corpo aqui é só metadado, poucos bytes) — o navegador do
     * atendente sobe direto ao Storage com a URL devolvida, e só DEPOIS
     * chama POST /mensagens com o caminho recebido aqui (ver `responder`).
     */
    async prepararAnexo(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);

      if (!storage?.disponivel) {
        const erro = new Error('envio de anexo não está configurado');
        erro.status = 503;
        throw erro;
      }

      const nomeOriginal = exigirTexto(corpo?.nome_arquivo, 'nome_arquivo', 200);
      const tipoMime = exigirTexto(corpo?.tipo_mime, 'tipo_mime', 100);
      const tipo = MIME_PARA_TIPO[tipoMime];
      if (!tipo) throw new ErroDeContrato(`tipo de arquivo não permitido: ${tipoMime}`, 'tipo_mime');

      const tamanhoBytes = Number(corpo?.tamanho_bytes);
      if (!Number.isInteger(tamanhoBytes) || tamanhoBytes <= 0) {
        throw new ErroDeContrato('campo "tamanho_bytes" deve ser um inteiro positivo', 'tamanho_bytes');
      }
      if (tamanhoBytes > limiteAnexoBytes) {
        throw new ErroDeContrato(
          `arquivo excede o tamanho máximo (${Math.floor(limiteAnexoBytes / (1024 * 1024))}MB)`,
          'tamanho_bytes',
        );
      }

      const nomeSanitizado = sanitizarNomeDeArquivo(nomeOriginal);
      // Prefixo por conversa: é o que `validarAnexoRecebido` confere depois,
      // em `responder`, para um anexo nunca virar mensagem de uma conversa
      // que não é a dele.
      const caminho = `conversas/${id}/${crypto.randomUUID()}-${nomeSanitizado}`;

      const { urlDeUpload } = await storage.gerarUploadAssinado(caminho);
      return {
        caminho,
        tipo,
        nome: nomeOriginal,
        upload_url: urlDeUpload,
        tipo_mime: tipoMime,
      };
    },

    /**
     * POST /api/conversas/:id/mensagens — resposta humana; assumir vem
     * junto. Texto normal, ou um anexo já enviado ao Storage (ver
     * `prepararAnexo`, acima) com legenda opcional — nunca os dois campos
     * vazios: "responder" sem texto e sem anexo não é uma ação de verdade.
     */
    async responder(conversaId, corpo) {
      const id = exigirIdentificador(conversaId, 'conversa_id');
      await exigirConversa(repositorio, id);

      const privada = Boolean(corpo?.privada);
      const anexo = validarAnexoRecebido(corpo?.anexo, id);
      // Com anexo, o texto vira legenda — pode faltar. Sem anexo, é
      // obrigatório como sempre foi.
      const texto = anexo
        ? (typeof corpo?.texto === 'string' ? corpo.texto.trim().slice(0, LIMITE_TEXTO) : '')
        : exigirTexto(corpo?.texto, 'texto');
      if (privada && anexo) throw new ErroDeContrato('nota interna não aceita anexo', 'anexo');

      const mensagem = await atendimento.responderComoEquipe(id, texto, {
        usuarioId: corpo?.usuario_id ?? null,
        autorNome: corpo?.autor ?? null,
        privada,
        anexo,
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

    /**
     * POST /api/conversas/liberar-todas — devolve à automação toda conversa
     * que a PRÓPRIA automação travou por falha (nunca uma que um humano
     * assumiu de verdade — ver o comentário de `liberarEmMassa` em
     * atendimento.js). Existe para o dia em que um canal cai por um tempo:
     * corrigida a causa raiz, ninguém deveria precisar clicar conversa por
     * conversa pra destravar o que sobrou.
     */
    async liberarTodas() {
      const { liberadas } = await atendimento.liberarEmMassa();
      return {
        liberadas,
        detalhe: liberadas > 0
          ? `${liberadas} conversa(s) devolvida(s) à automação.`
          : 'Nenhuma conversa travada por falha para liberar.',
      };
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

      // A temperatura vive nas etiquetas; o lead precisa refletir a mesma verdade
      // — só na conversa da CLÍNICA (auditoria de acesso M2). Lead é da clínica:
      // a etiqueta posta numa conversa de agente fica só nela, para qualquer
      // usuário. Antes, "lead_quente" no Alpins trocava a temperatura e o
      // conversa_id do lead da clínica.
      const temperatura = lerTemperatura(aplicadas);
      const conversa = await repositorio.obterConversa(id);
      const daClinica = (conversa.agente_id ?? null) === null;
      if (temperatura && daClinica) await repositorio.salvarLead(conversa.contato_id, { conversaId: id, temperatura });

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
    async criarNota(conversaId, corpo, { escopo = null } = {}) {
      // Auditoria de acesso B3: a nota é gravada no CONTATO (ficha da clínica),
      // não na conversa. Quem não vê a clínica anota na thread do agente com
      // mensagem privada. A lista de rotas já barra; esta linha segura se ela mudar.
      if (escopo && escopo.clinica !== true) throw new ErroSemAcessoAClinica();
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
    async historicoDoContato(contatoId, { escopo = null } = {}) {
      const id = exigirIdentificador(contatoId, 'contato_id');
      const contatoBruto = await repositorio.obterContato(id);
      if (!contatoBruto) throw erroNaoEncontrado('contato não encontrado');

      // Migration 047 + decisão 11/09: quem vê a clínica vê o contato (base
      // compartilhada); quem não vê só o cliente dos agentes dele. As conversas
      // — e a prévia de cada uma — seguem sempre o escopo de conversas.
      const efetivo = escopo ?? { admin: true, clinica: true, agentes: TODOS };
      const origens = repositorio.obterOrigensDoContato
        ? await repositorio.obterOrigensDoContato(id)
        : { clinica: true, agentes: [] };
      if (!veContato(efetivo, origens.agentes)) throw erroNaoEncontrado('contato não encontrado');
      const semClinica = efetivo.clinica !== true;

      const [conversas, notas, nomes] = await Promise.all([
        repositorio.listarConversas({ contatoId: id, limite: 50, escopo: escopo ? filtroDeEscopo(escopo) : null }),
        semClinica ? [] : repositorio.listarNotas(id),
        nomesDosAgentes(repositorio),
      ]);

      return {
        contato: semClinica ? fichaSemDadoClinico(contatoBruto) : contatoBruto,
        notas,
        conversas: semClinica ? conversas.map(conversaSemDadoClinico) : conversas,
        selos: selosDoContato(efetivo, origens, nomes),
      };
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
