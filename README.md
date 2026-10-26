# Feed Miou

Les repas de Miou Miou, partagés entre Tristan, Paul et Julie : qui a donné quoi, qui est de garde, le stock, la santé et les comptes.

## Installer sur son téléphone

1. Ouvrir le lien d'invitation (il contient le code de la coloc).
2. iPhone : Safari › bouton Partager › « Sur l'écran d'accueil ».
   Android : Chrome › menu ⋮ › « Installer l'application ».

L'app s'ouvre ensuite en plein écran, avec la photo de Miou Miou comme icône.

## Comment c'est fait

- `index.html` : toute l'app (HTML, CSS, JS), sans étape de build.
- `sw.js` : démarrage hors ligne et affichage des notifications. La page est rechargée depuis le réseau à chaque ouverture, donc une mise à jour poussée sur GitHub arrive tout de suite.
- Données : table `feedmiou_docs` dans le projet Supabase « Caminada ». Une ligne par document (`path`, `col`, `data`).
  - Chiffrement de bout en bout : chaque document est chiffré sur le téléphone (AES-GCM, clé dérivée du code de la coloc par PBKDF2). La base, et donc quiconque administre Caminada, ne voit que du texte chiffré. Seuls le chemin (`feeds/2026-10-25_…`) et la date de modification restent lisibles.
  - En plus, sans le code de la coloc (en-tête `x-coloc-code`), la table renvoie zéro ligne et refuse toute écriture.
  - Conséquence : si le code de la coloc est perdu, les données ne sont plus lisibles. Garde `lien-coloc.txt` précieusement.
- Synchronisation : chaque modification prévient les autres appareils ouverts ; sinon rafraîchissement toutes les 30 s et à chaque retour sur l'app.

Le code de la coloc n'est pas dans ce dépôt : il est dans `lien-coloc.txt`, ignoré par git.

## Notifications

Chacun les active sur son téléphone : Coloc › Réglages › Notifications (ou le bouton « Activer » proposé sur l'écran du jour). Sur iPhone, ça ne marche que depuis l'app installée sur l'écran d'accueil (iOS 16.4 ou plus).

- « Quelqu'un a nourri Miou Miou » : part 10 à 40 s après la distribution, pas vers la personne qui l'a donnée, et pas du tout si la portion est annulée entre-temps.
- « Repas en retard » : 45 min après l'heure prévue, si une portion du repas n'est pas cochée. Si le repas est donné ensuite, la notif « a mangé » remplace celle du retard.

Comment c'est fait :

- Le téléphone qui coche une portion dépose l'alerte dans `feedmiou_alerts`. Pour les retards, chaque téléphone ouvert envoie la liste des vérifications des 14 prochains jours, et la remet à jour quand les horaires, les portions ou les gardes changent. Si personne n'ouvre l'app pendant deux semaines, les alertes de retard s'arrêtent.
- Toutes les 30 s, `pg_cron` regarde s'il y a une alerte à envoyer et appelle alors la fonction `feedmiou-push` (`supabase/functions/feedmiou-push`), qui l'envoie en Web Push (chiffrement RFC 8291 et clés VAPID, sans dépendance).
- Les textes sont chiffrés avec le code de la coloc comme le reste ; c'est `sw.js` qui les déchiffre sur le téléphone. Le serveur voit seulement l'heure de chaque vérification (heure du repas + 45 min) et les chemins des portions à vérifier.
- Clés VAPID : la publique est dans `index.html` (`push`), la privée dans le Vault Supabase (`feedmiou_vapid`). Si on change la paire, chacun doit couper puis réactiver les notifications.
- Le SQL est dans `supabase/migrations/`. Test du chiffrement Web Push : `node tests/webpush.test.ts` (Node 22.6 ou plus).

## Mettre à jour

Modifier `index.html`, puis :

```bash
git commit -am "Ce qui change"
git push
```

GitHub Pages republie en une minute environ.
