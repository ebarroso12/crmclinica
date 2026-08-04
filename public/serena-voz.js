'use strict';

// Cliente mínimo do protocolo Realtime usado pelo projeto livre
// huggingface/speech-to-speech. O CRM cria a URL autorizada; este arquivo só
// transporta PCM16 e nunca guarda áudio.
class SerenaVozCliente {
  constructor({ aoEstado, aoTurno, aoErro } = {}) {
    this.aoEstado = aoEstado || (() => {});
    this.aoTurno = aoTurno || (() => {});
    this.aoErro = aoErro || (() => {});
    this.proximoAudioEm = 0;
  }

  async iniciar(url) {
    if (this.socket) throw new Error('uma sessão de voz já está em andamento');
    this.aoEstado('pedindo_microfone');
    this.fluxo = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.contexto = new AudioContext();
    await this.contexto.resume();

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('não foi possível conectar ao motor de voz')), { once: true });
      socket.addEventListener('message', (evento) => this._receber(evento.data));
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.parar(false);
        this.aoEstado('encerrada');
      });
    });

    const origem = this.contexto.createMediaStreamSource(this.fluxo);
    const processador = this.contexto.createScriptProcessor(4096, 1, 1);
    const mudo = this.contexto.createGain();
    mudo.gain.value = 0;
    processador.onaudioprocess = (evento) => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      const amostras = this._reamostrar(evento.inputBuffer.getChannelData(0), this.contexto.sampleRate, 16000);
      const pcm = new Int16Array(amostras.length);
      for (let i = 0; i < amostras.length; i += 1) {
        const valor = Math.max(-1, Math.min(1, amostras[i]));
        pcm[i] = valor < 0 ? valor * 0x8000 : valor * 0x7fff;
      }
      this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: this._base64(pcm.buffer) }));
    };
    origem.connect(processador);
    processador.connect(mudo);
    mudo.connect(this.contexto.destination);
    this.origem = origem;
    this.processador = processador;
    this.mudo = mudo;
    this.aoEstado('ouvindo');
  }

  async parar(fecharSocket = true) {
    const socket = this.socket;
    this.socket = null;
    if (fecharSocket && socket?.readyState <= WebSocket.OPEN) socket.close(1000, 'encerrada pelo usuário');
    if (this.processador) this.processador.disconnect();
    if (this.origem) this.origem.disconnect();
    if (this.mudo) this.mudo.disconnect();
    for (const faixa of this.fluxo?.getTracks?.() || []) faixa.stop();
    if (this.contexto && this.contexto.state !== 'closed') await this.contexto.close();
    this.processador = null;
    this.origem = null;
    this.mudo = null;
    this.fluxo = null;
    this.contexto = null;
  }

  _receber(bruto) {
    let evento;
    try { evento = JSON.parse(bruto); } catch { return; }
    if (evento.type === 'input_audio_buffer.speech_started') this.aoEstado('falando');
    if (evento.type === 'input_audio_buffer.speech_stopped') this.aoEstado('processando');
    if (evento.type === 'error') this.aoErro(new Error(evento.error?.message || 'falha no motor de voz'));

    if (evento.type === 'conversation.item.input_audio_transcription.completed' && evento.transcript) {
      this.aoTurno('usuario', evento.transcript);
    }
    if (['response.output_audio_transcript.done', 'response.audio_transcript.done'].includes(evento.type)
        && evento.transcript) this.aoTurno('serena', evento.transcript);

    if (['response.output_audio.delta', 'response.audio.delta'].includes(evento.type) && evento.delta) {
      this._tocar(evento.delta);
      this.aoEstado('respondendo');
    }
    if (evento.type === 'response.output_audio.done') this.aoEstado('ouvindo');
  }

  _tocar(base64) {
    if (!this.contexto) return;
    const binario = atob(base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer);
    const buffer = this.contexto.createBuffer(1, pcm.length, 24000);
    const canal = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) canal[i] = pcm[i] / 0x8000;
    const fonte = this.contexto.createBufferSource();
    fonte.buffer = buffer;
    fonte.connect(this.contexto.destination);
    const inicio = Math.max(this.contexto.currentTime + 0.02, this.proximoAudioEm);
    fonte.start(inicio);
    this.proximoAudioEm = inicio + buffer.duration;
  }

  _reamostrar(entrada, origemHz, destinoHz) {
    if (origemHz === destinoHz) return entrada;
    const proporcao = origemHz / destinoHz;
    const saida = new Float32Array(Math.round(entrada.length / proporcao));
    for (let i = 0; i < saida.length; i += 1) {
      const inicio = Math.floor(i * proporcao);
      const fim = Math.min(entrada.length, Math.floor((i + 1) * proporcao));
      let soma = 0;
      for (let j = inicio; j < fim; j += 1) soma += entrada[j];
      saida[i] = soma / Math.max(1, fim - inicio);
    }
    return saida;
  }

  _base64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binario = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binario);
  }
}

window.SerenaVozCliente = SerenaVozCliente;
