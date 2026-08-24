#!/usr/bin/env python3
"""Re-resuelve los promopack de Triple Vision desde los emails archivados en
Drive y los descarga a Assets/Triple Vision/{CATNO}.zip.

Uso:  ./tv-resolve-promopacks.py CITB019 RASTA008V ...

Es la primitiva de resolucion de la rama TV del pipeline. Lo que importa NO es
el curl (pelado basta: cero cabeceras, cero trucos de TLS) sino de donde sale
la URL:

  - TV sirve desde un bucket de DigitalOcean Spaces cuya clave lleva un sufijo
    -UTIMESTAMP=<ms> que es la VERSION del objeto. Cuando TV resube el
    promopack, la clave anterior deja de existir.
  - El bucket no da ListBucket al anonimo, asi que una clave inexistente
    responde 403 AccessDenied, no 404. 403 = "URL rancia, re-resuelve".
  - El href real vive detras de un tracker us.list-manage.com -> 302.
  - Un email posterior solo sustituye la URL si reapunta al MISMO
    order-item UUID. Los digests semanales mencionan muchos catnos pero sus
    links van a otros order-items: coger "el .html de fecha mas alta" a ciegas
    se lleva el ZIP equivocado.
"""
import os, re, subprocess, sys, urllib.parse

PRE = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-emontagut@telsnap.com/My Drive/"
    "Houseonly.store/Preorders")
DEST = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-emontagut@telsnap.com/My Drive/"
    "Houseonly.store/Assets/Triple Vision")

UA = "Mozilla/5.0"
TRACKER = re.compile(r'href="(https://us\.list-manage\.com/[^"]+)"')
DATE_IN_NAME = re.compile(r"__(\d{4}-\d{2}-\d{2})\.html$")


def curl(args, timeout=300):
    for _ in range(3):
        p = subprocess.run(["curl", "-sS", "--connect-timeout", "20",
                            "--max-time", str(timeout)] + args,
                           capture_output=True, text=True)
        if p.returncode == 0:
            return p.stdout
    return ""


def redirect_of(url):
    return curl(["-o", "/dev/null", "-w", "%{redirect_url}", "-A", UA, url]).strip()


def emails_for(catno):
    """Todos los TV__*.html que mencionan el catno, mas nuevo primero."""
    hits = []
    for name in os.listdir(PRE):
        if not name.startswith("TV__") or not name.endswith(".html"):
            continue
        path = os.path.join(PRE, name)
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            body = fh.read()
        if catno.lower() in body.lower() or catno.lower() in name.lower():
            m = DATE_IN_NAME.search(name)
            hits.append((m.group(1) if m else "0000-00-00", name, body))
    hits.sort(reverse=True)
    return hits


def promopacks_in(body):
    """Resuelve cada tracker y devuelve las URLs de promopack."""
    out = []
    for link in sorted(set(TRACKER.findall(body))):
        dest = redirect_of(link)
        if "promopack" in dest:
            out.append(dest)
    return out


def order_item_uuid(url):
    m = re.search(r"/order-items/([0-9a-f-]{36})/", url)
    return m.group(1) if m else None


def resolve(catno):
    """URL de promopack vigente para el catno."""
    mails = emails_for(catno)
    if not mails:
        return None, "sin email archivado"

    # El per-release (catno en el NOMBRE) fija el order-item UUID del catno.
    named = [m for m in mails if catno.lower() in m[1].lower()]
    anchor_uuid = None
    for date, name, body in named:
        packs = promopacks_in(body)
        if packs:
            anchor_uuid = order_item_uuid(packs[0])
            best = (date, name, packs[0])
            break
    else:
        return None, "ningun email per-release trae link de promopack"

    # Emails mas nuevos: si alguno reapunta el MISMO order-item, gana el nuevo.
    for date, name, body in mails:
        if date <= best[0]:
            continue
        for p in promopacks_in(body):
            if order_item_uuid(p) == anchor_uuid:
                best = (date, name, p)
                break
    return best, None


def main():
    catnos = [c.strip().upper() for c in sys.argv[1:] if c.strip()]
    if not catnos:
        print(__doc__.strip().split("\n\n")[1])
        return 2
    os.makedirs(DEST, exist_ok=True)
    ok = fail = 0
    for catno in catnos:
        print(f"\n=== {catno} ===")
        best, err = resolve(catno)
        if err:
            print(f"  x {err}")
            fail += 1
            continue
        date, name, url = best
        stamp = re.search(r"UTIMESTAMP=(\d+)", url)
        print(f"  email : {name}  ({date})")
        print(f"  clave : {urllib.parse.unquote(url.split('/')[-1])}")
        print(f"  stamp : {stamp.group(1) if stamp else 'SIN UTIMESTAMP'}")

        out = os.path.join(DEST, f"{catno}.zip")
        tmp = out + ".part"
        code = curl(["-L", "-o", tmp, "-w", "%{http_code}", url], timeout=900).strip()
        if code != "200":
            print(f"  x HTTP {code} — URL rancia, hace falta email mas nuevo")
            if os.path.exists(tmp):
                os.remove(tmp)
            fail += 1
            continue
        if subprocess.run(["unzip", "-tq", tmp],
                          capture_output=True).returncode != 0:
            bad = out.replace(".zip", ".INVALID.html")
            os.rename(tmp, bad)
            print(f"  x no es un ZIP valido -> {os.path.basename(bad)}")
            fail += 1
            continue
        os.replace(tmp, out)
        subprocess.run(["xattr", "-c", out], capture_output=True)
        size = os.path.getsize(out)
        listing = subprocess.run(["unzip", "-l", out],
                                 capture_output=True, text=True).stdout
        n = len([l for l in listing.splitlines()
                 if re.search(r"\d{2}-\d{2}-\d{4} \d{2}:\d{2}", l)])
        print(f"  v {catno}.zip  {size/1e6:.1f} MB  {n} ficheros  unzip -tq OK")
        ok += 1

    print(f"\ndescargados: {ok}   fallidos: {fail}")
    print(f"destino: {DEST}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
