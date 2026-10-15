#!/usr/bin/env python3
"""
PostoLibero – raccoglie le Zone a Traffico Limitato (ZTL) della Lombardia e le salva in ztl.json.

Lo esegue GitHub da solo una volta alla settimana (vedi .github/workflows/pubblica.yml).

Fonti, dalla più affidabile:
  1. Open data ufficiali dei Comuni (Milano, Bergamo, Cremona)
  2. Mappa dei varchi del Comune di Pavia (Google My Maps, esportata in KML)
  3. OpenStreetMap: aree "boundary=limited_traffic_zone" in tutta la Lombardia
     (solo dove il Comune non pubblica dati propri)

Ogni area in ztl.json ha: tipo ("ztl", "pedonale", "area_c"), nome, città, fonte.
I varchi (telecamere) sono punti con tipo "varco".
Se una fonte non risponde, si tiene quello che c'era la volta prima.
"""
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

USER_AGENT = "PostoLibero/1.0 (https://github.com/paolo1957-it/postolibero)"
FILE_USCITA = "ztl.json"

MILANO_AREE = ("https://dati.comune.milano.it/dataset/d7d9179a-8228-427f-9c86-1e30154be4fe/resource/"
               "d788b26b-31b4-4e57-992d-276a1280c8c2/download/disciplina_aree.geojson")
MILANO_VARCHI = ("https://dati.comune.milano.it/dataset/4cad1605-8225-4ecd-9b82-868b3af453e5/resource/"
                 "fa8fcc31-1722-4a50-a0ae-ce7b9c0d0361/download/ingressi_areac_varchi.geojson")
LOMBARDIA = "https://www.dati.lombardia.it"
# Dataset di dati.lombardia.it (si provano i codici in ordine: dataset e mappa)
SOCRATA = {
    "Bergamo": ["tkwz-spd9", "d9mg-gia6"],
    "Cremona": ["ewi5-vb8j"],
}
SOCRATA_VARCHI = {"Cremona": ["hsmb-ribt"]}
PAVIA_KML = "https://www.google.com/maps/d/kml?mid=1eReo-T1Z3Ws45IpsyAMHSMx5G4g&forcekml=1"

