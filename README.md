# Feed Miou

Les repas de Miou Miou, partagés entre Tristan, Paul et Julie : qui a donné quoi, qui est de garde, le stock, la santé et les comptes.

## Installer sur son téléphone

1. Ouvrir le lien d'invitation (il contient le code de la coloc).
2. iPhone : Safari › bouton Partager › « Sur l'écran d'accueil ».
   Android : Chrome › menu ⋮ › « Installer l'application ».

L'app s'ouvre ensuite en plein écran, avec la photo de Miou Miou comme icône.

## Comment c'est fait

- `index.html` : toute l'app (HTML, CSS, JS), sans étape de build.
- `sw.js` : démarrage hors ligne. La page est rechargée depuis le réseau à chaque ouverture, donc une mise à jour poussée sur GitHub arrive tout de suite.
- Données : table `feedmiou_docs` dans le projet Supabase « Caminada ». Une ligne par document (`path`, `col`, `data`).
  Sans le code de la coloc (en-tête `x-coloc-code`), la table renvoie zéro ligne et refuse toute écriture.
- Synchronisation : chaque modification prévient les autres appareils ouverts ; sinon rafraîchissement toutes les 30 s et à chaque retour sur l'app.

Le code de la coloc n'est pas dans ce dépôt : il est dans `lien-coloc.txt`, ignoré par git.

## Mettre à jour

Modifier `index.html`, puis :

```bash
git commit -am "Ce qui change"
git push
```

GitHub Pages republie en une minute environ.
