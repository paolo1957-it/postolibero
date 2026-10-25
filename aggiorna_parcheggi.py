#!/usr/bin/env python3
"""
PostoLibero – scarica una volta alla settimana i parcheggi di OpenStreetMap di tutta la Lombardia
e li salva nel sito, divisi in "tessere". Stesso schema di Trekking: una zona per provincia,
ognuna con la sua cartella (osm/milano/, osm/pavia/, …).

Lo esegue GitHub da solo (vedi .github/workflows/pubblica.yml).
Ogni zona si scarica allargata di MARGINE_KM per lato: così chi è dentro la zona trova tutto
anche col raggio più grande (2 km). Le zone si scaricano una alla volta (richieste piccole,
che i server accettano); se una non si scarica, resta quella della settimana prima.
Per aggiungere o cambiare una zona basta una riga in ZONE:
    "nome": (latitudine sud, longitudine ovest, latitudine nord, longitudine est)
I valori si trovano su https://bboxfinder.com
"""
import json
import math
import os
import re
import shutil
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# Le 12 province della Lombardia (riquadri arrotondati per eccesso: comprendono anche
# un po' delle regioni vicine, che non fa male)
ZONE = {
    "Varese": (45.53, 8.50, 46.17, 9.01),
    "Como": (45.62, 8.82, 46.33, 9.42),
    "Sondrio": (46.00, 9.19, 46.64, 10.64),
    "Lecco": (45.65, 9.21, 46.16, 9.58),
    "Monza e Brianza": (45.52, 9.04, 45.73, 9.53),
    "Milano": (45.24, 8.69, 45.65, 9.56),
    "Bergamo": (45.40, 9.40, 46.16, 10.30),
    "Brescia": (45.18, 9.84, 46.31, 10.85),
    "Pavia": (44.67, 8.51, 45.44, 9.49),
    "Lodi": (45.07, 9.32, 45.44, 9.89),
    "Cremona": (44.97, 9.42, 45.48, 10.54),
    "Mantova": (44.89, 10.11, 45.44, 11.43),
}
MARGINE_KM = 3      # raggio massimo dell'app (2 km) + un po' di scorta

SERVER = [
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "PostoLibero/1.0 (https://github.com/paolo1957-it/postolibero)"

PASSO = 0.02            # lato della tessera in gradi (circa 2,2 km × 1,6 km)
CARTELLA = "osm"        # dove vengono salvate le tessere nel sito

# Solo i dati che l'app usa: file più piccoli e veloci da scaricare
TAG_UTILI = {
    "amenity", "parking", "parking_space", "name", "operator", "capacity",
    "capacity:disabled", "fee", "charge", "access", "covered", "opening_hours",
    "maxstay", "parking:maxstay", "parking:fee", "addr:street", "highway",
}

SOSTA_STRADA = "^(lane|street_side|on_kerb|half_on_kerb|shoulder|yes)$"
SOSTA_VECCHIA = "^(parallel|diagonal|perpendicular|marked)$"


def query(s, w, n, e):
    a = f"({s},{w},{n},{e})"
    return f"""[out:json][timeout:600][maxsize:536870912];
(
  nwr["amenity"="parking"]{a};
  nwr["amenity"="parking_space"]{a};
  node["amenity"="parking_entrance"]{a};
);
out tags geom;
way["highway"]{a}->.strade;
(
  way.strade[~"^parking:(both|left|right)$"~"{SOSTA_STRADA}"];
  way.strade[~"^parking:lane:(both|left|right)$"~"{SOSTA_VECCHIA}"];
);
out tags geom;"""


def scarica(q):
    ultimo = None
    for tentativo in range(3):
        for url in SERVER:
            try:
                dati = urllib.parse.urlencode({"data": q}).encode()
                req = urllib.request.Request(url, data=dati, headers={
                    "User-Agent": USER_AGENT,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                })
                with urllib.request.urlopen(req, timeout=660) as r:
                    j = json.load(r)
                if not isinstance(j.get("elements"), list):
                    raise ValueError("risposta senza elementi")
                remark = j.get("remark", "")
                if remark and any(x in remark.lower() for x in ("error", "timed out", "out of memory", "rate")):
                    raise ValueError(remark)
                print(f"  ok da {url}: {len(j['elements'])} elementi")
                return j["elements"]
            except Exception as ex:  # prova il server successivo
                ultimo = ex
                print(f"  {url}: {ex}")
        time.sleep(60 * (tentativo + 1))
    raise RuntimeError(f"nessun server ha risposto: {ultimo}")


M2_PER_POSTO = 25      # stallo + parte di corsia: stima dei posti dalla superficie


def area_anello(punti):
    """Superficie in m² di un contorno chiuso (formula di Gauss su coordinate locali)."""
    if len(punti) < 4 or punti[0] != punti[-1]:
        return 0.0
    lat0 = math.radians(sum(p["lat"] for p in punti) / len(punti))
    xy = [(p["lon"] * 111320 * math.cos(lat0), p["lat"] * 111320) for p in punti]
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(xy, xy[1:]))) / 2


