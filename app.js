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

  const icona = (cls, html) => L.divIcon({ className: "", html: `<div class="mk ${cls}">${html || ""}</div>`, iconSize: null });

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

  async function caricaOsm(lat, lon, raggio) {
    const chiave = `${lat.toFixed(3)},${lon.toFixed(3)},${raggio}`;
    const c = cacheOsm.get(chiave);
    if (c && Date.now() - c.t < 10 * 60000) return PL.analizzaOverpass(c.json, lat, lon, raggio);
    const query = PL.queryOverpass(lat, lon, raggio + 150);
    let ultimoErrore;
    for (const url of cfg.overpass) {
      try {
        const r = await fetchConTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query)
        }, 30000);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const json = await r.json();
        cacheOsm.set(chiave, { t: Date.now(), json });
        return PL.analizzaOverpass(json, lat, lon, raggio);
      } catch (e) { ultimoErrore = e; }
    }
    throw ultimoErrore || new Error("OpenStreetMap non raggiungibile");
  }

  async function caricaOpenData(lat, lon, raggio) {
    const fonti = (cfg.openData || []).filter((f) => f.attivo &&
      (!f.centro || PL.distanza(lat, lon, f.centro[0], f.centro[1]) <= (f.entroKm || 20) * 1000));
    const risultati = await Promise.allSettled(fonti.map(async (f) => {
      const r = await fetchConTimeout(f.url, {}, 15000);
      if (!r.ok) throw new Error(f.nome + ": HTTP " + r.status);
      return PL.analizzaOpenData(await r.json(), f, lat, lon, raggio);
    }));
    const nomi = fonti.filter((_, i) => risultati[i].status === "fulfilled").map((f) => f.nome);
    $("fonti-extra").textContent = nomi.length ? ", tempo reale: " + nomi.join(", ") : "";
    return risultati.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async function caricaSegnalazioni() {
    if (!stato.centro) return;
    const { lat, lon } = stato.centro;
    try {
      const lista = await Segnalazioni.carica(lat, lon, stato.raggio, cfg.durataSegnalazioneMinuti);
      stato.segn = PL.filtraSegnalazioni(lista, lat, lon, stato.raggio, cfg.durataSegnalazioneMinuti);
    } catch (e) {
      console.warn(e);
    }
  }

  async function carica(forza) {
    if (!stato.centro || stato.caricando) return;
    stato.caricando = true;
    $("btn-aggiorna").classList.add("gira");
    const { lat, lon } = stato.centro;
    if (forza) cacheOsm.clear();
    messaggio("Cerco parcheggi entro " + PL.formattaDistanza(stato.raggio) + "…");

    const [osm, reale] = await Promise.allSettled([
      caricaOsm(lat, lon, stato.raggio),
      caricaOpenData(lat, lon, stato.raggio),
      caricaSegnalazioni()
    ]);
    stato.osm = osm.status === "fulfilled" ? osm.value : [];
    stato.reale = reale.status === "fulfilled" ? reale.value : [];

    stato.caricando = false;
    $("btn-aggiorna").classList.remove("gira");
    render();

    const ora = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    if (osm.status === "rejected") {
      messaggio("OpenStreetMap non risponde. Riprova tra poco con il tasto aggiorna.", true);
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

  function popupLuogo(l) {
    const righe = [];
    if (l.fonte === "opendata") {
      righe.push(`<b style="color:var(--libero)">${l.liberi} posti liberi</b>${l.capienza ? " su " + l.capienza : ""}`);
      if (l.aggiornato) righe.push("Dato del " + esc(new Date(l.aggiornato).toLocaleString("it-IT")));
      righe.push("Fonte: " + esc(l.fonteNome));
    } else {
      if (l.capienza) righe.push((l.capienzaStimata ? "circa " : "") + l.capienza + " posti");
      if (l.tariffa === "gratuito") righe.push("Gratuito");
      else if (l.tariffa === "pagamento") righe.push("A pagamento");
      if (l.disabili) righe.push(l.disabili + " posti disabili");
      if (l.maxstay) righe.push("Sosta max: " + esc(l.maxstay));
      if (l.orari) righe.push("Orari: " + esc(l.orari));
    }
    righe.push(PL.formattaDistanza(l.distanza) + " · " + PL.minutiA_piedi(l.distanza) + " min a piedi");
    return `<div class="pop"><h3>${esc(l.nome || l.via || l.tipo)}</h3>
      <p>${esc(l.tipo)}</p>${righe.map((r) => "<p>" + r + "</p>").join("")}
      <p><a href="${linkNavigazione(l.lat, l.lon)}" target="_blank" rel="noopener">Portami qui →</a></p></div>`;
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
        .bindPopup(popupLuogo(l)).addTo(livelli.strade);
      markerPerId.set(l.id, linea);
    }
    // Stalli singoli (visibili da zoom 17)
    for (const l of osm.filter((x) => x.categoria === "stallo")) {
      const m = L.marker([l.lat, l.lon], { icon: icona("stallo" + (l.disabili ? " disabili" : "")) })
        .bindPopup(popupLuogo(l)).addTo(livelli.stalli);
      markerPerId.set(l.id, m);
    }
    aggiornaVisibilitaStalli();
    // Parcheggi
    for (const l of osm.filter((x) => x.categoria === "parcheggio")) {
      const m = L.marker([l.lat, l.lon], { icon: icona("", "P"), title: l.nome || l.tipo })
        .bindPopup(popupLuogo(l)).addTo(livelli.luoghi);
      markerPerId.set(l.id, m);
    }
    // Tempo reale
    for (const l of reale) {
      const s = PL.statoDisponibilita(l.liberi, l.capienza);
      const m = L.marker([l.lat, l.lon], { icon: icona("reale " + s, l.liberi), zIndexOffset: 500, title: l.nome })
        .bindPopup(popupLuogo(l)).addTo(livelli.luoghi);
      markerPerId.set(l.id, m);
    }
    // Segnalazioni
    for (const s of segnVisibili) {
      const m = L.marker([s.lat, s.lon], {
        icon: icona("segn " + s.stato), opacity: s.freschezza, zIndexOffset: 800
      }).bindPopup(`<div class="pop"><h3>${s.stato === "libero" ? "Posto segnalato libero" : "Posto appena occupato"}</h3>
          <p>${PL.formattaEta(s.eta)} · ${PL.formattaDistanza(s.distanza)}</p>
          ${s.stato === "libero" ? `<p><a href="${linkNavigazione(s.lat, s.lon)}" target="_blank" rel="noopener">Portami qui →</a></p>` : ""}</div>`)
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
        id: l.id, classe: st, icona: `<span class="num">${l.liberi}</span>`,
        titolo: l.nome,
        meta: [`<span class="tag ${st === "libero" ? "reale" : st}">${st === "pieno" ? "Pieno" : l.liberi + " liberi ora"}</span>`,
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
        id: l.id, classe: l.categoria === "parcheggio" ? "parcheggio" : "",
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
      const r = await fetchConTimeout(url, { headers: { Accept: "application/json" } }, 12000);
      const [primo] = await r.json();
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

  // Aggiornamenti periodici: segnalazioni ogni minuto, tutto ogni 3 minuti
  setInterval(async () => { await caricaSegnalazioni(); render(); }, 60000);
  setInterval(async () => {
    if (!stato.centro || stato.caricando) return;
    stato.reale = await caricaOpenData(stato.centro.lat, stato.centro.lon, stato.raggio).catch(() => stato.reale);
    render();
  }, 180000);

  $("btn-libero").disabled = true;
  $("btn-parcheggiato").disabled = true;
  avviaGps();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
