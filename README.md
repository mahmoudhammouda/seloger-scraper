# seloger-scraper

Scraper SeLoger avec Playwright et interception API CDP — paramètres anti-bot avancés.  
Extraction des URLs d’annonces, interception réseau (/api/), screenshot, et logs.

## Configuration proxy (iproyal ou autre)
1. Copie `src/config.example.json` en `src/config.json` (git ignore `config.json`).
2. Renseigne tes identifiants proxy :
   - `proxy.server` (ex: `http://geo.iproyal.com:12321`)
   - `proxy.username`
   - `proxy.password`
3. Ajuste `targetUrl` si nécessaire (secteur/type de bien/page).

## Installation & exécution
```bash
cd src
npm install
npx tsc -p tsconfig.json
node scraper.js
```

## Sorties générées
- `output/urls.json` : URLs d’annonces extraites + titre de page + source.
- `output/api_calls.json` : appels API interceptés (URL, status, timestamp).
- `output/logs.log` : logs internes en texte simple.
- `output/screenshot.png` : capture pleine page.
