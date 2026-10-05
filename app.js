/*
 * PostoLibero – interfaccia: mappa, posizione, caricamento dati, elenco.
 */
(function () {
  "use strict";
  const cfg = window.POSTOLIBERO_CONFIG;
  const $ = (id) => document.getElementById(id);

  const stato = {
    gps: null,          // ultima posizione GPS {lat, lon, acc}
    centro: null,       // punto della ricerca {lat, lon, daGps}
    raggio: cfg.raggioMetri || 1000,
    osm: [], reale: [], segn: [],
    filtri: new Set(),
    caricando: false,
    ultimaSegnalazione: 0,
    seguiGps: true
  };

  // ---------- Mappa ----------
  const mappa = L.map("mappa", { zoomControl: false, attributionControl: true })
    .setView([41.9, 12.5], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(mappa);

  const livelli = {
    raggio: L.layerGroup().addTo(mappa),
    strade: L.layerGroup().addTo(mappa),
    stalli: L.layerGroup(),
    luoghi: L.layerGroup().addTo(mappa),
    segn: L.layerGroup().addTo(mappa),
    io: L.layerGroup().addTo(mappa)
  };
  const markerPerId = new Map();

  function aggiornaVisibilitaStalli() {
    if (mappa.getZoom() >= 17) livelli.stalli.addTo(mappa);
    else livelli.stalli.remove();
  }
  mappa.on("zoomend", aggiornaVisibilitaStalli);
  mappa.on("dragstart", () => { stato.seguiGps = false; });

  const icona = (cls, html) => L.divIcon({ className: "", html: `<div class="mk ${cls}">${html ?? ""}</div>`, iconSize: null });

  // ---------- Utilità UI ----------
  function messaggio(testo, errore) {
    const el = $("stato");
    el.textContent = testo;
    el.classList.toggle("errore", !!errore);
    if (errore && $("pannello").hidden) toast(testo);
  }
  let timerToast;
  function toast(testo) {
    const t = $("toast");
    t.textContent = testo;
    t.hidden = false;
    clearTimeout(timerToast);
    timerToast = setTimeout(() => { t.hidden = true; }, 3200);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const linkNavigazione = (lat, lon) =>
    `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;

  // ---------- Caricamento dati ----------
  const cacheOsm = new Map();

  async function fetchConTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  // Scarica e legge il JSON entro "ms" millisecondi in tutto (risposta + dati).
  // "segnale" esterno opzionale per annullare la richiesta da fuori.
  async function fetchJson(url, opts, ms, segnale) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const annulla = () => ctrl.abort();
    if (segnale) segnale.addEventListener("abort", annulla);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
      if (segnale) segnale.removeEventListener("abort", annulla);
    }
  }

  // Copia di riserva sul telefono: i parcheggi non cambiano spesso, quindi se tutti
  // i server OpenStreetMap sono fuori uso mostriamo l'ultimo risultato salvato per la zona.
  const CHIAVE_RISERVA = "postolibero.osm";
  function leggiRiserva() {
    try { return JSON.parse(localStorage.getItem(CHIAVE_RISERVA) || "[]"); } catch (e) { return []; }
  }
  function salvaRiserva(lat, lon, raggio, json) {
    let lista = leggiRiserva().filter((x) => PL.distanza(x.lat, x.lon, lat, lon) > 300);
    lista.unshift({ lat, lon, raggio, t: Date.now(), json: { elements: json.elements } });
    lista = lista.slice(0, 12);
    // Se la memoria del telefono è piena, toglie le zone più vecchie finché ci sta
    while (lista.length) {
      try { localStorage.setItem(CHIAVE_RISERVA, JSON.stringify(lista)); return; }
      catch (e) { lista.pop(); }
    }
  }
  // Unisce tutte le zone salvate vicine (anche se coprono solo in parte il raggio attuale)
  function cercaRiserva(lat, lon, raggio) {
    const zone = leggiRiserva().filter((x) =>
      PL.distanza(x.lat, x.lon, lat, lon) < x.raggio + raggio &&
      Date.now() - x.t < 30 * 86400000);
    if (!zone.length) return null;
    const visti = new Set(), elementi = [];
    for (const z of zone) {
      for (const el of z.json.elements || []) {
        const id = el.type + el.id;
        if (!visti.has(id)) { visti.add(id); elementi.push(el); }
      }
    }
    return { t: Math.min(...zone.map((z) => z.t)), json: { elements: elementi } };
  }

  // Ordine dei server: prima quello che ha funzionato l'ultima volta
  function serverInOrdine() {
    let ultimo = null;
    try { ultimo = localStorage.getItem("postolibero.overpass"); } catch (e) { /* ignora */ }
    const lista = cfg.overpass.slice();
    const i = lista.indexOf(ultimo);
    if (i > 0) { lista.splice(i, 1); lista.unshift(ultimo); }
    return lista;
  }

  async function caricaOsm(lat, lon, raggio) {
    const chiave = `${lat.toFixed(3)},${lon.toFixed(3)},${raggio}`;
    const c = cacheOsm.get(chiave);
    if (c && Date.now() - c.t < 10 * 60000) return PL.analizzaOverpass(c.json, lat, lon, raggio);
    const query = PL.queryOverpass(lat, lon, raggio + 150);
    const fine = new AbortController();

    // Il server preferito parte subito. Il successivo parte dopo 4 secondi, oppure subito
    // se uno dei server già avviati risponde con un errore. Vince la prima risposta valida.
    const lista = serverInOrdine();
    const prova = async (url) => {
      const json = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
      }, 25000, fine.signal);
      // Un server sovraccarico risponde "200 OK" ma con un errore in "remark" e nessun dato
      if (!json || !Array.isArray(json.elements)) throw new Error("Risposta non valida");
      if (json.remark && /error|timed out|out of memory|rate/i.test(json.remark)) throw new Error(json.remark);
      return { url, json };
    };
    const risultato = new Promise((ok, ko) => {
      let prossimo = 0, inCorso = 0, timer, finito = false;
      const avvia = () => {
        clearTimeout(timer);
        if (finito || prossimo >= lista.length) return;
        const url = lista[prossimo++];
        inCorso++;
        prova(url).then((r) => {
          if (finito) return;
          finito = true; clearTimeout(timer);
          fine.abort(); // ferma le richieste ancora in corso
          ok(r);
        }, (e) => {
          inCorso--;
          if (finito) return;
          console.warn("Overpass", url, e && e.message);
          if (prossimo < lista.length) avvia();
          else if (inCorso === 0) { finito = true; ko(e); }
        });
        if (prossimo < lista.length) timer = setTimeout(avvia, 4000);
      };
      avvia();
    });

    try {
      const { url, json } = await risultato;
      cacheOsm.set(chiave, { t: Date.now(), json });
      salvaRiserva(lat, lon, raggio + 150, json);
      try { localStorage.setItem("postolibero.overpass", url); } catch (e) { /* ignora */ }
      stato.osmDaRiserva = null;
      return PL.analizzaOverpass(json, lat, lon, raggio);
    } catch (e) {
      const riserva = cercaRiserva(lat, lon, raggio);
      if (riserva) {
        stato.osmDaRiserva = riserva.t;
        return PL.analizzaOverpass(riserva.json, lat, lon, raggio);
      }
      throw new Error("OpenStreetMap non raggiungibile");
    }
  }

  function fontiVicine(lat, lon, statiche) {
    return (cfg.openData || []).filter((f) => f.attivo &&
      (f.type === "statico") === statiche &&
      (!f.centro || PL.distanza(lat, lon, f.centro[0], f.centro[1]) <= (f.entroKm || 20) * 1000));
  }

  // Scarica il primo URL che risponde (accetta una stringa o un elenco)
  async function scaricaJson(url) {
    let ultimo;
    for (const u of [].concat(url)) {
      try {
        return await fetchJson(u, {}, 15000);
      } catch (e) { ultimo = e; }
    }
    throw ultimo;
  }

  const fontiAttive = { reale: [], comunali: [] };
  function aggiornaFonti() {
    const parti = [];
    const uniq = (a) => [...new Set(a)];
    if (fontiAttive.reale.length) parti.push("tempo reale: " + uniq(fontiAttive.reale).join(", "));
    if (fontiAttive.comunali.length) parti.push("parcheggi comunali: " + uniq(fontiAttive.comunali).join(", "));
    $("fonti-extra").textContent = parti.length ? ", " + parti.join(", ") : "";
  }

  async function caricaOpenData(lat, lon, raggio) {
    const fonti = fontiVicine(lat, lon, false);
    const risultati = await Promise.allSettled(fonti.map(async (f) =>
      PL.analizzaOpenData(await scaricaJson(f.url), f, lat, lon, raggio)));
    fontiAttive.reale = fonti.filter((_, i) => risultati[i].status === "fulfilled").map((f) => f.nome);
    aggiornaFonti();
    return risultati.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  // I dati comunali statici si scaricano una volta sola per sessione
  const cacheComunali = new Map();
  async function caricaComunali(lat, lon, raggio) {
    const fonti = fontiVicine(lat, lon, true);
    const risultati = await Promise.allSettled(fonti.map(async (f) => {
      const chiave = [].concat(f.url).join("|");
      if (!cacheComunali.has(chiave)) cacheComunali.set(chiave, scaricaJson(f.url));
      try {
        return PL.analizzaStatico(await cacheComunali.get(chiave), f, lat, lon, raggio);
      } catch (e) { cacheComunali.delete(chiave); throw e; }
    }));
    fontiAttive.comunali = fonti.filter((_, i) => risultati[i].status === "fulfilled").map((f) => f.nome);
    aggiornaFonti();
    return risultati.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  // ---------- Suoni ----------
  // Suoni sintetizzati (nessun file da scaricare). Su iPhone il browser li permette solo
  // dopo il primo tocco sullo schermo, quindi l'audio si "sblocca" al primo tocco.
  let audio = null;
  let suoniAttivi = true;
  try { suoniAttivi = localStorage.getItem("postolibero.suoni") !== "0"; } catch (e) { /* ignora */ }
  function sbloccaAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state !== "running") audio.resume();
    } catch (e) { /* audio non disponibile */ }
  }
  document.addEventListener("pointerdown", sbloccaAudio, { passive: true });
  document.addEventListener("touchend", sbloccaAudio, { passive: true });

  // note: elenco di [frequenza Hz, inizio s, durata s]
  function suona(note, volume) {
    if (!suoniAttivi || !audio || document.hidden) return;
    if (audio.state !== "running") { audio.resume().catch(() => {}); if (audio.state !== "running") return; }
    const t0 = audio.currentTime + 0.02;
    for (const [freq, inizio, durata] of note) {
      const osc = audio.createOscillator(), g = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + inizio);
      g.gain.exponentialRampToValueAtTime(volume || 0.35, t0 + inizio + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + inizio + durata);
      osc.connect(g).connect(audio.destination);
      osc.start(t0 + inizio);
      osc.stop(t0 + inizio + durata + 0.05);
    }
  }
  const SUONO = {
    aggiornato: () => suona([[1318.5, 0, 0.6], [2637, 0, 0.25]], 0.3),          // "bing"
    errore: () => suona([[392, 0, 0.25], [311, 0.22, 0.45]], 0.3),             // due note che scendono
    nuovoPosto: () => suona([[784, 0, 0.18], [1046.5, 0.15, 0.18], [1568, 0.3, 0.5]], 0.32) // tre note che salgono
  };

  async function caricaSegnalazioni() {
    if (!stato.centro) return;
    const { lat, lon } = stato.centro;
    try {
      const lista = await Segnalazioni.carica(lat, lon, stato.raggio, cfg.durataSegnalazioneMinuti);
      stato.segn = PL.filtraSegnalazioni(lista, lat, lon, stato.raggio, cfg.durataSegnalazioneMinuti);
      // Suono quando compare un posto libero nuovo segnalato da qualcun altro
      const visti = stato.segnViste || (stato.segnViste = new Set());
      const primaVolta = !stato.segnCaricate;
      let nuovo = false;
      for (const x of stato.segn) {
        const id = String(x.id);
        if (visti.has(id)) continue;
        visti.add(id);
        const mia = stato.miaSegnalazione &&
          PL.distanza(x.lat, x.lon, stato.miaSegnalazione.lat, stato.miaSegnalazione.lon) < 20 &&
          Math.abs(x.ts - stato.miaSegnalazione.t) < 120000;
        if (!primaVolta && x.stato === "libero" && !mia) nuovo = true;
      }
      stato.segnCaricate = true;
      if (nuovo) { SUONO.nuovoPosto(); stato.suonoNuovo = Date.now(); }
    } catch (e) {
      console.warn(e);
    }
  }

  let giroCarica = 0;
  async function carica(forza) {
    if (!stato.centro) return;
    const giro = ++giroCarica; // se parte un nuovo caricamento, quello vecchio non aggiorna più la schermata
    stato.caricando = true;
    $("btn-aggiorna").classList.add("gira");
    const { lat, lon } = stato.centro;
    if (forza) cacheOsm.clear();
    messaggio("Cerco parcheggi entro " + PL.formattaDistanza(stato.raggio) + "…");

    let osmLista = null, comunaliLista = [];
    const aggiornaOsm = () => {
      if (giro !== giroCarica) return;
      stato.osm = PL.unisciStatici(osmLista || [], comunaliLista);
      render();
    };

    const pOsm = caricaOsm(lat, lon, stato.raggio).then((l) => { osmLista = l; aggiornaOsm(); });
    const pCom = caricaComunali(lat, lon, stato.raggio).then((l) => { comunaliLista = l; aggiornaOsm(); });
    const pReale = caricaOpenData(lat, lon, stato.raggio).then((l) => {
      if (giro === giroCarica) { stato.reale = l; render(); }
    });
    const pSegn = caricaSegnalazioni().then(() => { if (giro === giroCarica) render(); });

    const [osm] = await Promise.allSettled([pOsm, pCom, pReale, pSegn]);
    if (giro !== giroCarica) return;
    stato.caricando = false;
    $("btn-aggiorna").classList.remove("gira");
    aggiornaOsm();

    const ora = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    clearTimeout(stato.timerRiprova);
    if (osm.status === "rejected" || stato.osmDaRiserva) {
      // Riprova da sola: dopo 30 s, poi 1 min, poi 2 min, poi ogni 5 min
      const attese = [30, 60, 120, 300];
      const sec = attese[Math.min(stato.tentativiOsm || 0, attese.length - 1)];
      stato.tentativiOsm = (stato.tentativiOsm || 0) + 1;
      stato.timerRiprova = setTimeout(() => carica(true), sec * 1000);
    } else {
      stato.tentativiOsm = 0;
    }
    // Suono di fine aggiornamento (non se è appena suonato quello del nuovo posto libero)
    if (Date.now() - (stato.suonoNuovo || 0) > 3000) {
      (osm.status === "rejected" || stato.osmDaRiserva) ? SUONO.errore() : SUONO.aggiornato();
    }
    const riprovo = (s) => s >= 60 ? `tra ${s / 60} min` : `tra ${s} secondi`;
    const prossima = [30, 60, 120, 300][Math.min((stato.tentativiOsm || 1) - 1, 3)];
    if (osm.status === "rejected") {
      messaggio(`I server di OpenStreetMap sono sovraccarichi. Riprovo da solo ${riprovo(prossima)}.`, true);
    } else if (stato.osmDaRiserva) {
      const quando = new Date(stato.osmDaRiserva).toLocaleDateString("it-IT", { day: "numeric", month: "long" });
      messaggio(`OpenStreetMap non risponde: mostro i parcheggi salvati il ${quando}. Riprovo ${riprovo(prossima)}.`, true);
    } else {
      const dove = stato.centro.daGps ? "dalla tua posizione" : "dal punto cercato";
      messaggio(`Entro ${PL.formattaDistanza(stato.raggio)} ${dove} · aggiornato alle ${ora}` +
        (Segnalazioni.condiviso ? "" : " · segnalazioni solo su questo dispositivo"));
    }
  }

  // ---------- Rendering ----------
  function passaFiltri(l) {
    const f = stato.filtri;
    if (f.has("gratuito") && l.tariffa !== "gratuito") return false;
    if (f.has("disabili") && !(l.disabili > 0)) return false;
    if (f.has("coperto") && !l.coperto) return false;
    if (f.has("strada") && l.categoria !== "strada" && l.categoria !== "stallo") return false;
    return true;
  }

  // Colore del segnaposto: verde = posti liberi ora, blu = meno di 4 posti,
  // grigio = 4 posti o più (o numero di posti non indicato), rosso = pieno
  function coloreLuogo(l) {
    if (l.fonte === "opendata") return l.liberi > 0 ? "verde" : "pieno";
    if (l.capienza != null && l.capienza < 4) return "blu";
    return "grigio";
  }

  // Testi per la lettura vocale
  function distanzaParlata(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " metri";
    return (m / 1000).toFixed(1).replace(".", ",") + " chilometri";
  }
  function minutiParlati(m) {
    const n = PL.minutiA_piedi(m);
    return n === 1 ? "1 minuto a piedi" : n + " minuti a piedi";
  }
  const attr = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const OPZ_POPUP = { maxWidth: 360, minWidth: 260, autoPanPadding: [16, 90] };

  function popupLuogo(l) {
    const righe = [], voce = [];
    const titolo = l.nome || l.via || l.tipo;
    voce.push(titolo + ".");
    if (l.tipo && l.tipo !== titolo) voce.push(l.tipo + ".");
    if (l.fonte === "opendata") {
      righe.push(`<b style="color:var(--libero)">${l.liberi} posti liberi</b>${l.capienza ? " su " + l.capienza : ""}`);
      voce.push(l.liberi > 0 ? `${l.liberi} posti liberi${l.capienza ? " su " + l.capienza : ""}.` : "Pieno.");
      if (l.aggiornato) righe.push("Dato del " + esc(new Date(l.aggiornato).toLocaleString("it-IT")));
      righe.push("Fonte: " + esc(l.fonteNome));
    } else {
      if (l.capienza) {
        righe.push((l.capienzaStimata ? "circa " : "") + l.capienza + " posti");
        voce.push((l.capienzaStimata ? "Circa " : "") + l.capienza + (l.capienza === 1 ? " posto." : " posti."));
      }
      if (l.tariffa === "gratuito") { righe.push("Gratuito"); voce.push("Gratuito."); }
      else if (l.tariffa === "pagamento") { righe.push("A pagamento"); voce.push("A pagamento."); }
      if (l.disabili) { righe.push(l.disabili + " posti disabili"); voce.push(l.disabili + " posti per disabili."); }
      if (l.maxstay) righe.push("Sosta max: " + esc(l.maxstay));
      if (l.orari) righe.push("Orari: " + esc(l.orari));
      if (l.note) righe.push(esc(l.note));
      if (l.fonteNome) righe.push("Fonte: " + esc(l.fonteNome));
    }
    righe.push(PL.formattaDistanza(l.distanza) + " · " + PL.minutiA_piedi(l.distanza) + " min a piedi");
    voce.push(distanzaParlata(l.distanza) + ", " + minutiParlati(l.distanza) + ".");
    return `<div class="pop" data-voce="${attr(voce.join(" "))}"><h3>${esc(titolo)}</h3>
      <p>${esc(l.tipo)}</p>${righe.map((r) => "<p>" + r + "</p>").join("")}
      <a class="pop-vai" href="${linkNavigazione(l.lat, l.lon)}" target="_blank" rel="noopener">Portami qui</a></div>`;
  }

  function render() {
    Object.entries(livelli).forEach(([k, g]) => { if (k !== "io") g.clearLayers(); });
    markerPerId.clear();
    if (!stato.centro) return;
    const { lat, lon } = stato.centro;

    L.circle([lat, lon], {
      radius: stato.raggio, color: getComputedStyle(document.documentElement).getPropertyValue("--blu").trim() || "#1b4f9c",
      weight: 1.5, opacity: .6, fillOpacity: .04, dashArray: "6 6", interactive: false
    }).addTo(livelli.raggio);
    if (!stato.centro.daGps) {
      L.circleMarker([lat, lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#172033", fillOpacity: 1 }).addTo(livelli.io);
    }

    const osm = stato.osm.filter(passaFiltri);
    const reale = stato.reale.filter(passaFiltri);
    const segnVisibili = stato.filtri.size ? [] : stato.segn;

    // Strade con sosta
    for (const l of osm.filter((x) => x.categoria === "strada")) {
      const linea = L.polyline(l.geom.map((p) => [p.lat, p.lon]), { color: "#1b4f9c", weight: 6, opacity: .55 })
        .bindPopup(popupLuogo(l), OPZ_POPUP).addTo(livelli.strade);
      markerPerId.set(l.id, linea);
    }
    // Stalli singoli (visibili da zoom 17)
    for (const l of osm.filter((x) => x.categoria === "stallo")) {
      const m = L.marker([l.lat, l.lon], { icon: icona("stallo " + coloreLuogo(l)) })
        .bindPopup(popupLuogo(l), OPZ_POPUP).addTo(livelli.stalli);
      markerPerId.set(l.id, m);
    }
    aggiornaVisibilitaStalli();
    // Parcheggi
    for (const l of osm.filter((x) => x.categoria === "parcheggio")) {
      const m = L.marker([l.lat, l.lon], { icon: icona(coloreLuogo(l), "P"), title: l.nome || l.tipo })
        .bindPopup(popupLuogo(l), OPZ_POPUP).addTo(livelli.luoghi);
      markerPerId.set(l.id, m);
    }
    // Tempo reale
    for (const l of reale) {
      const s = PL.statoDisponibilita(l.liberi, l.capienza);
      const m = L.marker([l.lat, l.lon], { icon: icona("reale " + coloreLuogo(l), l.liberi), zIndexOffset: 500, title: l.nome })
        .bindPopup(popupLuogo(l), OPZ_POPUP).addTo(livelli.luoghi);
      markerPerId.set(l.id, m);
    }
    // Segnalazioni
    for (const s of segnVisibili) {
      // Accanto al pallino verde: da quanti minuti è stato segnalato
      const etichetta = s.stato === "libero"
        ? `<span class="segn-eta">${s.eta < 1 ? "ora" : s.eta + " min"}</span>` : "";
      const m = L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: "", iconSize: null,
          html: `<div class="segn-box"><div class="mk segn ${s.stato}"></div>${etichetta}</div>` }),
        opacity: s.freschezza, zIndexOffset: 800
      }).bindPopup(`<div class="pop" data-voce="${attr((s.stato === "libero" ? "Posto segnalato libero, " : "Posto appena occupato, ") +
            (s.eta < 1 ? "adesso" : s.eta === 1 ? "1 minuto fa" : s.eta + " minuti fa") + ". " + distanzaParlata(s.distanza) + ".")}">
          <h3>${s.stato === "libero" ? "Posto segnalato libero" : "Posto appena occupato"}</h3>
          <p>${PL.formattaEta(s.eta)} · ${PL.formattaDistanza(s.distanza)}</p>
          ${s.stato === "libero" ? `<a class="pop-vai" href="${linkNavigazione(s.lat, s.lon)}" target="_blank" rel="noopener">Portami qui</a>` : ""}</div>`, OPZ_POPUP)
        .addTo(livelli.segn);
      markerPerId.set("segn/" + s.id, m);
    }

    // KPI
    $("k-reale").textContent = stato.reale.length ? stato.reale.reduce((t, l) => t + (l.liberi || 0), 0) : "n/d";
    $("k-segn").textContent = stato.segn.filter((s) => s.stato === "libero").length;
    const certi = stato.segn.filter((s) => s.stato === "libero").length + stato.reale.filter((l) => l.liberi > 0).length;
    $("badge-elenco").textContent = certi > 99 ? "99+" : String(certi);
    $("badge-elenco").hidden = certi === 0;
    $("k-osm").textContent = stato.osm.filter((l) => l.categoria === "parcheggio" || l.categoria === "strada").length;

    renderLista(osm, reale, segnVisibili);
  }

  function voce(l, opts) {
    const li = document.createElement("li");
    li.className = "voce";
    li.tabIndex = 0;
    li.innerHTML = `
      <div class="icona ${opts.classe}">${opts.icona}</div>
      <div class="voce-testo">
        <div class="voce-titolo">${esc(opts.titolo)}</div>
        <div class="voce-meta">${opts.meta.join("")}</div>
      </div>
      <div class="voce-dist"><b>${PL.formattaDistanza(l.distanza)}</b><small>${PL.minutiA_piedi(l.distanza)} min a piedi</small></div>`;
    const apri = () => {
      const m = markerPerId.get(opts.id);
      stato.seguiGps = false;
      mappa.setView([l.lat, l.lon], Math.max(mappa.getZoom(), 17));
      if (m) setTimeout(() => m.openPopup(), 250);
      chiudiElenco();
    };
    li.addEventListener("click", apri);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apri(); } });
    return li;
  }

  function renderLista(osm, reale, segn) {
    const ol = $("lista");
    ol.innerHTML = "";
    const voci = [];

    for (const s of segn.filter((x) => x.stato === "libero")) {
      voci.push({ p: 0, d: s.distanza, el: voce(s, {
        id: "segn/" + s.id, classe: "segnalato", icona: "",
        titolo: "Posto libero segnalato",
        meta: [`<span class="tag reale">${PL.formattaEta(s.eta)}</span>`]
      }) });
    }
    for (const l of reale) {
      const st = PL.statoDisponibilita(l.liberi, l.capienza);
      voci.push({ p: st === "pieno" ? 2 : 0, d: l.distanza, el: voce(l, {
        id: l.id, classe: coloreLuogo(l), icona: `<span class="num">${l.liberi}</span>`,
        titolo: l.nome,
        meta: [`<span class="tag ${st === "pieno" ? "pieno" : "reale"}">${st === "pieno" ? "Pieno" : l.liberi + " liberi ora"}</span>`,
          l.capienza ? `<span>${l.capienza} posti</span>` : ""]
      }) });
    }
    const mostraStalli = stato.filtri.has("disabili") || stato.filtri.has("strada");
    for (const l of osm) {
      if (l.categoria === "ingresso") continue;
      if (l.categoria === "stallo" && !mostraStalli) continue;
      const meta = [`<span>${esc(l.tipo)}</span>`];
      if (l.capienza) meta.push(`<span>${l.capienzaStimata ? "~" : ""}${l.capienza} posti</span>`);
      if (l.tariffa === "gratuito") meta.push('<span class="tag gratis">Gratuito</span>');
      else if (l.tariffa === "pagamento") meta.push("<span>A pagamento</span>");
      if (l.disabili) meta.push(`<span>♿ ${l.disabili}</span>`);
      voci.push({ p: 1, d: l.distanza, el: voce(l, {
        id: l.id, classe: coloreLuogo(l),
        icona: "P", titolo: l.nome || l.via || (l.categoria === "strada" ? "Sosta su strada" : l.tipo), meta
      }) });
    }

    voci.sort((a, b) => a.p - b.p || a.d - b.d);
    if (!voci.length) {
      const li = document.createElement("li");
      li.className = "vuoto";
      li.textContent = stato.filtri.size
        ? "Nessun risultato con questi filtri. Prova a toglierne uno o ad allargare il raggio."
        : "Nessuna area di sosta mappata qui. Prova ad allargare il raggio.";
      ol.appendChild(li);
      return;
    }
    voci.slice(0, 150).forEach((v) => ol.appendChild(v.el));
  }

  // ---------- Posizione ----------
  let marcatoreIo, cerchioPrecisione;

  function impostaCentro(lat, lon, daGps) {
    const prima = stato.centro;
    stato.centro = { lat, lon, daGps };
    const spostato = !prima || prima.daGps !== daGps ||
      PL.distanza(prima.lat, prima.lon, lat, lon) > (cfg.ricaricaDopoMetri || 200);
    if (spostato) {
      mappa.fitBounds(L.latLng(lat, lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  }

  function suPosizione(p) {
    const { latitude: lat, longitude: lon, accuracy: acc } = p.coords;
    stato.gps = { lat, lon, acc };
    if (!marcatoreIo) {
      marcatoreIo = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="io"></div>', iconSize: [18, 18] }), zIndexOffset: 1000, interactive: false }).addTo(livelli.io);
      cerchioPrecisione = L.circle([lat, lon], { radius: acc, color: "#2f7cf6", weight: 0, fillOpacity: .12, interactive: false }).addTo(livelli.io);
    } else {
      marcatoreIo.setLatLng([lat, lon]);
      cerchioPrecisione.setLatLng([lat, lon]).setRadius(acc);
    }
    $("btn-libero").disabled = false;
    $("btn-parcheggiato").disabled = false;
    if (stato.seguiGps) impostaCentro(lat, lon, true);
  }

  function erroreGps(e) {
    const testi = {
      1: "Posizione non autorizzata. Consenti l'accesso alla posizione oppure cerca un indirizzo.",
      2: "Posizione non disponibile. Cerca un indirizzo qui sopra.",
      3: "Il GPS non risponde. Cerca un indirizzo qui sopra."
    };
    if (!stato.gps) messaggio(testi[e.code] || testi[2], true);
  }

  function avviaGps() {
    if (!("geolocation" in navigator)) {
      messaggio("Questo browser non fornisce la posizione. Cerca un indirizzo qui sopra.", true);
      return;
    }
    if (!window.isSecureContext) {
      messaggio("Il GPS funziona solo su HTTPS. Pubblica l'app su un sito https o cerca un indirizzo.", true);
    }
    navigator.geolocation.watchPosition(suPosizione, erroreGps, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }

  // ---------- Ricerca indirizzo ----------
  $("form-cerca").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("cerca-indirizzo").value.trim();
    if (!q) return;
    messaggio("Cerco “" + q + "”…");
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=it&q=" + encodeURIComponent(q);
      const [primo] = await fetchJson(url, { headers: { Accept: "application/json" } }, 12000);
      if (!primo) { messaggio("Indirizzo non trovato. Prova ad aggiungere la città.", true); return; }
      stato.seguiGps = false;
      $("cerca-indirizzo").blur();
      impostaCentro(+primo.lat, +primo.lon, false);
    } catch (err) {
      messaggio("Ricerca non riuscita. Controlla la connessione.", true);
    }
  });

  // ---------- Segnalazioni ----------
  async function segnala(tipo) {
    if (!stato.gps) { toast("Serve la tua posizione GPS per segnalare."); return; }
    if (stato.gps.acc > 60) { toast("Posizione poco precisa (±" + Math.round(stato.gps.acc) + " m). Riprova all'aperto."); return; }
    if (Date.now() - stato.ultimaSegnalazione < 30000) { toast("Hai appena segnalato. Attendi qualche secondo."); return; }
    try {
      stato.miaSegnalazione = { lat: stato.gps.lat, lon: stato.gps.lon, t: Date.now() };
      await Segnalazioni.invia(stato.gps.lat, stato.gps.lon, tipo);
      stato.ultimaSegnalazione = Date.now();
      toast(tipo === "libero" ? "Grazie! Posto libero segnalato." : "Segnato come occupato. Buona sosta!");
      await caricaSegnalazioni();
      render();
    } catch (e) {
      toast("Invio non riuscito. Riprova.");
    }
  }
  $("btn-libero").addEventListener("click", () => segnala("libero"));
  $("btn-parcheggiato").addEventListener("click", () => segnala("occupato"));

  // ---------- Controlli ----------
  $("btn-centra").addEventListener("click", () => {
    stato.seguiGps = true;
    if (stato.gps) impostaCentro(stato.gps.lat, stato.gps.lon, true);
    if (stato.gps) mappa.setView([stato.gps.lat, stato.gps.lon], 16);
    else toast("Posizione non ancora disponibile.");
  });
  $("btn-aggiorna").addEventListener("click", () => carica(true));
  $("raggio").value = String(stato.raggio);
  $("raggio").addEventListener("change", (e) => {
    stato.raggio = +e.target.value;
    if (stato.centro) {
      mappa.fitBounds(L.latLng(stato.centro.lat, stato.centro.lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  });
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
    const f = c.dataset.filtro;
    const on = !stato.filtri.has(f);
    on ? stato.filtri.add(f) : stato.filtri.delete(f);
    c.setAttribute("aria-pressed", String(on));
    render();
  }));
  function apriElenco() {
    $("pannello").hidden = false;
    $("btn-elenco").setAttribute("aria-expanded", "true");
    $("btn-chiudi").focus();
  }
  function chiudiElenco() {
    if ($("pannello").hidden) return;
    $("pannello").hidden = true;
    $("btn-elenco").setAttribute("aria-expanded", "false");
    $("btn-elenco").focus();
  }
  $("btn-elenco").addEventListener("click", apriElenco);
  $("btn-chiudi").addEventListener("click", chiudiElenco);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") chiudiElenco(); });

  // ---------- Lettura vocale dei riquadri ----------
  let letturaAttiva = true;
  try { letturaAttiva = localStorage.getItem("postolibero.lettura") !== "0"; } catch (e) { /* ignora */ }
  const sintesi = window.speechSynthesis;
  function vocItaliana() {
    const voci = sintesi ? sintesi.getVoices() : [];
    return voci.find((v) => /^it[-_]IT/i.test(v.lang) && v.localService) || voci.find((v) => /^it/i.test(v.lang)) || null;
  }
  function leggi(testo) {
    if (!sintesi || !testo) return;
    sintesi.cancel();
    const u = new SpeechSynthesisUtterance(testo);
    u.lang = "it-IT";
    const v = vocItaliana();
    if (v) u.voice = v;
    u.rate = 1;
    sintesi.speak(u);
  }
  mappa.on("popupopen", (e) => {
    if (!letturaAttiva) return;
    const el = e.popup.getElement && e.popup.getElement();
    const pop = el ? el.querySelector(".pop") : null;
    if (pop) leggi(pop.dataset.voce);
  });
  mappa.on("popupclose", () => { if (sintesi) sintesi.cancel(); });
  if (!sintesi) { $("riga-lettura").hidden = true; }
  $("lettura").value = letturaAttiva ? "1" : "0";
  $("lettura").addEventListener("change", (e) => {
    letturaAttiva = e.target.value === "1";
    try { localStorage.setItem("postolibero.lettura", letturaAttiva ? "1" : "0"); } catch (err) { /* ignora */ }
    if (letturaAttiva) leggi("Lettura vocale attiva.");
    else if (sintesi) sintesi.cancel();
  });

  // ---------- Auto-refresh ----------
  // Ogni N secondi fa come premere "posizione" e poi "aggiorna".
  // I parcheggi di OpenStreetMap vengono riscaricati solo se ti sei spostato o dopo 10 minuti,
  // per non sovraccaricare i server pubblici; segnalazioni e posti in tempo reale ogni volta.
  let timerAuto;
  function autoAggiorna() {
    if (document.hidden || !stato.gps) return;
    stato.seguiGps = true;
    stato.centro = { lat: stato.gps.lat, lon: stato.gps.lon, daGps: true };
    mappa.setView([stato.gps.lat, stato.gps.lon], 16);
    carica(false);
  }
  function impostaAuto(sec) {
    clearInterval(timerAuto);
    if (sec > 0) timerAuto = setInterval(autoAggiorna, sec * 1000);
    try { localStorage.setItem("postolibero.auto", String(sec)); } catch (e) { /* ignora */ }
  }
  let secAuto = cfg.autoRefreshSecondi ?? 120;
  try {
    const salvato = localStorage.getItem("postolibero.auto");
    if (salvato !== null && ["0", "30", "60", "120"].includes(salvato)) secAuto = +salvato;
  } catch (e) { /* ignora */ }
  $("auto-refresh").value = String(secAuto);
  impostaAuto(secAuto);
  $("suoni").value = suoniAttivi ? "1" : "0";
  $("suoni").addEventListener("change", (e) => {
    suoniAttivi = e.target.value === "1";
    try { localStorage.setItem("postolibero.suoni", suoniAttivi ? "1" : "0"); } catch (err) { /* ignora */ }
    sbloccaAudio();
    if (suoniAttivi) setTimeout(SUONO.aggiornato, 150); // prova
  });
  $("auto-refresh").addEventListener("change", (e) => {
    impostaAuto(+e.target.value);
    toast(+e.target.value ? `Auto-refresh ogni ${e.target.value} secondi` : "Auto-refresh disattivato");
  });

  // Aggiornamenti periodici: segnalazioni ogni minuto, tutto ogni 3 minuti
  setInterval(async () => { await caricaSegnalazioni(); render(); }, 60000);
  setInterval(async () => {
    if (!stato.centro || stato.caricando) return;
    stato.reale = await caricaOpenData(stato.centro.lat, stato.centro.lon, stato.raggio).catch(() => stato.reale);
    render();
  }, 180000);

  // Numero di versione lungo la diagonale della mappa (da in alto a sinistra a in basso a destra)
  $("filigrana-testo").textContent = "Versione " + (cfg.versione || "");
  function posizionaFiligrana() {
    const f = $("filigrana"), w = f.clientWidth, h = f.clientHeight;
    if (!w || !h) return;
    const diag = Math.hypot(w, h);
    f.style.setProperty("--fil-ang", (Math.atan2(h, w) * 180 / Math.PI).toFixed(1) + "deg");
    f.style.setProperty("--fil-size", Math.round(diag / 10.5) + "px");
  }
  posizionaFiligrana();
  window.addEventListener("resize", posizionaFiligrana);

  $("btn-libero").disabled = true;
  $("btn-parcheggiato").disabled = true;
  avviaGps();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
