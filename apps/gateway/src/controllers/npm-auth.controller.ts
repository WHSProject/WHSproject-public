import { Controller, Get, Put, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

// npm login은 종료한다. 계정 비밀번호나 서비스 자격증명을 중계하지 않는다.
@Controller('npm')
export class NpmAuthController {
  @Put('-/user/:userdoc/-rev/:rev')
  loginWithRevision(@Res() reply: FastifyReply) { return this.login(reply); }

  @Put('-/user/:userdoc')
  login(@Res() reply: FastifyReply) {
    return reply.code(410).send({ error: 'NPM_LOGIN_DISABLED', message: 'Issue an npm token in Dashboard settings and configure /npm/:_authToken in .npmrc' });
  }

  @Get('-/user/:userdoc')
  userDocument(@Res() reply: FastifyReply) { return this.login(reply); }
}
