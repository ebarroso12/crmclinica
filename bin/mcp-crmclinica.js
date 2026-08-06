#!/usr/bin/env node
'use strict';

// Servidor MCP que dá à Serena as mãos para operar o CRM.
//
// Ela conversava bem e não conseguia fazer nada: oferecia horário sem poder
// consultar a agenda, prometia registrar o contato sem ter onde escrever. A
// equipe transcrevia à mão o que a conversa já dizia.
//
// Este processo é a ponte. Fala MCP com o OpenClaw pela entrada padrão, e HTTP
// com o crmclinica — que é onde as regras vivem. Nenhuma decisão acontece aqui:
// a carência de três dias, a trava de conflito e o que cada ação pode fazer são
// do CRM, e continuam valendo mesmo que este arquivo esteja errado.
//
// ------------------------------------------------------------------ o desenho
//
// Uma ferramenta por ação, e não uma ferramenta genérica com um campo "ação".
// O modelo escolhe melhor entre nomes que descrevem intenção do que entre
// valores de um parâmetro — e a lista de ferramentas vira, por si, a lista do
// que ele consegue fazer.
//
// O token vai no ambiente, nunca nos argumentos: linha de comando aparece em
// `ps`, e um token de escrita no CRM não pode ficar visível para quem listar os
// processos do servidor.

const BASE = process.env.CRMCLINICA_URL || 'https://crmclinica.edsonbarrosojr.com.br';
const TOKEN = process.env.CRMCLINICA_AGENTE_TOKEN || '';
const TIMEOUT_MS = Number(process.env.CRMCLINICA_TIMEOUT_MS) || 20000;

const FERRAMENTAS = [
  {
    name: 'consultar_horarios',
    description: 'Lista os horários livres para consulta, já respeitando a agenda do médico '
      + 'e o prazo mínimo da clínica. Use antes de oferecer qualquer horário ao paciente — '
      + 'nunca invente data ou hora.',
    inputSchema: {
      type: 'object',
      properties: {
        dias: { type: 'number', description: 'Quantos dias à frente procurar. Padrão 7.' },
      },
    },
  },
  {
    name: 'agendar',
    description: 'Marca a consulta no horário escolhido pelo paciente. Use apenas com um '
      + 'horário devolvido por consultar_horarios, e só depois de a pessoa confirmar '
      + 'que aquele horário serve.',
    inputSchema: {
      type: 'object',
      properties: {
        telefone: { type: 'string', description: 'Telefone do paciente, com DDD.' },
        nome: { type: 'string', description: 'Nome do paciente.' },
        inicio: { type: 'string', description: 'O campo "inicio" do horário escolhido.' },
        fim: { type: 'string', description: 'O campo "fim" do mesmo horário.' },
      },
      required: ['telefone', 'inicio', 'fim'],
    },
  },
  {
    name: 'registrar_contato',
    description: 'Registra ou atualiza o paciente no CRM. Use assim que souber o nome dele.',
    inputSchema: {
      type: 'object',
      properties: {
        telefone: { type: 'string' },
        nome: { type: 'string' },
      },
      required: ['telefone'],
    },
  },
  {
    name: 'qualificar_lead',
    description: 'Guarda o que a conversa revelou: o que a pessoa procura, se é primeira '
      + 'consulta, preferência de horário. Só informação comercial — nada clínico.',
    inputSchema: {
      type: 'object',
      properties: {
        telefone: { type: 'string' },
        qualificacao: {
          type: 'object',
          description: 'O que a conversa revelou: interesse, primeira_consulta, '
            + 'disponibilidade, pagamento, urgencia.',
          // Aberto de propósito. Um esquema fechado recusava a chamada inteira
          // quando a Serena mandava um campo a mais — e a qualificação se perdia
          // por causa de um dado extra, não de um dado errado. O CRM já ignora
          // o que não reconhece, então filtrar aqui só criava atrito.
          additionalProperties: true,
        },
      },
      required: ['telefone'],
    },
  },
];

/** Chama o CRM. É lá que as regras moram; aqui só se transporta. */
async function chamarCrm(acao, argumentos) {
  const resposta = await fetch(`${BASE}/api/agente/acao`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agente-token': TOKEN },
    body: JSON.stringify({ acao, ...argumentos }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const texto = await resposta.text();
  if (!resposta.ok) {
    // A mensagem do CRM volta inteira: "esse horário acabou de ser ocupado" é o
    // que a Serena precisa dizer ao paciente, e trocá-la por "erro 409" a
    // obrigaria a inventar uma explicação.
    let motivo = texto;
    try { motivo = JSON.parse(texto).erro ?? texto; } catch { /* texto puro */ }
    throw new Error(motivo);
  }

  return texto;
}

// ------------------------------------------------------------------ protocolo

function responder(id, resultado) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: resultado })}\n`);
}

function responderErro(id, mensagem) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: mensagem } })}\n`);
}

async function tratar(pedido) {
  const { id, method, params } = pedido;

  if (method === 'initialize') {
    return responder(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'crmclinica', version: '1.0.0' },
    });
  }

  if (method === 'tools/list') return responder(id, { tools: FERRAMENTAS });

  if (method === 'tools/call') {
    const nome = params?.name;
    if (!FERRAMENTAS.some((f) => f.name === nome)) {
      return responderErro(id, `ferramenta desconhecida: ${nome}`);
    }

    try {
      const saida = await chamarCrm(nome, params?.arguments ?? {});
      return responder(id, { content: [{ type: 'text', text: saida }] });
    } catch (erro) {
      // Erro como conteúdo, não como falha do protocolo: assim a Serena lê o
      // motivo e responde ao paciente, em vez de a chamada sumir sem explicação.
      return responder(id, {
        content: [{ type: 'text', text: `não foi possível: ${erro.message}` }],
        isError: true,
      });
    }
  }

  // Notificação (sem id) não espera resposta; método desconhecido, sim.
  if (id !== undefined) responderErro(id, `método não suportado: ${method}`);
  return undefined;
}

let acumulado = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (pedaco) => {
  acumulado += pedaco;

  // Uma mensagem por linha. Processar por pedaço quebraria um JSON partido no
  // meio pela rede, e o servidor morreria na primeira mensagem grande.
  let quebra = acumulado.indexOf('\n');
  while (quebra !== -1) {
    const linha = acumulado.slice(0, quebra).trim();
    acumulado = acumulado.slice(quebra + 1);

    if (linha) {
      try {
        tratar(JSON.parse(linha));
      } catch {
        // Linha ilegível não derruba o servidor: o OpenClaw reenvia, e cair aqui
        // deixaria a Serena sem ferramenta nenhuma pelo resto da conversa.
      }
    }
    quebra = acumulado.indexOf('\n');
  }
});
