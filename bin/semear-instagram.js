#!/usr/bin/env node
'use strict';

// Semeia as regras de palavra-gatilho do Instagram.
//
//   npm run semear-instagram
//
// Por que existe: a integração de Instagram estava recebendo eventos e não
// fazendo nada. Em 05/09, `GET /api/instagram` respondia 15 comentários
// processados, ZERO com gatilho, ZERO respostas públicas e ZERO DMs — porque
// a lista de regras estava vazia. Não era token expirado nem worker parado:
// não havia nada para disparar.
//
// Idempotente: regra que já existe pelo nome é mantida como está. O texto que
// está no ar foi decidido por alguém, e sobrescrevê-lo a cada deploy tiraria da
// equipe o controle que a tela de Instagram existe para dar.
//
// O texto abaixo é ponto de partida, não decreto: a tela de Instagram edita
// tudo — palavras, mensagens e o CTA — sem passar por deploy.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../src/config');
const { criarServicoDeGatilhos } = require('../src/dominio/instagram-gatilhos');
const { GATILHO_TODOS } = require('../src/dominio/texto-normalizado');

// A ordem aqui é a ordem de leitura, não de execução: a regra que responde a
// qualquer comentário é sempre a ÚLTIMA consultada em tempo de execução
// (ver `processarComentario`), independentemente de como foi cadastrada.
const REGRAS = [
  {
    nome: 'Agendamento',
    // Vários termos, separados por vírgula, casados por substring sem acento:
    // "agend" cobre agendar, agendamento, agenda e agendado; "atend" cobre
    // atende, atendimento e atendeu. É o que faz uma regra só cobrir a
    // intenção inteira em vez de uma palavra literal.
    palavraGatilho: 'agend, marcar, marque, marcac, consulta, horario, atend, vaga',
    mensagemPublica: 'Oi! Obrigada pelo contato. Acabei de te chamar no direct '
      + 'para ver o melhor horário para você.',
    mensagemDm: 'Oi! Aqui é a Serena, do consultório do Dr. Edson Barroso. '
      + 'Vi seu comentário sobre agendamento e já queria te ajudar a separar um horário. '
      + 'Para eu adiantar: é a sua primeira consulta com o Dr. Edson? '
      + 'E qual período costuma ser melhor para você, manhã ou tarde?',
    ctaWhatsapp: true,
  },
  {
    nome: 'Todo comentário',
    // Responder só quem digitou a palavra certa deixa o resto sem resposta — e
    // comentário sem resposta é paciente sem resposta. Esta regra atende o que
    // sobrou, com um texto que convida sem prometer nada.
    palavraGatilho: GATILHO_TODOS,
    mensagemPublica: 'Oi! Obrigada por comentar. Se tiver qualquer dúvida sobre o '
      + 'consultório, me chama no direct que eu te respondo por lá.',
    mensagemDm: 'Oi! Aqui é a Serena, do consultório do Dr. Edson Barroso. '
      + 'Vi seu comentário no nosso post e vim me colocar à disposição. '
      + 'Se quiser saber como funciona a consulta ou ver um horário, é só me dizer por aqui.',
    ctaWhatsapp: true,
  },
];

const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const amarelo = (t) => `\x1b[33m${t}\x1b[0m`;

async function main() {
  const configuracao = carregarConfiguracao();
  if (!configuracao.banco.configurado) {
    console.error('CRMCLINICA_DATABASE_URL não está definida.');
    process.exit(1);
  }

  const { criarPool, encerrarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');

  const pool = criarPool(configuracao.banco);
  const repositorio = criarRepositorio(pool);
  const gatilhos = criarServicoDeGatilhos({
    repositorio,
    numeroWhatsapp: configuracao.openclaw.numeroWhatsapp,
  });

  try {
    const existentes = new Set((await gatilhos.listarRegras({})).map((regra) => regra.nome));
    let criadas = 0;

    for (const regra of REGRAS) {
      if (existentes.has(regra.nome)) {
        console.log(amarelo(`"${regra.nome}" já existe — mantida como está.`));
        continue;
      }
      await gatilhos.criarRegra(regra);
      console.log(verde(`"${regra.nome}" criada.`));
      criadas += 1;
    }

    console.log(criadas > 0
      ? verde(`\n${criadas} regra(s) criada(s).`)
      : amarelo('\nNenhuma regra nova.'));

    // O CTA sem número configurado é um botão que não leva a lugar nenhum —
    // dizer isso agora é melhor do que a equipe descobrir pela DM que saiu
    // sem o link.
    if (!configuracao.openclaw.numeroWhatsapp) {
      console.log(amarelo('Atenção: WHATSAPP_BUSINESS_PHONE não está definida — '
        + 'a DM sai sem o link do WhatsApp mesmo com o CTA ligado.'));
    }

    const finais = await gatilhos.listarRegras({ apenasAtivas: true });
    console.log(`\n${finais.length} regra(s) ativa(s): ${finais.map((r) => r.nome).join(', ')}`);
  } finally {
    await encerrarPool();
  }
}

// Só executa quando chamado como script. Importar este arquivo (os testes
// importam REGRAS) não pode disparar conexão com banco nenhum.
if (require.main === module) {
  main().catch((erro) => {
    console.error(`falha ao semear as regras do Instagram: ${erro.message}`);
    process.exit(1);
  });
}

module.exports = { REGRAS };
