# PostoLibero

Web app per il telefono che mostra dove parcheggiare entro 1 km dalla tua posizione (raggio regolabile a 500 m o 2 km).

## Cosa mostra

| Fonte | Cosa dice | Aggiornamento |
|---|---|---|
| **Open data comunali** | Posti liberi *adesso* nei parcheggi a sbarra (es. Bologna) | ogni 3 min |
| **Segnalazioni utenti** | "Posto libero qui" / "Ho parcheggiato" inviati da chi usa l'app | ogni minuto, scadono dopo 20 min |
| **OpenStreetMap** | Parcheggi, garage, stalli e strade con sosta, con capienza, tariffa e posti disabili | alla partenza e quando ti sposti di 200 m |

L'elenco mette prima i posti sicuramente liberi (segnalati o in tempo reale), poi le aree di sosta ordinate per distanza. Ogni voce ha il link "Portami qui" per il navigatore.

## Pubblicarla (gratis, 5 minuti)

Il GPS del browser funziona solo su **HTTPS**, quindi l'app va messa online:

1. **Netlify Drop**: vai su https://app.netlify.com/drop e trascina la cartella `postolibero`. Ottieni subito un indirizzo https.
2. Oppure **GitHub Pages**: crea un repository, carica i file, poi Settings → Pages → Deploy from branch.

Apri l'indirizzo dal telefono, consenti la posizione e scegli "Aggiungi a schermata Home" per usarla come un'app.

Per provarla sul computer: `python3 -m http.server` nella cartella e apri http://localhost:8000.

## Attivare le segnalazioni condivise

Senza configurazione le segnalazioni restano sul tuo telefono. Per condividerle tra tutti:

1. Crea un progetto gratuito su https://supabase.com
2. SQL Editor → incolla ed esegui `supabase.sql`
3. Project Settings → API: copia **Project URL** e **anon public key** in `config.js` → `supabase`

## Città già configurate

- **Bologna**: posti liberi in tempo reale nei parcheggi comunali.
- **Milano**: parcheggi pubblici e parcheggi di interscambio del Comune (nome e numero di posti, non in tempo reale). File `milano-interscambio.geojson`; i parcheggi pubblici vengono scaricati dal portale del Comune, oppure dal file `milano-parcheggi-pubblici.geojson` se lo carichi nel sito.
- **Pavia**: i dataset pubblicati non hanno coordinate, quindi si usano OpenStreetMap e le segnalazioni.

## Parcheggi salvati nel sito (Pavia, Milano, Varese e Biandronno)

Ogni lunedì GitHub esegue `aggiorna_parcheggi.py` (workflow `.github/workflows/pubblica.yml`), scarica da OpenStreetMap i parcheggi delle zone elencate in `ZONE` e li salva nella cartella `osm/` divisi in tessere. Nelle zone coperte l'app legge da lì; fuori zona interroga i server pubblici. Il workflow pubblica anche il sito a ogni caricamento di file (impostazione Pages: *Source = GitHub Actions*). Per farlo partire subito: Actions → *Pubblica sito e aggiorna parcheggi* → *Run workflow*.

## Aggiungere la tua città

In `config.js` → `openData` aggiungi il dataset del tuo comune. I campi più comuni (`posti_liberi`, `posti_totali`, `coordinate`, `lat`/`lon`…) vengono riconosciuti da soli; altrimenti indica i nomi in `campi`. Il dataset di Bologna è preconfigurato: controlla al primo avvio che i posti compaiano, e se non escono specifica i nomi dei campi.

## File

- `index.html`, `style.css`: interfaccia
- `core.js`: logica (distanze, lettura dati OSM e open data, filtro segnalazioni)
- `segnalazioni.js`: invio e lettura segnalazioni (Supabase o locale)
- `app.js`: mappa, GPS, elenco
- `config.js`: impostazioni e fonti open data
- `milano-interscambio.geojson`: parcheggi di interscambio di Milano
- `aggiorna_parcheggi.py`, `.github/workflows/pubblica.yml`: scaricamento settimanale dei parcheggi e pubblicazione
- `osm/`: parcheggi salvati (creata da GitHub, non toccare)
- `sw.js`, `manifest.webmanifest`, `icon.svg`: installazione come app

## Limiti da sapere

- OpenStreetMap indica *dove* si può parcheggiare, non se c'è posto in quel momento. La copertura degli stalli su strada varia molto da zona a zona.
- Le segnalazioni valgono quanto il numero di persone che usano l'app.
- I server pubblici Overpass e Nominatim hanno limiti d'uso: vanno bene per uso personale; per molti utenti conviene un server proprio.
