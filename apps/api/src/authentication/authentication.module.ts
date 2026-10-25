import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Injectable,
  Module,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface Principal {
  issuer: string;
  subject: string;
  clientId: string;
}
export interface IdentityRequest {
  headers: { authorization?: string };
  identity?: Principal;
}

@Injectable()
export class IdentityVerifier {
  private readonly issuer: string;
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor() {
    const issuer = new URL(process.env.OIDC_ISSUER ?? '');
    const local =
      process.env.AUTH_ENV === 'development' &&
      process.env.AUTH_ALLOW_HTTP === 'true' &&
      issuer.hostname === '127.0.0.1' &&
      issuer.protocol === 'http:';
    if (
      (!local && issuer.protocol !== 'https:') ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      issuer.pathname.endsWith('/')
    )
      throw new Error('Invalid OIDC issuer configuration');
    this.issuer = issuer.href;
    this.keys = createRemoteJWKSet(
      new URL(`${this.issuer}/protocol/openid-connect/certs`),
      { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 },
    );
  }
  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.issuer,
      audience: 'innoview-api',
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'iat', 'exp', 'azp'],
      maxTokenAge: '5m',
      clockTolerance: 5,
    });
    if (
      payload.typ !== 'Bearer' ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.azp !== 'string' ||
      !['innoview-portal', 'innoview-control-center'].includes(payload.azp)
    )
      throw new Error('Invalid access token');
    return {
      issuer: payload.iss!,
      subject: payload.sub,
      clientId: payload.azp,
    };
  }
}

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(private readonly verifier: IdentityVerifier) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const header = request.headers.authorization;
    try {
      if (
        !header ||
        !/^Bearer [A-Za-z0-9_.-]+$/i.test(header) ||
        header.length > 16384
      )
        throw new Error('Missing bearer');
      request.identity = await this.verifier.verify(header.slice(7));
      return true;
    } catch {
      throw new UnauthorizedException('Valid access token required');
    }
  }
}

@Controller('auth')
export class AuthenticationController {
  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthenticationGuard)
  me(@Req() request: IdentityRequest): Principal {
    return request.identity!;
  }
}

@Module({
  controllers: [AuthenticationController],
  providers: [IdentityVerifier, AuthenticationGuard],
  exports: [AuthenticationGuard, IdentityVerifier],
})
export class AuthenticationModule {}
