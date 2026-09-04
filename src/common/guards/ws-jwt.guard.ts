import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import { UsersService } from '../../modules/users/users.service';
import { AuthenticatedUser, JwtPayload } from '../interfaces/jwt-payload.interface';

/**
 * The actual handshake verification runs once, in the Socket.io namespace
 * middleware registered by TrackingGateway.afterInit() — that's what can
 * reject a connection with `connect_error` before it's ever established
 * (contracts/websocket-events.md). This guard is the cheap per-message
 * check: it just confirms the middleware already populated `socket.data.user`,
 * so every @SubscribeMessage handler stays guarded without re-verifying the
 * JWT on every frame.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    if (!client.data?.user) {
      throw new WsException('UNAUTHORIZED');
    }
    return true;
  }
}

export async function authenticateSocket(
  socket: Socket,
  jwtService: JwtService,
  config: ConfigService,
  usersService: UsersService,
): Promise<AuthenticatedUser> {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) {
    throw new Error('UNAUTHORIZED');
  }
  const payload = await jwtService.verifyAsync<JwtPayload>(token, {
    secret: config.get<string>('jwt.secret'),
  });
  // spec 006: also refuses a handshake whose session has since been
  // revoked — the free offline fallback for a push the device missed
  // while disconnected (FR-035a, research R2).
  const { user, parentFuelCompanyId } =
    await usersService.validateActiveSessionWithScoping(payload);
  return {
    userId: (user._id as { toString(): string }).toString(),
    role: user.role,
    companyId: user.companyId?.toString(),
    parentFuelCompanyId,
    // feature 013 US2 (research R2/R3): carried from the HANDSHAKE token, not
    // re-read from `user` — the per-frame check in `TrackingGateway`
    // compares *what this connection claimed when it opened* against *what
    // the account holds now*. Sourcing both from the account compares it to
    // itself, always agrees, and yields a silently inert guard. Absent
    // normalises to 0 on the comparison side.
    sgen: payload.sgen,
    // spec 015 T023a — same discipline, for the admin session id. The
    // handshake path's `validateActiveSessionWithScoping` call above already
    // enforces `sid` membership; this is carried only so a handler could
    // name the session if it ever needed to (none does today).
    sid: payload.sid,
  };
}
