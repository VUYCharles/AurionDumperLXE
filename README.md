# x-gcal

Exporte l'emploi du temps x x vers un fichier `.ics` ou synchronise automatiquement Google Agenda.

---

## Export rapide (aucune configuration)

```bash
git clone https://github.com/your-username/x-gcal
cd x-gcal
npm install
node export-ics.js
```

```
x username (email) : prenom.nom@enac.fr
x password         : **************
Weeks to export   [17]  : 17

  12-2026 ... 19 event(s)
  13-2026 ... 21 event(s)
  ...

147 event(s) exported to x-2026-03-17.ics
```

Importez le fichier `.ics` dans votre agenda :

- **Google Agenda** — Paramètres ⚙ → Importer et exporter → Importer
- **Apple Agenda** — Fichier → Importer
- **Outlook** — Fichier → Ouvrir et exporter → Importer/Exporter

---

## Automatisation sur LXC Proxmox

La synchronisation automatique repose sur `main.js`, qui écrit directement dans Google Agenda via l'API. Elle tourne quotidiennement sur un LXC Proxmox.

### 1. Créer le LXC

Dans l'interface Proxmox, créer un conteneur avec ces paramètres :

| Paramètre | Valeur |
|---|---|
| Template | ubuntu-22.04-standard |
| RAM | 1024 Mo |
| CPU | 2 cœurs |
| Disque | 8 Go |

Avant de démarrer : **Options → Features → cocher Nesting**.
Sans ça, Chromium ne peut pas s'exécuter dans le conteneur.

### 2. Installer le projet

```bash
# Depuis votre machine
scp x-gcal.zip root@<IP_LXC>:/opt/

# Sur le LXC
cd /opt && apt install -y unzip && unzip x-gcal.zip && cd x-gcal
bash scripts/setup-lxc.sh
```

Le script installe Node.js 20, Chromium et les dépendances, puis crée un service systemd avec un timer quotidien à 4h.

### 3. Configurer Google Agenda

Deux options :

**Service Account** (recommandé pour un serveur)

1. [console.cloud.google.com](https://console.cloud.google.com) → créer un projet → activer l'**API Google Calendar**
2. IAM → Comptes de service → Créer → télécharger la clé JSON → placer dans le projet
3. Google Agenda → Paramètres de l'agenda → Partager → ajouter l'email du service account avec les droits *"Modifier les événements"*

```js
const serviceAccountKeyFile = './service-account-key.json';
const oauth2Credentials     = null;
```

**OAuth2** (sur votre machine locale, pas le LXC)

```bash
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/oauth-setup.js
```

Ouvrez le lien affiché, autorisez, copiez le bloc dans `config.js`.

### 4. Créer config.js

```bash
cp config.example.js config.js
nano config.js
```

```js
const xurl            = 'https://x-prod.enac.fr/faces/Login.xhtml';
const username             = 'prenom.nom@enac.fr';
const password             = 'votre_mot_de_passe';
const weeksToScrape        = 17;               // ~4 mois
const googleCalendarId     = 'primary';        // ou l'ID d'un agenda secondaire
const consolidatedCalendarId = 'id2';          // agenda pour les blocs fusionnés
const consolidationGapMinutes = 20;
```

### 5. Tester

```bash
node main.js
```

### 6. Activer la sync automatique

```bash
systemctl start x-gcal.timer
systemctl status x-gcal.timer  # vérifie la prochaine exécution
tail -f logs/sync.log               # suit les logs en temps réel
```

La sync tourne tous les jours à 4h. Pour changer l'heure :

```bash
nano /etc/systemd/system/x-gcal.timer
# OnCalendar=*-*-* 06:00:00
systemctl daemon-reload && systemctl restart x-gcal.timer
```

### 7. Consolidation (optionnel)

`consolidate.js` fusionne les cours consécutifs séparés de moins de 20 minutes dans un agenda séparé. Lancé automatiquement après la sync par le service systemd.

---

## Dépannage

**Chromium crash** → vérifier que Nesting est activé dans les Features du LXC.

**`libasound.so.2` manquant** → `apt install -y libasound2`

**Erreur 404 Google Agenda** → `googleCalendarId` incorrect, ou agenda non partagé avec le service account.

**Semaine vide (ICS 133 octets)** → comportement normal pour une semaine sans cours.

---

## Licence

MIT