def area_elemento(el):
    if el["type"] == "way":
        return area_anello(el.get("geometry") or [])
    if el["type"] == "relation":   # multipoligono: contorni esterni meno i buchi
        tot = 0.0
        for m in el.get("members") or []:
            g = [p for p in (m.get("geometry") or []) if p]
            a = area_anello(g)
            tot += -a if m.get("role") == "inner" else a
        return max(tot, 0.0)
    return 0.0


def e_parcheggio(el):
    return (el.get("tags") or {}).get("amenity") in ("parking", "parking_space", "parking_entrance")


def snellisci(el):
    """Tiene solo i dati utili e arrotonda le coordinate a ~10 cm.
    Per i parcheggi disegnati come aree salva solo il centro e, per quelli all'aperto
    senza numero di posti, una stima dei posti ricavata dalla superficie."""
    tutti = el.get("tags") or {}
    tags = {k: v for k, v in tutti.items() if k in TAG_UTILI or k.startswith("parking:")}
    out = {"type": el["type"], "id": el["id"], "tags": tags}
    r6 = lambda x: round(x, 6)
    if "lat" in el:
        out["lat"], out["lon"] = r6(el["lat"]), r6(el["lon"])
    if "center" in el:
        out["center"] = {"lat": r6(el["center"]["lat"]), "lon": r6(el["center"]["lon"])}
    if e_parcheggio(el) and el["type"] != "node":
        b = el.get("bounds")
        if b:
            out["center"] = {"lat": r6((b["minlat"] + b["maxlat"]) / 2),
                             "lon": r6((b["minlon"] + b["maxlon"]) / 2)}
        if (tutti.get("amenity") == "parking" and "capacity" not in tutti
                and tutti.get("parking", "surface") == "surface"):
            area = area_elemento(el)
            if area > 0:
                tags["_postiStimati"] = str(max(1, round(area / M2_PER_POSTO)))
    elif "geometry" in el:
        out["geometry"] = [{"lat": r6(p["lat"]), "lon": r6(p["lon"])} for p in el["geometry"] if p]
    return out


