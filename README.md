# MySQL → PostgreSQL Data Migrator

Web aplikacija koja **kopira podatke** iz MySQL baze u PostgreSQL bazu čija je
šema već kreirana (npr. Prisma migracijama). Aplikacija sama **ne kreira šemu**
— automatski mapira tabele i kolone (`users` → `"User"`, `is_active` →
`"isActive"`), kopira redove u FK-sigurnom redoslijedu, re-sinhronizira
identity sekvence i na kraju validira rezultat.

## Treba li aplikaciji baza?

**Ne.** Aplikacija se spaja direktno na tvoj MySQL i tvoj PostgreSQL sa
podacima koje uneseš u UI — za rad joj nije potreban nijedan drugi servis.

Dvije "udobne" funkcije (sačuvani profili konekcija i istorija migracijskih
runova) čuvaju se u **jednom JSON fajlu** (`store.json`) koji se defaultno
pohranjuje u Docker volume `migration_store`. U tom volume-u se čuvaju
enkriptovane lozinke profila (AES-256-GCM, ključ = `MIGRATOR_SECRET`).

Zbog toga `docker-compose.yml` ima **samo jedan servis** — nema postgresql
kontejnera.

---

## Šta trebaš prije pokretanja

1. **Docker** (+ Compose plugin) na serveru.
2. **Traefik** koji već radi i spojen je na Docker mrežu **`web`**, sa:
   - entrypointima `web` (80) i `websecure` (443),
   - Let’s Encrypt resolverom pod nazivom **`le`** (`certificatesResolvers.le...`).
3. **DNS record**: `migration.ba101.top` → IP tvog servera (A zapis).
   Otvoreni portovi `80/tcp` i `443/tcp` na serveru (HTTP-01 challenge).
4. **Dostupnost baza**:
   - Kontejner mora moći doći do MySQL-a i PostgreSQL-a koje migriraš —
     host mora biti javno dostupan, ili baza treba biti na nekoj zajedničkoj
     Docker mreži. Vidi sekciju "Dostup do baza".

---

## Pokretanje na svom Dockeru

```bash
# 1. Prebaci projekt na server (git clone ili kopiraj folder),
#    zatim uđi u njega:
cd <folder-projekta>

# 2. Kreiraj web mrežu ako Traefik nije već (ignore ako postoji):
docker network create web

# 3. Postavi tajni ključ za enkripciju profila (u .env fajl pored compose-a):
echo "MIGRATOR_SECRET=$(openssl rand -hex 32)" > .env

# 4. Buildaj i pokreni:
docker compose build --no-cache
docker compose up -d

# 5. Prati logove dok Let’s Encrypt izda certifikat:
docker compose logs -f
docker logs -f <ime-traefik-kontejnera>
```

Aplikacija je nakon toga dostupna na **https://migration.ba101.top**.

### Update aplikacije na novu verziju

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

Profili i istorija ostaju sačuvani (volume se ne dira).

---

## Šta i gdje mijenjati

Sve se mijenja u **`docker-compose.yml`** (osim tajnog ključa u `.env`):

| Želim promijeniti… | Gdje / kako |
| --- | --- |
| **Domenu** | Label `Host(\`migration.ba101.top\`)` — zamijeni u oba routera (ima ih dva: `migration-app` i `migration-app-http`). |
| **IME cert resolvera** | Label `...tls.certresolver=le` — ako se tvoj resolver zove drugačije (npr. `myresolver`), zamijeni. |
| **Eksternu mrežu** | Sekcija `networks:` na dnu fajla (`name: web`) — mora biti **external** i ista mreža na kojoj je Traefik. |
| **Entrypointe** | Labeli `entrypoints=websecure` / `web` — prilagodi nazivima u svom `traefik.yml`. |
| **Tajni ključ profila** | `MIGRATOR_SECRET` — postavi u `.env` fajlu pored compose-a (vidi korak 3). NIKAD ga ne commitaj. |
| **Lokaciju JSON store-a** | Env `STORE_PATH` + volume mapiranje `migration_store:/data`. |
| **Privremeni (nepersistentni) store** | Obriši cijeli blok `volumes:` ispod servisa i sekciju `volumes:` na dnu — profili/istorija se gube pri rekreaciji kontejnera, aplikacija radi normalno. |
| **Self-test enginea** | Otkomentariši `DATABASE_URL` u compose-u i usmjeri na bilo koju testnu PostgreSQL bazu. Opcionalno. |

