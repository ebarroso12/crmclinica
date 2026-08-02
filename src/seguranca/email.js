'use strict';

const net = require('node:net');
const tls = require('node:tls');

// Envio de e-mail para recuperação de senha.
//
// Cliente SMTP mínimo sobre `net`/`tls`, sem dependência. Faz o necessário e nada
// além: EHLO, STARTTLS quando preciso, AUTH LOGIN e uma mensagem de texto.
//
// Sem SMTP configurado, o remetente registra em log em vez de enviar. A rota de
// recuperação responde igual nos dois casos — quem pede a recuperação nunca fica
// sabendo se o e-mail existe, nem se o envio funcionou.

function lerResposta(socket, esperado) {
  return new Promise((resolver, rejeitar) => {
    let acumulado = '';

    const aoReceber = (pedaco) => {
      acumulado += pedaco.toString('utf8');
      // Última linha da resposta SMTP vem como "250 texto"; as intermediárias, "250-texto".
      if (!/^\d{3} [^\n]*\r?\n$/m.test(acumulado.split(/\r?\n/).filter(Boolean).pop() + '\n')) return;

      socket.removeListener('data', aoReceber);
      socket.removeListener('error', aoFalhar);

      const codigo = Number(acumulado.slice(0, 3));
      if (esperado && !esperado.includes(codigo)) {
        rejeitar(new Error(`SMTP respondeu ${codigo}: ${acumulado.trim().slice(0, 120)}`));
        return;
      }
      resolver(acumulado);
    };

    const aoFalhar = (erro) => {
      socket.removeListener('data', aoReceber);
      rejeitar(erro);
    };

    socket.on('data', aoReceber);
    socket.once('error', aoFalhar);
  });
}

function escrever(socket, comando) {
  socket.write(`${comando}\r\n`);
}

/** Escapa cabeçalhos: quebra de linha em assunto ou destinatário permite injeção. */
function limparCabecalho(valor) {
  return String(valor).replace(/[\r\n]+/g, ' ').trim();
}

async function enviarPorSmtp(configuracao, mensagem) {
  const { host, porta, usuario, senha, seguro, remetente } = configuracao;

  const socket = seguro
    ? tls.connect({ host, port: porta, servername: host })
    : net.connect({ host, port: porta });

  socket.setTimeout(15000);
  socket.on('timeout', () => socket.destroy(new Error('tempo esgotado no SMTP')));

  try {
    await new Promise((resolver, rejeitar) => {
      socket.once(seguro ? 'secureConnect' : 'connect', resolver);
      socket.once('error', rejeitar);
    });
    await lerResposta(socket, [220]);

    escrever(socket, 'EHLO crmclinica');
    const saudacao = await lerResposta(socket, [250]);

    let canal = socket;
    if (!seguro && /STARTTLS/i.test(saudacao)) {
      escrever(socket, 'STARTTLS');
      await lerResposta(socket, [220]);

      canal = tls.connect({ socket, servername: host });
      await new Promise((resolver, rejeitar) => {
        canal.once('secureConnect', resolver);
        canal.once('error', rejeitar);
      });
      escrever(canal, 'EHLO crmclinica');
      await lerResposta(canal, [250]);
    }

    if (usuario && senha) {
      escrever(canal, 'AUTH LOGIN');
      await lerResposta(canal, [334]);
      escrever(canal, Buffer.from(usuario, 'utf8').toString('base64'));
      await lerResposta(canal, [334]);
      escrever(canal, Buffer.from(senha, 'utf8').toString('base64'));
      await lerResposta(canal, [235]);
    }

    escrever(canal, `MAIL FROM:<${limparCabecalho(remetente)}>`);
    await lerResposta(canal, [250]);
    escrever(canal, `RCPT TO:<${limparCabecalho(mensagem.para)}>`);
    await lerResposta(canal, [250, 251]);

    escrever(canal, 'DATA');
    await lerResposta(canal, [354]);

    const corpo = [
      `From: crmclinica <${limparCabecalho(remetente)}>`,
      `To: <${limparCabecalho(mensagem.para)}>`,
      `Subject: ${limparCabecalho(mensagem.assunto)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      // Linha que começa com ponto encerraria o DATA: o protocolo manda duplicar.
      mensagem.texto.replace(/^\./gm, '..'),
      '.',
    ].join('\r\n');

    canal.write(`${corpo}\r\n`);
    await lerResposta(canal, [250]);

    escrever(canal, 'QUIT');
    canal.end();

    return { enviado: true, via: 'smtp' };
  } finally {
    socket.destroy();
  }
}

/**
 * Cria o remetente de e-mail.
 * Sem SMTP configurado, registra em log — o que mantém o fluxo utilizável em
 * desenvolvimento sem simular sucesso de entrega.
 */
function criarRemetente(configuracao = {}, dependencias = {}) {
  const registrar = dependencias.registrar || console.log;
  const enviar = dependencias.enviarPorSmtp || enviarPorSmtp;
  const disponivel = Boolean(configuracao.host && configuracao.remetente);

  return {
    disponivel,

    async enviar(mensagem) {
      if (!disponivel) {
        registrar(
          `[crmclinica] SMTP não configurado — e-mail para ${mensagem.para} não foi enviado: ${mensagem.assunto}`,
        );
        return { enviado: false, via: 'log', motivo: 'smtp_nao_configurado' };
      }

      try {
        return await enviar(configuracao, mensagem);
      } catch (erro) {
        // Falha de entrega não pode derrubar o pedido de recuperação nem revelar
        // ao solicitante o que aconteceu do lado de dentro.
        registrar(`[crmclinica] falha ao enviar e-mail: ${erro.message}`);
        return { enviado: false, via: 'smtp', motivo: 'falha_no_envio' };
      }
    },
  };
}

module.exports = { criarRemetente, enviarPorSmtp, limparCabecalho };
