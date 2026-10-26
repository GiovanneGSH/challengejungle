export interface AuthenticatedProvider {
  providerId: string;
  scopes: string[];
}

export abstract class ProviderIdentityPort {
  abstract verifyRequest(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedProvider | null>;
}

/**
 * Implementação No-Op documentada em ARCHITECTURE.md (Seção 2).
 * Em produção, um OidcProviderIdentityAdapter validaria o Bearer JWT emitido pelo Keycloak/Zitadel.
 */
export class NoOpProviderIdentityAdapter extends ProviderIdentityPort {
  async verifyRequest(): Promise<AuthenticatedProvider | null> {
    return { providerId: 'trusted-channel', scopes: ['wagering:write', 'wagering:read'] };
  }
}

export class ConflictApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConflictApplicationError';
  }
}

export class NotFoundApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NotFoundApplicationError';
  }
}