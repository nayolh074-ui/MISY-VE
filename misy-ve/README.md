# MISY VE ? — le vrai projet (avec backend)

Site pour trouver les produits disponibles dans les commerces locaux à Madagascar.
Cette version remplace le prototype : **les données sont maintenant partagées entre tous les visiteurs**, les vendeurs ont de vrais comptes, et l'administrateur valide les boutiques.

## Ce qui est inclus

| Fonction | Détail |
|---|---|
| Catalogue public | Recherche (insensible aux accents), filtres ville/catégorie, tri par prix, pagination « Voir plus » |
| Fiche produit | Appel direct, bouton **WhatsApp** (numéros malgaches 03x convertis en +261), partage, signalement, lien direct `#produit-12` |
| Comptes vendeurs | Inscription e-mail + mot de passe (chiffré), connexion, changement de mot de passe |
| Espace vendeur | Ajouter / modifier / supprimer des produits, **photo** (réduite automatiquement), bouton « ✓ À jour » pour confirmer prix et stock, statistiques (vues, contacts) |
| Espace admin | Valider / refuser / suspendre les boutiques, masquer ou supprimer des produits, traiter les signalements, supprimer les données d'exemple |
| Sécurité | Mots de passe `scrypt`, sessions en cookie HttpOnly, protection CSRF, limitation des tentatives, validation de toutes les entrées, vérification réelle des images, en-têtes de sécurité (CSP…) |
| Pages légales | `/confidentialite` et `/conditions` (modèles **à compléter et faire relire**) |

**Aucune dépendance à installer** : le serveur utilise uniquement Node.js et sa base SQLite intégrée.

## Démarrer en local

Prérequis : **Node.js 22.13 ou plus récent** (https://nodejs.org).

```bash
cd misy-ve
npm start
```

Ouvre http://localhost:3000.
Au premier démarrage, le terminal affiche le compte administrateur :

```
 Compte administrateur créé
   e-mail       : admin@misyve.local
   mot de passe : XXXXXXXXXXXX   (note-le puis change-le dans ton espace)
```

Pour choisir toi-même l'e-mail et le mot de passe, définis `ADMIN_EMAIL` et `ADMIN_PASSWORD` avant le premier lancement (voir `.env.example`).
Tu peux lancer les tests avec `npm test`.

## Variables de configuration

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port du serveur | `3000` |
| `NODE_ENV` | Mets `production` en ligne (cookies `Secure`, HSTS) | — |
| `DATA_DIR` | Dossier de la base SQLite et des photos | `./data` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Compte admin créé au 1er démarrage | e-mail `admin@misyve.local`, mot de passe aléatoire |
| `TRUST_PROXY` | `true` derrière Render/Railway/Nginx pour lire la vraie IP | `false` |
| `SEED_DEMO` | Boutiques et produits d'exemple au 1er démarrage | `true` |

## Mettre en ligne

Il faut un hébergeur avec **un disque persistant** (sinon la base et les photos disparaissent à chaque redéploiement).

**Option A — Render** (le plus simple) : pousse le dossier sur GitHub, crée un « Blueprint » à partir de `render.yaml`, renseigne `ADMIN_EMAIL` et `ADMIN_PASSWORD`. Le disque de 1 Go et le HTTPS sont configurés automatiquement.

**Option B — Docker / VPS** :

```bash
docker build -t misy-ve .
docker run -d -p 3000:3000 -v misy-data:/data \
  -e ADMIN_EMAIL=toi@exemple.mg -e ADMIN_PASSWORD='un-vrai-mot-de-passe' -e SEED_DEMO=false \
  --restart unless-stopped misy-ve
```

Place ensuite Caddy ou Nginx devant (HTTPS obligatoire, car les mots de passe circulent).

> **Netlify ne convient pas** à ce projet : il héberge des sites statiques, pas un serveur avec base de données.

### Avant le vrai lancement
1. Mets `SEED_DEMO=false` (ou supprime les données d'exemple depuis Administration → Paramètres).
2. Complète et fais relire `public/confidentialite.html` et `public/conditions.html`.
3. **Sauvegarde** régulièrement le dossier `DATA_DIR` (il contient `misyve.sqlite` et `uploads/`).
4. Vérifie quelques boutiques par téléphone avant de les valider.

## Structure

```
server.js          serveur HTTP, sécurité, fichiers statiques
src/config.js      villes, catégories, configuration
src/db.js          schéma SQLite, compte admin, données d'exemple
src/auth.js        mots de passe, sessions, cookies
src/routes.js      toute l'API
src/util.js        validation, limitation de débit
public/            le site (index.html, app.js, styles.css, pages légales)
test/api.test.js   tests automatiques de l'API
```

## API (résumé)

Public : `GET /api/products?q=&city=&category=&sort=&page=` · `GET /api/products/:id` · `POST /api/products/:id/report` · `GET /api/meta`
Compte : `POST /api/auth/register|login|logout|password` · `GET /api/auth/me`
Vendeur : `GET /api/seller/overview` · `PUT /api/seller/shop` · `POST|PUT|DELETE /api/seller/products[/:id]` · `PUT|DELETE /api/seller/products/:id/image`
Admin : `GET /api/admin/overview|shops|products|reports` · `PATCH|DELETE /api/admin/shops|products/:id` · `DELETE /api/admin/demo`

Les requêtes qui modifient des données doivent envoyer l'en-tête `X-Requested-With: misyve` (protection CSRF).

## Limites connues et prochaines étapes

- **Une seule instance** : la limitation de débit et le cache sont en mémoire. Pour plusieurs serveurs, passer à PostgreSQL/Redis.
- **Pas d'e-mail** : pas de « mot de passe oublié » automatique. L'étape suivante est d'ajouter l'envoi d'e-mails (Brevo, Resend…).
- **Notification** : l'admin voit les boutiques en attente dans son espace ; une alerte WhatsApp/e-mail serait un bon ajout.
- `node:sqlite` est encore marqué « expérimental » par Node.js ; il fonctionne bien, mais garde Node à jour.