def punto(el):
    if e_parcheggio(el) and el.get("bounds"):
        b = el["bounds"]
        return (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2
    if "lat" in el:
        return el["lat"], el["lon"]
    if "center" in el:
        return el["center"]["lat"], el["center"]["lon"]
    g = el.get("geometry") or []
    if g:
        m = g[len(g) // 2]
        return m["lat"], m["lon"]
    return None


def nome_tessera(lat, lon):
    return f"t_{math.floor(lat / PASSO)}_{math.floor(lon / PASSO)}.json"


def slug(nome):
    s = unicodedata.normalize("NFD", nome.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def allarga(s, w, n, e):
    dlat = MARGINE_KM / 111.32
    dlon = MARGINE_KM / (111.32 * math.cos(math.radians((s + n) / 2)))
    return tuple(round(x, 4) for x in (s - dlat, w - dlon, n + dlat, e + dlon))


# ---------- Programma ----------

def main():
    os.makedirs(CARTELLA, exist_ok=True)
    adesso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    indice_path = os.path.join(CARTELLA, "indice.json")
    try:
        with open(indice_path) as f:
            indice = json.load(f)
    except Exception:
        indice = {"passo": PASSO, "zone": {}}
    indice["passo"] = PASSO
    indice.pop("confine", None)

    def togli(nome):
        z = indice["zone"].pop(nome)
        if z.get("cartella"):
            shutil.rmtree(os.path.join(CARTELLA, z["cartella"]), ignore_errors=True)
        else:   # vecchio formato: tessere direttamente in osm/
            for t in z.get("tessere", []):
                try:
                    os.remove(os.path.join(CARTELLA, t))
                except FileNotFoundError:
                    pass
        print(f"Tolta la vecchia zona {nome}")

    # Zone del vecchio formato (Pavia, Milano, Varese e Biandronno con le tessere in osm/):
    # restano finché la provincia nuova non è scaricata, così l'app non resta mai senza dati.
    vecchie = [k for k, z in indice["zone"].items() if not z.get("cartella")]

    errori = 0
    for n, (nome, bbox) in enumerate(ZONE.items()):
        if n:
            time.sleep(20)          # un attimo di pausa tra una zona e l'altra, per i server
        print(f"{nome}…")
        largo = allarga(*bbox)
        try:
            elementi = scarica(query(*largo))
        except Exception as ex:
            print(f"  {nome} NON aggiornata, resta la versione precedente: {ex}")
            errori += 1
            continue
        tessere = {}
        visti = set()
        for el in elementi:
            chiave = (el["type"], el["id"])
            if chiave in visti:
                continue
            visti.add(chiave)
            p = punto(el)
            if not p:
                continue
            tessere.setdefault(nome_tessera(*p), []).append(snellisci(el))
        if nome in vecchie:
            togli(nome)
            vecchie.remove(nome)
        cartella = slug(nome)
        shutil.rmtree(os.path.join(CARTELLA, cartella), ignore_errors=True)
        os.makedirs(os.path.join(CARTELLA, cartella))
        for t, els in tessere.items():
            with open(os.path.join(CARTELLA, cartella, t), "w") as f:
                json.dump({"elements": els}, f, separators=(",", ":"), ensure_ascii=False)
        indice["zone"][nome] = {
            "bbox": list(bbox),
            "scaricata": list(largo),
            "cartella": cartella,
            "aggiornato": adesso,
            "elementi": len(visti),
            "tessere": sorted(tessere),
        }
        dim = sum(os.path.getsize(os.path.join(CARTELLA, cartella, t)) for t in tessere)
        print(f"  {len(visti)} elementi in {len(tessere)} tessere ({dim // 1024} KB)")

    # Zone non più in ZONE: si tolgono quando tutte le province sono state scaricate
    if errori == 0:
        for nome in [k for k in indice["zone"] if k not in ZONE]:
            togli(nome)

    indice["fonte"] = "© OpenStreetMap contributors (ODbL)"
    with open(indice_path, "w") as f:
        json.dump(indice, f, indent=1, ensure_ascii=False)
    totale = sum(z.get("elementi", 0) for z in indice["zone"].values())
    print(f"Totale: {totale} elementi, {len(ZONE) - errori} zone aggiornate su {len(ZONE)}")

    # Per la notifica sull'iPhone: riga "zone aggiornate;zone totali" (vedi .github/workflows/pubblica.yml)
    if os.environ.get("ESITO"):
        with open(os.environ["ESITO"], "w") as f:
            f.write(f"{len(ZONE) - errori};{len(ZONE)}\n")
    if errori == len(ZONE):
        sys.exit(1)


if __name__ == "__main__":
    main()
