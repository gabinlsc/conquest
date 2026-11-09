/** Erreur applicative avec statut HTTP ; convertie en réponse JSON par le gestionnaire d'erreurs global. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = () => new AppError(401, 'connexion requise', 'unauthorized');
