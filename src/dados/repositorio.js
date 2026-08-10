'use strict';

// Repositório do inbox. Todo SQL do produto mora aqui — nenhuma outra camada
// escreve consulta. A interface é a mesma do repositório em memória usado nos
// testes, de modo que rotas e domínio não sabem qual dos dois está por trás.
//
// Consultas sempre parametrizadas ($1, $2…): nada de concatenar valor em SQL.

const contexto = require('./contexto');
const { redigirAuditoria } = require('../seguranca/redator-auditoria');

const SELECAO_CONVERSA = `
  c.id, c.contato_id, c.canal, c.status, c.prioridade, c.atribuido_a,
  c.assumida_por_humano, c.ia_pausada_ate, c.ultima_msg_em, c.criado_em,
  ct.nome AS contato_nome, ct.telefone AS contato_telefone,
  ct.email AS contato_email, ct.identificador AS contato_identificador,
  u.nome AS responsavel_nome,
  l.id AS lead_id, l.temperatura, l.estagio, l.score,
  -- Campos de qualificação: é com eles que a lista mostra a próxima ação sem
  -- precisar de uma segunda consulta por conversa.
  l.interesse, l.primeira_consulta, l.pagamento, l.urgencia, l.disponibilidade, l.perdido_motivo
`;

const JUNCOES_CONVERSA = `
  FROM conversas c
  JOIN contatos ct ON ct.id = c.contato_id
  LEFT JOIN usuarios u ON u.id = c.atribuido_a
  LEFT JOIN leads l ON l.contato_id = c.contato_id
`;

// Prévia e etiquetas acompanham a conversa em **toda** consulta, não só na lista.
// Trazer só numa delas fazia `obterConversa` devolver uma forma diferente da que
// `listarConversas` devolve — divergência que a suíte de contrato pega.
const AGREGADOS_CONVERSA = `
  (SELECT m.conteudo FROM mensagens m
    WHERE m.conversa_id = c.id AND NOT m.privada
    ORDER BY m.criado_em DESC, m.id DESC LIMIT 1) AS previa,
  COALESCE((SELECT array_agg(e.nome ORDER BY e.nome)
    FROM conversa_etiquetas ce JOIN etiquetas e ON e.id = ce.etiqueta_id
    WHERE ce.conversa_id = c.id), '{}') AS etiquetas
`;

function montarConversa(linha) {
  if (!linha) return null;
  return {
    id: Number(linha.id),
    contato_id: Number(linha.contato_id),
    canal: linha.canal,
    status: linha.status,
    prioridade: linha.prioridade,
    atribuido_a: linha.atribuido_a ? Number(linha.atribuido_a) : null,
    responsavel_nome: linha.responsavel_nome || null,
    assumida_por_humano: linha.assumida_por_humano,
    ia_pausada_ate: linha.ia_pausada_ate,
    ultima_msg_em: linha.ultima_msg_em,
    criado_em: linha.criado_em,
    previa: linha.previa || null,
    lead_id: linha.lead_id ? Number(linha.lead_id) : null,
    temperatura: linha.temperatura || null,
    estagio: linha.estagio || null,
    score: linha.score ?? null,
    // Só os campos que a lista usa para calcular a próxima ação.
    interesse: linha.interesse ?? null,
    primeira_consulta: linha.primeira_consulta ?? null,
    pagamento: linha.pagamento ?? null,
    urgencia: linha.urgencia ?? null,
    disponibilidade: linha.disponibilidade ?? null,
    perdido_motivo: linha.perdido_motivo ?? null,
    etiquetas: linha.etiquetas || [],
    contato: {
      id: Number(linha.contato_id),
      nome: linha.contato_nome,
      telefone: linha.contato_telefone,
      email: linha.contato_email,
      identificador: linha.contato_identificador,
    },
  };
}

// Campos de usuário devolvidos por padrão. `senha_hash` e `totp_segredo_cifrado`
// ficam de fora: só as consultas que precisam deles os pedem explicitamente.
// Campos de usuário devolvidos por padrão. `senha_hash` e `totp_segredo_cifrado`
// ficam de fora: só as consultas que precisam deles os pedem explicitamente.
// Documentos (CPF/RG cifrados) também ficam de fora: saem só por
// `obterDocumentosDoUsuario`, que é chamada com controle de acesso.
const CAMPOS_USUARIO = `
  id, nome, email, papel, ativo, situacao, master, precisa_trocar_senha,
  telefone, avatar_url, google_sub, totp_ativo, aprovado_em, ultimo_login_em, criado_em,
  nome_completo, nascimento, whatsapp_ddi, whatsapp_ddd, whatsapp_numero,
  whatsapp_particular_autorizado, excluido_em
`;

function montarLead(linha) {
  if (!linha) return null;
  return {
    ...linha,
    id: Number(linha.id),
    contato_id: Number(linha.contato_id),
    conversa_id: linha.conversa_id ? Number(linha.conversa_id) : null,
    score: Number(linha.score ?? 0),
    score_motivos: linha.score_motivos ?? [],
  };
}

function montarAgendamento(linha) {
  if (!linha) return null;
  return {
    ...linha,
    id: Number(linha.id),
    profissional_id: Number(linha.profissional_id),
    contato_id: Number(linha.contato_id),
    lead_id: linha.lead_id ? Number(linha.lead_id) : null,
    conversa_id: linha.conversa_id ? Number(linha.conversa_id) : null,
  };
}

/**
 * Um lembrete com o mundo que a decisão de envio precisa consultar.
 *
 * O agendamento e o contato vêm juntos porque a decisão depende do estado
 * **atual** dos dois, e buscá-los em consultas separadas abriria espaço para
 * decidir com uma foto e enviar com outra.
 */
function montarLembrete(linha) {
  if (!linha) return null;

  const lembrete = {
    id: Number(linha.id),
    agendamento_id: Number(linha.agendamento_id),
    contato_id: Number(linha.contato_id),
    tipo: linha.tipo,
    janela: linha.janela,
    agendar_para: linha.agendar_para,
    estado: linha.estado,
    tentativas: Number(linha.tentativas),
    max_tentativas: Number(linha.max_tentativas),
    tentar_em: linha.tentar_em,
    processando_por: linha.processando_por,
    processando_desde: linha.processando_desde,
    modo_entrega: linha.modo_entrega,
    entrega_referencia: linha.entrega_referencia,
    enviado_em: linha.enviado_em,
    ignorado_motivo: linha.ignorado_motivo,
    ultimo_erro: linha.ultimo_erro,
    criado_em: linha.criado_em,
    atualizado_em: linha.atualizado_em,
  };

  if (linha.agendamento_status !== undefined) {
    lembrete.agendamento = {
      id: Number(linha.agendamento_id),
      status: linha.agendamento_status,
      inicio: linha.agendamento_inicio,
      fim: linha.agendamento_fim,
      contato_id: Number(linha.contato_id),
    };
  }
  if (linha.contato_telefone !== undefined) {
    lembrete.contato = {
      id: Number(linha.contato_id),
      nome: linha.contato_nome,
      telefone: linha.contato_telefone,
      lembretes_optout: linha.contato_optout === true,
    };
  }

  return lembrete;
}

// Junções e colunas usadas por toda leitura de lembrete: uma forma só, para as
// consultas não divergirem entre si.
const SELECAO_LEMBRETE = `
  l.*,
  a.status AS agendamento_status, a.inicio AS agendamento_inicio, a.fim AS agendamento_fim,
  ct.nome AS contato_nome, ct.telefone AS contato_telefone,
  ct.lembretes_optout AS contato_optout
`;

const JUNCOES_LEMBRETE = `
  FROM lembretes l
  JOIN agendamentos a ON a.id = l.agendamento_id
  JOIN contatos ct ON ct.id = l.contato_id
`;

function montarMensagem(linha) {
  return {
    id: Number(linha.id),
    conversa_id: Number(linha.conversa_id),
    direcao: linha.direcao,
    tipo: linha.tipo,
    conteudo: linha.conteudo,
    media_url: linha.media_url,
    autor_tipo: linha.autor_tipo,
    autor_nome: linha.autor_nome,
    privada: linha.privada,
    // O id externo viaja junto: é ele que permite ao ciclo de atendimento
    // reconhecer, num retry, que a resposta deste inbound já foi gravada.
    id_externo: linha.id_externo ?? null,
    criado_em: linha.criado_em,
  };
}

function montarTarefa(linha) {
  if (!linha) return null;
  return {
    ...linha,
    id: Number(linha.id),
    lead_id: linha.lead_id ? Number(linha.lead_id) : null,
    conversa_id: linha.conversa_id ? Number(linha.conversa_id) : null,
    contato_id: linha.contato_id ? Number(linha.contato_id) : null,
  };
}

function montarFormulario(linha) {
  if (!linha) return null;
  return {
    ...linha,
    id: Number(linha.id),
    agendamento_id: Number(linha.agendamento_id),
    contato_id: Number(linha.contato_id),
  };
}

// Claims do papel de sistema. Mesmo valor com que a conexão nasce (ver `criarPool`).
const CLAIMS_DE_SISTEMA = JSON.stringify({ app_role: 'backend' });