OVERPASS = [
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
QUERY_OSM = """[out:json][timeout:300];
area["ISO3166-2"="IT-25"]["admin_level"="4"]->.lom;
(
  relation["boundary"="limited_traffic_zone"](area.lom);
  way["boundary"="limited_traffic_zone"](area.lom);
);
out tags geom;"""


# ---------- Download ----------

def scarica(url, dati=None, tentativi=3, timeout=120):
    ultimo = None
    for i in range(tentativi):
        try:
            req = urllib.request.Request(url, data=dati, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as ex:
            ultimo = ex
            print(f"    {url[:90]}: {ex}")
            time.sleep(10 * (i + 1))
    raise RuntimeError(ultimo)


def scarica_json(url, **kw):
    return json.loads(scarica(url, **kw).decode("utf-8-sig"))


# ---------- Geometria ----------

def utm32_a_wgs84(x, y):
    """Coordinate UTM fuso 32 nord (EPSG:32632) → latitudine, longitudine."""
    a, f = 6378137.0, 1 / 298.257223563
    k0, e2 = 0.9996, f * (2 - f)
    ep2 = e2 / (1 - e2)
    x -= 500000.0
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu))
    n1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    t1 = math.tan(phi1) ** 2
    c1 = ep2 * math.cos(phi1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (
        d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6
           + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(phi1)
    return math.degrees(lat), 9.0 + math.degrees(lon)


def converti_coordinate(geom):
    """Porta la geometria in gradi (lon, lat). Riconosce le coordinate UTM 32N in metri."""
    def primo(c):
        while isinstance(c, list) and c and isinstance(c[0], list):
            c = c[0]
        return c
    p = primo(geom.get("coordinates"))
    if not p:
        return None
    if abs(p[0]) <= 180 and abs(p[1]) <= 90:
        return geom
    if 200000 < p[0] < 900000 and 4000000 < p[1] < 5500000:
        def conv(c):
            if c and isinstance(c[0], (int, float)):
                lat, lon = utm32_a_wgs84(c[0], c[1])
                return [lon, lat]
            return [conv(x) for x in c]
        return {"type": geom["type"], "coordinates": conv(geom["coordinates"])}
    print(f"    coordinate in un sistema non riconosciuto ({p[:2]}): scartate")
    return None


def semplifica(punti, tolleranza=0.00002):
    """Douglas-Peucker su [lon, lat] (circa 2 metri)."""
    if len(punti) < 4:
        return punti
    def dist(p, a, b):
        if a == b:
            return math.hypot(p[0] - a[0], p[1] - a[1])
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
    tieni = [False] * len(punti)
    tieni[0] = tieni[-1] = True
    pila = [(0, len(punti) - 1)]
    while pila:
        i, j = pila.pop()
        mx, k = 0, None
        for n in range(i + 1, j):
            d = dist(punti[n], punti[i], punti[j])
            if d > mx:
                mx, k = d, n
        if k is not None and mx > tolleranza:
            tieni[k] = True
            pila += [(i, k), (k, j)]
    return [p for p, t in zip(punti, tieni) if t]


def pulisci_anello(anello):
    a = [[round(p[0], 6), round(p[1], 6)] for p in anello]
    a = semplifica(a)
    if a[0] != a[-1]:
        a.append(a[0])
    return a if len(a) >= 4 else None


def poligoni_da_geometria(geom):
    """Restituisce una lista di poligoni [[anello esterno, buchi…], …] in lon/lat."""
    if not geom:
        return []
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "Polygon":
        polis = [c]
    elif t == "MultiPolygon":
        polis = c
    else:
        return []
    out = []
    for poli in polis:
        anelli = [pulisci_anello(a) for a in poli if a and len(a) >= 4]
        anelli = [a for a in anelli if a]
        if anelli:
            out.append(anelli)
    return out


def centro(poligoni):
    xs = [p[0] for poli in poligoni for p in poli[0]]
    ys = [p[1] for poli in poligoni for p in poli[0]]
    return (min(ys) + max(ys)) / 2, (min(xs) + max(xs)) / 2


def bbox(poligoni):
    xs = [p[0] for poli in poligoni for p in poli[0]]
    ys = [p[1] for poli in poligoni for p in poli[0]]
    return [round(min(ys), 6), round(min(xs), 6), round(max(ys), 6), round(max(xs), 6)]


def anelli_da_segmenti(segmenti):
    """Unisce i tratti di un multipoligono OSM in anelli chiusi."""
    segs = [list(s) for s in segmenti if len(s) >= 2]
    anelli = []
    while segs:
        anello = segs.pop(0)
        cambiato = True
        while anello[0] != anello[-1] and cambiato:
            cambiato = False
            for i, s in enumerate(segs):
                if s[0] == anello[-1]:
                    anello += s[1:]
                elif s[-1] == anello[-1]:
                    anello += s[::-1][1:]
                elif s[-1] == anello[0]:
                    anello = s[:-1] + anello
                elif s[0] == anello[0]:
                    anello = s[::-1][:-1] + anello
                else:
                    continue
                segs.pop(i)
                cambiato = True
                break
        if anello[0] == anello[-1] and len(anello) >= 4:
            anelli.append(anello)
    return anelli


# ---------- Fonti ----------

def area(tipo, nome, citta, fonte, poligoni, **extra):
    if not poligoni:
        return None
    a = {"tipo": tipo, "nome": nome or "", "citta": citta, "fonte": fonte,
         "bbox": bbox(poligoni), "poligoni": poligoni}
    a.update({k: v for k, v in extra.items() if v})
    return a


def da_milano():
    print("Milano (open data del Comune)…")
    gj = scarica_json(MILANO_AREE)
    oggi = datetime.now().strftime("%Y-%m-%d")
    tipi = {"ZTL": "ztl", "AP": "pedonale", "AREA_C": "area_c"}   # Area B e corsie riservate escluse
    out = []
    for f in gj.get("features", []):
        p = f.get("properties") or {}
        tipo = tipi.get(str(p.get("tipo", "")).strip().upper())
        if not tipo:
            continue
        fine = str(p.get("val_fine") or "")[:10]
        if fine and re.match(r"\d{4}-\d{2}-\d{2}", fine) and fine < oggi:
            continue        # zona sospesa
        polis = poligoni_da_geometria(converti_coordinate(f.get("geometry") or {}))
        nome = (p.get("nome") or "").strip()
        a = area(tipo, nome, "Milano", "Comune di Milano – open data (CC BY 4.0)", polis,
                 deroghe=(p.get("deroghe") or "").strip()[:300])
        if a:
            out.append(a)
    print(f"  {len(out)} aree")
    return out


def varchi_milano():
    gj = scarica_json(MILANO_VARCHI)
    out = []
    for f in gj.get("features", []):
        g = converti_coordinate(f.get("geometry") or {})
        if g and g.get("type") == "Point":
            lon, lat = g["coordinates"][:2]
            out.append({"tipo": "varco", "nome": "Varco Area C " + str((f.get("properties") or {}).get("label") or ""),
                        "citta": "Milano", "fonte": "Comune di Milano – open data (CC BY 4.0)",
                        "lat": round(lat, 6), "lon": round(lon, 6)})
    print(f"  {len(out)} varchi di Area C")
    return out


def socrata_geojson(codice):
    for url in (f"{LOMBARDIA}/resource/{codice}.geojson?$limit=5000",
                f"{LOMBARDIA}/api/geospatial/{codice}?method=export&format=GeoJSON"):
        try:
            gj = scarica_json(url, tentativi=2)
            if gj.get("features"):
                return gj
        except Exception:
            pass
    return None


def nome_da_proprieta(p, predefinito):
    for k in ("nome", "name", "denominazione", "descrizione", "descr", "zona", "denominaz", "nome_ztl"):
        for kk, v in p.items():
            if kk.lower() == k and v:
                return str(v).strip()
    return predefinito


def da_socrata():
    out = []
    for citta, codici in SOCRATA.items():
        print(f"{citta} (dati.lombardia.it)…")
        gj = None
        for c in codici:
            gj = socrata_geojson(c)
            if gj:
                break
        if not gj:
            print("  nessun dato")
            continue
        n = 0
        for f in gj["features"]:
            polis = poligoni_da_geometria(converti_coordinate(f.get("geometry") or {}))
            a = area("ztl", nome_da_proprieta(f.get("properties") or {}, "ZTL " + citta), citta,
                     f"Comune di {citta} – dati.lombardia.it", polis)
            if a:
                out.append(a)
                n += 1
        print(f"  {n} aree")
    return out


def varchi_socrata():
    out = []
    for citta, codici in SOCRATA_VARCHI.items():
        for c in codici:
            gj = socrata_geojson(c)
            if not gj:
                continue
            for f in gj["features"]:
                g = converti_coordinate(f.get("geometry") or {})
                if g and g.get("type") == "Point":
                    lon, lat = g["coordinates"][:2]
                    out.append({"tipo": "varco", "nome": nome_da_proprieta(f.get("properties") or {}, "Varco ZTL"),
                                "citta": citta, "fonte": f"Comune di {citta} – dati.lombardia.it",
                                "lat": round(lat, 6), "lon": round(lon, 6)})
            print(f"  {citta}: {len(out)} varchi")
            break
    return out


def da_kml(testo, citta, fonte):
    """Legge una mappa Google My Maps: poligoni = aree ZTL, punti = varchi."""
    radice = ET.fromstring(testo)
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    aree, varchi = [], []
    def coordinate(s):
        pts = []
        for t in s.split():
            v = t.split(",")
            if len(v) >= 2:
                pts.append([float(v[0]), float(v[1])])
        return pts
    for pm in radice.iter("{http://www.opengis.net/kml/2.2}Placemark"):
        nome = (pm.findtext("k:name", default="", namespaces=ns) or "").strip()
        cartella = ""
        for poly in pm.iter("{http://www.opengis.net/kml/2.2}Polygon"):
            est = poly.find(".//k:outerBoundaryIs//k:coordinates", ns)
            if est is None:
                continue
            anelli = [coordinate(est.text or "")]
            for inn in poly.findall(".//k:innerBoundaryIs//k:coordinates", ns):
                anelli.append(coordinate(inn.text or ""))
            tipo = "pedonale" if re.search(r"pedonal|blu", nome, re.I) else "ztl"
            a = area(tipo, nome or ("ZTL " + citta), citta, fonte,
                     poligoni_da_geometria({"type": "Polygon", "coordinates": anelli}))
            if a:
                aree.append(a)
        for pt in pm.iter("{http://www.opengis.net/kml/2.2}Point"):
            c = coordinate(pm.findtext(".//k:Point/k:coordinates", default="", namespaces=ns))
            if c:
                varchi.append({"tipo": "varco", "nome": nome or "Varco ZTL", "citta": citta, "fonte": fonte,
                               "lat": round(c[0][1], 6), "lon": round(c[0][0], 6)})
    return aree, varchi


def leggi_kml(dati):
    """Accetta sia KML sia KMZ (KML compresso)."""
    if dati[:2] == b"PK":
        import io, zipfile
        with zipfile.ZipFile(io.BytesIO(dati)) as z:
            nome = next(n for n in z.namelist() if n.lower().endswith(".kml"))
            return z.read(nome)
    return dati


def da_pavia():
    print("Pavia (mappa dei varchi del Comune)…")
    if os.path.exists("ztl-pavia.kml"):          # copia caricata a mano nel sito
        with open("ztl-pavia.kml", "rb") as f:
            testo = leggi_kml(f.read())
    else:
        testo = leggi_kml(scarica(PAVIA_KML, tentativi=2))
    aree, varchi = da_kml(testo, "Pavia", "Comune di Pavia – mappa dei varchi")
    print(f"  {len(aree)} aree, {len(varchi)} varchi")
    for a in aree:
        print(f"    area: {a['nome']}")
    return aree, varchi


def da_osm():
    print("OpenStreetMap (tutta la Lombardia)…")
    dati = urllib.parse.urlencode({"data": QUERY_OSM}).encode()
    js = None
    for url in OVERPASS:
        try:
            js = json.loads(scarica(url, dati=dati, tentativi=1, timeout=360).decode("utf-8"))
            if isinstance(js.get("elements"), list):
                break
        except Exception:
            js = None
    if not js:
        raise RuntimeError("nessun server Overpass ha risposto")
    out = []
    for el in js["elements"]:
        tags = el.get("tags") or {}
        if el["type"] == "way":
            anello = [[p["lon"], p["lat"]] for p in el.get("geometry") or []]
            polis = poligoni_da_geometria({"type": "Polygon", "coordinates": [anello]})
        else:
            esterni = [[[p["lon"], p["lat"]] for p in m.get("geometry") or [] if p]
                       for m in el.get("members") or [] if m.get("type") == "way" and m.get("role") != "inner"]
            interni = [[[p["lon"], p["lat"]] for p in m.get("geometry") or [] if p]
                       for m in el.get("members") or [] if m.get("type") == "way" and m.get("role") == "inner"]
            buchi = anelli_da_segmenti(interni)
            polis = []
            for e in anelli_da_segmenti(esterni):
                polis += poligoni_da_geometria({"type": "Polygon", "coordinates": [e] + buchi})
        citta = tags.get("addr:city") or tags.get("is_in:city") or ""
        a = area("ztl", tags.get("name") or "ZTL", citta, "© OpenStreetMap contributors", polis,
                 orari=tags.get("opening_hours") or "")
        if a:
            out.append(a)
    print(f"  {len(out)} aree")
    return out


def dentro_bbox(lat, lon, b):
    return b[0] <= lat <= b[2] and b[1] <= lon <= b[3]


def main():
    try:
        with open(FILE_USCITA) as f:
            precedente = json.load(f)
    except Exception:
        precedente = {"aree": [], "varchi": []}

    def vecchie(fonte_contiene):
        return ([a for a in precedente.get("aree", []) if fonte_contiene in a.get("fonte", "")],
                [v for v in precedente.get("varchi", []) if fonte_contiene in v.get("fonte", "")])

    aree, varchi, riuscite = [], [], 0
    fonti = [
        ("Milano", lambda: (da_milano(), varchi_milano())),
        ("dati.lombardia.it", lambda: (da_socrata(), varchi_socrata())),
        ("Pavia", da_pavia),
    ]
    for chiave, fn in fonti:
        try:
            a, v = fn()
            if not a and not v:
                raise RuntimeError("nessun dato")
            aree += a
            varchi += v
            riuscite += 1
        except Exception as ex:
            va, vv = vecchie(chiave)
            print(f"  {chiave} non aggiornata ({ex}): tengo {len(va)} aree della volta prima")
            aree += va
            varchi += vv

    # OpenStreetMap solo dove i Comuni non pubblicano dati propri
    ufficiali = [a["bbox"] for a in aree]
    try:
        osm = da_osm()
        riuscite += 1
    except Exception as ex:
        osm = vecchie("OpenStreetMap")[0]
        print(f"  OpenStreetMap non aggiornata ({ex}): tengo {len(osm)} aree della volta prima")
    aggiunte = 0
    for a in osm:
        lat, lon = centro(a["poligoni"])
        if any(dentro_bbox(lat, lon, b) for b in ufficiali):
            continue
        aree.append(a)
        aggiunte += 1
    print(f"OpenStreetMap: {aggiunte} aree aggiunte dove mancano i dati dei Comuni")

    if not aree and not varchi:
        print("Nessuna ZTL trovata: ztl.json non viene toccato")
        sys.exit(1 if riuscite == 0 else 0)
    uscita = {
        "aggiornato": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "aree": aree,
        "varchi": varchi,
    }
    with open(FILE_USCITA, "w", encoding="utf-8") as f:
        json.dump(uscita, f, separators=(",", ":"), ensure_ascii=False)
    print(f"Salvate {len(aree)} aree e {len(varchi)} varchi in {FILE_USCITA} "
          f"({os.path.getsize(FILE_USCITA) // 1024} KB)")


if __name__ == "__main__":
    main()
