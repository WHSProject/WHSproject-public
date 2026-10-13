import {
  Controller,
  Get,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { NpmAuthService } from '../services/npm-auth.service';
import { NpmAuthenticationError, InstallNotPermittedError, type NpmUser } from '../errors/npm-auth.errors';
import { PackageNotAllowedError } from '../errors/approval.errors';
import { toHttpException } from '../http/to-http-exception';
import { RegistryProxy } from '../http/registry-proxy';
import {
  DownloadEventService,
  type DownloadOutcome,
} from '../services/download-event.service';
import { PackageNameParserService } from '../services/package-name-parser.service';
import { TarballAnalysisService } from '../services/tarball-analysis.service';
import { TarballPathParserService } from '../services/tarball-path-parser.service';
import type { Decision } from '../types/decision.types';

// 검사 시작점. package-lock.json이 있으면 Metadata 요청이 발생하지 않아(실측)
// tarball 요청에서 검사해야 CI 환경에서도 걸러진다. 경로 문자열만 읽는다.
@Controller('npm')
export class TarballController {
  constructor(
    private readonly packageNameParserService: PackageNameParserService,
    private readonly tarballPathParserService: TarballPathParserService,
    private readonly tarballAnalysisService: TarballAnalysisService,
    private readonly registryProxy: RegistryProxy,
    private readonly downloadEventService: DownloadEventService,
    private readonly npmAuth: NpmAuthService,
  ) {}

  @Get('@:scope/:name/-/:file')
  scopedTarball(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('scope') scope: string,
    @Param('name') name: string,
    @Param('file') file: string,
  ): Promise<void> {
    return this.handleTarball(request, reply, `@${scope}/${name}`, file);
  }

  @Get(':package/-/:file')
  tarball(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('package') packageName: string,
    @Param('file') file: string,
  ): Promise<void> {
    return this.handleTarball(request, reply, packageName, file);
  }

  // 패키지명·Version을 확인하고 분석을 마친 뒤에만 중계한다.
  private async handleTarball(
    request: FastifyRequest,
    reply: FastifyReply,
    rawPackageName: string,
    file: string,
  ): Promise<void> {
    const occurredAt = new Date();
    // 차단·오류가 확정되면 여기에 남긴다. 비어 있으면 응답 상태로 정한다.
    let outcome: DownloadOutcome | null = null;
    let user: NpmUser | null = null;

    let decision: Decision | null = null;
    let decisionId: string | null = null;
    let isRoot = false;

    try {
      const parsed = this.packageNameParserService.parse(rawPackageName);

      const { version } = this.tarballPathParserService.parse(
        parsed.packageName,
        file,
      );

      // 패키지·Version을 알아낸 요청만 기록한다(잘못된 경로는 400, 기록 없음).
      // 응답이 끝나거나 끊긴 시점의 실제 상태로 1번만 남긴다.
      // 본문을 끝까지 보냈는지는 finish로 판단한다(끊기면 close만 온다).
      let finished = false;
      reply.raw.once('finish', () => {
        finished = true;
      });
      reply.raw.once('close', () => {
        // 헤더를 보내기 전에 끊기면 상태 코드가 기본값(200)이라 의미가 없다.
        const httpStatus = reply.raw.headersSent ? reply.raw.statusCode : null;
        const delivered = finished
          && httpStatus !== null
          && httpStatus < 400;

        // decision·decisionId·isRoot는 #460의 analyze() 결과로,
        // 사용자 정보는 검증된 npm 토큰의 사용자만 사용한다.
        void this.downloadEventService.record({
          occurredAt,
          requestId: request.id,
          sourceIp: request.ip,
          packageName: parsed.packageName,
          version,
          outcome: outcome ?? (delivered ? 'DELIVERED' : 'ERROR'),
          httpStatus,
          decision,
          decisionId,
          isRoot,
          userId: user?.userId ?? null,
          username: user?.username ?? null,
        });
      });

      user = await this.npmAuth.authenticate(request.headers.authorization);

      const analysis = await this.tarballAnalysisService.analyze(
        request.id,
        parsed.packageName,
        version,
      );

      decision = analysis.decision;
      decisionId = analysis.decisionId;
      isRoot = analysis.isRoot;
    } catch (error) {
      if (error instanceof InstallNotPermittedError) {
        user = error.user;
        outcome = 'FORBIDDEN';
      } else if (error instanceof NpmAuthenticationError) {
        outcome = 'UNAUTHENTICATED';
      } else if (error instanceof PackageNotAllowedError) {
        outcome = 'BLOCKED';
        decision = error.decision;
        decisionId = error.decisionId;
        isRoot = error.isRoot;
      } else {
        outcome = 'ERROR';
      }
      throw toHttpException(error);
    }

    try {
      await this.registryProxy.forward(request, reply);
    } catch (error) {
      outcome = 'ERROR';
      throw error;
    }
  }
}
