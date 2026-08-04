# Gateway Serena Voz

Proxy seguro e pequeno entre o navegador do CRM e o servidor Realtime do
[`huggingface/speech-to-speech`](https://github.com/huggingface/speech-to-speech).
Ele valida a sessão, busca o prompt no CRM, filtra eventos e devolve transcrições
assinadas. Não contém modelo e não guarda áudio.

Operação, arquitetura e ativação: [`../../docs/SERENA_VOZ.md`](../../docs/SERENA_VOZ.md).

```bash
python3 -m unittest discover -s testes
uvicorn app.main:app --host 127.0.0.1 --port 8000
```
