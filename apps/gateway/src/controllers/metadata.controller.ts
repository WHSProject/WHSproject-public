import {
  Controller,
  Get,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';

import { NpmAuthService } from '../services/npm-auth.service';
import { RegistryProxy } from '../http/registry-proxy';
import { toHttpException } from '../http/to-http-exception';
import { PackageNameParserService } from '../services/package-name-parser.service';

// 패키지 정보(packument) 요청을 Verdaccio로 중계한다.
// 어떤 Version이 선택될지 모르는 시점이라 분석·판정 조회는 하지 않는다.
@Controller('npm')
export class MetadataController {
  constructor(
    private readonly packageNameParserService: PackageNameParserService,
    private readonly registryProxy: RegistryProxy,
    private readonly npmAuth: NpmAuthService,
  ) {}

  @Get('@:scope/:name')
  scopedMetadata(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('scope') scope: string,
    @Param('name') name: string,
  ): Promise<void> {
    return this.handleMetadata(request, reply, `@${scope}/${name}`);
  }

  @Get(':package')
  metadata(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('package') packageName: string,
  ): Promise<void> {
    return this.handleMetadata(request, reply, packageName);
  }

  // 패키지명 형식만 확인한 뒤 그대로 중계한다.
  private async handleMetadata(
    request: FastifyRequest,
    reply: FastifyReply,
    rawPackageName: string,
  ): Promise<void> {
    try {
      this.packageNameParserService.parse(rawPackageName);
    } catch (error) {
      throw toHttpException(error);
    }

    await this.npmAuth.authenticate(request.headers.authorization);
    await this.registryProxy.forward(request, reply);
  }
}
