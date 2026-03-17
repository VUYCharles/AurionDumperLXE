# aurion-gcal

Synchronise automatiquement l'emploi du temps Aurion ENAC vers Google Agenda.

Le script se connecte à Aurion, navigue semaine par semaine dans le planning, télécharge l'export ICS de chaque semaine et insère les événements dans Google Agenda. Conçu pour tourner en tâche planifiée quotidienne sur un LXC Proxmox.

---

## Pourquoi c'est compliqué

Aurion est construit sur **PrimeFaces (JSF)**. Chaque requête porte un token `javax.faces.ViewState` à usage unique qui encode l'état côté serveur. Les approches simples échouent toutes :

| Approche | Problème |
|---|---|
| Écrire dans `form:week` puis POST | Le ViewState encode toujours la semaine courante — le serveur l'ignore |
| Réutiliser un ViewState | Il est consommé au premier appel, les suivants retournent des données périmées |
| Recharger la page avant chaque semaine | Remet le navigateur à la semaine réelle, les clics s'accumulent mais la position repart de zéro |
| Intercepter l'ICS dans Puppeteer | Le browser consomme la réponse `application/octet-stream` avant que JS puisse y accéder |
| Lire `form:week` pour connaître la position | PrimeFaces ne met pas à jour ce champ après une navigation Ajax |

**Ce qui fonctionne** : charger la page une seule fois, avancer d'un clic `fc-next-button` par semaine (ce qui met à jour le ViewState côté serveur), lire la position depuis le titre FullCalendar, puis rejouer le POST du bouton Download via `node-fetch` avec les cookies et le ViewState courant.

---

## Installation sur LXC Proxmox

### 1. Créer le conteneur

- Template : Ubuntu 22.04
- RAM : 1024 Mo, CPU : 2 cœurs, Disque : 8 Go
- **Obligatoire** : `Options → Features → Nesting: activé`
  *(sans ça, Chromium refuse de démarrer dans un conteneur non privilégié)*

### 2. Installer

```bash
# Depuis votre machine
scp aurion-gcal.zip root@<IP_LXC>:/opt/

# Sur le LXC
cd /opt && apt install -y unzip && unzip aurion-gcal.zip && cd aurion-gcal
bash scripts/setup-lxc.sh
```

Le script installe Node.js 20, Chromium et les dépendances npm, puis configure un service systemd avec un timer quotidien à 4h.

### 3. Configurer

```bash
cp config.example.js config.js
nano config.js
```

### 4. Tester et activer

```bash
node main.js                      # test manuel
systemctl start aurion-gcal.timer # activer la sync quotidienne
```

---

## Authentification Google

Deux méthodes disponibles, choisissez-en une.

### Service Account (recommandé pour un serveur)

1. [Google Cloud Console](https://console.cloud.google.com) → créer un projet → activer l'**API Google Calendar**
2. *IAM → Comptes de service → Créer* → télécharger la clé JSON
3. Dans Google Agenda, partager votre agenda avec l'email du service account (droits : *"Modifier les événements"*)
4. Dans `config.js` :

```js
const serviceAccountKeyFile = './service-account-key.json';
const oauth2Credentials     = null;
```

### OAuth2 (usage personnel)

À faire **sur votre machine locale** (pas le LXC) :

```bash
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/oauth-setup.js
```

Créez d'abord un client OAuth2 de type *Application Web* avec `http://localhost:3000/oauth2callback` comme URI de redirection, et ajoutez votre email en utilisateur test dans l'écran de consentement.

Copiez le bloc affiché dans `config.js` :

```js
const serviceAccountKeyFile = '';
const oauth2Credentials = {
  clientId:     '...',
  clientSecret: '...',
  redirectUri:  'http://localhost:3000/oauth2callback',
  refreshToken: '...',
};
```

---

## Configuration

```js
const aurionUrl        = 'https://aurion-prod.enac.fr/faces/Login.xhtml';
const username         = 'prenom.nom@enac.fr';
const password         = 'votre_mot_de_passe';

// Calcule automatiquement le nombre de semaines couvrant les 4 prochains mois
const weeksToScrape = (() => {
  const now = new Date(), end = new Date(now);
  end.setMonth(end.getMonth() + 4);
  return Math.ceil((end - now) / (7 * 24 * 60 * 60 * 1000));
})();

const googleCalendarId = 'primary'; // ou l'ID d'un agenda secondaire

const useTor  = false; // activer si votre IP est bloquée par Aurion
const torPort = 9050;
```

---

## Modifier l'heure de synchronisation

```bash
nano /etc/systemd/system/aurion-gcal.timer
# Modifier : OnCalendar=*-*-* 04:00:00

systemctl daemon-reload && systemctl restart aurion-gcal.timer
tail -f logs/sync.log
```

---

## Dépannage

**Chromium crash au démarrage** → activer `Nesting` dans les Features du LXC Proxmox.

**`libasound.so.2` manquant** → `apt install -y libasound2`

**Erreur 404 Google Calendar** → vérifier `googleCalendarId` dans `config.js`. Utiliser `'primary'` pour l'agenda principal, ou partager l'agenda avec le service account.

**Semaine vide (ICS de 133 octets)** → comportement normal, Aurion retourne un ICS vide pour les semaines sans cours (vacances, fin de cursus).

---

## Usage ponctuel

Pour une synchronisation manuelle sans configuration permanente :

```bash
node sync-once.js
```

Le script demande interactivement les identifiants Aurion, les credentials OAuth2 Google et l'ID de l'agenda cible, puis effectue la sync et quitte. Aucun fichier `config.js` requis.

Le refresh token s'obtient une seule fois avec :

```bash
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/oauth-setup.js
```

---

## Consolidation

Un second script fusionne les événements consécutifs de l'agenda source dans un agenda séparé.

Deux événements sont fusionnés si l'écart entre eux est inférieur ou égal à 20 minutes. Le bloc résultant couvre le début du premier et la fin du dernier événement. Les titres sont concaténés.

**Configuration** dans `config.js` :

```js
const consolidatedCalendarId  = 'xxx@group.calendar.google.com'; // agenda de destination
const consolidationGapMinutes = 20; // seuil en minutes (modifiable)
```

**Lancement** :

```bash
node consolidate.js          # consolidation seule
npm run sync-all             # sync Aurion + consolidation enchaînées
```

La consolidation est automatiquement enchaînée après la sync dans le service systemd installé par `setup-lxc.sh`.

---

## Structure

```
aurion-gcal/
├── main.js                   Sync Aurion → Google Agenda (mode automatique)
├── sync-once.js              Sync interactive one-shot (sans config.js)
├── consolidate.js            Fusion des blocs consécutifs
├── config.example.js         Template de configuration
├── src/
│   ├── scraper.js            Scraping Aurion via Puppeteer
│   ├── google-calendar.js    Client API Google Agenda
│   └── consolidate.js        Logique de fusion et écriture
├── scripts/
│   ├── setup-lxc.sh          Installation automatique sur LXC
│   └── oauth-setup.js        Obtenir un refresh token OAuth2
├── Dockerfile
└── docker-compose.yml
```

---

## Licence

MIT
