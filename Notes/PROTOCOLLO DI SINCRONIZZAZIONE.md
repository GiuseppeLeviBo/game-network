# Sincronizzare al meglio due applicazioni PWA: 10 ms possono essere OK, 100 ms no

Nota pratica: il target sotto 10 ms va inteso come obiettivo raggiungibile quando RTT e jitter lo consentono, non come garanzia su qualunque rete.

## Stato implementazione in Game_Network

Il protocollo e stato implementato come servizio di basso livello separato dal room model:

- `src/clockSync.ts` espone `ClockSyncHost` e `ClockSyncClient`.
- `src/protocol.ts` definisce `sync_req` e `sync_resp`.
- `src/transport.ts` aggiunge il canale logico `sync`.
- `tests/clockSync.test.ts` copre formula NTP, filtro sui campioni a RTT basso e scambio host/client su `FakeTransport`.

Responsabilita SOLID:

- `Transport`: consegna messaggi e non interpreta il tempo.
- `Protocol`: definisce envelope e payload.
- `ClockSync`: stima offset, RTT, drift e clock virtuale.
- `Room`: gestisce host, guest e player.
- `Game`: decide come usare il clock per input, snapshot, countdown ed eventi.

Limite attuale: `sync` e un canale logico multiplexato sullo stesso collegamento fisico di `control` e `realtime`. Una fase successiva potra mappare `sync` su un DataChannel fisico dedicato, unordered e loss-tolerant.

Per stare sotto 10 ms su Internet standard, la strada più concreta è un protocollo **NTP-like/Cristian evoluto** sopra **WebRTC DataChannel**, con stima continua di **offset** e **drift**, più filtro robusto sui campioni con RTT minimo. La formula base da usare è quella classica a quattro timestamp, con offset $\theta = \frac{(t_2-t_1)+(t_3-t_4)}{2}$ e round-trip delay $\delta = (t_4-t_1)-(t_3-t_2)$, perché consente di separare parzialmente offset e ritardo di rete.[^1][^2]

## Idea di protocollo

Usa una topologia **master-client**: una sola applicazione è riferimento temporale, l’altra non cambia brutalmente il clock locale ma mantiene un **clock virtuale sincronizzato** per schedulare eventi applicativi. Su WebRTC conviene usare un DataChannel con messaggi piccoli e frequenti, e scegliere una modalità che riduca buffering e ritrasmissioni, dato che unordered/unreliable si comporta più come UDP e limita il ritardo indotto dal trasporto.[^3][^4][^5][^6]

Messaggi minimi:

- `SYNC_REQ(seq, t1)` inviato dal client.
- `SYNC_RESP(seq, t1, t2, t3)` risposto dal master, con `t2` ricezione e `t3` trasmissione.
- Il client registra `t4` alla ricezione e calcola $\theta$ e $\delta$.[^2][^1]

## Algoritmo pratico

Non usare un singolo scambio, ma una **raffica breve** di campioni, per esempio 16–32 richieste in 1–2 secondi, poi tieni solo i campioni con RTT più basso perché sono i meno contaminati dal jitter; l’algoritmo di Cristian ha infatti errore legato a circa metà RTT e funziona meglio quando il RTT è piccolo e abbastanza simmetrico. Tra i campioni validi, calcola offset stimato con mediana o media troncata, poi aggiorna un modello lineare del clock remoto del tipo $T_{master} \approx a \cdot T_{locale} + b$, dove $b$ è offset e $a$ corregge il drift.[^5][^2][^3]

Schema operativo:

1. Bootstrap con 32 scambi rapidi.
2. Scarta il 70–80% peggiore per RTT.
3. Sui migliori campioni, stima offset con mediana.
4. Aggiorna drift con regressione lineare sugli ultimi 30–120 s.
5. Ripeti mini-burst ogni 2–5 s, più spesso se il jitter cresce.[^3][^5]

## Regole per restare entro 10 ms

La regola chiave è **non sincronizzare l’orologio OS**, ma mantenere un tempo applicativo corretto e pianificare gli eventi con un piccolo anticipo comune, ad esempio 20–50 ms nel futuro del clock virtuale condiviso, così assorbi il jitter residuo. Se il miglior RTT del burst è 12 ms, l’errore teorico da simmetria perfetta è già circa ±6 ms, quindi sotto 10 ms è realistico solo quando il **best RTT** resta abbastanza basso e stabile; se il best RTT sale verso 30–40 ms, il tuo target diventa fragile.[^7][^5][^3]

Accorgimenti utili:

- Usa `performance.now()` o un clock monotono equivalente, non `Date.now()`, per evitare salti dell’orologio di sistema.[^3]
- Timestampa il più vicino possibile a send/receive lato applicazione, con payload piccoli.[^8][^6]
- Applica slewing graduale, mai step improvvisi, così eviti jitter introdotto dal correttore.[^3]
- Se ricevi offset incompatibili con il trend ma con RTT alto, scartali come outlier.[^5]

## Pseudocodice

Lato client, il cuore può essere questo:

```text
ogni ciclo di sync:
  per i in 1..N:
    t1 = mono()
    invia SYNC_REQ(seq=i, t1)
    attendi risposta
    t4 = mono()
    delta = (t4 - t1) - (t3 - t2)
    theta = ((t2 - t1) + (t3 - t4)) / 2
    salva campione(theta, delta, t4)

  prendi i campioni con delta minimo
  theta_hat = mediana(theta dei migliori campioni)
  aggiorna modello:
    remote_time_est = a * local_mono + b
  con b corretto da theta_hat e a corretto lentamente dal drift storico
```

Per schedulare un evento:

```text
target_master_time = now_master + 40 ms
target_local_time  = inverti_modello(target_master_time)
programma evento a target_local_time
```

Le formule NTP restano la base più solida per ricavare offset e delay dai quattro timestamp.[^1][^2]

## Configurazione consigliata

Proposta:

- DataChannel dedicato solo al sync, separato dai dati applicativi, così eviti interferenze di coda.[^6]
- `ordered: false` e trasporto a bassa affidabilità per i pacchetti di sync, perché i campioni vecchi valgono poco e le ritrasmissioni peggiorano il timing.[^4][^6]
- Burst iniziale da 32 campioni, poi 8 campioni ogni 2 s.
- Filtro: tieni il miglior 20–30% per RTT.
- Scheduler eventi con lookahead di 30–50 ms.
- Correzione offset lenta, per esempio max 1 ms per ciclo, salvo re-lock iniziale.[^5][^3]

[^1]: https://zenn.dev/su8/articles/8bec80c3da97df?locale=en
[^2]: https://www.ntp.org/reflib/time/
[^3]: https://arpitbhayani.me/blogs/clock-sync-nightmare/
[^4]: https://stackoverflow.com/questions/54292824/webrtc-channel-reliability
[^5]: https://arxiv.org/html/2404.15467v1
[^6]: https://jameshfisher.com/2017/01/17/webrtc-datachannel-reliability/
[^7]: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels
[^8]: https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