function criarRepositorio(pool) {
  // Um client transacional representa uma única conexão PostgreSQL. Algumas
  // telas consultam partes independentes em paralelo; isso é correto no nível
  // da aplicação, mas o driver não aceita duas `query()` simultâneas no mesmo
  // client. O pool continua paralelo entre requisições; só as consultas que
  // compartilham a mesma transação entram numa fila curta e determinística.
  const filasPorCliente = new WeakMap();
  function consultarNoCliente(cliente, texto, valores) {
    if (cliente === pool) return pool.query(texto, valores);
    const anterior = filasPorCliente.get(cliente) ?? Promise.resolve();
    const atual = anterior.catch(() => undefined).then(() => cliente.query(texto, valores));
    filasPorCliente.set(cliente, atual);
    return atual.finally(() => {
      if (filasPorCliente.get(cliente) === atual) filasPorCliente.delete(cliente);
    });
  }

  // Dentro de uma requisição existe uma transação aberta com o usuário já
  // declarado; fora dela (semeadura, tarefas de manutenção, health check) o pool
  // atende direto. Nenhuma consulta abaixo precisa saber em qual dos dois está.
  const consultar = (texto, valores) => consultarNoCliente(contexto.atual()?.client ?? pool, texto, valores);

  /**
   * Roda uma instrução como o **sistema**, não como o usuário da requisição.
   *
   * Existe por causa de uma regra do banco que está certa: a policy de INSERT em
   * `audit_log` exige `app_role = 'backend'`. Auditoria que o usuário pode
   * escrever é auditoria que o usuário pode forjar — e a trilha deixaria de
   * servir para o que existe.
   *
   * Mas quem escreve a auditoria é a aplicação, **dentro** da transação do
   * usuário, que declarou o papel dele. Sem esta elevação, todo INSERT de
   * auditoria era recusado — e, pior, o PostgreSQL aborta a transação inteira
   * quando um comando falha: a ação que estava sendo auditada ia junto no
   * rollback. O sintoma era desligar a Serena, receber "ok", e ela continuar
   * ligada.
   *
   * A elevação é de uma instrução: as claims do usuário são restauradas em
   * `finally`, ainda dentro da mesma transação. Fora de transação não há o que
   * elevar — a conexão já nasce como `backend`.
   */
  async function comoSistema(executar) {
    const atual = contexto.atual();
    if (!atual?.client) return executar(pool);

    const { client, claims } = atual;
    await consultarNoCliente(client, 'SELECT set_config($1, $2, true)', ['request.jwt.claims', CLAIMS_DE_SISTEMA]);
    try {
      return await executar(client);
    } finally {
      // Volta ao papel do usuário mesmo se a instrução falhar: uma transação que
      // segue com privilégio de sistema é pior que a falha original.
      if (claims) {
        await consultarNoCliente(client, 'SELECT set_config($1, $2, true)', ['request.jwt.claims', claims]);
      }
    }
  }

  return {
    tipo: 'postgres',

    /**
     * Roda `acao` numa transação, com o usuário declarado para o banco.
     *
     * Duas declarações saem daqui, porque o banco pergunta duas coisas
     * diferentes:
     *
     *   • `app.usuario_id` — lido por `app_usuario_atual()` (migration 007);
     *   • `request.jwt.claims` — lido por `current_app_role()` e
     *     `current_usuario_id()`, de que dependem **todas** as políticas
     *     `crm008_*` do banco.
     *
     * A segunda é a que decide se a linha entra. Sem ela, `current_app_role()`
     * devolve `deny` e o INSERT é recusado — mesmo com o usuário identificado
     * na aplicação e o privilégio de tabela concedido.
     *
     * O papel declarado é o do usuário (admin, gestor, atendente), o que
     * **restringe** o que a conexão podia fazer: ela nasce como `backend` (ver
     * `criarPool`). Uma requisição de atendente não deve poder o que a conta
     * dele não pode, ainda que a conexão pudesse.
     *
     * `set_config(..., is_local => true)` é o `SET LOCAL` da documentação, mas
     * aceita parâmetro. `SET LOCAL app.usuario_id = ...` não aceita `$1`, e
     * interpolar um valor vindo do token dentro do SQL é exatamente o tipo de
     * concatenação que este repositório não faz em lugar nenhum.
     *
     * Sendo local, o valor morre com a transação. A conexão volta ao pool limpa
     * e a próxima requisição não herda a identidade da anterior — que é o modo
     * como esse tipo de mecanismo costuma vazar.
     *
     * @param {number|{id: number, papel: string}} quem  Id ou o usuário inteiro.
     *   Passar só o id mantém a chamada antiga funcionando, mas sem papel a
     *   transação assume `backend` — a mesma coisa que a conexão já era.
     */
    async comUsuario(quem, acao) {
      const usuario = (quem !== null && typeof quem === 'object') ? quem : { id: quem, papel: null };
      const usuarioId = usuario.id ?? null;
      const papel = usuario.papel || 'backend';

      const client = await pool.connect();
      try {
        await consultarNoCliente(client, 'BEGIN');
        await consultarNoCliente(client,
          'SELECT set_config($1, $2, true)',
          ['app.usuario_id', usuarioId === null || usuarioId === undefined ? '' : String(usuarioId)],
        );
        const claims = JSON.stringify({
          ...(usuarioId === null || usuarioId === undefined ? {} : { usuario_id: String(usuarioId) }),
          app_role: papel,
        });
        await consultarNoCliente(client, 'SELECT set_config($1, $2, true)', ['request.jwt.claims', claims]);

        const resultado = await contexto.executarCom(
          { client, usuarioId, claims },
          () => acao(this),
        );

        await consultarNoCliente(client, 'COMMIT');
        return resultado;
      } catch (erro) {
        // Falha no meio de uma rota não pode deixar meia escrita para trás: uma
        // mensagem gravada sem a auditoria correspondente é pior que nenhuma.
        try {
          await consultarNoCliente(client, 'ROLLBACK');
        } catch {
          // Conexão já perdida; o servidor a descarta ao liberar.
        }
        throw erro;
      } finally {
        client.release();
      }
    },

    /**
     * Estado da conexão para o health check: quem conectou e com que papel.
     *
     * O papel importa mais que o alcance. Uma conexão que responde com
     * `app_role = deny` faz o RLS filtrar tudo sem erro nenhum — o sintoma é
     * "credenciais inválidas" no login, e ninguém olha para o banco.
     */
    async consultarSaudeDaConexao() {
      return consultar('SELECT current_user AS usuario, current_app_role() AS papel');
    },

    async verificarSaude() {
      try {
        await consultar('SELECT 1');
        return { estado: 'operacional' };
      } catch {
        return { estado: 'indisponivel' };
      }
    },

    /**
     * Saúde dos componentes vivos, lida da tabela `system_heartbeats` que o
     * servidor mantém (quem enxerga OpenClaw/Serena/inbox grava lá). Devolve um
     * mapa componente→estado por frescor do batimento: até 90s "operacional",
     * até 5min "degradado", acima disso "indisponivel".
     *
     * Nunca lança: sem a tabela (migração ainda não aplicada) ou sem linha, o
     * componente fica de fora do mapa e o chamador assume "indisponível". É o
     * que permite implantar o painel antes da migração, sem quebrar nada.
     */
    async lerBatimentos() {
      try {
        const { rows } = await consultar(
          'SELECT componente, status, EXTRACT(EPOCH FROM (now() - updated_at)) AS idade_s FROM system_heartbeats',
        );
        const mapa = {};
        for (const linha of rows) {
          const idade = Number(linha.idade_s);
          let estado;
          if (linha.status && linha.status !== 'ok') estado = 'degradado';
          else if (idade < 90) estado = 'operacional';
          else if (idade < 300) estado = 'degradado';
          else estado = 'indisponivel';
          mapa[linha.componente] = estado;
        }
        return mapa;
      } catch {
        return {};
      }
    },

    // ---------------------------------------------------------------- conversas

    /**
     * Lista conversas do inbox.
     * `previa` sai da última mensagem não privada — é o que a equipe lê na lista.
     */
    async listarConversas({
      status = null, busca = null, contatoId = null, limite = 50,
      dataInicio = null, dataFim = null, ordenacao = 'desc',
    } = {}) {
      const condicoes = [];
      const valores = [];

      if (status) { valores.push(status); condicoes.push(`c.status = $${valores.length}`); }
      if (contatoId) { valores.push(contatoId); condicoes.push(`c.contato_id = $${valores.length}`); }
      if (busca) {
        valores.push(`%${busca}%`);
        condicoes.push(`(ct.nome ILIKE $${valores.length} OR ct.telefone ILIKE $${valores.length})`);
      }
      // O filtro de data casa com o que a lista mostra ("há 10 min"): a data da
      // última movimentação, não a da criação — uma conversa aberta ontem e
      // respondida hoje é uma conversa de hoje para quem está triando o inbox.
      if (dataInicio) { valores.push(dataInicio); condicoes.push(`c.ultima_msg_em >= $${valores.length}`); }
      if (dataFim) { valores.push(dataFim); condicoes.push(`c.ultima_msg_em <= $${valores.length}`); }
      valores.push(limite);

      const direcao = ordenacao === 'asc' ? 'ASC' : 'DESC';

      const { rows } = await consultar(`
        SELECT ${SELECAO_CONVERSA}, ${AGREGADOS_CONVERSA}
        ${JUNCOES_CONVERSA}
        ${condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : ''}
        ORDER BY c.ultima_msg_em ${direcao} NULLS LAST, c.id ${direcao}
        LIMIT $${valores.length}
      `, valores);

      return rows.map(montarConversa);
    },

    async obterConversa(id) {
      const { rows } = await consultar(`
        SELECT ${SELECAO_CONVERSA}, ${AGREGADOS_CONVERSA}
        ${JUNCOES_CONVERSA}
        WHERE c.id = $1
      `, [id]);

      return montarConversa(rows[0]);
    },

    async atualizarConversa(id, campos) {
      const permitidos = ['status', 'prioridade', 'atribuido_a', 'assumida_por_humano', 'ia_pausada_ate'];
      const partes = [];
      const valores = [];

      for (const [campo, valor] of Object.entries(campos)) {
        if (!permitidos.includes(campo)) continue;
        valores.push(valor);
        partes.push(`${campo} = $${valores.length}`);
      }
      if (partes.length === 0) return this.obterConversa(id);

      valores.push(id);
      await consultar(`UPDATE conversas SET ${partes.join(', ')} WHERE id = $${valores.length}`, valores);
      return this.obterConversa(id);
    },

    // ---------------------------------------------------------------- mensagens

    async listarMensagens(conversaId, { incluirPrivadas = true } = {}) {
      const { rows } = await consultar(`
        SELECT * FROM mensagens
        WHERE conversa_id = $1 ${incluirPrivadas ? '' : 'AND NOT privada'}
        ORDER BY criado_em, id
      `, [conversaId]);

      return rows.map(montarMensagem);
    },

    /**
     * Grava a mensagem e move o relógio da conversa.
     * As duas coisas em uma transação: uma mensagem sem `ultima_msg_em` atualizado
     * some do topo da lista e a equipe não a vê.
     */
    async registrarMensagem(conversaId, mensagem) {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');

        const { rows } = await cliente.query(`
          INSERT INTO mensagens (conversa_id, direcao, tipo, conteudo, media_url, autor_tipo, autor_nome, privada, id_externo)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id_externo) WHERE id_externo IS NOT NULL DO NOTHING
          RETURNING *
        `, [
          conversaId,
          mensagem.direcao,
          mensagem.tipo || 'texto',
          mensagem.conteudo || null,
          mensagem.media_url || null,
          mensagem.autor_tipo || 'contato',
          mensagem.autor_nome || null,
          Boolean(mensagem.privada),
          mensagem.id_externo || null,
        ]);

        // Sem linha devolvida, a mensagem já existia: reentrega do canal.
        if (rows.length === 0) {
          await cliente.query('ROLLBACK');
          const existente = await consultar('SELECT * FROM mensagens WHERE id_externo = $1', [mensagem.id_externo]);
          return { mensagem: montarMensagem(existente.rows[0]), duplicada: true };
        }

        // Nota interna não conta como atividade do atendimento. A marca de SLA
        // anda junto: entrada abre a espera (preservando o início se o paciente
        // mandou duas seguidas); saída visível encerra a espera.
        if (!mensagem.privada) {
          if (mensagem.direcao === 'entrada') {
            await cliente.query(`
              UPDATE conversas
              SET ultima_msg_em = now(),
                  aguardando_resposta_desde = COALESCE(aguardando_resposta_desde, now())
              WHERE id = $1
            `, [conversaId]);
          } else {
            await cliente.query(`
              UPDATE conversas
              SET ultima_msg_em = now(), aguardando_resposta_desde = NULL
              WHERE id = $1
            `, [conversaId]);
          }
        }

        await cliente.query('COMMIT');
        return { mensagem: montarMensagem(rows[0]), duplicada: false };
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }
    },

    // ---------------------------------------------------------------- contatos

    /**
     * Busca por nome ou telefone, para escolher o paciente ao marcar.
     *
     * O telefone é comparado só pelos dígitos: quem atende digita "(11) 99999"
     * olhando para a tela do paciente, e isso precisa achar o mesmo contato que
     * "11999990000" acha. Por isso o `regexp_replace` dos dois lados.
     */
    async buscarContatos({ termo, limite = 10 }) {
      const alvo = String(termo ?? '').trim();
      if (!alvo) return [];

      const digitos = alvo.replace(/\D/g, '');
      const { rows } = await consultar(
        `SELECT id, nome, telefone
           FROM contatos
          WHERE excluido_em IS NULL
            AND (nome ILIKE '%' || $1 || '%'
             OR ($2 <> '' AND length($2) >= 3
                 AND regexp_replace(COALESCE(telefone, ''), '\\D', '', 'g') LIKE '%' || $2 || '%'))
          ORDER BY nome NULLS LAST
          LIMIT $3`,
        [alvo, digitos, Number(limite)],
      );

      return rows.map((linha) => ({
        id: Number(linha.id),
        nome: linha.nome,
        telefone: linha.telefone,
      }));
    },

    async obterContato(id) {
      const { rows } = await consultar('SELECT * FROM contatos WHERE id = $1', [id]);
      if (!rows[0]) return null;
      return {
        id: Number(rows[0].id),
        nome: rows[0].nome,
        telefone: rows[0].telefone,
        email: rows[0].email,
        identificador: rows[0].identificador,
        origem: rows[0].origem,
        atributos: rows[0].atributos || {},
        observacoes: rows[0].observacoes,
        // O opt-out acompanha o contato em toda leitura: quem decide enviar um
        // lembrete não deve precisar lembrar de buscar isso à parte.
        lembretes_optout: rows[0].lembretes_optout === true,
        lembretes_optout_em: rows[0].lembretes_optout_em ?? null,
        lembretes_optout_motivo: rows[0].lembretes_optout_motivo ?? null,
        excluido_em: rows[0].excluido_em ?? null,
        excluido_motivo: rows[0].excluido_motivo ?? null,
        // P1-05/P1-08 — ficha estruturada. Documentos (cpf_cifrado, rg_cifrado,
        // responsavel_cpf_cifrado) ficam fora de propósito: saem só por
        // `obterDocumentosDoContato`, com controle de acesso na rota.
        nome_completo: rows[0].nome_completo ?? null,
        nascimento: rows[0].nascimento ?? null,
        whatsapp_ddi: rows[0].whatsapp_ddi ?? null,
        whatsapp_ddd: rows[0].whatsapp_ddd ?? null,
        whatsapp_numero: rows[0].whatsapp_numero ?? null,
        cpf_cadastrado: Boolean(rows[0].cpf_cifrado),
        responsavel_nome: rows[0].responsavel_nome ?? null,
        responsavel_parentesco: rows[0].responsavel_parentesco ?? null,
        consentimento_responsavel_em: rows[0].consentimento_responsavel_em ?? null,
        consentimento_canal: rows[0].consentimento_canal ?? null,
        consentimento_termo_id: rows[0].consentimento_termo_id ?? null,
        criado_em: rows[0].criado_em,
      };
    },

    /**
     * P1-05 — documentos do contato (CPF/RG cifrados e hash de busca).
     *
     * Leitura dedicada e auditável: a ficha comum não carrega documento, então
     * cada chamada aqui é uma decisão explícita da rota — que deve exigir a
     * permissão certa e registrar acesso em auditoria.
     */
    async obterDocumentosDoContato(id) {
      const { rows } = await consultar(
        'SELECT cpf_cifrado, cpf_busca_hash, rg_cifrado, responsavel_cpf_cifrado FROM contatos WHERE id = $1',
        [id]
      );
      if (!rows[0]) return null;
      return {
        cpfCifrado: rows[0].cpf_cifrado ?? null,
        cpfBuscaHash: rows[0].cpf_busca_hash ?? null,
        rgCifrado: rows[0].rg_cifrado ?? null,
        responsavelCpfCifrado: rows[0].responsavel_cpf_cifrado ?? null,
      };
    },

    /**
     * Lista contatos para a tela de gestão.
     *
     * Excluídos ficam de fora por padrão. `incluirExcluidos` existe para a
     * própria tela poder mostrar quem saiu e oferecer a restauração — sem isso,
     * um contato apagado por engano viraria um chamado de suporte.
     */
    async listarContatos({ termo = null, incluirExcluidos = false, limite = 100 } = {}) {
      const condicoes = [];
      const valores = [];

      if (!incluirExcluidos) condicoes.push('c.excluido_em IS NULL');
      if (termo) {
        const digitos = String(termo).replace(/\D/g, '');
        valores.push(String(termo).trim(), digitos);
        condicoes.push(`(c.nome ILIKE '%' || $${valores.length - 1} || '%'
          OR ($${valores.length} <> '' AND length($${valores.length}) >= 3
              AND regexp_replace(COALESCE(c.telefone, ''), '\\D', '', 'g') LIKE '%' || $${valores.length} || '%'))`);
      }
      valores.push(Number(limite));

      const { rows } = await consultar(`
        SELECT c.id, c.nome, c.telefone, c.email, c.identificador, c.origem, c.observacoes,
               c.lembretes_optout, c.excluido_em, c.excluido_motivo, c.criado_em,
               (SELECT count(*)::int FROM conversas v WHERE v.contato_id = c.id) AS conversas,
               (SELECT count(*)::int FROM agendamentos a WHERE a.contato_id = c.id) AS agendamentos
          FROM contatos c
         ${condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : ''}
         ORDER BY c.excluido_em NULLS FIRST, c.nome NULLS LAST, c.id DESC
         LIMIT $${valores.length}
      `, valores);

      return rows.map((linha) => ({
        ...linha,
        id: Number(linha.id),
        lembretes_optout: linha.lembretes_optout === true,
      }));
    },

    /** O contato de um telefone, mesmo excluído — é como o duplicado é impedido. */
    async obterContatoPorTelefone(telefone) {
      if (!telefone) return null;
      const { rows } = await consultar('SELECT id FROM contatos WHERE telefone = $1', [telefone]);
      return rows[0] ? this.obterContato(rows[0].id) : null;
    },

    async criarContato({ nome, telefone, email = null, identificador = null, origem = 'manual', observacoes = null }) {
      const { rows } = await consultar(`
        INSERT INTO contatos (nome, telefone, email, identificador, origem, observacoes)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [nome, telefone, email, identificador, origem, observacoes]);

      return this.obterContato(rows[0].id);
    },

    /**
     * Soft delete: o contato sai das listas, o histórico fica.
     *
     * Não há `DELETE` aqui de propósito. Apagar a linha levaria junto conversas,
     * mensagens, leads e agendamentos pelo `ON DELETE CASCADE` — o histórico
     * clínico e comercial inteiro daquela pessoa, sem aviso e sem volta.
     */
    async excluirContato(id, { motivo = null, usuarioId = null } = {}) {
      const { rowCount } = await consultar(`
        UPDATE contatos
           SET excluido_em = now(), excluido_por = $2, excluido_motivo = $3
         WHERE id = $1 AND excluido_em IS NULL
      `, [id, usuarioId, motivo]);

      if (rowCount === 0) return null;
      return this.obterContato(id);
    },

    async restaurarContato(id) {
      const { rowCount } = await consultar(`
        UPDATE contatos
           SET excluido_em = NULL, excluido_por = NULL, excluido_motivo = NULL
         WHERE id = $1 AND excluido_em IS NOT NULL
      `, [id]);

      if (rowCount === 0) return null;
      return this.obterContato(id);
    },

    /**
     * Liga ou desliga os lembretes para o contato.
     *
     * Fora de `atualizarContato` de propósito: opt-out não é campo de ficha que
     * a equipe edita junto com o telefone — é uma decisão do paciente, com data
     * e motivo próprios, e passa por uma rota que a audita.
     */
    async definirOptOutDeLembretes(id, { optout = true, motivo = null, agora = null }) {
      const { rowCount } = await consultar(`
        UPDATE contatos
           SET lembretes_optout = $2,
               lembretes_optout_em = CASE WHEN $2 THEN COALESCE($3::timestamptz, now()) ELSE NULL END,
               lembretes_optout_motivo = CASE WHEN $2 THEN $4 ELSE NULL END
         WHERE id = $1
      `, [id, optout === true, agora, motivo]);

      if (rowCount === 0) return null;
      return this.obterContato(id);
    },

    async atualizarContato(id, campos) {
      // Chave camelCase -> coluna. Documentos ficam cifrados/hash de busca; o
      // texto aberto nunca atravessa a camada de dados (P1-05/P1-08).
      const permitidos = new Map([
        ['nome', 'nome'], ['telefone', 'telefone'], ['email', 'email'],
        ['identificador', 'identificador'], ['observacoes', 'observacoes'],
        ['atributos', 'atributos'],
        ['nomeCompleto', 'nome_completo'], ['nascimento', 'nascimento'],
        ['cpfCifrado', 'cpf_cifrado'], ['cpfBuscaHash', 'cpf_busca_hash'],
        ['rgCifrado', 'rg_cifrado'],
        ['whatsappDdi', 'whatsapp_ddi'], ['whatsappDdd', 'whatsapp_ddd'],
        ['whatsappNumero', 'whatsapp_numero'],
        ['responsavelNome', 'responsavel_nome'],
        ['responsavelCpfCifrado', 'responsavel_cpf_cifrado'],
        ['responsavelParentesco', 'responsavel_parentesco'],
        ['consentimentoResponsavelEm', 'consentimento_responsavel_em'],
        ['consentimentoCanal', 'consentimento_canal'],
        ['consentimentoTermoId', 'consentimento_termo_id'],
      ]);
      const partes = [];
      const valores = [];

      for (const [campo, valor] of Object.entries(campos)) {
        const coluna = permitidos.get(campo);
        if (!coluna) continue;
        valores.push(coluna === 'atributos' ? JSON.stringify(valor) : valor);
        partes.push(`${coluna} = $${valores.length}${coluna === 'atributos' ? '::jsonb' : ''}`);
      }
      if (partes.length === 0) return this.obterContato(id);

      valores.push(id);
      await consultar(`UPDATE contatos SET ${partes.join(', ')} WHERE id = $${valores.length}`, valores);
      return this.obterContato(id);
    },

    /**
     * Encontra pelo telefone ou cria. É como uma mensagem nova vira contato.
     *
     * Contato excluído que volta a escrever é **reativado**, não duplicado. O
     * índice único do telefone não distingue excluído de ativo justamente para
     * isso: a alternativa seria uma segunda ficha para a mesma pessoa, e um CRM
     * com fichas duplicadas não se recupera direito depois.
     */
    async encontrarOuCriarContato({ telefone, nome = null, canal = 'whatsapp', identificador = null }) {
      const { rows } = await consultar(`
        INSERT INTO contatos (telefone, nome, origem, identificador)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (telefone) WHERE telefone IS NOT NULL
        DO UPDATE SET nome = COALESCE(contatos.nome, EXCLUDED.nome),
                      excluido_em = NULL, excluido_por = NULL, excluido_motivo = NULL
        RETURNING id
      `, [telefone, nome, canal, identificador]);

      return this.obterContato(rows[0].id);
    },

    /** Conversa aberta do contato, ou uma nova. Evita abrir uma conversa por mensagem. */
    async encontrarOuCriarConversaAberta(contatoId, canal = 'whatsapp') {
      const abertas = await consultar(`
        SELECT id FROM conversas
        WHERE contato_id = $1 AND status <> 'resolvida'
        ORDER BY criado_em DESC LIMIT 1
      `, [contatoId]);

      if (abertas.rows[0]) return this.obterConversa(abertas.rows[0].id);

      const { rows } = await consultar(
        'INSERT INTO conversas (contato_id, canal) VALUES ($1, $2) RETURNING id',
        [contatoId, canal],
      );
      return this.obterConversa(rows[0].id);
    },

    // ---------------------------------------------------------------- etiquetas

    async listarEtiquetas() {
      const { rows } = await consultar('SELECT id, nome, descricao, cor, do_sistema FROM etiquetas WHERE ativa ORDER BY nome');
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async listarEtiquetasDaConversa(conversaId) {
      const { rows } = await consultar(`
        SELECT e.nome FROM conversa_etiquetas ce
        JOIN etiquetas e ON e.id = ce.etiqueta_id
        WHERE ce.conversa_id = $1 ORDER BY e.nome
      `, [conversaId]);
      return rows.map((linha) => linha.nome);
    },

    /**
     * Substitui o conjunto de etiquetas da conversa pelo informado.
     * Nomes desconhecidos são ignorados — não se cria etiqueta por digitação errada.
     */
    async definirEtiquetasDaConversa(conversaId, nomes) {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        await cliente.query('DELETE FROM conversa_etiquetas WHERE conversa_id = $1', [conversaId]);

        if (nomes.length > 0) {
          await cliente.query(`
            INSERT INTO conversa_etiquetas (conversa_id, etiqueta_id)
            SELECT $1, id FROM etiquetas WHERE nome = ANY($2::text[])
            ON CONFLICT DO NOTHING
          `, [conversaId, nomes]);
        }

        await cliente.query('COMMIT');
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }

      return this.listarEtiquetasDaConversa(conversaId);
    },

    // ---------------------------------------------------------------- notas

    async listarNotas(contatoId) {
      const { rows } = await consultar(`
        SELECT n.id, n.texto, n.criado_em, u.nome AS autor
        FROM notas_internas n LEFT JOIN usuarios u ON u.id = n.usuario_id
        WHERE n.contato_id = $1 ORDER BY n.criado_em DESC
      `, [contatoId]);
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async criarNota(contatoId, texto, usuarioId = null) {
      const { rows } = await consultar(`
        INSERT INTO notas_internas (contato_id, texto, usuario_id)
        VALUES ($1, $2, $3)
        RETURNING id, contato_id, texto, usuario_id, criado_em
      `, [contatoId, texto, usuarioId]);

      return { ...rows[0], id: Number(rows[0].id), contato_id: Number(rows[0].contato_id) };
    },

    // ---------------------------------------------------------------- leads

    async listarLeads() {
      const { rows } = await consultar(`
        SELECT l.*, ct.nome, ct.telefone,
               (SELECT max(m.criado_em) FROM mensagens m WHERE m.conversa_id = l.conversa_id) AS ultima_msg_em
        FROM leads l JOIN contatos ct ON ct.id = l.contato_id
        -- Score maior primeiro: é quem a equipe deve olhar antes.
        ORDER BY l.score DESC, l.atualizado_em DESC
      `);
      return rows.map(montarLead);
    },

    async obterLead(id) {
      const { rows } = await consultar(`
        SELECT l.*, ct.nome, ct.telefone,
               (SELECT max(m.criado_em) FROM mensagens m WHERE m.conversa_id = l.conversa_id) AS ultima_msg_em
        FROM leads l JOIN contatos ct ON ct.id = l.contato_id
        WHERE l.id = $1
      `, [id]);
      return rows[0] ? montarLead(rows[0]) : null;
    },

    async obterLeadPorContato(contatoId) {
      const { rows } = await consultar(`
        SELECT l.*, ct.nome, ct.telefone,
               (SELECT max(m.criado_em) FROM mensagens m WHERE m.conversa_id = l.conversa_id) AS ultima_msg_em
        FROM leads l JOIN contatos ct ON ct.id = l.contato_id
        WHERE l.contato_id = $1
      `, [contatoId]);
      return rows[0] ? montarLead(rows[0]) : null;
    },

    /** Atualiza o lead. Só os campos da lista permitida entram. */
    async atualizarLead(id, campos) {
      const permitidos = new Map([
        ['interesse', 'interesse'], ['especialidade', 'especialidade'],
        ['primeira_consulta', 'primeira_consulta'], ['pagamento', 'pagamento'],
        ['convenio_nome', 'convenio_nome'], ['urgencia', 'urgencia'],
        ['disponibilidade', 'disponibilidade'], ['origem_detalhe', 'origem_detalhe'],
        ['utm_source', 'utm_source'], ['utm_medium', 'utm_medium'],
        ['utm_campaign', 'utm_campaign'], ['utm_term', 'utm_term'], ['utm_content', 'utm_content'],
        ['estagio', 'estagio'], ['temperatura', 'temperatura'],
        ['temperaturaManual', 'temperatura_manual'], ['score', 'score'],
        ['scoreMotivos', 'score_motivos'], ['scoreCalculadoEm', 'score_calculado_em'],
        ['qualificadoEm', 'qualificado_em'], ['perdidoMotivo', 'perdido_motivo'],
        ['proximoPasso', 'proximo_passo'], ['conversaId', 'conversa_id'],
        ['proprietarioId', 'proprietario_id'], ['proximoPassoEm', 'proximo_passo_em'],
        ['estagioDesde', 'estagio_desde'],
      ]);

      const partes = [];
      const valores = [];
      for (const [campo, valor] of Object.entries(campos)) {
        const coluna = permitidos.get(campo);
        if (!coluna) continue;

        valores.push(coluna === 'score_motivos' ? JSON.stringify(valor) : valor);
        partes.push(`${coluna} = $${valores.length}${coluna === 'score_motivos' ? '::jsonb' : ''}`);
      }
      if (partes.length === 0) return this.obterLead(id);

      valores.push(id);
      await consultar(`UPDATE leads SET ${partes.join(', ')} WHERE id = $${valores.length}`, valores);
      return this.obterLead(id);
    },

    // ---------------------------------------------------------------- jornada

    /**
     * A jornada do lead é trilha de sistema, como a auditoria: escrita pela
     * aplicação, nunca digitada por alguém. Vai pelo mesmo caminho elevado —
     * do contrário, um atendente registrando avanço numa conversa que não é
     * dele abortaria a transação inteira.
     */
    async registrarEventoDeLead(evento) {
      const { rows } = await comoSistema((cliente) => consultarNoCliente(cliente, `
        INSERT INTO lead_eventos (lead_id, conversa_id, tipo, de, para, detalhe, origem, usuario_id)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        RETURNING id, lead_id, conversa_id, tipo, de, para, detalhe, origem, criado_em
      `, [
        evento.lead_id, evento.conversa_id, evento.tipo, evento.de, evento.para,
        evento.detalhe ? JSON.stringify(evento.detalhe) : null,
        evento.origem, evento.usuario_id,
      ]));

      return { ...rows[0], id: Number(rows[0].id), lead_id: Number(rows[0].lead_id) };
    },

    async listarEventosDoLead(leadId, { tipo = null, limite = 100 } = {}) {
      const valores = [leadId];
      let filtro = '';
      if (tipo) {
        valores.push(tipo);
        filtro = `AND e.tipo = $${valores.length}`;
      }
      valores.push(limite);

      const { rows } = await consultar(`
        SELECT e.id, e.lead_id, e.conversa_id, e.tipo, e.de, e.para, e.detalhe, e.origem, e.criado_em,
               u.nome AS usuario_nome
        FROM lead_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id
        WHERE e.lead_id = $1 ${filtro}
        ORDER BY e.criado_em DESC, e.id DESC
        LIMIT $${valores.length}
      `, valores);

      return rows.map((linha) => ({ ...linha, id: Number(linha.id), lead_id: Number(linha.lead_id) }));
    },

    /** Cria ou atualiza o lead do contato, mantendo o vínculo com a conversa. */
    async salvarLead(contatoId, { conversaId = null, temperatura = null, estagio = null, origem = null } = {}) {
      const { rows } = await consultar(`
        INSERT INTO leads (contato_id, conversa_id, temperatura, estagio, origem)
        VALUES ($1, $2, COALESCE($3, 'frio'), COALESCE($4, 'novo'), COALESCE($5, 'WHATSAPP'))
        ON CONFLICT (contato_id) DO UPDATE SET
          conversa_id = COALESCE(EXCLUDED.conversa_id, leads.conversa_id),
          temperatura = COALESCE($3, leads.temperatura),
          estagio     = COALESCE($4, leads.estagio),
          atualizado_em = now()
        RETURNING id, contato_id, conversa_id, temperatura, estagio, origem
      `, [contatoId, conversaId, temperatura, estagio, origem]);

      return { ...rows[0], id: Number(rows[0].id), contato_id: Number(rows[0].contato_id) };
    },

    /**
     * Leads sem atividade há N dias — a matéria-prima do sino de acompanhamento.
     * Convertido e perdido ficam de fora: acompanhamento é para quem ainda está
     * no funil.
     */
    async listarLeadsInativos({ dias = 15, limite = 200 } = {}) {
      const { rows } = await consultar(`
        SELECT l.*, ct.nome, ct.telefone,
               (SELECT max(m.criado_em) FROM mensagens m WHERE m.conversa_id = l.conversa_id) AS ultima_msg_em
        FROM leads l JOIN contatos ct ON ct.id = l.contato_id
        WHERE l.estagio NOT IN ('convertido', 'perdido')
          AND ct.excluido_em IS NULL
          AND COALESCE(
            (SELECT max(m.criado_em) FROM mensagens m WHERE m.conversa_id = l.conversa_id),
            l.atualizado_em
          ) < now() - make_interval(days => $1)
        ORDER BY l.atualizado_em
        LIMIT $2
      `, [dias, limite]);
      return rows.map(montarLead);
    },

    // ---------------------------------------------------------------- tarefas (sino)

    /**
     * Cria uma tarefa idempotente. A chave determinística faz a segunda chamada
     * devolver a tarefa existente em vez de criar outra — o worker pode rodar
     * de minuto em minuto sem encher o sino.
     */
    async criarTarefa({ chave, tipo, titulo, detalhe = null, leadId = null, conversaId = null, contatoId = null, devidaEm = null }) {
      const { rows } = await consultar(`
        INSERT INTO tarefas (chave, tipo, titulo, detalhe, lead_id, conversa_id, contato_id, devida_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()))
        ON CONFLICT (chave) DO NOTHING
        RETURNING *
      `, [chave, tipo, titulo, detalhe, leadId, conversaId, contatoId, devidaEm]);

      if (rows.length > 0) return { tarefa: montarTarefa(rows[0]), duplicada: false };

      const { rows: existentes } = await consultar('SELECT * FROM tarefas WHERE chave = $1', [chave]);
      return { tarefa: montarTarefa(existentes[0]), duplicada: true };
    },

    async listarTarefas({ abertas = true, limite = 100 } = {}) {
      const { rows } = await consultar(`
        SELECT t.*, ct.nome AS contato_nome
        FROM tarefas t LEFT JOIN contatos ct ON ct.id = t.contato_id
        ${abertas ? 'WHERE t.concluida_em IS NULL' : ''}
        ORDER BY t.devida_em, t.id
        LIMIT $1
      `, [limite]);
      return rows.map(montarTarefa);
    },

    async concluirTarefa(id, { usuarioId = null } = {}) {
      const { rows } = await consultar(`
        UPDATE tarefas SET concluida_em = now(), concluida_por = $2
        WHERE id = $1 AND concluida_em IS NULL
        RETURNING *
      `, [id, usuarioId]);
      return rows[0] ? montarTarefa(rows[0]) : null;
    },

    // ---------------------------------------------------------------- SLA

    /** Conversas em que o paciente fala por último, da espera mais antiga para a mais nova. */
    async listarConversasAguardando({ limite = 100 } = {}) {
      const { rows } = await consultar(`
        SELECT c.*, ct.nome AS contato_nome, ct.telefone AS contato_telefone
        FROM conversas c JOIN contatos ct ON ct.id = c.contato_id
        WHERE c.aguardando_resposta_desde IS NOT NULL
          AND c.status <> 'resolvida'
        ORDER BY c.aguardando_resposta_desde
        LIMIT $1
      `, [limite]);
      return rows.map((linha) => ({
        ...linha,
        id: Number(linha.id),
        contato_id: Number(linha.contato_id),
      }));
    },

    // ------------------------------------------------------ resumo interno

    /** Grava o resumo interno do encerramento. Fica NO CRM; nunca vai ao paciente. */
    async definirResumoInterno(conversaId, texto) {
      const { rows } = await consultar(`
        UPDATE conversas SET resumo_interno = $2, resumo_interno_em = now()
        WHERE id = $1
        RETURNING id, resumo_interno, resumo_interno_em
      `, [conversaId, texto]);
      return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    },

    // ------------------------------------------- formulário de pré-consulta

    /**
     * Um formulário por agendamento: o conflito devolve o existente. A regra
     * "só depois do agendamento confirmado" é do serviço; aqui é integridade.
     */
    async criarFormularioPreConsulta({ agendamentoId, contatoId, token }) {
      const { rows } = await consultar(`
        INSERT INTO formularios_pre_consulta (agendamento_id, contato_id, token)
        VALUES ($1, $2, $3)
        ON CONFLICT (agendamento_id) DO NOTHING
        RETURNING *
      `, [agendamentoId, contatoId, token]);

      if (rows.length > 0) return { formulario: montarFormulario(rows[0]), duplicado: false };

      const { rows: existentes } = await consultar(
        'SELECT * FROM formularios_pre_consulta WHERE agendamento_id = $1', [agendamentoId],
      );
      return { formulario: montarFormulario(existentes[0]), duplicado: true };
    },

    async obterFormularioPorAgendamento(agendamentoId) {
      const { rows } = await consultar(
        'SELECT * FROM formularios_pre_consulta WHERE agendamento_id = $1', [agendamentoId],
      );
      return rows[0] ? montarFormulario(rows[0]) : null;
    },

    async marcarFormularioEnviado(id) {
      const { rows } = await consultar(`
        UPDATE formularios_pre_consulta SET enviado_em = COALESCE(enviado_em, now())
        WHERE id = $1 RETURNING *
      `, [id]);
      return rows[0] ? montarFormulario(rows[0]) : null;
    },

    async registrarRespostaDeFormulario(token, respostas) {
      const { rows } = await consultar(`
        UPDATE formularios_pre_consulta
        SET respondido_em = COALESCE(respondido_em, now()), respostas = $2::jsonb
        WHERE token = $1 AND respondido_em IS NULL
        RETURNING *
      `, [token, JSON.stringify(respostas ?? {})]);
      return rows[0] ? montarFormulario(rows[0]) : null;
    },

    // ---------------------------------------------------------------- IA: catálogo e telemetria

    async listarModelosDeIA({ apenasAtivos = false } = {}) {
      const { rows } = await consultar(`
        SELECT * FROM ia_modelos ${apenasAtivos ? 'WHERE ativo' : ''}
        ORDER BY provedor, modelo
      `);
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async obterChamadaDeIA(chaveIdempotencia) {
      const { rows } = await consultar(
        'SELECT * FROM ia_chamadas WHERE chave_idempotencia = $1', [chaveIdempotencia],
      );
      return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    },

    async registrarChamadaDeIA({
      chaveIdempotencia, finalidade, provedor, modelo, promptVersion = null,
      latenciaMs = null, tokensEntrada = null, tokensSaida = null,
      custoEstimadoUsd = null, resposta = null, erro = null, fallbackDe = null,
    }) {
      const { rows } = await consultar(`
        INSERT INTO ia_chamadas (chave_idempotencia, finalidade, provedor, modelo, prompt_version,
          latencia_ms, tokens_entrada, tokens_saida, custo_estimado_usd, resposta, erro, fallback_de)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (chave_idempotencia) DO NOTHING
        RETURNING id
      `, [chaveIdempotencia, finalidade, provedor, modelo, promptVersion,
        latenciaMs, tokensEntrada, tokensSaida, custoEstimadoUsd, resposta, erro, fallbackDe]);
      return { registrado: rows.length > 0 };
    },

    async listarChamadasDeIA({ limite = 100 } = {}) {
      const { rows } = await consultar(`
        SELECT id, chave_idempotencia, finalidade, provedor, modelo, prompt_version,
               latencia_ms, tokens_entrada, tokens_saida, custo_estimado_usd, erro, fallback_de, criado_em
        FROM ia_chamadas ORDER BY criado_em DESC, id DESC LIMIT $1
      `, [limite]);
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    /**
     * Retenção mínima do texto gerado: anula `resposta` das chamadas mais
     * velhas que a janela. A única escrita permitida sobre a telemetria, e só
     * pela função do banco — a aplicação não tem UPDATE na tabela.
     */
    async limparRespostasDeIA({ retencaoDias = 30 } = {}) {
      const { rows } = await consultar(
        'SELECT public.limpar_respostas_de_ia(make_interval(days => $1)) AS anuladas',
        [retencaoDias],
      );
      return { anuladas: Number(rows[0]?.anuladas ?? 0) };
    },

    // ---------------------------------------------------------------- IA: avaliações

    async registrarAvaliacaoDeIA({
      conversaId = null, mensagemId, avaliador, empatia, seguranca, aderencia, veredito, motivos = [],
    }) {
      const { rows } = await consultar(`
        INSERT INTO ia_avaliacoes (conversa_id, mensagem_id, avaliador, empatia, seguranca, aderencia, veredito, motivos)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (mensagem_id, avaliador) DO NOTHING
        RETURNING *
      `, [conversaId, mensagemId, avaliador, empatia, seguranca, aderencia, veredito, JSON.stringify(motivos)]);
      if (rows.length > 0) return { avaliacao: { ...rows[0], id: Number(rows[0].id) }, duplicada: false };

      const { rows: existentes } = await consultar(
        'SELECT * FROM ia_avaliacoes WHERE mensagem_id = $1 AND avaliador = $2', [mensagemId, avaliador],
      );
      return { avaliacao: { ...existentes[0], id: Number(existentes[0].id) }, duplicada: true };
    },

    async listarAvaliacoesDeIA({ veredito = null, limite = 100 } = {}) {
      const valores = [];
      let filtro = '';
      if (veredito) {
        valores.push(veredito);
        filtro = `WHERE veredito = $${valores.length}`;
      }
      valores.push(limite);
      const { rows } = await consultar(`
        SELECT * FROM ia_avaliacoes ${filtro} ORDER BY criado_em DESC, id DESC LIMIT $${valores.length}
      `, valores);
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    /** Respostas da automação ainda sem avaliação do avaliador dado. */
    async listarRespostasSemAvaliacao({ avaliador = 'heuristica', limite = 50 } = {}) {
      const { rows } = await consultar(`
        SELECT m.* FROM mensagens m
        WHERE m.autor_tipo = 'automacao' AND m.direcao = 'saida'
          AND NOT EXISTS (
            SELECT 1 FROM ia_avaliacoes a WHERE a.mensagem_id = m.id AND a.avaliador = $1
          )
        ORDER BY m.criado_em DESC LIMIT $2
      `, [avaliador, limite]);
      return rows.map(montarMensagem);
    },

    // ---------------------------------------------------------------- notificações

    async criarNotificacao({ chave, tipo, titulo, corpo = null, usuarioId = null }) {
      const { rows } = await consultar(`
        INSERT INTO notificacoes (chave, tipo, titulo, corpo, usuario_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (chave) DO NOTHING
        RETURNING *
      `, [chave, tipo, titulo, corpo, usuarioId]);
      if (rows.length > 0) return { notificacao: { ...rows[0], id: Number(rows[0].id) }, duplicada: false };
      const { rows: existentes } = await consultar('SELECT * FROM notificacoes WHERE chave = $1', [chave]);
      return { notificacao: { ...existentes[0], id: Number(existentes[0].id) }, duplicada: true };
    },

    /** As do usuário e as de toda a equipe (usuario_id nulo). */
    async listarNotificacoes({ usuarioId = null, apenasNaoLidas = true, limite = 50 } = {}) {
      const { rows } = await consultar(`
        SELECT * FROM notificacoes
        WHERE (usuario_id IS NULL OR usuario_id = $1)
          ${apenasNaoLidas ? 'AND lida_em IS NULL' : ''}
        ORDER BY criado_em DESC, id DESC LIMIT $2
      `, [usuarioId, limite]);
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async marcarNotificacaoLida(id) {
      const { rows } = await consultar(`
        UPDATE notificacoes SET lida_em = now() WHERE id = $1 AND lida_em IS NULL RETURNING *
      `, [id]);
      return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    },

    // ------------------------------------------------- Serena: ativação gradual

    async definirAtivacaoGradual({ modo, percentual = null, usuarioId = null }) {
      const { rows } = await consultar(`
        UPDATE serena_configuracao
        SET modo_ativacao = $1,
            ativacao_percentual = COALESCE($2, ativacao_percentual),
            alterado_por = $3, alterado_em = now()
        WHERE id = 1
        RETURNING *
      `, [modo, percentual, usuarioId]);
      return rows[0] ?? null;
    },

    async listarContatosDeAtivacao() {
      const { rows } = await consultar('SELECT contato_id FROM serena_ativacao_contatos');
      return rows.map((linha) => Number(linha.contato_id));
    },

    async definirContatoDeAtivacao(contatoId, incluido, { usuarioId = null } = {}) {
      if (incluido) {
        await consultar(`
          INSERT INTO serena_ativacao_contatos (contato_id, criado_por)
          VALUES ($1, $2) ON CONFLICT (contato_id) DO NOTHING
        `, [contatoId, usuarioId]);
      } else {
        await consultar('DELETE FROM serena_ativacao_contatos WHERE contato_id = $1', [contatoId]);
      }
      return { contato_id: Number(contatoId), incluido };
    },

    // ---------------------------------------------------------------- analítica

    /** Evento de produto, deduplicado pela chave quando houver. Nunca clínico. */
    async registrarEventoAnalitico({ nome, entidade = null, entidadeId = null, propriedades = null, chave = null }) {
      const { rows } = await consultar(`
        INSERT INTO eventos_analiticos (nome, entidade, entidade_id, propriedades, chave)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (chave) DO NOTHING
        RETURNING id
      `, [nome, entidade, entidadeId, propriedades ? JSON.stringify(propriedades) : null, chave]);
      return { registrado: rows.length > 0 };
    },

    // As consultas abaixo materializam o dicionário oficial (docs/METRICAS.md)
    // sobre as views da migration 026. Período: [de, ate) em dias de São Paulo.

    async metricasLeadsPorDia({ de, ate }) {
      const { rows } = await consultar(`
        SELECT dia, origem, total::int FROM vw_leads_por_dia
        WHERE dia >= $1::date AND dia < $2::date
        ORDER BY dia, origem
      `, [de, ate]);
      return rows;
    },

    async metricasFunil() {
      const { rows } = await consultar('SELECT estagio, total::int FROM vw_funil_estagios ORDER BY estagio');
      return rows;
    },

    async metricasMotivosPerda({ de, ate }) {
      const { rows } = await consultar(`
        SELECT motivo, sum(total)::int AS total FROM vw_motivos_perda
        WHERE dia >= $1::date AND dia < $2::date
        GROUP BY motivo ORDER BY total DESC
      `, [de, ate]);
      return rows;
    },

    async metricasPrimeiraResposta({ de, ate }) {
      const { rows } = await consultar(`
        SELECT conversa_id, dia, minutos::float FROM vw_primeira_resposta
        WHERE dia >= $1::date AND dia < $2::date
      `, [de, ate]);
      return rows.map((linha) => ({ ...linha, conversa_id: Number(linha.conversa_id) }));
    },

    async metricasPicos({ de, ate }) {
      // A view agrega o histórico inteiro; o recorte de período exige refazer o
      // grupo sobre as mensagens do intervalo.
      const { rows } = await consultar(`
        SELECT
          extract(dow  FROM (m.criado_em AT TIME ZONE 'America/Sao_Paulo'))::int AS dia_semana,
          extract(hour FROM (m.criado_em AT TIME ZONE 'America/Sao_Paulo'))::int AS hora,
          count(*)::int AS entradas
        FROM mensagens m
        JOIN conversas c ON c.id = m.conversa_id
        JOIN contatos ct ON ct.id = c.contato_id
        WHERE m.direcao = 'entrada' AND NOT m.privada
          AND ct.telefone NOT LIKE '5516900000%'
          AND (m.criado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
          AND (m.criado_em AT TIME ZONE 'America/Sao_Paulo')::date <  $2::date
        GROUP BY 1, 2 ORDER BY 1, 2
      `, [de, ate]);
      return rows;
    },

    async metricasAgenda({ de, ate }) {
      const { rows } = await consultar(`
        SELECT status, sum(total)::int AS total FROM vw_agenda_por_dia
        WHERE dia >= $1::date AND dia < $2::date
        GROUP BY status ORDER BY status
      `, [de, ate]);
      return rows;
    },

    async metricasSerena({ de, ate }) {
      const { rows } = await consultar(`
        SELECT acao, motivo, sum(total)::int AS total FROM vw_serena_por_dia
        WHERE dia >= $1::date AND dia < $2::date
        GROUP BY acao, motivo ORDER BY acao, total DESC
      `, [de, ate]);
      return rows;
    },

    // ---------------------------------------------------------------- idempotência e auditoria

    async consultarEvento(chave) {
      const { rows } = await consultar('SELECT recibo FROM eventos_recebidos WHERE chave = $1', [chave]);
      return rows[0]?.recibo ?? null;
    },

    async registrarEvento(chave, recibo) {
      const { rows } = await consultar(`
        INSERT INTO eventos_recebidos (chave, recibo) VALUES ($1, $2::jsonb)
        ON CONFLICT (chave) DO NOTHING
        RETURNING recibo
      `, [chave, JSON.stringify(recibo)]);

      // Sem linha devolvida, outra entrega ganhou a corrida: vale o recibo dela.
      if (rows.length === 0) return this.consultarEvento(chave);
      return rows[0].recibo;
    },

    /**
     * Grava a trilha. Escreve como sistema — ver `comoSistema` acima: a policy
     * do banco exige isso, e ela está certa em exigir.
     *
     * O `usuario_id` continua sendo o do autor da ação: elevar o papel não
     * apaga quem fez o quê, que é justamente o que a auditoria registra.
     */
    async registrarAuditoria({ entidade, entidadeId, acao, detalhe = null, usuarioId = null }) {
      const autor = usuarioId ?? contexto.atual()?.usuarioId ?? null;

      // Segredo não entra na trilha nem por engano: o detalhe passa pelo
      // redator antes de virar linha. O trigger do banco (017) protege o que
      // nasce lá; isto protege o que nasce aqui.
      const detalheLimpo = detalhe ? redigirAuditoria(detalhe) : null;

      await comoSistema((cliente) => consultarNoCliente(cliente,
        'INSERT INTO audit_log (entidade, entidade_id, acao, detalhe, usuario_id) VALUES ($1, $2, $3, $4::jsonb, $5)',
        [entidade, entidadeId, acao, detalheLimpo ? JSON.stringify(detalheLimpo) : null, autor],
      ));
    },

    async listarAuditoria({ limite = 50, antesDeId = null, entidade = null, acao = null } = {}) {
      const parametros = [limite];
      const filtros = [];
      if (antesDeId) {
        parametros.push(antesDeId);
        filtros.push(`a.id < $${parametros.length}`);
      }
      if (entidade) {
        parametros.push(entidade);
        filtros.push(`a.entidade = $${parametros.length}`);
      }
      if (acao) {
        parametros.push(acao);
        filtros.push(`a.acao = $${parametros.length}`);
      }
      const onde = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
      const { rows } = await consultar(`
        SELECT a.id, a.entidade, a.entidade_id, a.acao, a.detalhe, a.criado_em,
               u.nome AS usuario_nome
          FROM audit_log a
          LEFT JOIN usuarios u ON u.id = a.usuario_id
          ${onde}
         ORDER BY a.id DESC
         LIMIT $1
      `, parametros);
      const itens = rows.map((linha) => ({ ...linha, id: Number(linha.id), entidade_id: linha.entidade_id ? Number(linha.entidade_id) : null }));
      return { itens, proximoCursor: itens.length === limite ? itens.at(-1).id : null };
    },

    async registrarHeartbeat(componente, instancia, versao = null) {
      await consultar(
        `INSERT INTO operacao_heartbeats (componente, instancia, versao, visto_em)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (componente) DO UPDATE SET instancia = EXCLUDED.instancia, versao = EXCLUDED.versao, visto_em = now()`,
        [componente, instancia, versao],
      );
    },

    async obterHeartbeat(componente) {
      const { rows } = await consultar(
        'SELECT componente, instancia, versao, visto_em FROM operacao_heartbeats WHERE componente = $1', [componente],
      );
      return rows[0] ?? null;
    },

    // ---------------------------------------------------------------- usuários e sessões

    async obterUsuarioPorEmail(email) {
      if (!email) return null;
      const { rows } = await consultar(
        `SELECT ${CAMPOS_USUARIO}, senha_hash FROM usuarios WHERE lower(email) = lower($1)`,
        [email],
      );
      return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    },

    async obterUsuarioPorId(id) {
      const { rows } = await consultar(`SELECT ${CAMPOS_USUARIO} FROM usuarios WHERE id = $1`, [id]);
      return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    },

    /**
     * P1-05 — documentos do usuário (CPF/RG cifrados e hash de busca).
     *
     * `CAMPOS_USUARIO` não traz documento nenhum: cada chamada aqui é uma
     * decisão explícita da rota, com permissão exigida e acesso auditado.
     */
    async obterDocumentosDoUsuario(id) {
      const { rows } = await consultar(
        'SELECT cpf_cifrado, cpf_busca_hash, rg_cifrado FROM usuarios WHERE id = $1',
        [id]
      );
      if (!rows[0]) return null;
      return {
        cpfCifrado: rows[0].cpf_cifrado ?? null,
        cpfBuscaHash: rows[0].cpf_busca_hash ?? null,
        rgCifrado: rows[0].rg_cifrado ?? null,
      };
    },

    async obterUsuarioPorGoogleSub(sub) {
      if (!sub) return null;
      const { rows } = await consultar(`SELECT ${CAMPOS_USUARIO} FROM usuarios WHERE google_sub = $1`, [sub]);
      return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    },

    async criarUsuario({
      nome, email, senhaHash = null, papel = 'atendente',
      situacao = 'pendente', master = false, precisaTrocarSenha = false,
      googleSub = null, telefone = null,
    }) {
      const { rows } = await consultar(`
        INSERT INTO usuarios (nome, email, senha_hash, papel, situacao, master, precisa_trocar_senha, google_sub, telefone)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING ${CAMPOS_USUARIO}
      `, [nome, email, senhaHash, papel, situacao, master, precisaTrocarSenha, googleSub, telefone]);

      return { ...rows[0], id: Number(rows[0].id) };
    },

    async atualizarUsuario(id, campos) {
      const permitidos = new Map([
        ['nome', 'nome'], ['telefone', 'telefone'], ['papel', 'papel'],
        // `master` só é escrito pela semeadura do administrador: nenhuma rota HTTP
        // passa este campo, e promover a si mesmo não é um caminho existente.
        ['master', 'master'],
        ['situacao', 'situacao'], ['ativo', 'ativo'], ['senhaHash', 'senha_hash'],
        ['precisaTrocarSenha', 'precisa_trocar_senha'], ['googleSub', 'google_sub'],
        ['totpSegredoCifrado', 'totp_segredo_cifrado'], ['totpAtivo', 'totp_ativo'],
        ['totpConfirmadoEm', 'totp_confirmado_em'], ['aprovadoPor', 'aprovado_por'],
        ['aprovadoEm', 'aprovado_em'], ['ultimoLoginEm', 'ultimo_login_em'],
        ['avatarUrl', 'avatar_url'],
        // P1-01/P1-05 — cadastro completo. CPF/RG chegam já cifrados da camada
        // de domínio: o repositório não sabe decifrar, e não deve.
        ['nomeCompleto', 'nome_completo'], ['nascimento', 'nascimento'],
        ['cpfCifrado', 'cpf_cifrado'], ['cpfBuscaHash', 'cpf_busca_hash'],
        ['rgCifrado', 'rg_cifrado'],
        // P1-06 — WhatsApp estruturado e autorização explícita de uso particular.
        ['whatsappDdi', 'whatsapp_ddi'], ['whatsappDdd', 'whatsapp_ddd'],
        ['whatsappNumero', 'whatsapp_numero'],
        ['whatsappParticularAutorizado', 'whatsapp_particular_autorizado'],
        ['whatsappParticularAutorizadoEm', 'whatsapp_particular_autorizado_em'],
        ['whatsappParticularAutorizadoPor', 'whatsapp_particular_autorizado_por'],
        // P1-02 — exclusão lógica: a linha fica, a autoria histórica fica.
        ['excluidoEm', 'excluido_em'], ['excluidoPor', 'excluido_por'],
        ['excluidoMotivo', 'excluido_motivo'],
      ]);

      const partes = [];
      const valores = [];
      for (const [campo, valor] of Object.entries(campos)) {
        const coluna = permitidos.get(campo);
        if (!coluna) continue;
        valores.push(valor);
        partes.push(`${coluna} = $${valores.length}`);
      }
      if (partes.length === 0) return this.obterUsuarioPorId(id);

      valores.push(id);
      await consultar(`UPDATE usuarios SET ${partes.join(', ')} WHERE id = $${valores.length}`, valores);
      return this.obterUsuarioPorId(id);
    },

    /**
     * Números do canal nos últimos `dias`, para julgar risco de bloqueio.
     *
     * Uma consulta só: são quatro medidas do mesmo período, e buscá-las
     * separadamente abriria janela para uma contar dias que a outra não conta —
     * uma taxa calculada sobre dois períodos diferentes é pior que nenhuma.
     */
    /**
     * Saúde da fila de lembretes, para o centro operacional.
     *
     * Três contagens que denunciam falhas diferentes: preso é worker que morreu
     * no meio do lote, falhado é entrega que esgotou as tentativas, e atrasado é
     * fila que parou de ser processada — o sintoma mais direto de worker fora do
     * ar, e o único que ninguém percebe até um paciente não receber o lembrete.
     */
    /**
     * Já existe uma saída com este texto nesta conversa?
     *
     * A resposta que a equipe manda pelo painel sai pelo gateway e reaparece no
     * histórico do OpenClaw na leitura seguinte, como saída do agente. Sem esta
     * pergunta, a sincronização a gravaria de novo — e a equipe veria a própria
     * mensagem duas vezes, a segunda assinada pela Serena.
     *
     * A janela é curta porque o eco chega em minutos: uma frase repetida de
     * propósito daqui a uma hora ("Bom dia!") é mensagem nova, e deve entrar.
     */
    async existeSaidaComTexto(conversaId, texto) {
      const { rows } = await consultar(
        `SELECT 1 FROM mensagens
          WHERE conversa_id = $1 AND direcao = 'saida' AND conteudo = $2
            AND criado_em > now() - interval '30 minutes'
          LIMIT 1`,
        [conversaId, texto],
      );
      return rows.length > 0;
    },

    /**
     * Conversas que esfriaram e ainda não foram resumidas para a equipe.
     *
     * Silêncio é o único sinal honesto de que o atendimento acabou: ninguém se
     * despede no WhatsApp. O filtro exige mensagem do paciente para não resumir
     * conversa em que só a Serena falou — disparo sem resposta não é atendimento.
     */
    async listarConversasSemResumo({ silencioMin = 30, limite = 20 } = {}) {
      const { rows } = await consultar(
        `SELECT c.id, c.contato_id, c.ultima_msg_em
           FROM conversas c
          WHERE c.resumo_enviado_em IS NULL
            AND c.ultima_msg_em < now() - ($1 || ' minutes')::interval
            AND EXISTS (
              SELECT 1 FROM mensagens m
               WHERE m.conversa_id = c.id AND m.autor_tipo = 'contato'
            )
          ORDER BY c.ultima_msg_em
          LIMIT $2`,
        [String(silencioMin), limite],
      );
      return rows;
    },

    async marcarResumoEnviado(conversaId) {
      await consultar('UPDATE conversas SET resumo_enviado_em = now() WHERE id = $1', [conversaId]);
    },

    /** O agendamento futuro do contato, para o resumo dizer se ele marcou. */
    async obterAgendamentoDoContato(contatoId) {
      const { rows } = await consultar(
        `SELECT id, inicio, fim, tipo FROM agendamentos
          WHERE contato_id = $1 AND status <> 'cancelado' AND inicio > now() - interval '1 hour'
          ORDER BY inicio LIMIT 1`,
        [contatoId],
      );
      return rows[0] ?? null;
    },

    async resumirFilaDeLembretes() {
      const { rows } = await consultar(
        `SELECT
           count(*) FILTER (WHERE estado = 'processando'
                              AND processando_desde < now() - interval '10 minutes') AS presos,
           count(*) FILTER (WHERE estado = 'falhou')                                  AS falhados,
           count(*) FILTER (WHERE estado = 'pendente' AND agendar_para < now() - interval '15 minutes') AS atrasados,
           count(*) FILTER (WHERE estado = 'pendente')                                AS pendentes
         FROM lembretes`,
      );

      const linha = rows[0] ?? {};
      return {
        presos: Number(linha.presos ?? 0),
        falhados: Number(linha.falhados ?? 0),
        atrasados: Number(linha.atrasados ?? 0),
        pendentes: Number(linha.pendentes ?? 0),
      };
    },

    /**
     * Verifica objetos do banco que as migrations deveriam ter criado.
     *
     * Olha o objeto, não o registro no ledger: `supabase_migrations` só recebe
     * o que passa pelo CLI, e boa parte das migrations aqui foi aplicada por
     * outros caminhos. Perguntar "a coluna existe?" responde a pergunta que
     * importa — se o código publicado vai encontrar o que espera.
     */
    async conferirObjetosEsperados(objetos = []) {
      if (!objetos.length) return [];

      const faltando = [];
      for (const alvo of objetos) {
        const { rows } = alvo.coluna
          ? await consultar(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
            [alvo.tabela, alvo.coluna],
          )
          : await consultar(
            `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
            [alvo.tabela],
          );

        if (rows.length === 0) {
          faltando.push(alvo.coluna ? `${alvo.tabela}.${alvo.coluna}` : alvo.tabela);
        }
      }
      return faltando;
    },

    async medirCanalDeLembretes({ dias = 30 } = {}) {
      const { rows } = await consultar(
        `WITH periodo AS (SELECT (now() - ($1 || ' days')::interval) AS desde)
         SELECT
           (SELECT count(*) FROM lembretes, periodo
              WHERE estado = 'enviado' AND enviado_em >= periodo.desde)         AS enviados,
           (SELECT count(*) FROM lembretes, periodo
              WHERE estado = 'falhou' AND atualizado_em >= periodo.desde)       AS falhas,
           (SELECT count(DISTINCT contato_id) FROM lembretes, periodo
              WHERE estado = 'enviado' AND enviado_em >= periodo.desde)         AS contatos,
           (SELECT count(*) FROM contatos, periodo
              WHERE lembretes_optout = true
                AND lembretes_optout_em >= periodo.desde)                       AS optouts`,
        [String(dias)],
      );

      const linha = rows[0] ?? {};
      const enviados = Number(linha.enviados ?? 0);

      return {
        dias,
        enviados,
        falhas: Number(linha.falhas ?? 0),
        contatos: Number(linha.contatos ?? 0),
        optouts: Number(linha.optouts ?? 0),
        enviadosPorDia: dias > 0 ? enviados / dias : 0,
      };
    },

    async listarUsuarios({ situacao = null } = {}) {
      const valores = [];
      let filtro = '';
      if (situacao) {
        valores.push(situacao);
        filtro = 'WHERE situacao = $1';
      }
      const { rows } = await consultar(
        `SELECT ${CAMPOS_USUARIO} FROM usuarios ${filtro} ORDER BY situacao = 'pendente' DESC, nome`,
        valores,
      );
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    /** O segredo do segundo fator sai separado: quase nenhuma consulta precisa dele. */
    async obterSegredoTotp(id) {
      const { rows } = await consultar('SELECT totp_segredo_cifrado FROM usuarios WHERE id = $1', [id]);
      return rows[0]?.totp_segredo_cifrado ?? null;
    },

    // ---------------------------------------------------------------- recuperação de senha

    async criarRecuperacao({ usuarioId, hashToken, expiraEm, ip = null }) {
      const { rows } = await consultar(
        'INSERT INTO recuperacoes_senha (usuario_id, hash_token, expira_em, solicitado_ip) VALUES ($1, $2, $3, $4) RETURNING id',
        [usuarioId, hashToken, expiraEm, ip],
      );
      return { id: Number(rows[0].id) };
    },

    async obterRecuperacaoPorHash(hashToken) {
      const { rows } = await consultar(
        'SELECT id, usuario_id, expira_em, usado_em FROM recuperacoes_senha WHERE hash_token = $1',
        [hashToken],
      );
      return rows[0] ? { ...rows[0], id: Number(rows[0].id), usuario_id: Number(rows[0].usuario_id) } : null;
    },

    async marcarRecuperacaoUsada(id) {
      await consultar('UPDATE recuperacoes_senha SET usado_em = now() WHERE id = $1 AND usado_em IS NULL', [id]);
    },

    /** Um pedido novo invalida os anteriores: só o último link deve funcionar. */
    async invalidarRecuperacoesDoUsuario(usuarioId) {
      const { rowCount } = await consultar(
        'UPDATE recuperacoes_senha SET usado_em = now() WHERE usuario_id = $1 AND usado_em IS NULL',
        [usuarioId],
      );
      return rowCount;
    },

    // ---------------------------------------------------------------- agenda

    async listarProfissionais({ apenasAtivos = true } = {}) {
      const { rows } = await consultar(`
        SELECT id, nome, especialidade, registro, cor, duracao_min, usuario_id, ativo
        FROM profissionais ${apenasAtivos ? 'WHERE ativo' : ''}
        ORDER BY nome
      `);
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async obterProfissional(id) {
      const { rows } = await consultar(
        'SELECT id, nome, especialidade, registro, cor, duracao_min, usuario_id, ativo FROM profissionais WHERE id = $1',
        [id],
      );
      return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    },

    async criarProfissional({ nome, especialidade = null, registro = null, cor = null, duracaoMin = 30, usuarioId = null }) {
      const { rows } = await consultar(`
        INSERT INTO profissionais (nome, especialidade, registro, cor, duracao_min, usuario_id)
        VALUES ($1, $2, $3, COALESCE($4, '#0e8fa1'), $5, $6)
        RETURNING id, nome, especialidade, registro, cor, duracao_min, usuario_id, ativo
      `, [nome, especialidade, registro, cor, duracaoMin, usuarioId]);

      return { ...rows[0], id: Number(rows[0].id) };
    },

    async definirDisponibilidades(profissionalId, janelas) {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        await cliente.query('DELETE FROM disponibilidades WHERE profissional_id = $1', [profissionalId]);

        for (const janela of janelas) {
          await cliente.query(
            'INSERT INTO disponibilidades (profissional_id, dia_semana, hora_inicio, hora_fim) VALUES ($1, $2, $3, $4)',
            [profissionalId, janela.dia_semana, janela.hora_inicio, janela.hora_fim],
          );
        }
        await cliente.query('COMMIT');
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }

      return this.listarDisponibilidades(profissionalId);
    },

    async listarDisponibilidades(profissionalId) {
      const { rows } = await consultar(`
        SELECT id, profissional_id, dia_semana, to_char(hora_inicio, 'HH24:MI') AS hora_inicio,
               to_char(hora_fim, 'HH24:MI') AS hora_fim
        FROM disponibilidades WHERE profissional_id = $1
        ORDER BY dia_semana, hora_inicio
      `, [profissionalId]);

      return rows.map((linha) => ({
        ...linha, id: Number(linha.id), profissional_id: Number(linha.profissional_id),
      }));
    },

    async criarBloqueio({ profissionalId = null, inicio, fim, motivo = null, criadoPor = null }) {
      const { rows } = await consultar(`
        INSERT INTO agenda_bloqueios (profissional_id, inicio, fim, motivo, criado_por)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, profissional_id, inicio, fim, motivo
      `, [profissionalId, inicio, fim, motivo, criadoPor]);

      return { ...rows[0], id: Number(rows[0].id) };
    },

    /** Bloqueio sem profissional vale para a clínica inteira (feriado). */
    async listarBloqueios({ profissionalId = null, inicio, fim }) {
      const { rows } = await consultar(`
        SELECT id, profissional_id, inicio, fim, motivo
        FROM agenda_bloqueios
        WHERE (profissional_id = $1 OR profissional_id IS NULL)
          AND inicio < $3 AND fim > $2
        ORDER BY inicio
      `, [profissionalId, inicio, fim]);

      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async removerBloqueio(id) {
      const { rowCount } = await consultar('DELETE FROM agenda_bloqueios WHERE id = $1', [id]);
      return rowCount;
    },

    async criarAgendamento({
      profissionalId, contatoId, leadId = null, conversaId = null,
      inicio, fim, tipo = 'consulta', observacoes = null, local = null, criadoPor = null,
    }) {
      const { rows } = await consultar(`
        INSERT INTO agendamentos
          (profissional_id, contato_id, lead_id, conversa_id, inicio, fim, tipo, observacoes, local, criado_por)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `, [profissionalId, contatoId, leadId, conversaId, inicio, fim, tipo, observacoes, local, criadoPor]);

      return montarAgendamento(rows[0]);
    },

    async obterAgendamento(id) {
      const { rows } = await consultar(`
        SELECT a.*, p.nome AS profissional_nome, p.cor AS profissional_cor,
               ct.nome AS contato_nome, ct.telefone AS contato_telefone
        FROM agendamentos a
        JOIN profissionais p ON p.id = a.profissional_id
        JOIN contatos ct ON ct.id = a.contato_id
        WHERE a.id = $1
      `, [id]);

      return rows[0] ? montarAgendamento(rows[0]) : null;
    },

    async listarAgendamentos({ profissionalId = null, contatoId = null, conversaId = null, inicio, fim, incluirCancelados = false } = {}) {
      const condicoes = [];
      const valores = [];

      if (profissionalId) { valores.push(profissionalId); condicoes.push(`a.profissional_id = $${valores.length}`); }
      if (contatoId) { valores.push(contatoId); condicoes.push(`a.contato_id = $${valores.length}`); }
      if (conversaId) { valores.push(conversaId); condicoes.push(`a.conversa_id = $${valores.length}`); }
      if (inicio && fim) {
        valores.push(inicio, fim);
        condicoes.push(`a.inicio < $${valores.length} AND a.fim > $${valores.length - 1}`);
      }
      if (!incluirCancelados) condicoes.push("a.status <> 'cancelado'");

      const { rows } = await consultar(`
        SELECT a.*, p.nome AS profissional_nome, p.cor AS profissional_cor,
               ct.nome AS contato_nome, ct.telefone AS contato_telefone
        FROM agendamentos a
        JOIN profissionais p ON p.id = a.profissional_id
        JOIN contatos ct ON ct.id = a.contato_id
        ${condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : ''}
        ORDER BY a.inicio
      `, valores);

      return rows.map(montarAgendamento);
    },

    async atualizarAgendamento(id, campos) {
      const permitidos = new Map([
        ['inicio', 'inicio'], ['fim', 'fim'], ['status', 'status'], ['tipo', 'tipo'],
        ['observacoes', 'observacoes'], ['local', 'local'],
        ['confirmadoEm', 'confirmado_em'], ['canceladoEm', 'cancelado_em'],
        ['canceladoMotivo', 'cancelado_motivo'], ['profissionalId', 'profissional_id'],
        // Sem esta linha o identificador do evento era descartado em silêncio:
        // a consulta ia para o Google e o CRM não guardava o vínculo, então
        // remarcar criaria um evento novo e cancelar não teria o que apagar.
        ['google_evento_id', 'google_evento_id'],
        // Estado de sincronia com o Google (P0-09 a P0-12): o worker do outbox
        // e o sync incremental gravam aqui o vínculo e o resultado de cada
        // tentativa — nunca a interface diretamente.
        ['googleCalendarId', 'google_calendar_id'], ['googleEtag', 'google_etag'],
        ['syncStatus', 'sync_status'], ['syncVersion', 'sync_version'],
        ['lastSyncedAt', 'last_synced_at'], ['lastSyncError', 'last_sync_error'],
        ['origemAlteracao', 'origem_alteracao'],
      ]);

      const partes = [];
      const valores = [];
      for (const [campo, valor] of Object.entries(campos)) {
        const coluna = permitidos.get(campo);
        if (!coluna) continue;
        valores.push(valor);
        partes.push(`${coluna} = $${valores.length}`);
      }
      if (partes.length === 0) return this.obterAgendamento(id);

      valores.push(id);
      await consultar(`UPDATE agendamentos SET ${partes.join(', ')} WHERE id = $${valores.length}`, valores);
      return this.obterAgendamento(id);
    },

    // ---------------------------------------------------------------- Serena

    /** O interruptor global. Uma linha só, garantida pela constraint da tabela. */
    async obterConfiguracaoDaSerena() {
      const PADRAO = {
        id: 1, ativa: true, alterado_por: null, alterado_em: null, motivo: null,
        agenda: null, pausada_ate: null, ligada_ate: null,
      };

      const consulta = (colunasNovas) => consultar(`
        SELECT c.id, c.ativa, c.alterado_por, c.alterado_em, c.motivo,
               ${colunasNovas ? 'c.agenda, c.pausada_ate, c.ligada_ate,' : ''}
               u.nome AS alterado_por_nome
          FROM serena_configuracao c
          LEFT JOIN usuarios u ON u.id = c.alterado_por
         WHERE c.id = 1
      `);

      let rows;
      try {
        ({ rows } = await consulta(true));
      } catch (erro) {
        // 42703 = coluna inexistente: o código subiu antes da migração 013.
        // Deploy e migração não são atômicos, e o intervalo entre os dois não
        // pode derrubar o painel inteiro da Serena — o horário é um detalhe
        // dela, não a razão de ela existir. Sem as colunas, a leitura degrada
        // para "sem limite de horário", que é o padrão de quem nunca configurou.
        if (erro.code !== '42703') throw erro;
        ({ rows } = await consulta(false));
      }

      // Linha ausente nasce ligada e sem limite: um sistema que sobe mudo sem
      // ninguém pedir é pior que um que sobe falando.
      if (!rows[0]) return PADRAO;
      return { ...PADRAO, ...rows[0], ativa: rows[0].ativa === true };
    },

    /**
     * Grava horário, pausa e plantão — só os campos informados.
     *
     * `undefined` é "não mexa" e `null` é "apague", e a diferença importa:
     * despausar é gravar `null` em `pausada_ate`, e um `COALESCE` ingênuo
     * transformaria isso em "mantenha a pausa".
     */
    async definirHorarioDaSerena({ agenda, pausadaAte, ligadaAte, usuarioId = null }) {
      const campos = [];
      const valores = [];
      const marcar = (coluna, valor) => {
        valores.push(valor);
        campos.push(`${coluna} = $${valores.length}`);
      };

      if (agenda !== undefined) marcar('agenda', agenda === null ? null : JSON.stringify(agenda));
      if (pausadaAte !== undefined) marcar('pausada_ate', pausadaAte);
      if (ligadaAte !== undefined) marcar('ligada_ate', ligadaAte);

      valores.push(usuarioId);
      campos.push(`alterado_por = $${valores.length}`, 'alterado_em = now()');

      let rows;
      try {
        ({ rows } = await consultar(`
          UPDATE serena_configuracao SET ${campos.join(', ')}
           WHERE id = 1
          RETURNING id, ativa, alterado_por, alterado_em, motivo, agenda, pausada_ate, ligada_ate
        `, valores));
      } catch (erro) {
        // Mesmo intervalo entre deploy e migração da leitura. Aqui não dá para
        // degradar — não há onde gravar —, mas "falha interna" mandaria procurar
        // bug onde falta um passo de operação.
        if (erro.code !== '42703') throw erro;
        const falta = new Error('o horário da Serena exige a migração 013_serena_horario, ainda não aplicada');
        falta.status = 503;
        falta.codigo = 'migracao_pendente';
        throw falta;
      }

      if (!rows[0]) return this.obterConfiguracaoDaSerena();
      return { ...rows[0], ativa: rows[0].ativa === true };
    },

    async definirConfiguracaoDaSerena({ ativa, motivo = null, usuarioId = null }) {
      // UPSERT: se a linha sumiu (banco novo, restauração parcial), ela volta
      // com o valor pedido em vez de a chamada falhar em silêncio.
      const { rows } = await consultar(`
        INSERT INTO serena_configuracao (id, ativa, motivo, alterado_por, alterado_em)
        VALUES (1, $1, $2, $3, now())
        ON CONFLICT (id) DO UPDATE
           SET ativa = EXCLUDED.ativa,
               motivo = EXCLUDED.motivo,
               alterado_por = EXCLUDED.alterado_por,
               alterado_em = now()
        RETURNING id, ativa, alterado_por, alterado_em, motivo
      `, [ativa === true, motivo, usuarioId]);

      return { ...rows[0], ativa: rows[0].ativa === true };
    },

    // ---------------------------------------------------------------- prompts

    async listarPromptsDaSerena({ limite = 50 } = {}) {
      const { rows } = await consultar(`
        SELECT p.id, p.versao, p.titulo, p.conteudo, p.publicado, p.publicado_em,
               p.criado_em, p.atualizado_em,
               c.nome AS criado_por_nome, e.nome AS publicado_por_nome
          FROM serena_prompts p
          LEFT JOIN usuarios c ON c.id = p.criado_por
          LEFT JOIN usuarios e ON e.id = p.publicado_por
         ORDER BY p.versao DESC
         LIMIT $1
      `, [Number(limite)]);

      return rows.map((linha) => ({ ...linha, id: Number(linha.id), versao: Number(linha.versao) }));
    },

    async obterPromptDaSerena(id) {
      const { rows } = await consultar('SELECT * FROM serena_prompts WHERE id = $1', [id]);
      return rows[0] ? { ...rows[0], id: Number(rows[0].id), versao: Number(rows[0].versao) } : null;
    },

    async obterPromptPublicadoDaSerena() {
      const { rows } = await consultar('SELECT * FROM serena_prompts WHERE publicado LIMIT 1');
      return rows[0] ? { ...rows[0], id: Number(rows[0].id), versao: Number(rows[0].versao) } : null;
    },

    /**
     * Cria uma versão nova.
     *
     * A numeração vem do banco (`max(versao) + 1`) e não de um contador da
     * aplicação: duas pessoas salvando ao mesmo tempo receberiam o mesmo número
     * se a conta fosse feita em JavaScript, e a constraint `serena_prompt_versao_uk`
     * recusaria a segunda com um erro que não diz nada.
     */
    async criarPromptDaSerena({ titulo, conteudo, criadoPor = null }) {
      const { rows } = await consultar(`
        INSERT INTO serena_prompts (versao, titulo, conteudo, criado_por)
        VALUES ((SELECT COALESCE(max(versao), 0) + 1 FROM serena_prompts), $1, $2, $3)
        RETURNING *
      `, [titulo, conteudo, criadoPor]);

      return { ...rows[0], id: Number(rows[0].id), versao: Number(rows[0].versao) };
    },

    /** Edita um rascunho. O que já foi publicado não se reescreve. */
    async atualizarPromptDaSerena(id, { titulo, conteudo }) {
      const { rows } = await consultar(`
        UPDATE serena_prompts SET titulo = $2, conteudo = $3
         WHERE id = $1 AND NOT publicado
        RETURNING *
      `, [id, titulo, conteudo]);

      return rows[0] ? { ...rows[0], id: Number(rows[0].id), versao: Number(rows[0].versao) } : null;
    },

    /**
     * Publica uma versão. Despublicar a anterior e publicar a nova na **mesma**
     * transação: o índice único parcial recusaria duas publicadas, e fazer em
     * duas chamadas deixaria um instante sem nenhuma no ar.
     */
    async publicarPromptDaSerena(id, { usuarioId = null } = {}) {
      const cliente = contexto.atual()?.client;
      const executar = async (query) => (cliente ? cliente.query(query.texto, query.valores) : pool.query(query.texto, query.valores));

      // Dentro de uma transação da requisição, aproveita-a; fora dela, abre uma.
      if (cliente) {
        await executar({ texto: 'UPDATE serena_prompts SET publicado = false, publicado_em = NULL, publicado_por = NULL WHERE publicado AND id <> $1', valores: [id] });
        const { rows } = await executar({
          texto: 'UPDATE serena_prompts SET publicado = true, publicado_em = now(), publicado_por = $2 WHERE id = $1 RETURNING *',
          valores: [id, usuarioId],
        });
        return rows[0] ? { ...rows[0], id: Number(rows[0].id), versao: Number(rows[0].versao) } : null;
      }

      const conexao = await pool.connect();
      try {
        await conexao.query('BEGIN');
        await conexao.query('UPDATE serena_prompts SET publicado = false, publicado_em = NULL, publicado_por = NULL WHERE publicado AND id <> $1', [id]);
        const { rows } = await conexao.query(
          'UPDATE serena_prompts SET publicado = true, publicado_em = now(), publicado_por = $2 WHERE id = $1 RETURNING *',
          [id, usuarioId],
        );
        await conexao.query('COMMIT');
        return rows[0] ? { ...rows[0], id: Number(rows[0].id), versao: Number(rows[0].versao) } : null;
      } catch (erro) {
        try { await conexao.query('ROLLBACK'); } catch { /* conexão perdida */ }
        throw erro;
      } finally {
        conexao.release();
      }
    },

    // ---------------------------------------------------------------- regras

    async listarRegrasDaSerena({ apenasAtivas = false } = {}) {
      const { rows } = await consultar(`
        SELECT r.*, u.nome AS criado_por_nome
          FROM serena_regras r
          LEFT JOIN usuarios u ON u.id = r.criado_por
         ${apenasAtivas ? 'WHERE r.ativa' : ''}
         ORDER BY r.categoria, r.ordem, r.nome
      `);
      return rows.map((linha) => ({ ...linha, id: Number(linha.id), ativa: linha.ativa === true }));
    },

    async obterRegraDaSerena(id) {
      const { rows } = await consultar('SELECT * FROM serena_regras WHERE id = $1', [id]);
      return rows[0] ? { ...rows[0], id: Number(rows[0].id), ativa: rows[0].ativa === true } : null;
    },

    async criarRegraDaSerena({ nome, conteudo, categoria, descricao = null, ordem = 100, criadoPor = null }) {
      const { rows } = await consultar(`
        INSERT INTO serena_regras (nome, conteudo, categoria, descricao, ordem, criado_por)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [nome, conteudo, categoria, descricao, ordem, criadoPor]);

      return { ...rows[0], id: Number(rows[0].id), ativa: rows[0].ativa === true };
    },

    async atualizarRegraDaSerena(id, campos) {
      const permitidos = new Map([
        ['nome', 'nome'], ['conteudo', 'conteudo'], ['categoria', 'categoria'],
        ['descricao', 'descricao'], ['ordem', 'ordem'], ['ativa', 'ativa'],
      ]);

      const partes = [];
      const valores = [];
      for (const [campo, valor] of Object.entries(campos)) {
        const coluna = permitidos.get(campo);
        if (!coluna) continue;
        valores.push(valor);
        partes.push(`${coluna} = $${valores.length}`);
      }
      if (partes.length === 0) return this.obterRegraDaSerena(id);

      valores.push(id);
      const { rows } = await consultar(
        `UPDATE serena_regras SET ${partes.join(', ')} WHERE id = $${valores.length} RETURNING *`,
        valores,
      );
      return rows[0] ? { ...rows[0], id: Number(rows[0].id), ativa: rows[0].ativa === true } : null;
    },

    async removerRegraDaSerena(id) {
      const { rowCount } = await consultar('DELETE FROM serena_regras WHERE id = $1', [id]);
      return rowCount;
    },

    // --------------------------------------------------------- Serena — voz

    async criarSessaoDeVoz({ id, usuarioId, conversaId = null, perfil, consentimentoEm, expiraEm }) {
      const { rows } = await consultar(`
        INSERT INTO serena_voz_sessoes
          (id, usuario_id, conversa_id, perfil, consentimento_em, expira_em)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [id, usuarioId, conversaId, perfil, consentimentoEm, expiraEm]);
      return rows[0];
    },

    async obterSessaoDeVoz(id) {
      const { rows } = await consultar('SELECT * FROM serena_voz_sessoes WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async encerrarSessaoDeVoz(id) {
      const { rows } = await consultar(`
        UPDATE serena_voz_sessoes
           SET estado = CASE WHEN estado = 'ativa' THEN 'encerrada' ELSE estado END,
               encerrado_em = CASE WHEN estado = 'ativa' THEN now() ELSE encerrado_em END
         WHERE id = $1 RETURNING *
      `, [id]);
      return rows[0] ?? null;
    },

    async listarTurnosDeVoz(sessaoId) {
      const { rows } = await consultar(`
        SELECT * FROM serena_voz_turnos WHERE sessao_id = $1
        ORDER BY ocorrido_em, id
      `, [sessaoId]);
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async registrarTurnoDeVoz({ chaveIdempotencia, sessaoId, papel, transcricao, ocorridoEm }) {
      const { rows } = await consultar(`
        INSERT INTO serena_voz_turnos
          (chave_idempotencia, sessao_id, papel, transcricao, ocorrido_em)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (chave_idempotencia) DO NOTHING
        RETURNING *
      `, [chaveIdempotencia, sessaoId, papel, transcricao, ocorridoEm]);
      if (rows[0]) return { turno: { ...rows[0], id: Number(rows[0].id) }, criado: true };
      const { rows: existentes } = await consultar(
        'SELECT * FROM serena_voz_turnos WHERE chave_idempotencia = $1', [chaveIdempotencia],
      );
      return { turno: { ...existentes[0], id: Number(existentes[0].id) }, criado: false };
    },

    // ---------------------------------------------------------------- lembretes
    //
    // A fila que sustenta os lembretes de 24h e 2h. Duas operações carregam as
    // garantias inteiras — `enfileirarLembrete` (idempotência) e
    // `reivindicarLembretes` (exclusão entre workers). O resto é leitura.

    /**
     * Põe um lembrete na fila. Repetir não cria linha.
     *
     * `ON CONFLICT DO NOTHING` sobre `lembretes_unicos` é o que torna o
     * enfileiramento idempotente por (agendamento, tipo, janela). Sem linha
     * devolvida, o lembrete já existia — e é o que existe que vale, não o que
     * esta chamada tentou criar.
     */
    async enfileirarLembrete({
      agendamentoId, contatoId, tipo, janela, agendarPara,
      estado = 'pendente', ignoradoMotivo = null, maxTentativas = 5,
    }) {
      const { rows } = await consultar(`
        INSERT INTO lembretes
          (agendamento_id, contato_id, tipo, janela, agendar_para, estado, ignorado_motivo, max_tentativas, tentar_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $5)
        ON CONFLICT ON CONSTRAINT lembretes_unicos DO NOTHING
        RETURNING *
      `, [agendamentoId, contatoId, tipo, janela, agendarPara, estado, ignoradoMotivo, maxTentativas]);

      if (rows.length > 0) return { lembrete: montarLembrete(rows[0]), criado: true };

      const { rows: existente } = await consultar(
        'SELECT * FROM lembretes WHERE agendamento_id = $1 AND tipo = $2 AND janela = $3',
        [agendamentoId, tipo, janela],
      );
      return { lembrete: montarLembrete(existente[0]), criado: false };
    },

    async obterLembrete(id) {
      const { rows } = await consultar(`SELECT ${SELECAO_LEMBRETE} ${JUNCOES_LEMBRETE} WHERE l.id = $1`, [id]);
      return montarLembrete(rows[0]);
    },

    async listarLembretes({
      estado = null, tipo = null, agendamentoId = null, contatoId = null, limite = 50,
    } = {}) {
      const condicoes = [];
      const valores = [];

      if (estado) { valores.push(estado); condicoes.push(`l.estado = $${valores.length}`); }
      if (tipo) { valores.push(tipo); condicoes.push(`l.tipo = $${valores.length}`); }
      if (agendamentoId) { valores.push(agendamentoId); condicoes.push(`l.agendamento_id = $${valores.length}`); }
      if (contatoId) { valores.push(contatoId); condicoes.push(`l.contato_id = $${valores.length}`); }
      valores.push(Number(limite));

      const { rows } = await consultar(`
        SELECT ${SELECAO_LEMBRETE} ${JUNCOES_LEMBRETE}
        ${condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : ''}
        ORDER BY l.agendar_para DESC, l.id DESC
        LIMIT $${valores.length}
      `, valores);

      return rows.map(montarLembrete);
    },

    async contarLembretesPorEstado() {
      const { rows } = await consultar(`
        SELECT estado, tipo, count(*)::int AS total,
               count(*) FILTER (WHERE modo_entrega = 'dry_run')::int AS dry_run,
               count(*) FILTER (WHERE modo_entrega = 'real')::int AS real
          FROM lembretes GROUP BY estado, tipo
      `);

      const total = { pendente: 0, processando: 0, enviado: 0, ignorado: 0, falhou: 0 };
      const porTipo = {};
      let dryRun = 0;
      let reais = 0;

      for (const linha of rows) {
        total[linha.estado] = (total[linha.estado] ?? 0) + linha.total;
        porTipo[linha.tipo] = porTipo[linha.tipo] ?? { pendente: 0, processando: 0, enviado: 0, ignorado: 0, falhou: 0 };
        porTipo[linha.tipo][linha.estado] += linha.total;
        dryRun += linha.dry_run;
        reais += linha.real;
      }

      return { por_estado: total, por_tipo: porTipo, entregas: { dry_run: dryRun, real: reais } };
    },

    /**
     * Reivindica lembretes para processar. **É a operação que impede duplicidade.**
     *
     * `FOR UPDATE SKIP LOCKED` faz o segundo worker pular a linha que o primeiro
     * travou, em vez de esperar por ela. Os dois recebem conjuntos disjuntos, e
     * a marcação para 'processando' acontece na mesma instrução — não há
     * intervalo entre selecionar e reservar em que um terceiro pudesse entrar.
     *
     * `SELECT ... FOR UPDATE` sozinho não bastaria: o segundo worker bloquearia
     * até o primeiro terminar e então enxergaria a linha já processada.
     */
    async reivindicarLembretes({ agora, limite = 20, worker = 'worker' }) {
      const { rows } = await consultar(`
        WITH candidatos AS (
          SELECT id FROM lembretes
           WHERE estado = 'pendente'
             AND agendar_para <= $1::timestamptz
             AND tentar_em <= $1::timestamptz
           ORDER BY agendar_para, id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
        UPDATE lembretes l
           SET estado = 'processando',
               processando_por = $3,
               processando_desde = $1::timestamptz
          FROM candidatos c
         WHERE l.id = c.id
        RETURNING l.id
      `, [agora, Number(limite), String(worker).slice(0, 100)]);

      if (rows.length === 0) return [];

      const { rows: completos } = await consultar(`
        SELECT ${SELECAO_LEMBRETE} ${JUNCOES_LEMBRETE}
         WHERE l.id = ANY($1::bigint[])
         ORDER BY l.agendar_para, l.id
      `, [rows.map((linha) => Number(linha.id))]);

      return completos.map(montarLembrete);
    },

    /** Grava o desfecho de um lembrete: enviado, ignorado, falhou ou de volta à fila. */
    async concluirLembrete(id, {
      estado, modoEntrega = undefined, entregaReferencia = undefined, enviadoEm = undefined,
      ignoradoMotivo = undefined, ultimoErro = undefined, tentativas = undefined, tentarEm = undefined,
    }) {
      const partes = ['estado = $2'];
      const valores = [id, estado];

      const acrescentar = (coluna, valor, cast = '') => {
        valores.push(valor);
        partes.push(`${coluna} = $${valores.length}${cast}`);
      };

      if (modoEntrega !== undefined) acrescentar('modo_entrega', modoEntrega);
      if (entregaReferencia !== undefined) acrescentar('entrega_referencia', entregaReferencia);
      if (enviadoEm !== undefined) acrescentar('enviado_em', enviadoEm, '::timestamptz');
      if (ignoradoMotivo !== undefined) acrescentar('ignorado_motivo', ignoradoMotivo);
      if (ultimoErro !== undefined) acrescentar('ultimo_erro', ultimoErro);
      if (tentativas !== undefined) acrescentar('tentativas', tentativas);
      if (tentarEm !== undefined) acrescentar('tentar_em', tentarEm ?? new Date().toISOString(), '::timestamptz');

      // Sair de 'processando' devolve a linha à fila limpa: um lease velho
      // faria a recuperação achar que ainda há alguém trabalhando nela.
      if (estado !== 'processando') partes.push('processando_por = NULL, processando_desde = NULL');

      await consultar(`UPDATE lembretes SET ${partes.join(', ')} WHERE id = $1`, valores);
      return this.obterLembrete(id);
    },

    /**
     * Devolve à fila o que ficou preso em 'processando'.
     *
     * O worker que morre no meio de um envio deixa a linha reservada para
     * sempre. Aqui ela volta — contando a tentativa, para que um lembrete que
     * derruba o worker toda vez termine em 'falhou' em vez de circular eterno.
     */
    async liberarLembretesPresos({ antesDe, agora }) {
      const { rows } = await consultar(`
        UPDATE lembretes
           SET tentativas = tentativas + 1,
               estado = CASE WHEN tentativas + 1 >= max_tentativas THEN 'falhou' ELSE 'pendente' END,
               tentar_em = $2::timestamptz,
               ultimo_erro = 'processamento abandonado por worker inativo',
               processando_por = NULL,
               processando_desde = NULL
         WHERE estado = 'processando'
           AND processando_desde < $1::timestamptz
        RETURNING id
      `, [antesDe, agora]);

      if (rows.length === 0) return [];
      const { rows: completos } = await consultar(
        `SELECT ${SELECAO_LEMBRETE} ${JUNCOES_LEMBRETE} WHERE l.id = ANY($1::bigint[])`,
        [rows.map((linha) => Number(linha.id))],
      );
      return completos.map(montarLembrete);
    },

    /**
     * Tira da fila o que ainda não saiu de um agendamento.
     *
     * `exceto` preserva a janela informada: remarcar enfileira o horário novo e
     * cancela o antigo numa tacada, sem apagar o que acabou de entrar.
     */
    async cancelarLembretesDoAgendamento(agendamentoId, { motivo = 'cancelado', exceto = null } = {}) {
      const { rows } = await consultar(`
        UPDATE lembretes
           SET estado = 'ignorado', ignorado_motivo = $2,
               processando_por = NULL, processando_desde = NULL
         WHERE agendamento_id = $1
           AND estado IN ('pendente', 'processando')
           AND ($3::timestamptz IS NULL OR janela <> $3::timestamptz)
        RETURNING id
      `, [agendamentoId, motivo, exceto]);

      if (rows.length === 0) return [];
      const { rows: completos } = await consultar(
        `SELECT ${SELECAO_LEMBRETE} ${JUNCOES_LEMBRETE} WHERE l.id = ANY($1::bigint[])`,
        [rows.map((linha) => Number(linha.id))],
      );
      return completos.map(montarLembrete);
    },

    async cancelarLembretesDoContato(contatoId, { motivo = 'optout' } = {}) {
      const { rows } = await consultar(`
        UPDATE lembretes
           SET estado = 'ignorado', ignorado_motivo = $2,
               processando_por = NULL, processando_desde = NULL
         WHERE contato_id = $1 AND estado IN ('pendente', 'processando')
        RETURNING id
      `, [contatoId, motivo]);

      if (rows.length === 0) return [];
      const { rows: completos } = await consultar(
        `SELECT ${SELECAO_LEMBRETE} ${JUNCOES_LEMBRETE} WHERE l.id = ANY($1::bigint[])`,
        [rows.map((linha) => Number(linha.id))],
      );
      return completos.map(montarLembrete);
    },

    // ---------------------------------------------------------------- tentativas de autenticação

    async registrarTentativa({ ip = null, hashConta = null, acao = 'login', sucesso = false }) {
      await consultar(
        'INSERT INTO tentativas_autenticacao (ip, hash_conta, acao, sucesso) VALUES ($1, $2, $3, $4)',
        [ip, hashConta, acao, sucesso],
      );
    },

    /**
     * Conta as falhas de uma chave dentro da janela e diz quando a mais antiga sai.
     * É o que sustenta a janela deslizante: nada de zerar de hora em hora.
     */
    async contarFalhas({ ip = null, hashConta = null, acao = 'login', desde }) {
      const coluna = hashConta ? 'hash_conta' : 'ip';
      const valor = hashConta ?? ip;
      if (valor === null || valor === undefined) return { total: 0, maisAntigaEm: null };

      const { rows } = await consultar(`
        SELECT count(*)::int AS total, min(criado_em) AS mais_antiga
        FROM tentativas_autenticacao
        WHERE ${coluna} = $1 AND acao = $2 AND NOT sucesso AND criado_em > $3
      `, [valor, acao, desde]);

      return { total: rows[0].total, maisAntigaEm: rows[0].mais_antiga };
    },

    /** Login bem-sucedido zera o contador da conta — quem provou ser quem é não fica de castigo. */
    async limparFalhasDaConta(hashConta, acao = 'login') {
      if (!hashConta) return 0;
      const { rowCount } = await consultar(
        'DELETE FROM tentativas_autenticacao WHERE hash_conta = $1 AND acao = $2 AND NOT sucesso',
        [hashConta, acao],
      );
      return rowCount;
    },

    async limparTentativasVencidas(anteriorA) {
      const { rowCount } = await consultar(
        'DELETE FROM tentativas_autenticacao WHERE criado_em < $1',
        [anteriorA],
      );
      return rowCount;
    },

    async criarSessao({ usuarioId, hashRefresh, expiraEm, agente = null, ip = null }) {
      const { rows } = await consultar(
        'INSERT INTO sessoes (usuario_id, hash_refresh, expira_em, agente, ip) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [usuarioId, hashRefresh, expiraEm, agente, ip],
      );
      return { id: Number(rows[0].id) };
    },

    async obterSessaoPorHash(hashRefresh) {
      const { rows } = await consultar(
        'SELECT id, usuario_id, hash_refresh, expira_em, revogada_em FROM sessoes WHERE hash_refresh = $1',
        [hashRefresh],
      );
      return rows[0] ? { ...rows[0], id: Number(rows[0].id), usuario_id: Number(rows[0].usuario_id) } : null;
    },

    async revogarSessao(id) {
      await consultar('UPDATE sessoes SET revogada_em = now() WHERE id = $1 AND revogada_em IS NULL', [id]);
    },

    async revogarSessoesDoUsuario(usuarioId) {
      const { rowCount } = await consultar(
        'UPDATE sessoes SET revogada_em = now() WHERE usuario_id = $1 AND revogada_em IS NULL',
        [usuarioId],
      );
      return rowCount;
    },
  };
}

module.exports = { criarRepositorio };
