/*
 * PostoLibero – logica pura (nessun accesso a DOM o rete).
 * Funziona sia nel browser (window.PL) sia in Node (module.exports) per i test.
 */
(function (root) {
  "use strict";

  const R_TERRA = 6371000;

  function distanza(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TERRA * Math.asin(Math.sqrt(a));
  }

  function formattaDistanza(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " m";
    return (m / 1000).toFixed(1).replace(".", ",") + " km";
  }

  function minutiA_piedi(m) {
    return Math.max(1, Math.round(m / 80)); // ~4,8 km/h
  }

  // ---------- OpenStreetMap / Overpass ----------

  const VALORI_SOSTA_STRADA = "^(lane|street_side|on_kerb|half_on_kerb|shoulder|yes)$";
  const VALORI_SOSTA_VECCHI = "^(parallel|diagonal|perpendicular|marked)$";

  function queryOverpass(lat, lon, raggio) {
    const a = `(around:${Math.round(raggio)},${lat.toFixed(6)},${lon.toFixed(6)})`;
    // Prima si prendono le strade della zona, poi si filtrano: molto più leggero per il server
    // di una ricerca per chiave su tutta la mappa.
    return `[out:json][timeout:25];
(
  nwr["amenity"="parking"]${a};
  nwr["amenity"="parking_space"]${a};
  node["amenity"="parking_entrance"]${a};
);
out tags bb;
way${a}["highway"]->.strade;
(
  way.strade[~"^parking:(both|left|right)$"~"${VALORI_SOSTA_STRADA}"];
  way.strade[~"^parking:lane:(both|left|right)$"~"${VALORI_SOSTA_VECCHI}"];
);
out tags geom;`;
  }

  const TIPI_PARCHEGGIO = {
    surface: "Area di sosta",
    "multi-storey": "Multipiano",
    underground: "Interrato",
    rooftop: "Sul tetto",
    street_side: "Bordo strada",
    lane: "Bordo strada",
    carports: "Posti coperti",
    garage_boxes: "Garage"
  };

  function intOrNull(v) {
    if (v == null) return null;
    const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  function tariffa(tags) {
    const fee = (tags.fee || "").toLowerCase();
    if (fee === "no") return "gratuito";
    if (fee === "yes" || tags.charge || tags["parking:fee"] === "yes") return "pagamento";
    if (/^(mo|tu|we|th|fr|sa|su|\d)/i.test(fee)) return "pagamento"; // orari a pagamento
    return "sconosciuto";
  }

  function accessibile(tags) {
    const a = (tags.access || "").toLowerCase();
    return !["private", "no", "customers", "permit", "delivery", "residents"].includes(a);
  }

  function lunghezzaWay(geom) {
    let l = 0;
    for (let i = 1; i < geom.length; i++) {
      l += distanza(geom[i - 1].lat, geom[i - 1].lon, geom[i].lat, geom[i].lon);
    }
    return l;
  }

  function puntoMedio(geom) {
    const tot = lunghezzaWay(geom);
    let acc = 0;
    for (let i = 1; i < geom.length; i++) {
      const seg = distanza(geom[i - 1].lat, geom[i - 1].lon, geom[i].lat, geom[i].lon);
      if (acc + seg >= tot / 2 && seg > 0) {
        const t = (tot / 2 - acc) / seg;
        return {
          lat: geom[i - 1].lat + (geom[i].lat - geom[i - 1].lat) * t,
          lon: geom[i - 1].lon + (geom[i].lon - geom[i - 1].lon) * t
        };
      }
      acc += seg;
    }
    return geom[0];
  }

  // Stima dei posti di un'area di sosta all'aperto dalla sua superficie: circa 25 m² per auto
  // (stallo + parte della corsia di manovra). Nelle zone salvate nel sito la superficie è
  // calcolata dal contorno vero (tag _postiStimati); altrove si usa il rettangolo che contiene
  // il parcheggio, ridotto del 30% perché i parcheggi raramente lo riempiono tutto.
  const M2_PER_POSTO = 25;
  function stimaPostiArea(el, tags) {
    const dalSito = intOrNull(tags._postiStimati);
    if (dalSito) return dalSito;
    const b = el.bounds;
    if (!b) return null;
    const alto = (b.maxlat - b.minlat) * 111320;
    const largo = (b.maxlon - b.minlon) * 111320 * Math.cos(((b.minlat + b.maxlat) / 2) * Math.PI / 180);
    const area = alto * largo * 0.7;
    if (!(area > 0)) return null;
    return Math.max(1, Math.round(area / M2_PER_POSTO));
  }

  function latiSosta(tags) {
    const lati = [];
    const re = new RegExp(VALORI_SOSTA_STRADA);
    const reOld = new RegExp(VALORI_SOSTA_VECCHI);
    for (const lato of ["both", "left", "right"]) {
      if (re.test(tags["parking:" + lato] || "") || reOld.test(tags["parking:lane:" + lato] || "")) {
        lati.push(lato);
      }
    }
    return lati;
  }

  /**
   * Converte la risposta Overpass in una lista uniforme di "luoghi".
   * Ogni luogo: { id, fonte:"osm", categoria, nome, lat, lon, distanza, capienza,
   *               tariffa, disabili, coperto, tipo, geom?, tags }
   */
  function analizzaOverpass(json, lat, lon, raggio) {
    const out = [];
    const visti = new Set();
    for (const el of (json && json.elements) || []) {
      const tags = el.tags || {};
      const id = el.type + "/" + el.id;
      if (visti.has(id)) continue;
      visti.add(id);

      let pLat, pLon, geom = null;
      if (el.type === "node") { pLat = el.lat; pLon = el.lon; }
      else if (el.center) { pLat = el.center.lat; pLon = el.center.lon; }
      else if (el.geometry && el.geometry.length) {
        geom = el.geometry;
        const m = puntoMedio(geom);
        pLat = m.lat; pLon = m.lon;
      } else if (el.bounds) {
        pLat = (el.bounds.minlat + el.bounds.maxlat) / 2;
        pLon = (el.bounds.minlon + el.bounds.maxlon) / 2;
      } else continue;

      if (el.type === "way" && el.geometry && !el.center) geom = el.geometry;
      if (pLat == null || pLon == null) continue;
      const d = distanza(lat, lon, pLat, pLon);
      if (d > raggio) continue;
      if (!accessibile(tags)) continue;

      let categoria, tipo, capienza = intOrNull(tags.capacity);
      if (tags.amenity === "parking") {
        categoria = "parcheggio";
        tipo = TIPI_PARCHEGGIO[tags.parking] || "Parcheggio";
        if (capienza == null && (!tags.parking || tags.parking === "surface")) {
          capienza = stimaPostiArea(el, tags);
          if (capienza) tags._capienzaStimata = "1";
        }
      } else if (tags.amenity === "parking_space") {
        categoria = "stallo";
        tipo = tags.parking_space === "disabled" ? "Stallo disabili" : "Stallo";
        if (capienza == null) capienza = 1;
      } else if (tags.amenity === "parking_entrance") {
        categoria = "ingresso";
        tipo = "Ingresso parcheggio";
      } else if (geom) {
        categoria = "strada";
        tipo = "Sosta su strada";
        if (capienza == null) {
          // stima: 1 posto ogni 5,5 m per lato (sosta in linea)
          capienza = Math.floor(lunghezzaWay(geom) / 5.5) * latiSosta(tags).reduce((s, l) => s + (l === "both" ? 2 : 1), 0) || null;
          if (capienza) tags._capienzaStimata = "1";
        }
      } else continue;

      const disabili = intOrNull(tags["capacity:disabled"]) ||
        (tags.parking_space === "disabled" || tags["capacity:disabled"] === "yes" ? 1 : 0);

      out.push({
        id, fonte: "osm", categoria, tipo,
        nome: tags.name || tags.operator || null,
        via: categoria === "strada" ? (tags.name || null) : (tags["addr:street"] || null),
        lat: pLat, lon: pLon, distanza: d,
        capienza, capienzaStimata: !!tags._capienzaStimata,
        tariffa: tariffa(tags),
        disabili,
        coperto: ["multi-storey", "underground", "carports"].includes(tags.parking) || tags.covered === "yes",
        orari: tags.opening_hours || null,
        maxstay: tags.maxstay || tags["parking:maxstay"] || null,
        geom, tags
      });
    }
    return out.sort((a, b) => a.distanza - b.distanza);
  }

  // ---------- Open data in tempo reale ----------

  const ALIAS = {
    nome: ["nome", "parcheggio", "name", "denominazione", "descrizione", "park_name", "nome_parcheggio"],
    liberi: ["posti_liberi", "liberi", "free", "free_spaces", "disponibili", "posti_disponibili", "available", "stalli_liberi"],
    totali: ["posti_totali", "totali", "total", "capacity", "capienza", "posti", "stalli_totali"],
    occupati: ["posti_occupati", "occupati", "occupied"],
    posizione: ["coordinate", "coordinates", "geo_point_2d", "geopoint", "posizione", "location", "geo_point"],
    lat: ["lat", "latitude", "latitudine", "y"],
    lon: ["lon", "lng", "longitude", "longitudine", "x"],
    aggiornato: ["data", "aggiornamento", "updated", "timestamp", "last_update", "data_aggiornamento", "dataora"]
  };

  function trovaCampo(rec, chiave, esplicito) {
    if (esplicito && rec[esplicito] !== undefined) return rec[esplicito];
    const keys = Object.keys(rec);
    for (const alias of ALIAS[chiave]) {
      const k = keys.find((x) => x.toLowerCase() === alias);
      if (k !== undefined && rec[k] != null && rec[k] !== "") return rec[k];
    }
    return undefined;
  }

  function leggiPosizione(v) {
    if (!v) return null;
    if (Array.isArray(v) && v.length >= 2) return { lat: +v[0], lon: +v[1] };
    if (typeof v === "object") {
      if (v.lat != null && (v.lon != null || v.lng != null)) return { lat: +v.lat, lon: +(v.lon ?? v.lng) };
      if (v.type === "Point" && Array.isArray(v.coordinates)) return { lat: +v.coordinates[1], lon: +v.coordinates[0] };
    }
    if (typeof v === "string" && v.includes(",")) {
      const [a, b] = v.split(",").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) return { lat: a, lon: b };
    }
    return null;
  }

  function analizzaOpenData(json, fonte, lat, lon, raggio) {
    const recs = Array.isArray(json) ? json : (json.results || json.records || json.data || json.features || []);
    const campi = fonte.campi || {};
    const out = [];
    recs.forEach((r0, i) => {
      const r = r0.fields || r0.properties || r0; // Opendatasoft v1 / GeoJSON / v2
      let pos = leggiPosizione(trovaCampo(r, "posizione", campi.posizione));
      if (!pos && r0.geometry) pos = leggiPosizione(r0.geometry);
      if (!pos) {
        const la = trovaCampo(r, "lat", campi.lat), lo = trovaCampo(r, "lon", campi.lon);
        if (la != null && lo != null) pos = { lat: +la, lon: +lo };
      }
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return;
      const d = distanza(lat, lon, pos.lat, pos.lon);
      if (d > raggio) return;
      const totali = intOrNull(trovaCampo(r, "totali", campi.totali));
      let liberi = intOrNull(trovaCampo(r, "liberi", campi.liberi));
      if (liberi == null) {
        const occ = intOrNull(trovaCampo(r, "occupati", campi.occupati));
        if (occ != null && totali != null) liberi = Math.max(0, totali - occ);
      }
      if (liberi == null) return;
      out.push({
        id: "od/" + fonte.nome + "/" + i,
        fonte: "opendata", fonteNome: fonte.nome,
        categoria: "tempo-reale", tipo: "Posti in tempo reale",
        nome: String(trovaCampo(r, "nome", campi.nome) || "Parcheggio"),
        lat: pos.lat, lon: pos.lon, distanza: d,
        liberi, capienza: totali,
        aggiornato: trovaCampo(r, "aggiornato", campi.aggiornato) || null,
        tariffa: "sconosciuto", disabili: 0, coperto: false
      });
    });
    return out.sort((a, b) => a.distanza - b.distanza);
  }

  // ---------- Open data statici (parcheggi comunali senza posti in tempo reale) ----------

  function primoValore(obj, nomi) {
    const keys = Object.keys(obj);
    for (const n of nomi) {
      const k = keys.find((x) => x.toLowerCase() === n);
      if (k !== undefined && obj[k] != null && obj[k] !== "" && obj[k] !== "-") return obj[k];
    }
    return null;
  }

  function titolo(s) {
    if (!s) return s;
    const t = String(s).trim();
    return t === t.toUpperCase()
      ? t.toLowerCase().replace(/(^|[\s'(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
          .replace(/\b([A-Za-z]+\d+|Fnm)\b/g, (m) => m.toUpperCase())
      : t;
  }

  /**
   * Legge un GeoJSON di parcheggi (es. Comune di Milano) e restituisce luoghi
   * nello stesso formato di OpenStreetMap, con fonte "comune".
   */
  function analizzaStatico(json, fonte, lat, lon, raggio) {
    const out = [];
    const features = (json && json.features) || [];
    features.forEach((f, i) => {
      const g = f.geometry;
      if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) return;
      const pLon = +g.coordinates[0], pLat = +g.coordinates[1];
      if (!Number.isFinite(pLat) || !Number.isFinite(pLon)) return;
      const d = distanza(lat, lon, pLat, pLon);
      if (d > raggio) return;
      const p = f.properties || {};
      const testoPosti = String(primoValore(p, ["n_posti", "posti", "capienza", "tab1"]) || "");
      const capienza = intOrNull((testoPosti.match(/\d+/) || [])[0]);
      const dis = testoPosti.match(/(\d+)\s*disabili/i);
      const note = primoValore(p, ["info", "note"]);
      out.push({
        id: "com/" + fonte.nome + "/" + (p.id ?? i),
        fonte: "comune", fonteNome: fonte.nome,
        categoria: "parcheggio",
        tipo: fonte.etichetta || "Parcheggio comunale",
        nome: titolo(primoValore(p, ["nome", "name", "denominazione"])),
        via: titolo(primoValore(p, ["indirizzo", "address"])),
        lat: pLat, lon: pLon, distanza: d,
        capienza, capienzaStimata: false,
        tariffa: "sconosciuto",
        disabili: dis ? +dis[1] : 0,
        coperto: false,
        note: note ? titolo(String(note).replace(/\s+/g, " ")) : null,
        orari: null, maxstay: null, geom: null, tags: {}
      });
    });
    return out;
  }

  /**
   * Unisce i parcheggi comunali a quelli OSM: se c'è già un parcheggio OSM entro 80 m,
   * lo arricchisce (nome, posti, fonte) invece di duplicarlo.
   */
  function unisciStatici(osm, statici) {
    const lista = osm.map((l) => ({ ...l }));
    for (const s of statici) {
      const doppio = lista.find((l) => l.categoria === "parcheggio" &&
        distanza(l.lat, l.lon, s.lat, s.lon) < 80);
      if (doppio) {
        if (!doppio.nome && s.nome) doppio.nome = s.nome;
        if (doppio.capienza == null && s.capienza != null) doppio.capienza = s.capienza;
        if (!doppio.disabili && s.disabili) doppio.disabili = s.disabili;
        if (!doppio.note && s.note) doppio.note = s.note;
        doppio.fonteNome = s.fonteNome;
      } else {
        lista.push(s);
      }
    }
    return lista.sort((a, b) => a.distanza - b.distanza);
  }

  function statoDisponibilita(liberi, totali) {
    if (liberi == null) return "ignoto";
    if (liberi <= 0) return "pieno";
    if (totali && liberi / totali < 0.1) return "quasi-pieno";
    if (!totali && liberi < 5) return "quasi-pieno";
    return "libero";
  }

  // ---------- Segnalazioni ----------

  /**
   * Tiene solo le segnalazioni recenti ed entro il raggio.
   * Se nello stesso punto (~15 m) c'è una segnalazione più recente, quella vecchia viene scartata.
   */
  function filtraSegnalazioni(lista, lat, lon, raggio, durataMin, adesso) {
    const now = adesso || Date.now();
    const limite = durataMin * 60000;
    const recenti = lista
      .map((s) => ({ ...s, ts: new Date(s.created_at).getTime() }))
      .filter((s) => Number.isFinite(s.ts) && now - s.ts <= limite && now - s.ts >= -60000)
      .map((s) => ({ ...s, distanza: distanza(lat, lon, s.lat, s.lon) }))
      .filter((s) => s.distanza <= raggio)
      .sort((a, b) => b.ts - a.ts);
    const tenute = [];
    for (const s of recenti) {
      if (!tenute.some((t) => distanza(t.lat, t.lon, s.lat, s.lon) < 15)) tenute.push(s);
    }
    return tenute.map((s) => ({
      ...s,
      eta: Math.max(0, Math.round((now - s.ts) / 60000)),
      freschezza: Math.max(0.25, 1 - (now - s.ts) / limite)
    })).sort((a, b) => a.distanza - b.distanza);
  }

  function formattaEta(min) {
    if (min < 1) return "adesso";
    if (min === 1) return "1 min fa";
    return min + " min fa";
  }

  const API = {
    distanza, formattaDistanza, minutiA_piedi, queryOverpass, analizzaOverpass,
    analizzaOpenData, analizzaStatico, unisciStatici, statoDisponibilita, filtraSegnalazioni, formattaEta, leggiPosizione
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.PL = API;
})(typeof window !== "undefined" ? window : globalThis);
