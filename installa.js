/*
 * Qui-Parking – «Installa l'app»: aiuta a mettere l'icona sulla schermata Home.
 * Android/Chrome: pulsante che apre la finestra di installazione del telefono.
 * iPhone/iPad: i passaggi di Safari (Condividi → Aggiungi alla schermata Home).
 * Dentro WhatsApp, Facebook o Instagram non si può installare: spiega come aprire la pagina nel browser.
 * Il riquadro compare da solo poco dopo l'avvio, solo se l'app è aperta nel browser; «Più tardi» lo
 * nasconde per qualche giorno. La voce «Installa l'app» nella pagina Elenco lo riapre quando vuoi.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const PREF = "postolibero.installa.rimanda";
  const GIORNI_PAUSA = 5;
  const ua = navigator.userAgent || "";

  const installata = () =>
    navigator.standalone === true ||
    ["standalone", "fullscreen", "minimal-ui"].some((m) => window.matchMedia && matchMedia("(display-mode: " + m + ")").matches);
  if (installata()) return;

  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const dentroApp = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|MicroMessenger|Telegram/i.test(ua) || (android && /; wv\)/.test(ua));
  const iosAltroBrowser = ios && /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
  const telefono = ios || android;

  let richiesta = null; // evento beforeinstallprompt, conservato per il pulsante «Installa»
  let mostrato = false;
  const box = $("installa");
  const corpo = $("installa-corpo");
  const ok = $("installa-ok");
  const voce = $("btn-installa");

  // Icone disegnate come quelle di Safari e Chrome, per riconoscerle a colpo d'occhio
  const ICONA = {
    condividi: '<svg class="ins-ico" viewBox="0 0 24 24" width="22" height="22" aria-label="Condividi"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H6v11h12V10h-2" fill="none" stroke="#1a73e8" stroke-width="2" stroke-linejoin="round"/></svg>',
    piu: '<svg class="ins-ico" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    puntini: '<svg class="ins-ico" viewBox="0 0 24 24" width="22" height="22" aria-label="tre puntini"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>',
    righe: '<svg class="ins-ico" viewBox="0 0 24 24" width="22" height="22" aria-label="tre righe"><path d="M4 6.5h16M4 12h16M4 17.5h11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    puntiniOr: '<svg class="ins-ico" viewBox="0 0 24 24" width="22" height="22" aria-label="tre puntini"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>'
  };
  const passi = (lista) => '<ol class="ins-passi">' + lista.map((p) => "<li>" + p + "</li>").join("") + "</ol>";

  function contenuto() {
    if (dentroApp) {
      return {
        html: "<p>Adesso Qui-Parking è aperta <b>dentro un'altra app</b> (WhatsApp, Facebook…): da qui non si può mettere l'icona.</p>" +
          passi([
            "Tocca " + (ios ? ICONA.puntiniOr + " o " + ICONA.condividi : ICONA.puntini) + " in alto o in basso.",
            "Scegli <b>Apri in " + (ios ? "Safari" : "Chrome") + "</b> (o «Apri nel browser»).",
            "Lì tocca di nuovo <b>Installa l'app</b>."
          ]),
        pulsante: "Copia il link", azione: copiaLink
      };
    }
    if (iosAltroBrowser) {
      return {
        html: "<p>Sull'iPhone l'icona si mette più facilmente da <b>Safari</b>.</p>" +
          passi([
            "Tocca <b>Copia il link</b> qui sotto.",
            "Apri <b>Safari</b>, tieni il dito sulla barra degli indirizzi e scegli <b>Incolla e vai</b>.",
            "Tocca " + ICONA.condividi + " <b>Condividi</b> e poi " + ICONA.piu + " <b>Aggiungi alla schermata Home</b>."
          ]),
        pulsante: "Copia il link", azione: copiaLink
      };
    }
    if (ios) {
      return {
        html: passi([
          "Tocca " + ICONA.condividi + " <b>Condividi</b> nella barra di Safari (in basso, o in alto sull'iPad). Se non lo vedi, tocca prima " + ICONA.righe + " a sinistra dell'indirizzo.",
          "Scorri e tocca " + ICONA.piu + " <b>Aggiungi alla schermata Home</b>.",
          "Tocca <b>Aggiungi</b> in alto a destra: l'icona di Qui-Parking compare sulla schermata Home."
        ]),
        pulsante: "Ho capito", azione: chiudi
      };
    }
    if (richiesta) {
      return {
        html: "<p>Tocca <b>Installa</b> e conferma: l'icona di Qui-Parking compare sulla schermata Home.</p>",
        pulsante: "Installa", azione: installa
      };
    }
    return {
      html: passi([
        "Tocca " + ICONA.puntini + " il menu del browser, in alto a destra (in Samsung Internet: ☰ in basso).",
        "Scegli <b>Installa app</b> oppure <b>Aggiungi a schermata Home</b>.",
        "Conferma con <b>Installa</b> o <b>Aggiungi</b>."
      ]) + (telefono ? "" : "<p class=\"ins-nota\">Sul computer usa Chrome o Edge: nella barra degli indirizzi compare l'icona di installazione.</p>"),
      pulsante: "Ho capito", azione: chiudi
    };
  }

  let azione = chiudi;
  function apri() {
    const c = contenuto();
    // Su Android il browser parla di «Installa app»: usiamo la stessa parola
    $("installa-titolo").textContent = (android ? "Installa" : "Metti") + " Qui-Parking sul telefono";
    corpo.innerHTML = c.html;
    ok.textContent = c.pulsante;
    azione = c.azione;
    box.hidden = false;
    mostrato = true;
    ok.focus({ preventScroll: true });
  }
  function chiudi() { box.hidden = true; }
  function rimanda() {
    try { localStorage.setItem(PREF, String(Date.now())); } catch (e) { /* ignora */ }
    chiudi();
  }
  function avviso(t) {
    const el = $("toast");
    if (!el) return;
    el.textContent = t; el.hidden = false;
    clearTimeout(avviso.t); avviso.t = setTimeout(() => { el.hidden = true; }, 3500);
  }
  function copiaLink() {
    const link = location.origin + location.pathname;
    const fatto = () => avviso("Link copiato: incollalo nel browser.");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(fatto, () => prompt("Copia questo link:", link));
    else prompt("Copia questo link:", link);
  }
  function installa() {
    if (!richiesta) { apri(); return; }
    const r = richiesta;
    richiesta = null;
    chiudi();
    r.prompt();
    if (r.userChoice) r.userChoice.then((s) => { if (s && s.outcome !== "accepted") aggiornaVoce(); }).catch(() => {});
  }
  function aggiornaVoce() {
    // La voce nel menu c'è sui telefoni e, sul computer, solo se il browser sa installare
    voce.hidden = installata() || !(telefono || richiesta);
  }

  ok.addEventListener("click", () => azione());
  $("installa-dopo").addEventListener("click", rimanda);
  voce.addEventListener("click", () => (richiesta && !dentroApp ? installa() : apri()));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !box.hidden) { e.stopImmediatePropagation(); rimanda(); } }, true);

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // niente barra automatica: si installa dal nostro pulsante
    richiesta = e;
    aggiornaVoce();
    if (!box.hidden) apri(); // il riquadro già aperto passa al pulsante «Installa»
  });
  window.addEventListener("appinstalled", () => {
    richiesta = null;
    chiudi();
    voce.hidden = true;
    avviso("Fatto! Trovi Qui-Parking sulla schermata Home.");
  });
  aggiornaVoce();

  // Comparsa automatica: solo sui telefoni (o se il browser del computer sa installare),
  // a mappa libera e non nei giorni dopo un «Più tardi»
  let rimandato = 0;
  try { rimandato = +localStorage.getItem(PREF) || 0; } catch (e) { /* ignora */ }
  if (Date.now() - rimandato < GIORNI_PAUSA * 864e5) return;
  let tentativi = 0;
  const prova = () => {
    if (mostrato || installata()) return;
    const libera = !document.querySelector(".pannello:not([hidden])") && !document.hidden;
    if ((telefono || richiesta) && libera) apri();
    else if (++tentativi < 24) setTimeout(prova, 5000);
  };
  setTimeout(prova, 6000);
})();
