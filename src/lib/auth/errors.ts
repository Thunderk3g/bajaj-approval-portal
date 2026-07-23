export type AuthzCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INACTIVE';

export class AuthzError extends Error {
  constructor(
    public readonly code: AuthzCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AuthzError';
  }
}
