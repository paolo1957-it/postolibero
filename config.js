/*
 * PostoLibero – configurazione
 * Modifica questo file per attivare le segnalazioni condivise e le fonti open data.
 */
window.POSTOLIBERO_CONFIG = {
  // Raggio di ricerca iniziale in metri (modificabile anche dall'app)
  raggioMetri: 1000,

  // Ricarica i dati quando ti sposti di più di questi metri
  ricaricaDopoMetri: 200,

  // Server Overpass (OpenStreetMap). Se il primo non risponde si prova il successivo.
  overpass: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  ],

  // Segnalazioni degli utenti (crowdsourcing).
  // Crea un progetto gratuito su https://supabase.com, esegui supabase.sql
  // e incolla qui URL e "anon public key" (Project Settings → API).
  // Se lasci vuoto, le segnalazioni restano solo su questo dispositivo.
  supabase: {
    url: "",       // es. "https://abcdefgh.supabase.co"
    anonKey: ""    // es. "eyJhbGciOi..."
  },

  // Dopo quanti minuti una segnalazione non viene più mostrata
  durataSegnalazioneMinuti: 20,

  // Fonti open data con posti liberi in tempo reale.
  // type "opendatasoft": portali Opendatasoft (usati da molti comuni).
  // I nomi dei campi vengono riconosciuti automaticamente; se il comune usa nomi
  // diversi, indicali in "campi".
  openData: [
    {
      nome: "Comune di Bologna",
      type: "opendatasoft",
      attivo: true,
      // Il dataset viene interrogato solo se sei entro questa distanza (km) dal centro città
      centro: [44.4949, 11.3426],
      entroKm: 15,
      url: "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/disponibilita-parcheggi-vigente/records?limit=100",
      campi: {
        // nome: "parcheggio", liberi: "posti_liberi", totali: "posti_totali",
        // posizione: "coordinate", aggiornato: "data"
      }
    }
    // Aggiungi qui altre città, ad esempio:
    // {
    //   nome: "Mia Città", type: "json", attivo: true,
    //   centro: [lat, lon], entroKm: 15,
    //   url: "https://.../parcheggi.json",
    //   campi: { nome: "name", liberi: "free", totali: "total", lat: "lat", lon: "lon", aggiornato: "updated" }
    // }
  ]
};
