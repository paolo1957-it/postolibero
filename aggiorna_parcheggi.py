#!/usr/bin/env python3
"""
PostoLibero – scarica una volta alla settimana i parcheggi di OpenStreetMap
per le zone usate più spesso e li salva nel sito, divisi in "tessere".

Lo esegue GitHub da solo (vedi .github/workflows/pubblica.yml).
Per aggiungere una città basta aggiungere una riga in ZONE qui sotto:
    "nome": (latitudine sud, longitudine ovest, latitudine nord, longitudine est)
I valori si trovano su https://bboxfinder.com
"""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ZONE = {
    # Pavia con Travacò Siccomario (a sud, fino al Po) e Villanova d'Ardenghi (a ovest);
    # comprende anche San Martino Siccomario, Carbonara al Ticino e parte di Zerbolò
    "Pavia": (45.100, 9.010, 45.260, 9.215),
    "Milano": (45.380, 9.030, 45.540, 9.290),
    # Varese e Biandronno in un'unica zona: comprende anche i paesi in mezzo
    # (Gavirate, Comerio, Barasso, Casciago, Luvinate…) e la sponda del lago di Varese
    "Varese e Biandronno": (45.770, 8.675, 45.880, 8.890),
}

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
    b = f"({s},{w},{n},{e})"
    return f"""[out:json][timeout:300][maxsize:536870912];
(
  nwr["amenity"="parking"]{b};
  nwr["amenity"="parking_space"]{b};
  node["amenity"="parking_entrance"]{b};
);
out tags geom;
way{b}["highway"]->.strade;
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
                with urllib.request.urlopen(req, timeout=360) as r:
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

    errori = 0
    for nome, (s, w, n, e) in ZONE.items():
        print(f"{nome}…")
        try:
            elementi = scarica(query(s, w, n, e))
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
        # cancella le tessere vecchie di questa zona e scrive le nuove
        vecchie = set((indice["zone"].get(nome) or {}).get("tessere", []))
        for t in vecchie - set(tessere):
            try:
                os.remove(os.path.join(CARTELLA, t))
            except FileNotFoundError:
                pass
        for t, els in tessere.items():
            with open(os.path.join(CARTELLA, t), "w") as f:
                json.dump({"elements": els}, f, separators=(",", ":"), ensure_ascii=False)
        indice["zone"][nome] = {
            "bbox": [s, w, n, e],
            "aggiornato": adesso,
            "elementi": len(visti),
            "tessere": sorted(tessere),
        }
        print(f"  {len(visti)} elementi in {len(tessere)} tessere")

    with open(indice_path, "w") as f:
        json.dump(indice, f, indent=1, ensure_ascii=False)
    if errori == len(ZONE):
        sys.exit(1)


if __name__ == "__main__":
    main()
