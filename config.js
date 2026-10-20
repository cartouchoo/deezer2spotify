// Configuration de Passe-Playlist — à remplir une fois par l'organisateur.
window.PP_CONFIG = {
  // Client ID de ton application Spotify (developer.spotify.com/dashboard).
  // Laisse vide pour le saisir dans les réglages de l'appli (⚙︎).
  clientId: "",

  // Optionnel mais recommandé : adresse de ton résolveur de liens courts
  // (voir worker/resolver.js et le README). Ex. "https://passe-playlist.ton-pseudo.workers.dev"
  // Sans lui, les liens link.deezer.com/s/… doivent être remplacés par le lien complet.
  resolverUrl: "",

  // Dépôt GitHub qui héberge l'appli : sert à activer la synchronisation automatique
  // (voir le README, section « Synchronisation »). Laisse vide pour masquer cette fonction.
  repo: "cartouchoo/deezer2spotify"
};
