'use strict';

// Repositório das tabelas de gestão clínica da migração 023: sessões (painel
// e revogação), termos versionados e assinaturas, deduplicação e qualidade
// cadastral.
//
// Módulo irmão de `repositorio.js` — mesma conexão ambiente via contexto,
// mesma serialização por cliente. O repositório principal fica enxuto; o que
// é desta frente mora aqui.

const { contexto } = require('./contexto');

const filasPorCliente = new WeakMap();

function criarRepositorioClinica(pool) {
  function consultar(texto, parametros = []) {
    const cliente = contexto.atual()?.client ?? pool;
    if (!cliente) return Promise.reject(new Error('pool indisponível'));
    const filaAnterior = filasPorCliente.get(cliente) ?? Promise.resolve();
    const execucao = filaAnterior.then(() => cliente.query(texto, parametros));
    filasPorCliente.set(cliente, execucao.catch(() => {}));
    return execucao;
  }

  return {
    // ------------------------------------------------------------ sessões (P1-03)

    /** Sessões de um usuário, da mais recente: o painel do administrador. */
    async listarSessoesDoUsuario(usuarioId) {
      const { rows } = await consultar(
        `SELECT id, criado_em, expira_em, revogada_em, agente, ip
         FROM sessoes
         WHERE usuario_id = $1
         ORDER BY criado_em DESC
         LIMIT 50`,
        [usuarioId],
      );
      return rows;
    },

    /**
     * Revoga uma sessão DESTE usuário. O escopo é a proteção: um admin não
     * derruba a sessão de outro admin apontando um id que não é do alvo.
     */
    async revogarSessaoDoUsuario(usuarioId, sessaoId) {
      const { rowCount } = await consultar(
        `UPDATE sessoes SET revogada_em = now()
         WHERE id = $1 AND usuario_id = $2 AND revogada_em IS NULL`,
        [sessaoId, usuarioId],
      );
      return rowCount > 0;
    },

    // ------------------------------------------------------------ termos (P1-07)

    /** O termo que vale agora para um escopo — no máximo um, pelo índice único. */
    async obterTermoVigente(escopo) {
      const { rows } = await consultar(
        'SELECT * FROM termos WHERE escopo = $1 AND publicado ORDER BY versao DESC LIMIT 1',
        [escopo],
      );
      return rows[0] ?? null;
    },

    async listarTermos(escopo = null) {
      const { rows } = await consultar(
        `SELECT id, escopo, versao, titulo, publicado, publicado_em, autor_id, criado_em,
                left(texto, 200) AS resumo
         FROM termos
         WHERE ($1::text IS NULL OR escopo = $1)
         ORDER BY escopo, versao DESC`,
        [escopo],
      );
      return rows;
    },

    /** Nova versão, sempre rascunho: publicar é gesto separado. */
    async criarVersaoDeTermo({ escopo, titulo, texto, autorId = null }) {
      const { rows } = await consultar(
        `INSERT INTO termos (escopo, versao, titulo, texto, autor_id)
         SELECT $1, COALESCE(max(versao), 0) + 1, $2, $3, $4 FROM termos WHERE escopo = $1
         RETURNING *`,
        [escopo, titulo, texto, autorId],
      );
      return rows[0];
    },

    /** Torna vigente e despublica a anterior no mesmo fluxo. */
    async publicarTermo(termoId) {
      const { rows } = await consultar('SELECT * FROM termos WHERE id = $1', [termoId]);
      const termo = rows[0];
      if (!termo) return null;
      await consultar(
        'UPDATE termos SET publicado = false WHERE escopo = $1 AND publicado AND id <> $2',
        [termo.escopo, termoId],
      );
      const { rows: atualizado } = await consultar(
        'UPDATE termos SET publicado = true, publicado_em = now() WHERE id = $1 RETURNING *',
        [termoId],
      );
      return atualizado[0];
    },

    /** Registra a assinatura feita no provedor externo. */
    async assinarTermo({ termoId, usuarioId = null, contatoId = null, assinaturaExternaId, provedor = null, registradoPor = null }) {
      const { rows } = await consultar(
        `INSERT INTO termo_assinaturas
           (termo_id, usuario_id, contato_id, assinatura_externa_id, provedor, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [termoId, usuarioId, contatoId, assinaturaExternaId, provedor, registradoPor],
      );
      return rows[0];
    },

    async obterAssinaturaDoUsuario(termoId, usuarioId) {
      const { rows } = await consultar(
        'SELECT * FROM termo_assinaturas WHERE termo_id = $1 AND usuario_id = $2',
        [termoId, usuarioId],
      );
      return rows[0] ?? null;
    },

    async obterAssinaturaDoContato(termoId, contatoId) {
      const { rows } = await consultar(
        'SELECT * FROM termo_assinaturas WHERE termo_id = $1 AND contato_id = $2',
        [termoId, contatoId],
      );
      return rows[0] ?? null;
    },

    async listarAssinaturas(termoId) {
      const { rows } = await consultar(
        'SELECT * FROM termo_assinaturas WHERE termo_id = $1 ORDER BY criado_em DESC',
        [termoId],
      );
      return rows;
    },

    // ------------------------------------------------------------ deduplicação (P1-09)

    /**
     * Pares suspeitos, com a evidência que os liga. Critérios fortes apenas:
     * mesmo CPF (pelo hash), mesmo WhatsApp estruturado, mesmo telefone.
     * Nome parecido não é evidência.
     */
    async buscarCandidatosADuplicata({ limite = 20 } = {}) {
      const { rows } = await consultar(
        `WITH pares AS (
           SELECT a.id AS contato_a, b.id AS contato_b, 'cpf' AS criterio
           FROM contatos a JOIN contatos b
             ON a.cpf_busca_hash IS NOT NULL AND a.cpf_busca_hash = b.cpf_busca_hash AND a.id < b.id
           WHERE a.excluido_em IS NULL AND b.excluido_em IS NULL
           UNION ALL
           SELECT a.id, b.id, 'whatsapp'
           FROM contatos a JOIN contatos b
             ON a.whatsapp_numero IS NOT NULL AND a.whatsapp_ddd = b.whatsapp_ddd
                AND a.whatsapp_numero = b.whatsapp_numero AND a.id < b.id
           WHERE a.excluido_em IS NULL AND b.excluido_em IS NULL
           UNION ALL
           SELECT a.id, b.id, 'telefone'
           FROM contatos a JOIN contatos b
             ON a.telefone IS NOT NULL AND a.telefone = b.telefone AND a.id < b.id
           WHERE a.excluido_em IS NULL AND b.excluido_em IS NULL
         )
         SELECT DISTINCT contato_a, contato_b, criterio FROM pares LIMIT $1`,
        [limite],
      );
      return rows.map((r) => ({
        contato_a: Number(r.contato_a),
        contato_b: Number(r.contato_b),
        criterio: r.criterio,
      }));
    },

    /**
     * Funde `perdedorId` em `vencedorId`: move os vínculos, completa os
     * campos vazios do vencedor e marca o perdedor como excluído com o motivo
     * que permite desfazer. Nada é apagado.
     */
    async fundirContatos(vencedorId, perdedorId) {
      const movidos = {};
      const tabelas = ['conversas', 'leads', 'agendamentos', 'notas_internas', 'lembretes', 'termo_assinaturas'];
      for (const tabela of tabelas) {
        // Cada UPDATE é independente de propósito: tabela que ainda não tem a
        // coluna (migrações fora de ordem) não derruba as outras.
        try {
          const { rowCount } = await consultar(
            `UPDATE ${tabela} SET contato_id = $1 WHERE contato_id = $2`,
            [vencedorId, perdedorId],
          );
          movidos[tabela] = rowCount;
        } catch (erro) {
          if (erro.code !== '42P01' && erro.code !== '42703') throw erro;
        }
      }

      // Completa o vencedor com o que só o perdedor tinha.
      await consultar(
        `UPDATE contatos v SET
           nome_completo = COALESCE(v.nome_completo, p.nome_completo),
           nascimento = COALESCE(v.nascimento, p.nascimento),
           email = COALESCE(v.email, p.email),
           cpf_cifrado = COALESCE(v.cpf_cifrado, p.cpf_cifrado),
           cpf_busca_hash = COALESCE(v.cpf_busca_hash, p.cpf_busca_hash),
           rg_cifrado = COALESCE(v.rg_cifrado, p.rg_cifrado),
           whatsapp_ddi = COALESCE(v.whatsapp_ddi, p.whatsapp_ddi),
           whatsapp_ddd = COALESCE(v.whatsapp_ddd, p.whatsapp_ddd),
           whatsapp_numero = COALESCE(v.whatsapp_numero, p.whatsapp_numero),
           responsavel_nome = COALESCE(v.responsavel_nome, p.responsavel_nome),
           responsavel_cpf_cifrado = COALESCE(v.responsavel_cpf_cifrado, p.responsavel_cpf_cifrado),
           responsavel_parentesco = COALESCE(v.responsavel_parentesco, p.responsavel_parentesco),
           consentimento_responsavel_em = COALESCE(v.consentimento_responsavel_em, p.consentimento_responsavel_em),
           consentimento_canal = COALESCE(v.consentimento_canal, p.consentimento_canal),
           consentimento_termo_id = COALESCE(v.consentimento_termo_id, p.consentimento_termo_id),
           observacoes = COALESCE(v.observacoes, p.observacoes)
         FROM contatos p
         WHERE v.id = $1 AND p.id = $2`,
        [vencedorId, perdedorId],
      );

      await consultar(
        `UPDATE contatos SET excluido_em = now(), excluido_motivo = $2 WHERE id = $1`,
        [perdedorId, `fundido no contato ${vencedorId}`],
      );
      return movidos;
    },

    /** Busca exata por CPF via hash: é para isso que a coluna existe. */
    async obterContatoPorHashDeCpf(hash) {
      const { rows } = await consultar(
        `SELECT id, nome, telefone, excluido_em FROM contatos WHERE cpf_busca_hash = $1 LIMIT 5`,
        [hash],
      );
      return rows.map((r) => ({ ...r, id: Number(r.id) }));
    },

    // ------------------------------------------------------------ qualidade (P2-10)

    /** As medidas que denunciam base suja antes de ela virar problema. */
    async medirQualidadeCadastral() {
      const { rows } = await consultar(
        `SELECT
           count(*) AS ativos,
           count(*) FILTER (WHERE telefone IS NULL) AS sem_telefone,
           count(*) FILTER (WHERE nome IS NULL OR btrim(nome) = '') AS sem_nome,
           count(*) FILTER (WHERE nome_completo IS NULL) AS sem_nome_completo,
           count(*) FILTER (WHERE nascimento IS NULL) AS sem_nascimento,
           count(*) FILTER (WHERE nascimento > current_date - interval '18 years'
                            AND responsavel_nome IS NULL) AS menores_sem_responsavel
         FROM contatos
         WHERE excluido_em IS NULL`,
      );
      const { rows: duplicidades } = await consultar(
        'SELECT count(*) AS grupos FROM qualidade_cadastral_duplicidades',
      );
      const linha = rows[0] ?? {};
      return {
        ativos: Number(linha.ativos ?? 0),
        sem_telefone: Number(linha.sem_telefone ?? 0),
        sem_nome: Number(linha.sem_nome ?? 0),
        sem_nome_completo: Number(linha.sem_nome_completo ?? 0),
        sem_nascimento: Number(linha.sem_nascimento ?? 0),
        menores_sem_responsavel: Number(linha.menores_sem_responsavel ?? 0),
        grupos_duplicados_por_telefone: Number(duplicidades[0]?.grupos ?? 0),
      };
    },
  };
}

module.exports = { criarRepositorioClinica };
