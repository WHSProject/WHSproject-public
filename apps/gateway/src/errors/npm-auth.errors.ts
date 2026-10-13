import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

export interface NpmUser { userId: string; username: string | null; }

export class NpmAuthenticationError extends UnauthorizedException {}

export class InstallNotPermittedError extends ForbiddenException {
  constructor(public readonly user: NpmUser) { super(); }
}