> ⚠️ Ako promijeniš `MIGRATOR_SECRET` **nakon** što si sačuvao profile,
> stare lozinke se više ne mogu dekriptovati — profili će ostati sačuvani,
> ali ćeš morati ponovo unijeti lozinke. Izaberi ključ jednom i zadrži ga.

---

## Dostup do baza (česte zamke)

Aplikacija iz kontejnera otvara konekcije na **MySQL (port 3306)** i
**PostgreSQL (port 5432)** koje migriraš:

- **Baza na javno dostupnom serveru:** samo uneseš host/port u UI. Pazi da
  firewall i MySQL/PG ACL dozvole konekcije sa IP adrese ovog servera.
- **Baza na istom Docker hostu, u kontejneru:** najlakše — spoji taj projekt
  na mrežu `web` i koristi ime kontejnera kao host (npr. `mysql-host`).
- **Baza na samom hostu (localhost izvan Dockera):** unesi
  `host.docker.internal` kao host. Na Linuxu to zahtijeva dodatak u compose
  ispod servisa:
  ```yaml
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```
  I bazu podesi da sluša na host interfejsu, ne samo `127.0.0.1`.
- **Remote baze:** provjeri dugme **Test connection** u UI prije analize —
  aplikacija vraća tačnu grešku konekcije (auth, SSL, timeout…).

Lozinke koje uneseš u formular **nigdje se ne čuvaju** osim ako eksplicitno
klikneš *Save as profile* — tada se AES-256-GCM enkriptuju u `store.json`.

---

## Kako aplikacija radi (tok migracije)

1. **Connect** — uneseš podatke za MySQL (source, read-only) i PostgreSQL
   (target), testiraš konekcije.
2. **Analyze & select** — introspekcija obje baze, automatsko mapiranje
   tabela/kolona, checkbox selekcija tabela koje se migriraju, opcije
   (TRUNCATE, ON CONFLICT, re-sync sekvenci…).
3. **Migrate** — streaming kopiranje po tabelama u FK-sigurnom redoslijedu,
   live progress + log, mogućnost stopiranja.
4. **Validate** — poređenje broja redova MySQL vs PostgreSQL i provjera da je
   svaka identitet sekvenca iznad najvećeg PK-a (ono što inače obara Prisma
   `autoincrement()` nakon migracije podataka). Uz raport dobiješ i checklist
   Prisma koraka (`prisma validate`, `db pull`, `migrate status`, `generate`).

---

## Troubleshooting

| Problem | Provjera |
| --- | --- |
| 404 / "Bad gateway" na domenu | `docker compose ps` (kontejner running?), `docker inspect` kontejnera — da li je mreža `web` povezana, da li Traefik vidi labels (`docker logs <traefik>`). |
| Nema certifikata (self-signed) | DNS je propagiran? Portovi 80/443 otvoreni? Ime resolvera (`le`) se poklapa s tvojim Traefikom? |
| "ECONNREFUSED" na Test connection | Vidi sekciju "Dostup do baza" gore — kontejner ne vidi tvoju bazu. |
| Profili nestali nakon `up -d --force-recreate` | Volume je obrisan ili si mjenjao/uklonio mount; `docker volume ls`. |
| App se ne diže | `docker compose logs migration-app` — vidi grešku pri startu. |

## Razvoj lokalno (bez Dockera)

```bash
npm ci
npm run dev        # http://localhost:3000
```

Nije potrebna nikakva baza; store fajl nastaje kao `.migrator-store.json` u
korijenu projekta.
