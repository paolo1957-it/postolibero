/*
 * PostoLibero – segnalazioni degli utenti.
 * Con Supabase configurato: condivise tra tutti gli utenti (API REST, nessuna libreria).
 * Senza: salvate solo in questo browser (localStorage).
 */
(function () {
  "use strict";
  const cfg = window.POSTOLIBERO_CONFIG || {};
  const sb = Object.assign({}, cfg.supabase);
  if (sb.url) sb.url = sb.url.replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
  const condiviso = !!(sb.url && sb.anonKey);
  const CHIAVE_LOCALE = "postolibero.segnalazioni";

  function headers() {
    const h = { apikey: sb.anonKey, "Content-Type": "application/json" };
    // Le vecchie chiavi "anon" sono JWT (iniziano con eyJ) e vanno anche in Authorization;
    // le nuove chiavi "sb_publishable_..." vanno solo in apikey.
    if (/^eyJ/.test(sb.anonKey)) h.Authorization = "Bearer " + sb.anonKey;
    return h;
  }

  // Annulla la richiesta dopo "ms" millisecondi, così l'app non resta mai bloccata
  function scadenza(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }

  function leggiLocale() {
    try { return JSON.parse(localStorage.getItem(CHIAVE_LOCALE) || "[]"); } catch (e) { return []; }
  }
  function scriviLocale(lista) {
    try { localStorage.setItem(CHIAVE_LOCALE, JSON.stringify(lista.slice(-200))); } catch (e) { /* ignora */ }
  }

  // Riquadro approssimato attorno al punto (per filtrare lato server)
  function bbox(lat, lon, raggio) {
    const dLat = raggio / 111320;
    const dLon = raggio / (111320 * Math.cos(lat * Math.PI / 180));
    return { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };
  }

  async function carica(lat, lon, raggio, durataMin) {
    const da = new Date(Date.now() - durataMin * 60000).toISOString();
    if (!condiviso) {
      return leggiLocale().filter((s) => s.created_at >= da);
    }
    const b = bbox(lat, lon, raggio);
    const q = new URLSearchParams();
    q.append("select", "id,lat,lon,stato,created_at");
    q.append("created_at", "gte." + da);
    q.append("lat", "gte." + b.s.toFixed(6));
    q.append("lat", "lte." + b.n.toFixed(6));
    q.append("lon", "gte." + b.w.toFixed(6));
    q.append("lon", "lte." + b.e.toFixed(6));
    q.append("order", "created_at.desc");
    q.append("limit", "300");
    const r = await fetch(sb.url + "/rest/v1/segnalazioni?" + q,
      { headers: headers(), signal: scadenza(10000) });
    if (!r.ok) throw new Error("Segnalazioni non disponibili (" + r.status + ")");
    return r.json();
  }

  async function invia(lat, lon, stato) {
    const s = { lat: +lat.toFixed(6), lon: +lon.toFixed(6), stato, created_at: new Date().toISOString() };
    if (!condiviso) {
      const lista = leggiLocale();
      lista.push({ id: "loc-" + Date.now(), ...s });
      scriviLocale(lista);
      return s;
    }
    const r = await fetch(sb.url + "/rest/v1/segnalazioni", {
      method: "POST",
      signal: scadenza(10000),
      headers: { ...headers(), Prefer: "return=minimal" },
      body: JSON.stringify({ lat: s.lat, lon: s.lon, stato })
    });
    if (!r.ok) throw new Error("Invio non riuscito (" + r.status + ")");
    return s;
  }

  window.Segnalazioni = { condiviso, carica, invia };
})();
